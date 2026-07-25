// In-memory mirror of the `kits` store, plus the vocabulary and the derived
// values the views need. Everything is small enough (hundreds of records) that
// filtering and aggregating in JS is instant — no need to push work into IDB.

import * as db from './db.js';

// The stored values stay 'owned'/'wanted' — they are internal identifiers that
// already exist in saved records and exported backups. Only the labels shown to
// the reader changed. Renaming the values would mean migrating every record and
// every backup file for no user-visible gain.
export const STATUSES = [
  { value: 'owned',  label: 'Collected' },
  { value: 'wanted', label: 'Wishlist' },
];

export const CABINS = [
  { value: 'economy',  label: 'Economy' },
  { value: 'premium',  label: 'Premium Economy' },
  { value: 'business', label: 'Business' },
  { value: 'first',    label: 'First' },
];

export const ROUTE_TYPES = [
  { value: 'regional', label: 'Regional' },
  { value: 'longhaul', label: 'Long-haul' },
];

export const STATES = [
  { value: 'sealed', label: 'Sealed' },
  { value: 'opened', label: 'Opened' },
  { value: 'empty',  label: 'Empty' },
];

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const labelFrom = (list, value) => list.find((x) => x.value === value)?.label ?? '—';
export const statusLabel = (v) => labelFrom(STATUSES, v);
export const cabinLabel = (v) => labelFrom(CABINS, v);
export const routeLabel = (v) => labelFrom(ROUTE_TYPES, v);

export function dateLabel(kit) {
  const month = kit.month ? MONTHS[kit.month - 1] : null;
  // Year is optional — plenty of kits arrive with no date on them at all.
  if (!kit.year) return month || '—';
  return month ? `${month} ${kit.year}` : String(kit.year);
}

/* ── Duplicates ───────────────────────────────────────────────── */
//
// A kit you own several copies of is one record holding a count per state —
// { sealed: 2, opened: 1, empty: 0 }. Quantity is their sum rather than its own
// field, so the total can never disagree with the breakdown.
//
// Records written before duplicates existed carry a single `state` string
// instead. countsOf() reads both shapes, so old records and old backup files
// keep working; they pick up the new shape the next time they're saved.

export const EMPTY_COUNTS = { sealed: 0, opened: 0, empty: 0 };

export function countsOf(kit) {
  if (kit.counts) return { ...EMPTY_COUNTS, ...kit.counts };
  const state = STATES.some((s) => s.value === kit.state) ? kit.state : 'sealed';
  return { ...EMPTY_COUNTS, [state]: 1 };
}

/** How many physical copies this record represents. Wishlist entries are one. */
export function quantityOf(kit) {
  if (kit.status === 'wanted') return 1;
  const c = countsOf(kit);
  return STATES.reduce((sum, s) => sum + (c[s.value] || 0), 0);
}

/** "2 sealed · 1 opened" — omits states with no copies. */
export function stateSummary(kit) {
  const c = countsOf(kit);
  const parts = STATES
    .filter((s) => c[s.value] > 0)
    .map((s) => `${c[s.value]} ${s.label.toLowerCase()}`);
  return parts.join(' · ') || '—';
}

/** Short form for the card badge: "Sealed", or "×3" once there's more than one. */
export function quantityBadge(kit) {
  const qty = quantityOf(kit);
  if (qty > 1) return `×${qty}`;
  const c = countsOf(kit);
  const only = STATES.find((s) => c[s.value] > 0);
  return only ? only.label : '—';
}

/* ── Cache ────────────────────────────────────────────────────── */

let kits = [];
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(kits);
}

export async function load() {
  kits = await db.allKits();
  emit();
  return kits;
}

export function getAll() {
  return kits;
}

export function byId(id) {
  return kits.find((k) => k.id === id);
}

/* ── Mutations ────────────────────────────────────────────────── */

// Mutations write locally first and queue the change for Supabase, so a save
// never depends on the network. sync.js drains the queue; app.js schedules it.
//
// The signal is an event rather than a direct call because sync.js imports this
// module — importing it back would be circular. It is also narrower than
// subscribe(): only real local edits fire it, so a sync that pulls changes and
// refreshes the cache doesn't immediately trigger another sync.
const markDirty = () => window.dispatchEvent(new CustomEvent('kits:dirty'));

export async function save(kit) {
  const now = new Date().toISOString();
  const record = {
    ...kit,
    id: kit.id || crypto.randomUUID(),
    createdAt: kit.createdAt || now,
    updatedAt: now,
  };
  await db.putKit(record);
  await db.queueOp(record.id, 'upsert');
  markDirty();
  const i = kits.findIndex((k) => k.id === record.id);
  if (i >= 0) kits[i] = record; else kits.push(record);
  emit();
  return record;
}

export async function remove(id) {
  await db.deleteKit(id);
  await db.queueOp(id, 'delete');
  markDirty();
  kits = kits.filter((k) => k.id !== id);
  emit();
}

/* ── Filtering ────────────────────────────────────────────────── */

/**
 * @param {{status?: string, q?: string, cabin?: string, routeType?: string,
 *          state?: string, decade?: string}} f
 */
