// Scheduled keep-alive. Supabase pauses a free project after ~7 days with no
// database activity; this writes a timestamp every couple of days so it doesn't.
//
// The schedule lives in netlify.toml. Unlike the GitHub Actions equivalent, this
// needs no second heartbeat: Netlify does not disable a scheduled function for
// repository inactivity, so there is no 60-day clock to hold off and nothing has
// to commit to the repo to keep itself alive.
//
// kit_heartbeat() is a security-definer function that can only move one
// timestamp forward, so the publishable key is enough — no service-role secret.

const FALLBACK_URL = 'https://fkmwdbkjxzmbotbpqynw.supabase.co';
const FALLBACK_KEY = 'sb_publishable_4lXW5yf0vI8-PXL7htRnZw_r1T6hgnG';

export default async () => {
  const url = process.env.SUPABASE_URL || FALLBACK_URL;
  const key = process.env.SUPABASE_KEY || FALLBACK_KEY;

  let res;
  try {
    res = await fetch(`${url}/rest/v1/rpc/kit_heartbeat`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // Fail loudly in the function log. A silently broken keep-alive is worse
    // than none, because it looks fine right up until the project pauses.
    console.error('Heartbeat could not reach Supabase:', err.message);
    return new Response(`unreachable: ${err.message}`, { status: 502 });
  }

  const body = await res.text();
  if (!res.ok) {
    console.error(`Heartbeat failed with HTTP ${res.status}: ${body}`);
    return new Response(`failed: ${res.status} ${body}`, { status: 502 });
  }

  console.log(`Heartbeat ok — database timestamp now ${body}`);
  return new Response(body, { status: 200 });
};
