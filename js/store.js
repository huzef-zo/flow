/**
 * store.js — the block store: single source of truth for the app.
 *
 * Every entity is a BLOCK:
 *   { id (UUIDv7), type, parentId, order (fractional index), workspaceId,
 *     props, fieldHlcs, createdAt, updatedAt, deletedAt, version, deviceId }
 *
 * READS are synchronous from an in-memory cache (fast enough for 10k+
 * blocks and makes optimistic UI trivial). WRITES mutate the cache
 * immediately (optimistic) and persist to IndexedDB in the SAME transaction
 * as an outbox operation record — so "the UI confirmed" implies "durably
 * queued for sync". The sync engine (sync.js) drains the outbox.
 *
 * NEW BLOCK TYPES: call registerType({type, defaults, schema, describe}).
 * The store itself is type-agnostic; the registry supplies defaults,
 * a schema (for the dev panel / future validation) and a describe()
 * renderer used in search results and the dev entity browser.
 */

import { STORES, tx, dbGetAll, metaGet, metaSet } from './db.js';
import { hlc, applyPatch } from './sync.js';
import * as U from './utils.js';

const WORKSPACE = 'ws:default';

/* ================================================================== *
 * Block type registry
 * ================================================================== */

const registry = new Map();

export function registerType(def) {
  registry.set(def.type, { schema: {}, describe: (b) => b.props.title || b.props.name || b.type, ...def });
}
export function getType(type) { return registry.get(type); }
export function registeredTypes() { return [...registry.values()]; }

const TASK_PROPS = () => ({
  title: '', notes: '', priority: 4, projectId: null, labels: [],
  startDate: null, dueDate: null, dueTime: null, reminder: null,
  schedule: null, // { date:'YYYY-MM-DD', start: minutes|null, dur: minutes }
  recurrence: null, someday: false, completedAt: null,
  focusMinutes: 0, notifiedAt: null,
});

registerType({
  type: 'task', name: 'Task',
  defaults: TASK_PROPS,
  schema: { title: 'string', notes: 'string', priority: 'number', projectId: 'string|null', labels: 'array', startDate: 'date|null', dueDate: 'date|null', dueTime: 'time|null', reminder: 'time|null', schedule: 'object|null', recurrence: 'object|null', someday: 'boolean', completedAt: 'number|null', focusMinutes: 'number' },
  describe: (b) => b.props.title || 'Untitled task',
});
registerType({ type: 'project', name: 'Project', defaults: () => ({ name: '', color: null, emoji: null }), schema: { name: 'string', color: 'string|null' }, describe: (b) => b.props.name });
registerType({ type: 'area', name: 'Area', defaults: () => ({ name: '' }), schema: { name: 'string' }, describe: (b) => b.props.name });
registerType({ type: 'label', name: 'Label', defaults: () => ({ name: '' }), schema: { name: 'string' }, describe: (b) => b.props.name });
registerType({ type: 'habit', name: 'Habit', defaults: () => ({ name: '', cadence: 'daily', emoji: null, createdAt: null }), schema: { name: 'string', cadence: 'daily|weekly' }, describe: (b) => b.props.name });
registerType({ type: 'habitLog', name: 'Habit log', defaults: () => ({ done: true }), schema: { done: 'boolean' }, describe: (b) => b.id });
registerType({ type: 'timerLog', name: 'Timer log', defaults: () => ({ taskId: null, minutes: 0, endedAt: null, mode: 'focus' }), schema: { taskId: 'string|null', minutes: 'number' }, describe: (b) => `${b.props.minutes}m focus` });
registerType({ type: 'event', name: 'Event', defaults: () => ({ title: '', date: null, start: null, dur: 60, allDay: false, location: null, uid: null }), schema: { title: 'string', date: 'date', start: 'number|null', dur: 'number', allDay: 'boolean' }, describe: (b) => b.props.title });
registerType({ type: 'smartList', name: 'Smart list', defaults: () => ({ name: '', filter: {} }), schema: { name: 'string', filter: 'object' }, describe: (b) => b.props.name });

/* ================================================================== *
 * State
 * ================================================================== */

const cache = new Map();       // id → block
const outbox = new Map();      // opId → op record
const listeners = new Set();   // change listeners (views)
const outboxListeners = new Set();

export const settings = {
  theme: 'system', accent: 'indigo', weekStart: 1, use24h: false,
  defaultReminderTime: '09:00', autoReminders: true, hideUntilStart: true,
  planPrompt: true, devPanel: false,
  pomodoro: { focus: 25, break: 5, longBreak: 15, rounds: 4, autoStartBreaks: false, sound: true },
};

export let deviceId = 'local';

const SETTINGS_KEY = 'settings';
const SEED_KEY = 'seedIds';

let writeChain = Promise.resolve(); // serialize writes to avoid tx gaps

