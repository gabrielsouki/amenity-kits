// Reconciles the local IndexedDB copy against Supabase.
//
// IndexedDB stays the source of truth the views render from — the app opens and
// works with no signal. This layer mirrors it to Postgres so a second device
// sees the same collection.
//
// Conflicts resolve last-write-wins on `updatedAt`. That is the right call for a
// single-person collection: the loser of a race is always an older edit by the
// same person, so there is nothing to merge and nothing to ask about.
//
// Deletes are soft remotely (`deleted_at`). A hard delete would let any device
// still holding the record push it straight back on its next sync.

import * as db from './db.js';
import * as store from './store.js';
import { rest, upsert, currentUser, AuthError } from './supabase.js';
import { blobToDataURL, dataURLToBlob } from './images.js';

// Keeps `id=in.(…)` URLs to a sane length.
const ID_CHUNK = 20;

const chunk = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

/* ── Row mapping ──────────────────────────────────────────────── */

function toRow(kit) {
  return {
    id: kit.id,
    status: kit.status || 'owned',
    airline: kit.airline || '',
    designer: kit.designer || '',
    series: kit.series || '',
    variant: kit.variant || '',
    notes: kit.notes || '',
    month: kit.month || null,
    year: kit.year || null,
    route_type: kit.routeType || null,
    cabin: kit.cabin || null,
    // Normalises records still carrying the pre-duplicates `state` string, so
    // the remote copy only ever holds the current shape.
    counts: store.countsOf(kit),
    photo_ids: kit.photoIds || [],
    created_at: kit.createdAt || new Date().toISOString(),
    updated_at: kit.updatedAt || new Date().toISOString(),
    deleted_at: null,
    synced_at: new Date().toISOString(),
  };
}

