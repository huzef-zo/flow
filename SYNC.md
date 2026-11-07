# Flow sync protocol

Flow is local-first: IndexedDB is the source of truth and the UI never waits
on a network. Sync is an **add-on** that any backend can implement. Today a
`MockAdapter` (a second IndexedDB store pretending to be a shared server)
implements the contract so you can test multi-device behaviour — including
conflicts and offline/online flapping — in a single browser via
**Settings → Developer**.

## 1. Operation record (the outbox)

Every mutation is written to the `outbox` store **in the same IndexedDB
transaction as the block write**, before the UI confirms it:

```jsonc
{
  "id": "0193…uuid",          // opId — unique, makes retries idempotent
  "entityId": "0193…uuid",    // block id
  "type": "create | update | delete",
  "payload": {
    "block": { … },           // create: full block
    "patch": {                // update: changed fields + their HLCs
      "props": { "title": "New title" },
      "fieldHlcs": { "title": "0001730…​.000042.dev-a1b2" },
      "parentId": null, "order": "a0V", "deletedAt": null
    },
    "base": { … },            // update: client snapshot (server can
  },                          //   materialize a block it never saw)
  "timestamp": 1730000000000, // client wall clock, informational
  "deviceId": "dev-a1b2",
  "status": "pending",        // pending | sending | synced
  "tries": 0,                 // retry counter for backoff
  "hlc": "…"                  // HLC of the op itself (deletes use this)
}
```

## 2. Adapter contract

```js
const adapter = {
  // At-least-once delivery; the server MUST dedupe by opId.
  // Returns the ids it acknowledged.
  async push(ops) { return { acked: opIds } },

  // Blocks whose max field-HLC is > sinceCursor. cursors are opaque,
  // monotonically increasing strings the server issues.
  async pull(sinceCursor) { return { blocks: [...], cursor: "…" } },
};
```

The engine (`js/sync.js`) calls `push` in batches of 50, marks acked ops
`synced`, then `pull`s and merges. On failure it retries with exponential
backoff + jitter: `min(30s, 800ms · 2^tries) + random(0..400ms)`. A safety
flush runs every 30s and whenever the tab becomes visible or the network
returns.

## 3. Hybrid Logical Clock (HLC)

Every field write stamps an HLC string:
`<physical 15 digits>.<logical 6 digits>.<node id>`.

- Physical time gives intuitive ordering; a logical counter fixes same-ms
  races; the node id breaks exact ties deterministically.
- `hlc.receive(remote)` absorbs remote timestamps so a device with a slow
  clock still produces causally-later stamps after seeing newer data
  (no clock-skew reordering).
- The clock persists across sessions (meta `lastHlc`), so restarts stay
  monotonic.

## 4. Conflict resolution: field-level LWW + tombstones

Merging a remote block/patch onto local (`applyPatch`):

1. For each field key (`title`, `schedule`, … plus envelope keys
   `__deleted`, `__order`, `__parent`), compare the field's HLC on both
   sides.
2. The greater HLC wins; equal HLCs are no-ops (this makes replaying the
   same op idempotent).
3. `deletedAt` is just a field: a delete that happened after an edit wins
   because its HLC is greater. Only an explicit restore (a later-HLC update
   setting `__deleted = null`) resurrects a block. Deletes are therefore
   predictable under skew.

Scalar fields (title, dates, priority…) are ideal for LWW. **Where a CRDT
would be better**: rich-text `notes` edited concurrently on two devices will
clobber each other. The seam is `applyPatch()` in `js/sync.js` — swap the
`notes` field for a Yjs/Automerge document (stored as a binary field, merged
by its own CRDT rules) and keep LWW for the scalar envelope. Nothing else in
the protocol changes.

## 5. Sharding & multi-workspace

Every block carries `workspaceId` (`ws:default` today). A real backend
should shard by workspace: `blocks` keyed `(workspaceId, updatedAt-seq)`,
one cursor per `(deviceId, workspaceId)`. Pull queries stay scoped to the
workspace, so the protocol is multi-tenant-ready without any client changes.

## 6. Testing multi-device today (one browser)

Settings → Developer:

- **Force offline** — the engine stops pushing; the header chip shows
  `offline`; queue ops and watch pending counts grow.
- **Latency slider** — simulates a slow server; watch backoff on errors.
- **Device B** — injects ops as a phantom second device (`device-b`):
  create tasks, edit with a *future* clock (B wins), or inject a conflict
  where the local edit has the newer HLC (local wins).
- **Op log** — the live outbox (status, tries, timestamps).
- **Generate 1,000 tasks** — stress the windowed lists + batched writes.
- **Reset mock server** — wipe the phantom server state.

Both "devices" run the *same* merge code the server would run, so what you
observe is exactly what a correct backend will do.

## 7. Plugging in a real backend (sketch)

Supabase example — one table and two RPCs:

```sql
create table blocks (
  workspace_id text not null,
  id text not null,
  type text not null,
  parent_id text,
  order_key text,
  props jsonb not null,
  field_hlcs jsonb not null,
  deleted_at timestamptz,
  max_hlc text not null,
  seq bigint generated always as identity,
  primary key (workspace_id, id)
);

create table ops (
  op_id text primary key,          -- idempotency
  device_id text, entity_id text, type text,
  payload jsonb, hlc text, received_at timestamptz default now()
);
```

- `push(ops)`: insert into `ops` (on conflict do nothing — dedupe), then
  upsert each entity with the same field-level HLC compare Flow already
  uses (a Postgres function or edge function works; it can literally reuse
  the `applyPatch` semantics).
- `pull(cursor)`: `select … where workspace_id = $1 and seq > $2` —
  prefer the server's monotonic `seq` over raw HLC strings for the cursor.
- The client adapter is ~40 lines of `fetch`; the engine, outbox, UI and
  conflict handling need zero changes.