/* ================================================================== *
 * Events
 * ================================================================== */

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let emitTimer = null;
function emit() {
  // ~50ms trailing debounce: bursts of writes (sync pulls, bulk ops)
  // coalesce into one re-render instead of one per block.
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => {
    for (const fn of listeners) {
      try { fn(); } catch (err) { console.error('listener error', err); }
    }
  }, 50);
}
function notifyOutbox() { for (const fn of outboxListeners) fn(); }
export function onOutboxChange(fn) { outboxListeners.add(fn); return () => outboxListeners.delete(fn); }

/* ================================================================== *
 * Init
 * ================================================================== */

export async function initStore() {
  let id = await metaGet('deviceId', null);
  if (!id) { id = 'dev-' + U.shortId(6); await metaSet('deviceId', id); }
  deviceId = id;
  hlc.node = id;

  const [blocks, ops, savedSettings, lastHlc] = await Promise.all([
    dbGetAll(STORES.BLOCKS), dbGetAll(STORES.OUTBOX),
    metaGet(SETTINGS_KEY, null), metaGet('lastHlc', null),
  ]);
  for (const b of blocks) cache.set(b.id, b);
  for (const o of ops) outbox.set(o.id, o);
  if (savedSettings) Object.assign(settings, savedSettings);

  // Restore the HLC so a restart never produces timestamps older than
  // already-persisted ones (monotonicity across sessions).
  if (lastHlc) hlc.receive(lastHlc);
  persistHlcSoon();
}

let hlcTimer = null;
function persistHlcSoon() {
  clearTimeout(hlcTimer);
  hlcTimer = setTimeout(() => metaSet('lastHlc', hlc.now()), 2000);
}

export function setSettings(patch) {
  Object.assign(settings, patch);
  writeChain = writeChain.then(() => metaSet(SETTINGS_KEY, structuredClone(settings)));
  emit();
}

/** Resolves when all queued writes have settled (used by export/tests). */
export function whenIdle() { return writeChain.catch(() => {}); }

/* ================================================================== *
 * Internal: persistence + outbox
 * =================================================================== */

function newBlock({ type, props, parentId = null, order = null, id = null }) {
  const def = getType(type);
  if (!def) throw new Error(`Unknown block type "${type}" — register it first`);
  const now = Date.now();
  const block = {
    id: id || U.uuidv7(),
    type,
    parentId,
    order: order ?? U.FI.between(lastSiblingOrder(type, parentId), null),
    workspaceId: WORKSPACE,
    props: { ...def.defaults(), ...props },
    fieldHlcs: {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    deviceId,
  };
  const stamp = hlc.now();
  for (const key of Object.keys(block.props)) block.fieldHlcs[key] = stamp;
  block.fieldHlcs.__parent = stamp;
  block.fieldHlcs.__order = stamp;
  return block;
}

function enqueueOp(op) {
  outbox.set(op.id, op);
  writeChain = writeChain.then(() =>
    tx([STORES.OUTBOX], 'readwrite', (s, rq) => rq(s[STORES.OUTBOX].put(op)))
  );
  notifyOutbox();
}

function persistBlock(block) {
  writeChain = writeChain.then(() =>
    tx([STORES.BLOCKS], 'readwrite', (s, rq) => rq(s[STORES.BLOCKS].put(structuredClone(block))))
  );
  persistHlcSoon();
}

function opFor(block, type, extra = {}) {
  const stamp = hlc.now();
  return {
    id: U.uuidv7(),
    entityId: block.id,
    type,
    payload: extra,
    timestamp: Date.now(),
    deviceId,
    status: 'pending',
    tries: 0,
    hlc: stamp,
  };
}

function lastSiblingOrder(type, parentId) {
  let last = null;
  for (const b of cache.values()) {
    if (b.type !== type || b.deletedAt) continue;
    if ((b.parentId ?? null) !== (parentId ?? null)) continue;
    if (!last || U.FI.cmp(b.order, last) > 0) last = b.order;
  }
  return last;
}

/* ================================================================== *
 * CRUD
 * ================================================================== */

/** Create a block (optimistic; returns the block immediately). */
export function create({ type, props = {}, parentId = null, order = null, id = null }) {
  const block = newBlock({ type, props, parentId, order, id });
  cache.set(block.id, block);
  persistBlock(block);
  enqueueOp(opFor(block, 'create', { block: structuredClone(block) }));
  emit();
  return block;
}

/** Batch-create (one transaction) — used by seeding, import and stress tests. */
export function createMany(items) {
  const blocks = items.map((it) => newBlock(it));
  for (const b of blocks) cache.set(b.id, b);
  writeChain = writeChain.then(() =>
    tx([STORES.BLOCKS, STORES.OUTBOX], 'readwrite', (s, rq) =>
      Promise.all(blocks.flatMap((b) => [
        rq(s[STORES.BLOCKS].put(structuredClone(b))),
        rq(s[STORES.OUTBOX].put(opFor(b, 'create', { block: structuredClone(b) }))),
      ]))
    )
  );
  notifyOutbox();
  emit();
  return blocks;
}

/**
 * Update fields of a block. `patch` merges into props; use {__deletedAt,
 * __parentId, __order} for envelope fields. Optimistic + outboxed.
 */
export function update(id, patch) {
  const block = cache.get(id);
  if (!block) return null;
  const stamp = hlc.now();
  const propPatch = {};
  const fieldHlcs = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__deletedAt') {
      block.deletedAt = value; fieldHlcs.__deleted = stamp;
    } else if (key === '__parentId') {
      block.parentId = value; fieldHlcs.__parent = stamp;
    } else if (key === '__order') {
      block.order = value; fieldHlcs.__order = stamp;
    } else {
      block.props[key] = value;
      propPatch[key] = value;
      fieldHlcs[key] = stamp;
    }
  }
  block.updatedAt = Date.now();
  block.version += 1;
  persistBlock(block);
  // `base` lets a server that never saw the create still materialize the block.
  enqueueOp(opFor(block, 'update', {
    patch: { props: propPatch, fieldHlcs, parentId: block.parentId, order: block.order, deletedAt: block.deletedAt },
    base: structuredClone(block),
  }));
  emit();
  return block;
}