function fromRow(row) {
  return {
    id: row.id,
    status: row.status,
    airline: row.airline || '',
    designer: row.designer || '',
    series: row.series || '',
    variant: row.variant || '',
    notes: row.notes || '',
    month: row.month ?? null,
    year: row.year ?? null,
    routeType: row.route_type || 'regional',
    cabin: row.cabin || 'economy',
    counts: row.counts || { ...store.EMPTY_COUNTS },
    photoIds: row.photo_ids || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ── Photos ───────────────────────────────────────────────────── */

/** Downloads any photo referenced by `ids` that isn't already on this device. */
async function fetchMissingPhotos(ids) {
  if (!ids.length) return 0;
  const have = new Set(await db.allPhotoIds());
  const missing = ids.filter((id) => !have.has(id));
  if (!missing.length) return 0;

  let count = 0;
  for (const group of chunk(missing, ID_CHUNK)) {
    const rows = await rest('kit_photos', {
      params: { select: 'id,kit_id,blob,thumb_blob', id: `in.(${group.join(',')})` },
    });
    const photos = [];
    for (const r of rows || []) {
      photos.push({
        id: r.id,
        kitId: r.kit_id,
        blob: await dataURLToBlob(r.blob),
        thumbBlob: await dataURLToBlob(r.thumb_blob || r.blob),
      });
    }
    await db.putPhotos(photos);
    count += photos.length;
  }
  return count;
}

/** Uploads this kit's photos that aren't remote yet. Photos never change once
 *  written, so anything already there can be skipped. */
async function pushPhotosFor(kitId, photoIds) {
  if (!photoIds.length) return;
  const remote = await rest('kit_photos', {
    params: { select: 'id', kit_id: `eq.${kitId}` },
  });
  const have = new Set((remote || []).map((r) => r.id));
  const toSend = photoIds.filter((id) => !have.has(id));
  if (!toSend.length) return;

  const local = await db.getPhotos(toSend);
  // One at a time: a base64 display photo is a few hundred KB, and batching
  // them risks a request body big enough to be rejected.
  for (const p of local) {
    await upsert('kit_photos', [{
      id: p.id,
      kit_id: kitId,
      blob: await blobToDataURL(p.blob),
      thumb_blob: await blobToDataURL(p.thumbBlob || p.blob),
    }]);
  }
}

/* ── Push ─────────────────────────────────────────────────────── */

async function pushKit(kit) {
  await upsert('kits', [toRow(kit)]);
  await pushPhotosFor(kit.id, kit.photoIds || []);
}

async function pushDelete(id) {
  // Matches nothing when the kit was never pushed, which is the correct no-op.
  await rest('kits', {
    method: 'PATCH',
    params: { id: `eq.${id}` },
    body: { deleted_at: new Date().toISOString(), synced_at: new Date().toISOString() },
  });
}

/** Drains the outbox. Ops that fail stay queued for the next attempt. */
async function flushOutbox() {
  const ops = await db.pendingOps();
  if (!ops.length) return 0;

  const done = [];
  for (const op of ops) {
    try {
      if (op.op === 'delete') {
        await pushDelete(op.kitId);
      } else {
        const kit = await db.getKit(op.kitId);
        // Queued, then deleted before the flush — the delete op covers it.
        if (kit) await pushKit(kit);
      }
      done.push(op.kitId);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      // Leave it queued and keep going; a single bad row shouldn't block the rest.
    }
  }
  await db.clearOps(done);
  return done.length;
}

/* ── Pull ─────────────────────────────────────────────────────── */

async function pullRemote() {
  const rows = (await rest('kits', { params: { select: '*' } })) || [];
  const local = await db.allKits();
  const localById = new Map(local.map((k) => [k.id, k]));

  let pulled = 0;
  let removed = 0;
  const needPhotos = [];
  const toPush = [];

  for (const row of rows) {
    const mine = localById.get(row.id);

    if (row.deleted_at) {
      if (mine) { await db.deleteKit(row.id); removed++; }
      localById.delete(row.id);
      continue;
    }

    if (!mine || row.updated_at > mine.updatedAt) {
      const record = fromRow(row);
      await db.putKit(record);
      needPhotos.push(...record.photoIds);
      pulled++;
    } else if (mine.updatedAt > row.updated_at) {
      toPush.push(mine);
    }
    localById.delete(row.id);
  }

  // Anything still here exists only on this device — a first sync, or a kit
  // added while offline. Absence is not a deletion: a real delete leaves a
  // tombstone row, which is handled above.
  toPush.push(...localById.values());

  const photos = await fetchMissingPhotos([...new Set(needPhotos)]);

  let pushed = 0;
  for (const kit of toPush) {
    try {
      await pushKit(kit);
      pushed++;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      await db.queueOp(kit.id, 'upsert');
    }
  }

  return { pulled, pushed, removed, photos };
}

/* ── Public API ───────────────────────────────────────────────── */

let running = null;
let timer = null;

/**
 * Flushes pending writes, then reconciles both directions.
 * Concurrent callers share the in-flight run rather than racing.
 * @returns {Promise<{pulled: number, pushed: number, removed: number,
 *                    photos: number, skipped?: string}>}
 */
export function sync() {
  if (running) return running;
  if (!currentUser()) return Promise.resolve({ skipped: 'signed-out', pulled: 0, pushed: 0, removed: 0, photos: 0 });
  if (!navigator.onLine) return Promise.resolve({ skipped: 'offline', pulled: 0, pushed: 0, removed: 0, photos: 0 });

  running = (async () => {
    const flushed = await flushOutbox();
    const result = await pullRemote();
    result.pushed += flushed;
    if (result.pulled || result.removed) await store.load();
    return result;
  })().finally(() => { running = null; });

  return running;
}

/** Coalesces the bursts of saves a form submit produces into one sync. */
export function schedule(delay = 900) {
  clearTimeout(timer);
  timer = setTimeout(() => { sync().catch(() => {}); }, delay);
}

/** True when there are local edits Supabase hasn't accepted yet. */
export async function pendingCount() {
  return (await db.pendingOps()).length;
}
