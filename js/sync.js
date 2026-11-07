/**
 * sync.js — sync-ready architecture with a pluggable transport.
 *
 * There is no real server yet. Everything a future backend needs is here:
 *
 *   1. A durable OUTBOX (written in the same IndexedDB transaction as every
 *      mutation, BEFORE the UI confirms) holding operation records:
 *      { id, entityId, type: 'create'|'update'|'delete', payload, timestamp,
 *        deviceId, status, tries, hlc }
 *   2. An ADAPTER interface:  push(ops) → {acked}   /   pull(sinceCursor) → {blocks, cursor}
 *      A MockAdapter (a second IndexedDB store acting as a shared server)
 *      implements it so multi-device behaviour and conflicts can be tested
 *      in one browser via the Developer panel.
 *   3. Conflict resolution: FIELD-LEVEL last-write-wins keyed by a Hybrid
 *      Logical Clock (HLC) instead of wall-clock time, so clock skew between
 *      devices cannot reorder causally-related edits. Deletes are tombstones
 *      (`deletedAt` + its own HLC), so a delete that happened after an edit
 *      wins predictably; only an explicit restore op (later HLC) resurrects.
 *
 * WHERE A CRDT WOULD BE BETTER (documented for the future): LWW is perfect
 * for scalar fields (title, dates, priority). Rich-text notes edited
 * concurrently on two devices will clobber each other; when notes grow into
 * a real editor, replace `notes` with a per-block CRDT (e.g. Yjs / Automerge
 * document stored as a field) and keep LWW for the scalar envelope. The
 * merge function below is the single seam — swap it there.
 *
 * See SYNC.md for the full protocol description and a Supabase sketch.
 */

import { STORES, tx, dbGet, dbPut, metaGet, metaSet } from './db.js';
import { shortId } from './utils.js';

/* ================================================================== *
 * Hybrid Logical Clock (HLC)
 * ================================================================== */

/**
 * HLC timestamps pack as `<physical:15 digits>.<logical:6 digits>.<node>`
 * — fixed-width, so plain string comparison == chronological/causal order
 * (physical first, then logical, then node id as deterministic tie-break).
 */
export const hlc = {
  node: 'local-' + shortId(6),
  _p: 0,
  _l: 0,

  /** Advance the clock and return the packed timestamp for NOW. */
  now() {
    const wall = Date.now();
    if (wall > this._p) { this._p = wall; this._l = 0; }
    else this._l += 1;
    return this.pack(this._p, this._l, this.node);
  },

  /** Absorb a remote timestamp so our clock never goes backwards relative to it. */
  receive(remoteStr) {
    const r = hlc.parse(remoteStr);
    if (!r) return;
    const wall = Date.now();
    if (r.p > wall && r.p > this._p) { this._p = r.p; this._l = r.l + 1; }
    else if (r.p === this._p) { this._l = Math.max(this._l, r.l) + 1; }
    else if (wall > this._p) { this._p = wall; this._l = 0; }
    else this._l += 1;
  },

  pack(p, l, node) {
    return `${String(p).padStart(15, '0')}.${String(l).padStart(6, '0')}.${node}`;
  },
  parse(s) {
    const m = /^(\d{15})\.(\d{6})\.(.+)$/.exec(s || '');
    return m ? { p: +m[1], l: +m[2], node: m[3] } : null;
  },
  /** -1 / 0 / +1 — total order over timestamps. */
  compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; },
};

/* ================================================================== *
 * Merge core — field-level LWW
 * ================================================================== */

const SPECIAL_KEYS = { __deleted: 'deletedAt', __order: 'order', __parent: 'parentId' };

/**
 * Apply a remote patch onto a block, per field, when the patch's HLC wins.
 * patch = { props, fieldHlcs: {field → hlc}, parentId, order, deletedAt }
 * `applyPatch` is IDEMPOTENT: replaying the same patch (same HLCs) changes
 * nothing, which is what makes op retries and at-least-once delivery safe.
 */
export function applyPatch(block, patch) {
  const out = {
    ...block,
    props: { ...(block.props || {}) },
    fieldHlcs: { ...(block.fieldHlcs || {}) },
  };
  for (const [key, h] of Object.entries(patch.fieldHlcs || {})) {
    const cur = out.fieldHlcs[key] || hlc.pack(new Date(out.createdAt || 0).getTime(), 0, 'legacy');
    if (hlc.compare(h, cur) > 0) {
      out.fieldHlcs[key] = h;
      if (key in SPECIAL_KEYS) out[SPECIAL_KEYS[key]] = patch[SPECIAL_KEYS[key]];
      else out.props[key] = patch.props ? patch.props[key] : undefined;
    }
  }
  out.version = (out.version || 1) + 1;
  return out;
}

