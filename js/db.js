/**
 * db.js — tiny promise wrapper around IndexedDB.
 *
 * The app uses four object stores:
 *   blocks  — every entity ("block"): tasks, projects, areas, labels, habits,
 *             habit logs, timer logs, calendar events, smart lists. keyPath: id
 *   outbox  — durable sync queue. Every mutation is appended here in the SAME
 *             transaction as the block write, before the UI confirms.
 *             keyPath: id (opId)
 *   meta    — small key/value records (settings, device id, sync cursor…).
 *             keyPath: key
 *   server  — MockAdapter state: a pretend multi-device server living in a
 *             second store so sync/conflicts can be tested in one browser.
 *             keyPath: id
 *
 * Migrations: DB_MIGRATIONS maps oldVersion → upgrade function. Bump DB_VERSION
 * and add an entry; never mutate existing stores in a way that breaks data
 * written by older versions.
 */

const DB_NAME = 'flow-db';
export const DB_VERSION = 3;

export const STORES = {
  BLOCKS: 'blocks',
  OUTBOX: 'outbox',
  META: 'meta',
  SERVER: 'server',
};

/** Historical: v1 shipped {blocks, outbox, meta}; v2 added `server` for the
 *  MockAdapter; v3 added the `byType`/`byParent` indexes on blocks. */
const DB_MIGRATIONS = {
  1(db) {
    db.createObjectStore(STORES.BLOCKS, { keyPath: 'id' });
    db.createObjectStore(STORES.OUTBOX, { keyPath: 'id' });
    db.createObjectStore(STORES.META, { keyPath: 'key' });
  },
  2(db) {
    db.createObjectStore(STORES.SERVER, { keyPath: 'id' });
  },
  3(db, _e, t) {
    if (!db.objectStoreNames.contains(STORES.BLOCKS)) db.createObjectStore(STORES.BLOCKS, { keyPath: 'id' });
    const blocks = t.objectStore(STORES.BLOCKS);
    if (!blocks.indexNames.contains('byType')) blocks.createIndex('byType', 'type');
    if (!blocks.indexNames.contains('byParent')) blocks.createIndex('byParent', 'parentId');
  },
};

let dbPromise = null;

/** Open (and migrate) the database. Idempotent. */
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // `t` is the version-upgrade transaction — the only valid way to touch
      // stores while the version is changing.
      const t = e.target.transaction;
      for (let v = e.oldVersion; v < e.newVersion; v++) {
        DB_MIGRATIONS[v + 1]?.(db, e, t);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close(); // another tab is upgrading
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  return dbPromise;
}

/** Wrap an IDBRequest in a promise. */
export function rq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run fn inside a transaction over the named stores. fn receives a map of
 * store name → IDBObjectStore plus the rq helper. The returned promise
 * resolves only when the transaction has COMMITTED (durability), after fn's
 * own request-promises settle.
 */
export async function tx(storeNames, mode, fn) {
  const db = await openDB();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = {};
    for (const n of names) stores[n] = t.objectStore(n);
    let result;
    Promise.resolve(fn(stores, rq))
      .then((r) => { result = r; })
      .catch((err) => { try { t.abort(); } catch { /* already failing */ } reject(err); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

/* -- convenience one-shots (single-store, single-record) -- */

export async function dbGet(store, key) {
  const db = await openDB();
  return rq(db.transaction(store).objectStore(store).get(key));
}
export async function dbGetAll(store) {
  const db = await openDB();
  return rq(db.transaction(store).objectStore(store).getAll());
}
export async function dbPut(store, value) {
  return tx(store, 'readwrite', (s, rq2) => rq2(s[store].put(value)));
}
export async function dbDelete(store, key) {
  return tx(store, 'readwrite', (s, rq2) => rq2(s[store].delete(key)));
}
export async function dbClear(store) {
  return tx(store, 'readwrite', (s, rq2) => rq2(s[store].clear()));
}

/** Key/value helpers for the meta store. */
export async function metaGet(key, fallback = null) {
  const rec = await dbGet(STORES.META, key);
  return rec ? rec.value : fallback;
}
export async function metaSet(key, value) {
  return dbPut(STORES.META, { key, value });
}
