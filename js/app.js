import * as store from './store.js';
import * as sync from './sync.js';
import { route, start, go } from './router.js';
import { restoreSession, signIn, currentUser, onAuthChange, AuthError } from './supabase.js';

import { view as collection } from './views/collection.js';
import { view as detail } from './views/detail.js';
import { view as form } from './views/form.js';
import { view as stats } from './views/stats.js';
import { view as data } from './views/data.js';

/* ── Toast ────────────────────────────────────────────────────── */

let toastTimer = null;

export function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ── Sync status ──────────────────────────────────────────────── */

const syncState = document.getElementById('syncState');

async function showSyncState(text) {
  if (text) {
    syncState.textContent = text;
    return;
  }
  // Idle: report anything still waiting to reach the server, and nothing at all
  // when everything is up to date — a permanent "Synced" badge is just noise.
  const pending = await sync.pendingCount();
  if (!navigator.onLine) syncState.textContent = pending ? `${pending} to sync` : 'Offline';
  else syncState.textContent = pending ? `${pending} to sync` : '';
}

/** Runs a sync and reflects it in the topbar. Never throws. */
export async function runSync({ quiet = true } = {}) {
  if (!currentUser()) return;
  await showSyncState('Syncing…');
  try {
    const result = await sync.sync();
    if (!quiet && !result.skipped) {
      const bits = [];
      if (result.pulled) bits.push(`${result.pulled} in`);
      if (result.pushed) bits.push(`${result.pushed} out`);
      if (result.removed) bits.push(`${result.removed} removed`);
      toast(bits.length ? `Synced — ${bits.join(', ')}` : 'Already up to date');
    }
  } catch (err) {
    if (err instanceof AuthError) {
      showGate(true);
      return;
    }
    // Offline or a server hiccup: the outbox keeps the edits, so this is not
    // an error the reader needs to act on.
    if (!quiet) toast(`Sync failed: ${err.message}`);
  }
  await showSyncState();
}

/* ── Auth gate ────────────────────────────────────────────────── */

const gate = document.getElementById('authGate');
const authForm = document.getElementById('authForm');
const authError = document.getElementById('authError');
const authBtn = document.getElementById('authBtn');

function showGate(show) {
  gate.hidden = !show;
  document.body.classList.toggle('is-locked', show);
  if (show) authForm.email.focus();
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.hidden = true;
  authBtn.disabled = true;
  authBtn.textContent = 'Signing in…';
  try {
    await signIn(authForm.email.value.trim(), authForm.password.value);
    authForm.password.value = '';
    showGate(false);
    await startApp();
    runSync({ quiet: false });
  } catch (err) {
    authError.textContent = err instanceof AuthError
      ? err.message
      : 'Could not reach the server. Check your connection.';
    authError.hidden = false;
  } finally {
    authBtn.disabled = false;
    authBtn.textContent = 'Sign in';
  }
});

onAuthChange((user) => { if (!user) showGate(true); });

/* ── Boot ─────────────────────────────────────────────────────── */

route('/collection', collection);
route('/kit/:id', detail);
route('/new', form);
route('/edit/:id', form);
route('/stats', stats);
route('/data', data);

document.getElementById('addBtn').addEventListener('click', () => go('/new'));

let appStarted = false;

/** Everything that should happen once, after there is a session. */
async function startApp() {
  if (appStarted) return;
  appStarted = true;

  try {
    await store.load();
  } catch (err) {
    toast(`Could not open the database: ${err.message}`);
  }
  start();

  if ('serviceWorker' in navigator) {
    // Registered after the first render so it never delays paint.
    navigator.serviceWorker.register('sw.js').catch(() => {
      // A failed registration only costs offline support; the app still works.
    });
  }

  // Ask the browser to keep this data out of eviction sweeps. Safari usually
  // declines without a prompt — which is why the collection is mirrored to
  // Supabase and the backup screen still exists.
  navigator.storage?.persist?.().catch(() => {});

  // A local edit queues an op; push it shortly after, once the burst settles.
  window.addEventListener('kits:dirty', () => {
    sync.schedule();
    showSyncState();
  });

  // Coming back online, or returning to the app on another device, are the two
  // moments the local copy is most likely to be stale.
  window.addEventListener('online', () => runSync());
  window.addEventListener('offline', () => showSyncState());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runSync();
  });
}

async function boot() {
  if (!restoreSession()) {
    showGate(true);
    return;
  }
  showGate(false);
  await startApp();
  // Offline with a stored session is fine: the app runs on the local copy and
  // syncs when the connection returns.
  runSync();
}

boot();
