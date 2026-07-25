// Minimal Supabase client: the auth token endpoint plus PostgREST, over fetch.
//
// supabase-js is not used deliberately. The app has no build step, so it would
// have to come from a CDN as an ESM import — a third-party network dependency
// the service worker cannot precache, which would break the offline launch this
// app is built around. Only two endpoints are actually needed, so they are
// called directly.

export const SUPABASE_URL = 'https://fkmwdbkjxzmbotbpqynw.supabase.co';

// Publishable key. Shipping it in a public repo is expected and safe: on its own
// it grants nothing. Every kit row sits behind an RLS policy that checks the
// signed-in user's email, so an unauthenticated caller reads an empty list and
// its writes are rejected outright.
export const SUPABASE_KEY = 'sb_publishable_4lXW5yf0vI8-PXL7htRnZw_r1T6hgnG';

const SESSION_KEY = 'amenitykits.session';
const REFRESH_MARGIN_MS = 60_000;

/** @type {{access_token: string, refresh_token: string, expires_at: number, user: object}|null} */
let session = null;
const listeners = new Set();

/** Raised when the stored session is gone or unusable — the caller shows login. */
export class AuthError extends Error {}

/* ── Session ──────────────────────────────────────────────────── */

function persist(raw) {
  session = raw && {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    // Supabase returns expires_at (unix seconds) but only expires_in is
    // guaranteed, so derive it when missing.
    expires_at: raw.expires_at ?? Math.floor(Date.now() / 1000) + (raw.expires_in ?? 3600),
    user: raw.user,
  };
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Private-mode Safari can refuse writes. The session still works for this
    // tab; it just won't survive a reload.
  }
  for (const fn of listeners) fn(session?.user ?? null);
}

export function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    session = raw ? JSON.parse(raw) : null;
  } catch {
    session = null;
  }
  return session?.user ?? null;
}

export function currentUser() {
  return session?.user ?? null;
}

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ── Auth ─────────────────────────────────────────────────────── */

async function authFetch(grant, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthError(payload.error_description || payload.msg || payload.error || 'Sign in failed');
  }
  return payload;
}

export async function signIn(email, password) {
  persist(await authFetch('password', { email, password }));
  return session.user;
}

export function signOut() {
  persist(null);
}

/**
 * A valid access token, refreshing first if it is close to expiring.
 * @throws {AuthError} when there is no session, or the refresh token is spent.
 */
async function accessToken() {
  if (!session) throw new AuthError('Not signed in');
  if (session.expires_at * 1000 - Date.now() > REFRESH_MARGIN_MS) return session.access_token;

  try {
    persist(await authFetch('refresh_token', { refresh_token: session.refresh_token }));
  } catch (err) {
    // A rejected refresh token is unrecoverable — drop the session so the app
    // asks for a password instead of retrying forever. A network failure is
    // not: keep the session and let the caller treat it as "offline".
    if (err instanceof AuthError) persist(null);
    throw err;
  }
  return session.access_token;
}

/* ── PostgREST ────────────────────────────────────────────────── */

/**
 * @param {string} path   table name, e.g. 'kits'
 * @param {{method?: string, body?: any, params?: Record<string,string>,
 *          prefer?: string}} opts
 */
export async function rest(path, { method = 'GET', body, params, prefer } = {}) {
  const token = await accessToken();
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    persist(null);
    throw new AuthError('Session expired');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.message || `${method} ${path} failed (${res.status})`);
  }
  // 204, and any PostgREST write sent without Prefer: return=representation.
  if (res.status === 204 || !res.headers.get('content-type')?.includes('json')) return null;
  return res.json();
}

/** Upsert rows, overwriting any that collide on the primary key. */
export function upsert(path, rows) {
  if (!rows.length) return Promise.resolve(null);
  return rest(path, {
    method: 'POST',
    body: rows,
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}