/** Merge two full block versions (used by the server + local pull). */
export function mergeBlocks(local, remote) {
  const patch = {
    props: remote.props,
    fieldHlcs: remote.fieldHlcs,
    parentId: remote.parentId,
    order: remote.order,
    deletedAt: remote.deletedAt,
  };
  const merged = applyPatch(local, patch);
  merged.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
  return merged;
}

/* ================================================================== *
 * MockAdapter — pretend server in a second IndexedDB store
 * ================================================================== */

/**
 * Simulates a shared backend. Server records in STORES.SERVER:
 *   { id: 'block:<blockId>', kind: 'block', block, maxHlc }
 *   { id: 'op:<opId>',       kind: 'op' }              // idempotency markers
 *   { id: 'meta:cursor:<device>', kind: 'meta', value } // per-device cursors
 *
 * The SAME merge code (applyPatch/mergeBlocks) runs "server-side", exactly
 * like a real backend would run its own LWW merge — so conflicts resolve
 * identically wherever they meet.
 */
class MockAdapter {
  constructor() { this.latency = 0; }

  _wait() {
    const ms = this.latency + Math.random() * 120;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  async push(ops) {
    await this._wait();
    return tx([STORES.SERVER], 'readwrite', async (s, rq) => {
      const store = s[STORES.SERVER];
      const acked = [];
      for (const op of ops) {
        const seen = await rq(store.get('op:' + op.id));
        if (seen) { acked.push(op.id); continue; } // idempotent replay
        const recId = 'block:' + op.entityId;
        let rec = await rq(store.get(recId));
        let block;
        if (op.type === 'create') {
          block = rec ? rec.block : structuredClone(op.payload.block);
        } else if (op.type === 'delete') {
          block = applyPatch(rec?.block ?? { id: op.entityId, props: {}, createdAt: op.timestamp }, {
            fieldHlcs: { __deleted: op.hlc }, deletedAt: op.payload.deletedAt,
          });
        } else { // update
          block = applyPatch(rec?.block ?? op.payload.base ?? { id: op.entityId, props: {}, createdAt: op.timestamp }, op.payload.patch);
        }
        const maxHlc = Object.values(block.fieldHlcs || {}).reduce((a, b) => (a > b ? a : b), '0');
        await rq(store.put({ id: recId, kind: 'block', block, maxHlc }));
        await rq(store.put({ id: 'op:' + op.id, kind: 'op', opId: op.id, at: Date.now() }));
        acked.push(op.id);
      }
      return { acked };
    });
  }

  async pull(cursor) {
    await this._wait();
    const all = await tx([STORES.SERVER], 'readonly', (s, rq) => rq(s[STORES.SERVER].getAll()));
    let max = cursor || '0';
    const blocks = [];
    for (const rec of all) {
      if (rec.kind !== 'block') continue;
      if (!cursor || rec.maxHlc > cursor) { blocks.push(rec.block); if (rec.maxHlc > max) max = rec.maxHlc; }
    }
    return { blocks, cursor: max };
  }

  /** Dev helper: apply an op as a fake second device straight to the server. */
  async injectOp(op) {
    return this.push([op]);
  }
}

export const mockAdapter = new MockAdapter();

/* ================================================================== *
 * Sync engine
 * ================================================================== */

export const syncState = {
  status: 'idle', // idle | syncing | offline | error
  pending: 0,
  lastSync: null,
  lastError: null,
  forcedOffline: false,
};

const statusListeners = new Set();
export function subscribeSync(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
function emitStatus() {
  syncState.pending = engine ? engine.pendingCount() : 0;
  for (const fn of statusListeners) fn({ ...syncState });
}

let engine = null;

class SyncEngine {
  constructor({ store, adapter }) {
    this.store = store;           // injected store API (avoids a module cycle)
    this.adapter = adapter || mockAdapter;
    this.cursor = '0';
    this.busy = false;
    this.tries = 0;
    this.retryTimer = null;
    this.flushDebounce = null;
    this.online = navigator.onLine !== false;
    this.store.onOutboxChange(() => this.scheduleFlush());
  }

  pendingCount() { return this.store.pendingOpsCount(); }

  isReachable() { return this.online && !syncState.forcedOffline; }

  async loadCursor() { this.cursor = (await metaGet('sync:cursor', '0')) || '0'; }

  scheduleFlush() {
    clearTimeout(this.flushDebounce);
    this.flushDebounce = setTimeout(() => this.flush(), 400);
  }

  setOnline(v) {
    this.online = v;
    if (v) { this.tries = 0; this.scheduleFlush(); }
    this.updateStatus();
  }

  updateStatus() {
    if (this.busy) syncState.status = 'syncing';
    else if (!this.isReachable()) syncState.status = 'offline';
    else if (this.pendingCount() > 0) syncState.status = 'pending'; // engine still owes work
    else syncState.status = syncState.lastError ? 'error' : 'idle';
    syncState.pending = this.pendingCount();
    emitStatus();
  }

  /** Push pending ops, then pull remote changes. Retries with backoff. */
  async flush() {
    if (this.busy) return;
    if (!this.isReachable()) { this.updateStatus(); return; }
    this.busy = true;
    this.updateStatus();
    try {
      // Single-flight: any op still marked 'sending' belongs to an
      // interrupted round — reclaim it before this round starts.
      this.store.reclaimSendingOps?.();

      // --- push loop (batches of 50) ---
      while (true) {
        const ops = await this.store.takePendingOps(50);
        if (!ops.length) break;
        try {
          const res = await this.adapter.push(ops);
          await this.store.markOpsSynced(res.acked);
          this.tries = 0;
        } catch (err) {
          await this.store.requeueOps(ops, err);
          throw err;
        }
      }
      // --- pull ---
      const { blocks, cursor } = await this.adapter.pull(this.cursor);
      if (blocks.length) {
        for (const remote of blocks) await this.store.applyRemoteBlock(remote);
        hlc.receive(blocks.reduce((a, b) => {
          const m = Math.max(...Object.values(b.fieldHlcs || {}).concat(a));
          return m > a ? m : a;
        }, '0'));
      }
      this.cursor = cursor || this.cursor;
      await metaSet('sync:cursor', this.cursor);
      syncState.lastSync = Date.now();
      syncState.lastError = null;
    } catch (err) {
      syncState.lastError = String(err?.message || err);
      this.scheduleRetry();
    } finally {
      this.busy = false;
      this.updateStatus();
    }
  }

  scheduleRetry() {
    this.tries += 1;
    // Exponential backoff with jitter, capped at 30s.
    const delay = Math.min(30000, 800 * 2 ** Math.min(this.tries, 5)) + Math.random() * 400;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.flush(), delay);
  }
}

/**
 * Boot the sync engine. `store` is the store module (injected to avoid an
 * import cycle): it must expose pendingOpsCount, takePendingOps(n),
 * markOpsSynced(ids), requeueOps(ops, err), applyRemoteBlock(block),
 * onOutboxChange(fn).
 */
export function initSync({ store, adapter } = {}) {
  if (engine) return engine;
  engine = new SyncEngine({ store, adapter });
  engine.loadCursor().then(() => {
    engine.updateStatus();
    // Ops persisted from a previous session (or left by an interrupted
    // flush) should start draining immediately, not wait for the interval.
    if (engine.pendingCount() > 0) engine.scheduleFlush();
  });

  window.addEventListener('online', () => engine.setOnline(true));
  window.addEventListener('offline', () => engine.setOnline(false));

  // Safety flush: periodically + whenever the tab becomes visible.
  setInterval(() => engine.flush(), 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) engine.flush();
  });
  return engine;
}