export function filter(f = {}) {
  const q = (f.q || '').trim().toLowerCase();
  return kits
    .filter((k) => {
      if (f.status && k.status !== f.status) return false;
      if (f.cabin && k.cabin !== f.cabin) return false;
      if (f.routeType && k.routeType !== f.routeType) return false;
      // A state filter matches if ANY copy is in that state — a record with
      // 2 sealed and 1 opened belongs under both.
      if (f.state && !(countsOf(k)[f.state] > 0)) return false;
      if (f.decade) {
        const d = Math.floor((k.year || 0) / 10) * 10;
        if (String(d) !== f.decade) return false;
      }
      if (q) {
        const hay = [k.airline, k.designer, k.series, k.variant, k.notes]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort(sortNewestFirst);
}

export function sortNewestFirst(a, b) {
  if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
  if ((b.month || 0) !== (a.month || 0)) return (b.month || 0) - (a.month || 0);
  return (a.airline || '').localeCompare(b.airline || '');
}

/** Distinct non-empty values of a field, sorted — feeds the suggestion lists. */
export function vocabulary(field) {
  const set = new Set();
  for (const k of kits) {
    const v = (k[field] || '').trim();
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Decades present in the collection, newest first. */
export function decades() {
  const set = new Set();
  for (const k of kits) if (k.year) set.add(Math.floor(k.year / 10) * 10);
  return [...set].sort((a, b) => b - a);
}

/* ── Series ───────────────────────────────────────────────────── */

/** All kits sharing a series name (case-insensitive), owned and wanted. */
export function seriesMembers(seriesName) {
  const key = (seriesName || '').trim().toLowerCase();
  if (!key) return [];
  return kits
    .filter((k) => (k.series || '').trim().toLowerCase() === key)
    .sort((a, b) => (a.variant || '').localeCompare(b.variant || '') || sortNewestFirst(a, b));
}

/* ── Stats ────────────────────────────────────────────────────── */

// Breakdowns count physical copies, not records: three sealed Emirates kits are
// three kits on the Emirates bar. The record count is reported separately, as
// the "distinct kits" tile.

function tally(list, keyFn) {
  const counts = new Map();
  for (const k of list) {
    const key = keyFn(k);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + quantityOf(k));
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Counts in a fixed vocabulary order, keeping zero-count buckets out. */
function tallyOrdered(list, field, vocab) {
  const counts = new Map();
  for (const k of list) counts.set(k[field], (counts.get(k[field]) || 0) + quantityOf(k));
  return vocab
    .filter((v) => counts.get(v.value))
    .map((v) => ({ label: v.label, value: counts.get(v.value) }));
}

/** Copies per state, summed across every record. */
function tallyStates(list) {
  const totals = new Map();
  for (const k of list) {
    const c = countsOf(k);
    for (const s of STATES) {
      if (c[s.value] > 0) totals.set(s.value, (totals.get(s.value) || 0) + c[s.value]);
    }
  }
  return STATES
    .filter((s) => totals.get(s.value))
    .map((s) => ({ label: s.label, value: totals.get(s.value) }));
}

/**
 * Stats are computed over owned kits only — a wishlist entry isn't part of the
 * collection's composition. Wanted kits get their own headline number.
 */
export function stats() {
  const owned = kits.filter((k) => k.status === 'owned');
  const wanted = kits.filter((k) => k.status === 'wanted');

  const years = owned.map((k) => k.year).filter(Boolean);

  return {
    owned,
    wanted,
    totals: {
      owned: owned.length,
      // Total physical copies, which exceeds `owned` once anything is duplicated.
      items: owned.reduce((sum, k) => sum + quantityOf(k), 0),
      duplicated: owned.filter((k) => quantityOf(k) > 1).length,
      wanted: wanted.length,
      airlines: new Set(owned.map((k) => (k.airline || '').trim().toLowerCase()).filter(Boolean)).size,
      designers: new Set(owned.map((k) => (k.designer || '').trim().toLowerCase()).filter(Boolean)).size,
      series: new Set(owned.map((k) => (k.series || '').trim().toLowerCase()).filter(Boolean)).size,
      oldest: years.length ? Math.min(...years) : null,
      newest: years.length ? Math.max(...years) : null,
    },
    byAirline: tally(owned, (k) => (k.airline || '').trim()),
    byDesigner: tally(owned, (k) => (k.designer || '').trim()),
    byCabin: tallyOrdered(owned, 'cabin', CABINS),
    byRoute: tallyOrdered(owned, 'routeType', ROUTE_TYPES),
    byState: tallyStates(owned),
  };
}

/**
 * Collapses a long tail into a single "Other" bucket so a bar chart stays
 * readable. Returns {rows, hiddenCount} — views surface hiddenCount rather
 * than silently truncating.
 */
export function topN(rows, n) {
  if (rows.length <= n) return { rows, hiddenCount: 0, otherTotal: 0 };
  const head = rows.slice(0, n);
  const tail = rows.slice(n);
  const otherTotal = tail.reduce((s, r) => s + r.value, 0);
  return {
    rows: [...head, { label: `Other (${tail.length})`, value: otherTotal, isOther: true }],
    hiddenCount: tail.length,
    otherTotal,
  };
}
