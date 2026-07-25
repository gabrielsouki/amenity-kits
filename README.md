# Amenity Kits

A catalogue for an airline amenity kit collection — what you have, and what
you're still hunting for.

It's a web app with no build step and no dependencies. The collection lives in
your browser's storage and is mirrored to a Supabase database, so the same
collection appears on every device you sign in from. Added to an iPhone home
screen it behaves like a normal app: own icon, full screen, works with no
signal — reads and writes go to local storage first, and reach the server
whenever there's a connection.

## Running it

You need a local web server — opening `index.html` straight from Finder won't
work, because browsers block JavaScript modules and service workers on `file://`.
macOS already has Python, so from this folder:

```sh
cd "Amenity Kits"
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Putting it on your iPhone

The phone needs to reach the server, so both devices must be on the same Wi-Fi.

1. Find your Mac's IP: **System Settings → Wi-Fi → Details → IP Address**
   (something like `192.168.1.42`).
2. Start the server as above, but let it listen on the network:
   `python3 -m http.server 8000 --bind 0.0.0.0`
3. On the iPhone, open Safari and go to `http://192.168.1.42:8000`.
4. Tap **Share → Add to Home Screen**.

Once it's on the home screen the app shell is cached, so it opens and runs
without the Mac being on. You only need the server again to load a new version.

One caveat: iOS treats a plain `http://` origin as insecure, and Safari is
stricter about storage there. If you plan to use this seriously, putting the
folder on any HTTPS host (GitHub Pages, Netlify — it's all static files) makes
the install more durable. Nothing in the app needs to change.

## Recording a kit

Each entry holds:

- a photo (or several) — take one with the camera or pick from the library
- **Status** — Collected, or Wishlist
- **Airline**, **month + year**, **route type** (regional / long-haul), **cabin**
  — only the airline is required. Month and year can both be left as *Unknown*,
  which is the normal case for an unmarked kit with no packaging left. Undated
  kits sort last and sit outside the decade filter, but count everywhere else.
- **How many, and in what state** — a count of sealed / opened / empty copies
  (hidden on wishlist entries)
- **Designer**, **Series**, **Variant** — the collaboration house and where the
  kit sits in a set

Airline, Designer, and Series are search fields: tap one and a list drops down
of everything you've entered before, narrowing as you type. Matching is on any
part of the name, so "air" finds both *EVA Air* and *Qatar Airways*. Picking a
suggestion keeps spellings consistent; typing something new is always allowed,
which is what you do the first time you record an airline.

(These are hand-built rather than using the browser's `<datalist>`, because
Safari on iOS ignores `<datalist>` entirely — on a phone it would silently show
no suggestions at all.)

### Duplicates

If you have several copies of the same kit, keep them as **one entry** and set
the counts — say 2 sealed and 1 opened. Quantity isn't a separate field; it's
the sum of the three, so the total can never drift out of step with the
breakdown. Cards show a `×3` badge and the split beneath the date.

Stats then count **copies**, not entries: three Emirates kits put 3 on the
Emirates bar. Where that makes the two numbers differ, the Stats page shows both
— "6 kits collected" alongside "3 distinct kits" — and the collection header
reads "3 kits · 6 copies".

Filtering by a state matches any entry with at least one copy in it, so an entry
holding 2 sealed and 1 opened appears under both Sealed and Opened.

### Series

Give two or more kits the same **Series** name and each of their detail pages
grows a panel showing the whole set — "1 of 3 in this series" — with every
sibling listed as *Collected* or *Wishlist*. That's how the wishlist works: add
the kits you're missing as **Wishlist** entries with the same series name, and
the gap is visible from any member of the set.

## Photos

Photos are resized when you add them: max 1600px for the stored copy, plus a
400px thumbnail for the grid. Originals aren't kept. A typical 3 MB iPhone photo
ends up around 20 KB, which is what keeps a large collection inside the
browser's storage budget.

## Sync

The app is local-first. IndexedDB is what the screens read from, so it opens and
works with no signal; Supabase is a mirror that `js/sync.js` reconciles against
whenever there's a connection.

Signing in is required to load the collection on a new device. The session is
long-lived, so it's a one-time step per device.

- **Writes** go to IndexedDB, then queue in an `outbox` store. A save never
  waits on the network, and edits made offline upload when you're back.
- **Conflicts** resolve last-write-wins on `updatedAt`. For a one-person
  collection the loser is always your own older edit, so there's nothing to
  merge and nothing to ask about.
- **Deletes** are soft on the server (a `deleted_at` tombstone). A hard delete
  would let any device still holding the record push it straight back.
- Photos are immutable once written, so they upload once and are never re-sent.

The topbar shows a count when something hasn't reached the server yet. **Backup
→ Sync now** forces a round trip and reports what moved.

Access is locked to one email address by row-level security, checked in the
database rather than the client. The publishable key in `js/supabase.js` is
public on purpose — on its own it reads an empty collection and its writes are
rejected.

### Keeping the free tier awake

Two dormancy clocks run at once, and `.github/workflows/keepalive.yml` holds off
both:

| Clock | Trips after | Held off by |
| --- | --- | --- |
| Supabase pauses an idle free project | ~7 days | a cron ping every 2 days |
| GitHub disables idle scheduled workflows | 60 days | the same job committing a file when the last commit is 25+ days old |

The second one matters: without it the cron that prevents the first eventually
switches itself off. The ping calls `kit_heartbeat()`, a security-definer
function that can only move one timestamp forward — so no service-role secret
has to live in this repo.

This database is shared with the portfolio/roadmap project, so anything else
keeping that project warm covers the collection too. The cron is the guarantee,
not the only line of defence.

## Backups — still worth it

Sync means the collection survives a lost phone, which the old export-only setup
did not. A backup file covers what sync can't:

- An accidental delete syncs everywhere. The `.json` is the only copy that
  survives it.
- Losing access to the Supabase project, or the project being deleted.

Open **Backup** now and again and tap **Export backup file** — a single `.json`
holding every kit and every photo. Save it to Files, iCloud Drive, or email it
to yourself.

To restore, use **Merge from file** (adds the backup's kits to what's here) or
**Replace all** (wipes this device first). Merge is the safe default. Both push
to the server afterwards; **Replace all** also tombstones the kits it wiped, so
they don't come back on the next sync.

## Layout

```
index.html             app shell — one <section> per view
manifest.webmanifest   home-screen name, icons, colours
sw.js                  service worker; bump CACHE_VERSION on any change
css/app.css            all styling, light + dark, design tokens at the top
js/db.js               IndexedDB — kits, photos, and the sync outbox
js/images.js           photo downscaling, object-URL bookkeeping
js/store.js            in-memory cache, filtering, stats aggregation
js/charts.js           SVG bar + composition charts
js/combobox.js         the search/suggestion field
js/router.js           hash routing
js/supabase.js         auth + PostgREST over fetch; project URL and key
js/sync.js             reconciles IndexedDB against Supabase
js/views/*.js          one module per screen
js/app.js              boot, auth gate, sync triggers
.github/workflows/     the keep-alive cron
```

If you edit any file in `sw.js`'s `SHELL` list, bump `CACHE_VERSION` in `sw.js`
— otherwise the service worker keeps serving the old copy.

The chart colours in `css/app.css` (`--seq-1`…`--seq-4`, `--bar-fill`) were
checked against a colour-accessibility validator for both light and dark
surfaces. If you change them, re-validate rather than eyeballing.
