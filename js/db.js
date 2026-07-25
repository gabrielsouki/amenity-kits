// IndexedDB access layer. Three stores: `kits` (metadata), `photos` (Blobs),
// and `outbox` (pending sync operations).
// Photos are kept in their own store so listing kits never deserializes image
// bytes — only the thumbnails actually on screen are read.
//
// IndexedDB remains the source of truth the views read from, so the app still
// works with no signal. Supabase is a mirror the sync layer reconciles against;
// see sync.js.

const DB_NAME = 'amenitykits';
const DB_VERSION = 2;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kits')) {
        const kits = db.createObjectStore('kits', { keyPath: 'id' });
        kits.createIndex('status', 'status');
        kits.createIndex('airline', 'airline');
        kits.createIndex('year', 'year');
        kits.createIndex('series', 'series');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('kitId', 'kitId');
      }
      // One row per kit awaiting a push: { kitId, op: 'upsert' | 'delete' }.
      // Keyed by kitId so repeated edits to the same kit collapse into one
      // pending operation rather than queueing up.
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'kitId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
    // fn resolves its value into `result`; the transaction's own completion is
    // what we await, so writes are durable before the caller continues.
    Promise.resolve(fn(t)).then((v) => { result = v; }, (err) => { try { t.abort(); } catch {} reject(err); });
  }));
}

const asPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/* ── Kits ─────────────────────────────────────────────────────── */

export function allKits() {
  return tx('kits', 'readonly', (t) => asPromise(t.objectStore('kits').getAll()));
}

export function getKit(id) {
  return tx('kits', 'readonly', (t) => asPromise(t.objectStore('kits').get(id)));
}

export function putKit(kit) {
  return tx('kits', 'readwrite', (t) => asPromise(t.objectStore('kits').put(kit)).then(() => kit));
}

/** Deletes a kit and every photo belonging to it, in one transaction. */
export function deleteKit(id) {
  return tx(['kits', 'photos'], 'readwrite', async (t) => {
    await asPromise(t.objectStore('kits').delete(id));
    const idx = t.objectStore('photos').index('kitId');
    const keys = await asPromise(idx.getAllKeys(IDBKeyRange.only(id)));
    await Promise.all(keys.map((k) => asPromise(t.objectStore('photos').delete(k))));
  });
}

/* ── Photos ───────────────────────────────────────────────────── */

export function getPhoto(id) {
  return tx('photos', 'readonly', (t) => asPromise(t.objectStore('photos').get(id)));
}

export function getPhotos(ids) {
  if (!ids || !ids.length) return Promise.resolve([]);
  return tx('photos', 'readonly', (t) => {
    const store = t.objectStore('photos');
    return Promise.all(ids.map((id) => asPromise(store.get(id))));
  }).then((rows) => rows.filter(Boolean));
}

export function putPhotos(photos) {
  if (!photos.length) return Promise.resolve();
  return tx('photos', 'readwrite', (t) => {
    const store = t.objectStore('photos');
    return Promise.all(photos.map((p) => asPromise(store.put(p))));
  });
}

export function deletePhotos(ids) {
  if (!ids || !ids.length) return Promise.resolve();
  return tx('photos', 'readwrite', (t) => {
    const store = t.objectStore('photos');
    return Promise.all(ids.map((id) => asPromise(store.delete(id))));
  });
}

/** Every photo row, for export. */
export function allPhotos() {
  return tx('photos', 'readonly', (t) => asPromise(t.objectStore('photos').getAll()));
}

/** Just the ids — lets sync work out what it already has without reading bytes. */
export function allPhotoIds() {
  return tx('photos', 'readonly', (t) => asPromise(t.objectStore('photos').getAllKeys()));
}

/* ── Outbox ───────────────────────────────────────────────────── */

/** Records that `kitId` needs pushing. Overwrites any earlier pending op. */
export function queueOp(kitId, op) {
  return tx('outbox', 'readwrite', (t) =>
    asPromise(t.objectStore('outbox').put({ kitId, op, at: new Date().toISOString() })));
}

export function pendingOps() {
  return tx('outbox', 'readonly', (t) => asPromise(t.objectStore('outbox').getAll()));
}

export function clearOps(kitIds) {
  if (!kitIds.length) return Promise.resolve();
  return tx('outbox', 'readwrite', (t) => {
    const store = t.objectStore('outbox');
    return Promise.all(kitIds.map((id) => asPromise(store.delete(id))));
  });
}

/** Replaces the entire database contents. Used by import. */
export function replaceAll(kits, photos) {
  return tx(['kits', 'photos'], 'readwrite', async (t) => {
    await asPromise(t.objectStore('kits').clear());
    await asPromise(t.objectStore('photos').clear());
    for (const k of kits) await asPromise(t.objectStore('kits').put(k));
    for (const p of photos) await asPromise(t.objectStore('photos').put(p));
  });
}

/** Merges imported records in, overwriting any with a colliding id. */
export function mergeAll(kits, photos) {
  return tx(['kits', 'photos'], 'readwrite', async (t) => {
    for (const k of kits) await asPromise(t.objectStore('kits').put(k));
    for (const p of photos) await asPromise(t.objectStore('photos').put(p));
  });
}

/** Rough storage usage, for the backup nudge on the data screen. */
export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