export function updateMany(ids, patch) {
  for (const id of ids) update(id, patch);
}

/** Soft delete (tombstone — deletions propagate through sync predictably). */
export function softDelete(id) {
  const block = cache.get(id);
  if (!block || block.deletedAt) return;
  const deletedAt = Date.now();
  update(id, { __deletedAt: deletedAt });
  // Replace the generic update op with a compact delete op (still LWW-safe:
  // the __deleted HLC from update() is what wins merges).
}

export function restore(id) {
  const block = cache.get(id);
  if (!block || !block.deletedAt) return;
  const stamp = hlc.now();
  block.deletedAt = null;
  block.fieldHlcs.__deleted = stamp;
  block.updatedAt = Date.now();
  block.version += 1;
  persistBlock(block);
  enqueueOp(opFor(block, 'update', {
    patch: { props: {}, fieldHlcs: { __deleted: stamp }, parentId: block.parentId, order: block.order, deletedAt: null },
    base: structuredClone(block),
  }));
  emit();
}

/**
 * Move a block (reparent + manual reorder) so it lands just before
 * `beforeId` (or at the end when null). Fractional indexing means only the
 * moved block is rewritten; the single pathological case (inserting before
 * a sibling whose key is the floor key 'a0') additionally bumps that one
 * sibling — never the whole list.
 */
export function reorder(id, beforeId, newParentId) {
  const block = cache.get(id);
  if (!block) return;
  const parentId = newParentId === undefined ? block.parentId : newParentId;
  const siblings = childrenOf(block.type, parentId).filter((b) => b.id !== id);
  const idx = beforeId ? siblings.findIndex((b) => b.id === beforeId) : -1;
  const prev = idx > 0 ? siblings[idx - 1].order : null;
  const next = idx >= 0 ? siblings[idx].order : null;

  let key = U.FI.between(prev, next);
  const patch = { __parentId: parentId };
  if (key === null) {
    // Inserting before the floor key 'a0': claim 'a0' and bump that sibling.
    key = 'a0';
    patch.__order = key;
    update(id, patch);
    const bumped = siblings[0];
    if (bumped) update(bumped.id, { __order: U.FI.between('a0', siblings[1]?.order ?? null) });
    return;
  }
  patch.__order = key;
  update(id, patch);
}

/* ================================================================== *
 * Queries
 * ================================================================== */

export function get(id) { return cache.get(id) || null; }
export function exists(id) { return cache.has(id); }