export function forceSyncNow() { engine?.flush(); }
export function setForcedOffline(v) { syncState.forcedOffline = v; engine?.updateStatus(); if (!v) engine?.flush(); }
export function getEngine() { return engine; }

/* ------------------------------------------------------------------ *
 * Dev helpers — Device B simulation (see Settings → Developer)
 * ------------------------------------------------------------------ */

/**
 * Build and inject an op as a phantom "Device B". hlcOffsetMs lets the dev
 * panel fake clock skew (future HLC → B wins, past HLC → local wins).
 */
export async function devOpAsDeviceB({ type, entityId, block, patch, deletedAt, hlcOffsetMs = 0 }) {
  const base = hlc.pack(Date.now() + hlcOffsetMs, 1, 'device-b');
  const op = {
    id: 'devb-' + shortId(10),
    entityId,
    type,
    payload: type === 'create' ? { block } : type === 'delete' ? { deletedAt: deletedAt ?? Date.now() } : { patch },
    timestamp: Date.now(),
    deviceId: 'device-b',
    status: 'pending',
    hlc: base,
  };
  await mockAdapter.injectOp(op);
  await engine?.flush();
  return op;
}

/** Wipe the mock server (fresh multi-device experiments). */
export async function devResetServer() {
  await tx([STORES.SERVER], 'readwrite', (s, rq) => rq(s[STORES.SERVER].clear()));
  await metaSet('sync:cursor', '0');
  if (engine) { engine.cursor = '0'; engine.flush(); }
}