/** Sibling children of a parent, sorted by fractional order. */
export function childrenOf(type, parentId) {
  const out = [];
  for (const b of cache.values()) {
    if (b.type !== type || b.deletedAt) continue;
    if ((b.parentId ?? null) !== (parentId ?? null)) continue;
    out.push(b);
  }
  out.sort((a, b) => U.FI.cmp(a.order, b.order) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return out;
}

export function allOfType(type) {
  const out = [];
  for (const b of cache.values()) if (b.type === type && !b.deletedAt) out.push(b);
  return out;
}

/** All live (non-deleted) blocks — dev panel, export. */
export function allBlocks(includeDeleted = false) {
  return [...cache.values()].filter((b) => includeDeleted || !b.deletedAt);
}

/* ---- task helpers ---- */

export function activeTasks() { return allOfType('task'); }

export function projectOf(task) {
  return task.props.projectId ? get(task.props.projectId) : null;
}
export function areaOfProject(project) {
  return project?.parentId ? get(project.parentId) : null;
}
export function labelBlocks(task) {
  return (task.props.labels || []).map((id) => get(id)).filter(Boolean);
}

/** The "when" day of a task: scheduled day, else due day. */
export function taskDay(t) {
  return t.props.schedule?.date || t.props.dueDate || null;
}
export function isOverdue(t) {
  return !t.props.completedAt && !!t.props.dueDate && t.props.dueDate < U.todayStr();
}
/** A task is actionable (not hidden behind a future start date). */
export function isStarted(t, today = U.todayStr()) {
  return !t.props.startDate || t.props.startDate <= today;
}

export function matchesSmartFilter(t, f, today = U.todayStr()) {
  if (t.props.completedAt || t.deletedAt) return false;
  if (f.priority != null && (t.props.priority ?? 4) !== f.priority) return false;
  if (f.projectId !== undefined && f.projectId !== null && t.props.projectId !== f.projectId) return false;
  if (f.someday === true && !t.props.someday) return false;
  if (f.someday === false && t.props.someday) return false;
  if (f.labels?.length) {
    const names = new Set(labelBlocks(t).map((l) => l.props.name.toLowerCase()));
    if (!f.labels.every((n) => names.has(n.toLowerCase()))) return false;
  }
  if (f.text) {
    const q = f.text.toLowerCase();
    if (!(t.props.title || '').toLowerCase().includes(q) && !(t.props.notes || '').toLowerCase().includes(q)) return false;
  }
  const day = taskDay(t);
  switch (f.due) {
    case 'overdue': if (!(t.props.dueDate && t.props.dueDate < today)) return false; break;
    case 'today': if (!(day && day <= today)) return false; break;
    case 'week': if (!(day && day <= U.addDays(today, 7))) return false; break;
    case 'none': if (day) return false; break;
    default: break;
  }
  return true;
}

/* ---- name lookups for quick add ---- */

export function ensureNamed(type, name, parentId = null) {
  const clean = String(name).trim();
  const existing = allOfType(type).find(
    (b) => (b.props.name || '').toLowerCase() === clean.toLowerCase() && (b.parentId ?? null) === (parentId ?? null)
  );
  if (existing) return existing;
  return create({ type, props: { name: clean }, parentId });
}

export function labelByName(name) {
  return allOfType('label').find((l) => l.props.name.toLowerCase() === String(name).toLowerCase()) || null;
}

/* ================================================================== *
 * Completion + recurrence
 * ================================================================== */

/**
 * Rule shape produced by the parser / detail editor:
 *   { freq: 'day'|'week'|'month'|'year', interval, byDay?: [0..6],
 *     byMonthDay?: 1..31, nth?: {n:1..5, d:0..6}, fromCompletion?: bool,
 *     anchor: 'YYYY-MM-DD' }
 * All math is local-wall-clock (see utils.js header) so DST cannot shift a
 * "every monday 9:00" occurrence.
 */
export function ruleMatches(rule, d) {
  const a = rule.anchor;
  switch (rule.freq) {
    case 'day': {
      const diff = U.diffDays(a, d);
      return diff >= 0 && diff % Math.max(1, rule.interval || 1) === 0;
    }
    case 'week': {
      const interval = Math.max(1, rule.interval || 1);
      const weeks = ((U.weekIndex(d) - U.weekIndex(a)) % interval + interval) % interval;
      if (weeks !== 0) return false;
      if (rule.byDay?.length) return rule.byDay.includes(U.weekdayOf(d));
      return U.weekdayOf(d) === U.weekdayOf(a);
    }
    case 'month': {
      const months = (Number(d.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(d.slice(5, 7)) - Number(a.slice(5, 7)));
      if (months < 0 || months % Math.max(1, rule.interval || 1) !== 0) return false;
      const day = Number(d.slice(8, 10));
      if (rule.nth) return nthWeekdayOfMonth(d) === `${rule.nth.n}:${rule.nth.d}`;
      if (rule.byMonthDay) {
        const last = U.daysInMonth(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1);
        return day === Math.min(rule.byMonthDay, last);
      }
      const last = U.daysInMonth(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1);
      return day === Math.min(Number(a.slice(8, 10)), last);
    }
    case 'year':
      return d.slice(5) === a.slice(5) || (a.slice(5) === '02-29' && d.slice(5) === '02-28');
    default:
      return false;
  }
}

/** "3rd wednesday" → "3:3" (n:weekday) for the current month of d, or null. */
function nthWeekdayOfMonth(d) {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1, day = Number(d.slice(8, 10));
  const weekday = new Date(y, m, 1).getDay();
  const firstOccurrence = 1 + ((new Date(y, m, 1).getDay() + 7 - 0) % 7); // unused; compute directly:
  const dow = new Date(y, m, day).getDay();
  const n = Math.ceil(day / 7);
  const lastDay = U.daysInMonth(y, m);
  const isLast = day + 7 > lastDay;
  return isLast ? `5:${dow}` : `${n}:${dow}`;
}

/**
 * Next occurrence strictly after `from` (or on it when inclusive).
 * Iterative scan capped at 1000 days — cheap and obviously correct.
 */
export function nextOccurrence(rule, from, inclusive = false) {
  if (!rule?.freq) return null;
  let d = from;
  if (!inclusive) d = U.addDays(d, 1);
  for (let i = 0; i < 1000; i++) {
    if (ruleMatches(rule, d)) return d;
    d = U.addDays(d, 1);
  }
  return null;
}

/**
 * Complete a task. Recurring tasks spawn their next occurrence (the
 * completed one stays in the Logbook) — Todoist/Things behaviour.
 * Returns { spawnedId } so the UI can undo atomically.
 */
export function completeTask(id) {
  const t = cache.get(id);
  if (!t || t.deletedAt || t.props.completedAt) return {};
  const today = U.todayStr();
  update(id, { completedAt: Date.now() });

  let spawnedId = null;
  const rule = t.props.recurrence;
  if (rule?.freq) {
    const base = rule.fromCompletion ? today : (t.props.schedule?.date || t.props.dueDate || today);
    const next = nextOccurrence(rule, base, false);
    if (next) {
      const props = {
        ...structuredClone(t.props),
        completedAt: null,
        notifiedAt: null,
        focusMinutes: 0,
        schedule: t.props.schedule
          ? { date: next, start: t.props.schedule.start, dur: t.props.schedule.dur }
          : null,
        dueDate: t.props.dueDate ? next : null,
      };
      const spawned = create({ type: 'task', props, parentId: t.parentId, order: U.FI.between(t.order, null) });
      spawnedId = spawned.id;
    }
  }
  return { spawnedId };
}

export function uncompleteTask(id) {
  update(id, { completedAt: null, notifiedAt: null });
}

/* ================================================================== *
 * Habits / timer logs
 * ================================================================== */

export function habitLogId(habitId, date) { return `${habitId}:${date}`; }

export function toggleHabit(habitId, date) {
  const id = habitLogId(habitId, date);
  const existing = cache.get(id);
  if (existing && !existing.deletedAt) { softDelete(id); return false; }
  if (existing) { restore(id); return true; }
  create({ type: 'habitLog', props: { done: true }, id });
  return true;
}

export function habitDoneOn(habitId, date) {
  const log = cache.get(habitLogId(habitId, date));
  return !!log && !log.deletedAt;
}

/** Consecutive periods (days for daily habits, ISO weeks for weekly). */
export function habitStreak(habit) {
  const today = U.todayStr();
  let streak = 0;
  if (habit.props.cadence === 'weekly') {
    let week = U.weekStartOf(today, settings.weekStart);
    // A streak can include the current, unfinished week only if already done.
    if (!habitDoneOn(habit.id, week)) {
      // check ANY day this week
      const anyThisWeek = [...Array(7).keys()].some((i) => habitDoneOn(habit.id, U.addDays(week, i)));
      if (!anyThisWeek) week = U.addDays(week, -7);
    }
    while (true) {
      const hit = [...Array(7).keys()].some((i) => habitDoneOn(habit.id, U.addDays(week, i)));
      if (!hit) break;
      streak += 1;
      week = U.addDays(week, -7);
    }
    return streak;
  }
  let d = habitDoneOn(habit.id, today) ? today : U.addDays(today, -1);
  while (habitDoneOn(habit.id, d)) { streak += 1; d = U.addDays(d, -1); }
  return streak;
}

export function logFocus({ taskId, minutes, mode = 'focus' }) {
  create({ type: 'timerLog', props: { taskId, minutes, endedAt: Date.now(), mode } });
  if (taskId) {
    const t = get(taskId);
    if (t) update(taskId, { focusMinutes: (t.props.focusMinutes || 0) + minutes });
  }
}

/* ================================================================== *
 * Search
 * ================================================================== */

export function searchAll(q, limit = 24) {
  const query = q.trim().toLowerCase();
  if (!query) return { tasks: [], projects: [], labels: [], habits: [] };
  const score = (s) => {
    const i = s.toLowerCase().indexOf(query);
    return i < 0 ? -1 : 100 - i;
  };
  const tasks = [], projects = [], labels = [], habits = [];
  for (const b of cache.values()) {
    if (b.deletedAt) continue;
    if (b.type === 'task' && !b.props.completedAt) {
      const s = score(b.props.title || '') >= 0 ? score(b.props.title) : (b.props.notes || '').toLowerCase().includes(query) ? 10 : -1;
      if (s >= 0) tasks.push({ block: b, s });
    } else if (b.type === 'project' || b.type === 'area') {
      const s = score(b.props.name || '');
      if (s >= 0) projects.push({ block: b, s });
    } else if (b.type === 'label') {
      const s = score(b.props.name || '');
      if (s >= 0) labels.push({ block: b, s });
    } else if (b.type === 'habit') {
      const s = score(b.props.name || '');
      if (s >= 0) habits.push({ block: b, s });
    }
  }
  const pick = (arr) => arr.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.block);
  return { tasks: pick(tasks), projects: pick(projects), labels: pick(labels), habits: pick(habits) };
}

/* ================================================================== *
 * Sync plumbing (engine-facing API — see sync.js initSync)
 * ================================================================== */

export function pendingOpsCount() {
  let n = 0;
  for (const o of outbox.values()) if (o.status === 'pending' || o.status === 'sending') n++;
  return n;
}

export function takePendingOps(n) {
  const ops = [];
  for (const o of outbox.values()) {
    if (o.status === 'pending') { o.status = 'sending'; o.sentAt = Date.now(); ops.push(structuredClone(o)); }
    if (ops.length >= n) break;
  }
  persistOps(ops.map((o) => o.id));
  notifyOutbox();
  return Promise.resolve(ops);
}

/**
 * Reset orphaned 'sending' ops back to 'pending'. The engine runs a single
 * flush at a time, so any op still marked 'sending' when a new flush starts
 * belongs to an interrupted round (tab crash, killed promise) and must be
 * retried — this is what makes the queue self-healing.
 */
export function reclaimSendingOps() {
  const ids = [];
  for (const o of outbox.values()) {
    if (o.status === 'sending') { o.status = 'pending'; o.tries = (o.tries || 0); ids.push(o.id); }
  }
  if (ids.length) { persistOps(ids); notifyOutbox(); }
  return ids.length;
}

export function markOpsSynced(ids) {
  for (const id of ids) {
    const op = outbox.get(id);
    if (op) op.status = 'synced';
  }
  persistOps(ids);
  pruneSyncedOps();
  notifyOutbox();
}

export function requeueOps(ops, err) {
  for (const op of ops) {
    const local = outbox.get(op.id);
    if (local) { local.status = 'pending'; local.tries = (local.tries || 0) + 1; local.lastError = String(err?.message || err); }
  }
  persistOps(ops.map((o) => o.id));
  notifyOutbox();
}

function persistOps(ids) {
  // NOTE: not `.map(structuredClone)` — map passes (value, index, array) and
  // structuredClone treats the index as an options object.
  const records = ids.map((id) => outbox.get(id)).filter(Boolean).map((rec) => structuredClone(rec));
  if (!records.length) return;
  writeChain = writeChain.then(() =>
    tx([STORES.OUTBOX], 'readwrite', (s, rq) => Promise.all(records.map((r) => rq(s[STORES.OUTBOX].put(r)))))
  );
}

function pruneSyncedOps() {
  const synced = [...outbox.values()].filter((o) => o.status === 'synced')
    .sort((a, b) => b.timestamp - a.timestamp);
  const toDrop = synced.slice(60).map((o) => o.id);
  if (!toDrop.length) return;
  for (const id of toDrop) outbox.delete(id);
  writeChain = writeChain.then(() =>
    tx([STORES.OUTBOX], 'readwrite', (s, rq) => Promise.all(toDrop.map((id) => rq(s[STORES.OUTBOX].delete(id)))))
  );
}

export function recentOps(limit = 40) {
  return [...outbox.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/** Merge a remote (server) block version into the local store. */
export async function applyRemoteBlock(remote) {
  const local = cache.get(remote.id);

  // Fast path: nothing in the remote version is newer than what we have —
  // this is the pull of our own pushes echoing back. Skipping avoids a
  // pointless write + re-render per block (matters after bulk imports).
  if (local) {
    const remoteNewer = Object.entries(remote.fieldHlcs || {}).some(
      ([key, stamp]) => stamp > (local.fieldHlcs?.[key] || '')
    );
    if (!remoteNewer && (local.deletedAt || !remote.deletedAt || local.deletedAt === remote.deletedAt)) {
      const remoteMax = Object.values(remote.fieldHlcs || {}).reduce((a, b) => (a > b ? a : b), '0');
      if (remoteMax && remoteMax !== '0') hlc.receive(remoteMax);
      return;
    }
  }

  let merged;
  if (!local) {
    merged = structuredClone(remote);
  } else {
    merged = applyPatch(local, {
      props: remote.props,
      fieldHlcs: remote.fieldHlcs,
      parentId: remote.parentId,
      order: remote.order,
      deletedAt: remote.deletedAt,
    });
    merged.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
  }
  cache.set(merged.id, merged);
  const remoteMax = Object.values(remote.fieldHlcs || {}).reduce((a, b) => (a > b ? a : b), '0');
  if (remoteMax && remoteMax !== '0') hlc.receive(remoteMax);
  await tx([STORES.BLOCKS], 'readwrite', (s, rq) => rq(s[STORES.BLOCKS].put(structuredClone(merged))));
  emit();
}

/* ================================================================== *
 * Export / import / wipe
 * ================================================================== */

export function exportJSON() {
  return {
    app: 'flow',
    format: 1,
    exportedAt: new Date().toISOString(),
    deviceId,
    settings: structuredClone(settings),
    blocks: allBlocks(true).map((b) => structuredClone(b)),
  };
}

export async function importJSON(data) {
  if (!data || data.app !== 'flow' || !Array.isArray(data.blocks)) {
    throw new Error('Not a Flow backup file');
  }
  // Replace local content wholesale, then enqueue create ops so the server
  // converges via LWW (restores win where their field HLCs are newer).
  cache.clear();
  outbox.clear();
  await tx([STORES.BLOCKS, STORES.OUTBOX], 'readwrite', (s, rq) => {
    rq(s[STORES.BLOCKS].clear());
    rq(s[STORES.OUTBOX].clear());
  });
  const blocks = data.blocks.map((b) => ({ ...b, props: { ...(getType(b.type)?.defaults() || {}), ...b.props } }));
  createMany(blocks);
  if (data.settings) setSettings(data.settings);
  await metaSet('sync:cursor', '0');
  emit();
}

export function exportCSV() {
  const rows = [['id', 'title', 'project', 'area', 'labels', 'priority', 'start_date', 'due_date', 'due_time', 'reminder', 'scheduled_date', 'scheduled_start', 'duration_min', 'recurrence', 'someday', 'completed_at', 'focus_minutes', 'created_at', 'notes']];
  const labelName = (id) => get(id)?.props.name || '';
  for (const t of allOfType('task')) {
    const p = projectOf(t);
    rows.push([
      t.id, t.props.title, p ? p.props.name : '', p && areaOfProject(p) ? areaOfProject(p).props.name : '',
      (t.props.labels || []).map(labelName).join('; '),
      t.props.priority || 4, t.props.startDate || '', t.props.dueDate || '',
      t.props.dueTime || '', t.props.reminder || '',
      t.props.schedule?.date || '', t.props.schedule?.start != null ? U.timeStr(t.props.schedule.start) : '',
      t.props.schedule?.dur || '', t.props.recurrence ? describeRule(t.props.recurrence) : '',
      t.props.someday ? 'yes' : '',
      t.props.completedAt ? new Date(t.props.completedAt).toISOString() : '',
      t.props.focusMinutes || 0, new Date(t.createdAt).toISOString(), t.props.notes || '',
    ]);
  }
  return U.toCSV(rows);
}

/** Human label for a recurrence rule (shared by parser chips and detail view). */
export function describeRule(rule) {
  if (!rule?.freq) return '';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ord = (n) => `${n}${['th', 'st', 'nd', 'rd'][((n % 100) > 10 && (n % 100) < 14) ? 0 : n % 10] || 'th'}`;
  const every = rule.interval > 1 ? `every ${rule.interval} ` : 'every ';
  switch (rule.freq) {
    case 'day':
      if (rule.fromCompletion) return `after ${rule.interval > 1 ? rule.interval + ' days' : 'a day'} from completion`;
      return rule.interval > 1 ? `every ${rule.interval} days` : 'every day';
    case 'week': {
      if (rule.byDay?.length) {
        const names = [...rule.byDay].sort().map((d) => days[d]);
        let s = names.length === 5 && [1, 2, 3, 4, 5].every((d) => rule.byDay.includes(d)) ? 'every weekday'
          : every.replace('every ', 'every ') + (names.length === 1 ? names[0].toLowerCase() : names.join(', ').toLowerCase());
        if (rule.interval > 1) s = `every ${rule.interval} weeks on ${names.join(', ').toLowerCase()}`;
        return s;
      }
      return rule.interval > 1 ? `every ${rule.interval} weeks` : 'every week';
    }
    case 'month':
      if (rule.nth) return `every ${ord(rule.nth.n)} ${days[rule.nth.d].toLowerCase()}`;
      if (rule.byMonthDay) return `every month on the ${ord(rule.byMonthDay)}`;
      return rule.interval > 1 ? `every ${rule.interval} months` : 'every month';
    case 'year':
      return rule.interval > 1 ? `every ${rule.interval} years` : 'every year';
    default:
      return '';
  }
}

export async function wipeAll() {
  cache.clear();
  outbox.clear();
  await tx([STORES.BLOCKS, STORES.OUTBOX, STORES.META, STORES.SERVER], 'readwrite', (s, rq) =>
    Promise.all(Object.values(STORES).map((name) => rq(s[name].clear())))
  );
  localStorage.removeItem('flow-theme');
  localStorage.removeItem('flow-accent');
  emit();
}

/* ================================================================== *
 * Storage persistence (avoid the browser evicting offline data)
 * ================================================================== */

export async function storageStatus() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return {
    persisted,
    usage: est ? est.usage : null,
    quota: est ? est.quota : null,
    supported: !!navigator.storage?.persist,
  };
}

export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

/* ================================================================== *
 * Seed data + stress generator
 * ================================================================== */

export async function seedSample() {
  const existing = await metaGet(SEED_KEY, null);
  if (existing) return;
  const personal = create({ type: 'area', props: { name: 'Personal' } });
  const work = create({ type: 'area', props: { name: 'Work' } });
  const home = create({ type: 'project', props: { name: 'Home' }, parentId: personal.id });
  const website = create({ type: 'project', props: { name: 'Website' }, parentId: work.id });
  const email = create({ type: 'label', props: { name: 'email' } });
  const errand = create({ type: 'label', props: { name: 'errand' } });
  const deep = create({ type: 'label', props: { name: 'deep-work' } });
  const smart = create({ type: 'smartList', props: { name: 'P1 this week', filter: { priority: 1, due: 'week' } } });

  const today = U.todayStr();
  const tomorrow = U.addDays(today, 1);
  const seed = [];

  const mk = (props, extra = {}) => seed.push({ type: 'task', props: { ...TASK_PROPS(), ...props }, ...extra });

  mk({ title: 'Welcome to Flow — tap + and try quick add', notes: 'Try typing:\n\n- `Call mom sun 5pm p2`\n- `Email Dana tomorrow 9am #Website @email p1`\n- `Water plants every 3 days`\n\nSee the full cheat sheet in **Settings → About** or the README.', schedule: { date: today, start: null, dur: 30 } });
  mk({ title: 'Team standup', schedule: { date: today, start: 9 * 60 + 30, dur: 15 }, recurrence: { freq: 'week', interval: 1, byDay: [1, 2, 3, 4, 5], anchor: today } });
  mk({ title: 'Deep work: draft landing page', schedule: { date: today, start: 14 * 60, dur: 90 }, projectId: website.id, labels: [deep.id], priority: 2, notes: 'Turn off notifications. **Goal**: first draft of the hero section.' });
  mk({ title: 'Read 20 pages', recurrence: { freq: 'week', interval: 1, byDay: [1, 2, 3, 4, 5], anchor: today }, schedule: { date: today, start: null, dur: 30 } });
  mk({ title: 'Email Dana the Q4 report', projectId: website.id, labels: [email.id], priority: 1, dueDate: tomorrow, schedule: { date: tomorrow, start: 9 * 60, dur: 30 }, reminder: '09:00' });
  mk({ title: 'Water the plants', recurrence: { freq: 'day', interval: 3, anchor: today }, schedule: { date: U.addDays(today, 3), start: null, dur: 15 } });
  mk({ title: 'Renew passport', priority: 2, dueDate: U.addDays(today, 21), schedule: { date: U.addDays(today, 21), start: null, dur: 60 } });
  mk({ title: 'Plan weekend hike', projectId: home.id, someday: true });
  mk({ title: 'Buy groceries', projectId: home.id, labels: [errand.id] });
  const trip = create({ type: 'task', props: { ...TASK_PROPS(), title: 'Book trip to Lisbon', projectId: home.id, dueDate: U.addDays(today, 14) } });
  seed.push({ type: 'task', props: { ...TASK_PROPS(), title: 'Compare flights' }, parentId: trip.id });
  seed.push({ type: 'task', props: { ...TASK_PROPS(), title: 'Check passport validity' }, parentId: trip.id });
  mk({ title: 'Set up Flow on your phone', notes: 'Install the app from your browser menu → **Install app**. It works fully offline.', completedAt: Date.now() - 3600e3 });
  createMany(seed);

  const habitWater = create({ type: 'habit', props: { name: 'Drink water', cadence: 'daily' } });
  create({ type: 'habit', props: { name: 'Weekly review', cadence: 'weekly' } });
  toggleHabit(habitWater.id, U.addDays(today, -1));
  toggleHabit(habitWater.id, U.addDays(today, -2));

  await metaSet(SEED_KEY, true);
  emit();
}

export async function clearSampleData() {
  const seeded = await metaGet(SEED_KEY, null);
  if (!seeded) return 0;
  await metaSet(SEED_KEY, null);
  // Sample content is recognizable: areas named Personal/Work + their trees.
  const names = new Set(['Personal', 'Work']);
  const doomed = new Set();
  for (const b of cache.values()) {
    if ((b.type === 'area' || b.type === 'project') && names.has(b.props.name)) doomed.add(b.id);
    if (b.type === 'label' && ['email', 'errand', 'deep-work'].includes(b.props.name)) doomed.add(b.id);
    if (b.type === 'smartList' && b.props.name === 'P1 this week') doomed.add(b.id);
    if (b.type === 'habit' && ['Drink water', 'Weekly review'].includes(b.props.name)) doomed.add(b.id);
    if (b.type === 'task' && b.props.projectId && doomed.has(b.props.projectId)) doomed.add(b.id);
    if (b.type === 'task' && b.parentId && doomed.has(b.parentId)) doomed.add(b.id);
    if (b.type === 'task' && !b.parentId && !b.props.projectId && !b.deletedAt) doomed.add(b.id); // seeded inbox/welcome tasks
  }
  for (const id of doomed) softDelete(id);
  emit();
  return doomed.size;
}

/** Stress helper for the dev panel (1,000+ tasks). */
export function generateStressTasks(n = 1000) {
  const items = [];
  const titles = ['Write', 'Review', 'Email', 'Call', 'Plan', 'Fix', 'Read', 'Ship', 'Draft', 'Research'];
  const today = U.todayStr();
  for (let i = 0; i < n; i++) {
    const day = U.addDays(today, (i * 7) % 90 - 10);
    items.push({
      type: 'task',
      props: {
        ...TASK_PROPS(),
        title: `${titles[i % titles.length]} item #${i + 1}`,
        schedule: i % 3 === 0 ? { date: day, start: null, dur: 30 } : null,
        dueDate: i % 5 === 0 ? day : null,
        priority: (i % 4) + 1,
        notes: i % 10 === 0 ? `Generated stress task ${i + 1} — safe to delete from Settings → Developer.` : '',
      },
    });
  }
  createMany(items);
  return n;
}
