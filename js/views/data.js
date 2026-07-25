import * as store from '../store.js';
import * as db from '../db.js';
import * as sync from '../sync.js';
import { blobToDataURL, dataURLToBlob } from '../images.js';
import { currentUser, signOut } from '../supabase.js';
import { toast, runSync } from '../app.js';

const FORMAT = 'amenity-kits-backup';
const FORMAT_VERSION = 1;

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function exportJSON() {
  const kits = store.getAll();
  const photoRows = await db.allPhotos();

  const photos = [];
  for (const p of photoRows) {
    photos.push({
      id: p.id,
      kitId: p.kitId,
      blob: await blobToDataURL(p.blob),
      thumbBlob: await blobToDataURL(p.thumbBlob),
    });
  }

  const payload = {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    kits,
    photos,
  };

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `amenity-kits-${stamp}.json`;
  a.click();
  // Give the download a tick to start before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  toast(`Exported ${kits.length} kit${kits.length === 1 ? '' : 's'}`);
}

async function importJSON(file, mode) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (payload?.format !== FORMAT) {
    throw new Error('That does not look like an Amenity Kits backup.');
  }
  if (!Array.isArray(payload.kits)) {
    throw new Error('The backup is missing its kit list.');
  }

  const photos = [];
  for (const p of payload.photos || []) {
    photos.push({
      id: p.id,
      kitId: p.kitId,
      blob: await dataURLToBlob(p.blob),
      thumbBlob: await dataURLToBlob(p.thumbBlob || p.blob),
    });
  }

  const importedIds = new Set(payload.kits.map((k) => k.id));
  const priorIds = store.getAll().map((k) => k.id);

  if (mode === 'replace') await db.replaceAll(payload.kits, photos);
  else await db.mergeAll(payload.kits, photos);

  // An import is a local change like any other, so it has to reach the server
  // too. Replace additionally tombstones what it wiped — otherwise the next
  // sync would pull those kits straight back from Supabase.
  if (mode === 'replace') {
    for (const id of priorIds) {
      if (!importedIds.has(id)) await db.queueOp(id, 'delete');
    }
  }
  for (const id of importedIds) await db.queueOp(id, 'upsert');

  await store.load();
  toast(`Imported ${payload.kits.length} kit${payload.kits.length === 1 ? '' : 's'}`);
  runSync();
}

export const view = {
  el: '#view-data',
  title: 'Backup',
  tab: 'data',

  async render(host) {
    const kits = store.getAll();
    const usage = await db.estimateUsage();

    const pending = await sync.pendingCount();
    const user = currentUser();

    host.innerHTML = `
      <div class="stack">
        <section class="panel">
          <h3>Sync</h3>
          <p id="syncSummary"></p>
          <div class="form-actions">
            <button type="button" class="btn" id="syncBtn">Sync now</button>
            <button type="button" class="btn btn-quiet" id="signOutBtn">Sign out</button>
          </div>
        </section>

        <section class="panel">
          <h3>Why a file backup too</h3>
          <p>The collection is mirrored to the database, so it survives this
             device and appears on any other you sign in from. A backup file is
             still worth keeping: it is the only copy that survives an accidental
             delete, since a delete syncs everywhere too. Keep the file somewhere
             safe (Files, iCloud Drive, email to yourself).</p>
        </section>

        <section class="panel">
          <h3>Export</h3>
          <p id="exportSummary"></p>
          <button type="button" class="btn btn-primary btn-block" id="exportBtn">
            Export backup file
          </button>
        </section>

        <section class="panel">
          <h3>Import</h3>
          <p>Restoring from a backup. <strong>Merge</strong> adds the backup's
             kits to what is already here, overwriting any with the same id.
             <strong>Replace</strong> wipes this device's collection first.</p>
          <input type="file" id="importFile" accept="application/json,.json" style="display:none">
          <div class="form-actions">
            <button type="button" class="btn" id="mergeBtn">Merge from file</button>
            <button type="button" class="btn btn-danger" id="replaceBtn">Replace all</button>
          </div>
        </section>
      </div>`;

    const syncSummary = host.querySelector('#syncSummary');
    syncSummary.textContent = [
      user ? `Signed in as ${user.email}.` : 'Not signed in.',
      pending
        ? `${pending} change${pending === 1 ? '' : 's'} still waiting to upload.`
        : 'Everything here has reached the server.',
    ].join(' ');

    host.querySelector('#syncBtn').addEventListener('click', async () => {
      await runSync({ quiet: false });
      view.render(host);
    });

    host.querySelector('#signOutBtn').addEventListener('click', () => {
      if (!confirm('Sign out? The collection stays on this device and reloads when you sign back in.')) return;
      signOut();
    });

    const summary = host.querySelector('#exportSummary');
    const photoCount = kits.reduce((s, k) => s + (k.photoIds?.length || 0), 0);
    summary.textContent = usage
      ? `${kits.length} kits and ${photoCount} photos, using about ${fmtBytes(usage.usage)} of ${fmtBytes(usage.quota)} available.`
      : `${kits.length} kits and ${photoCount} photos.`;

    host.querySelector('#exportBtn').addEventListener('click', async () => {
      if (!kits.length) return toast('Nothing to export yet');
      try {
        await exportJSON();
      } catch (err) {
        toast(`Export failed: ${err.message}`);
      }
    });

    const fileInput = host.querySelector('#importFile');
    let pendingMode = 'merge';

    const pick = (mode) => {
      pendingMode = mode;
      fileInput.click();
    };

    host.querySelector('#mergeBtn').addEventListener('click', () => pick('merge'));
    host.querySelector('#replaceBtn').addEventListener('click', () => {
      if (!confirm('Replace everything on this device with the backup file? Your current collection will be deleted.')) return;
      pick('replace');
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      toast('Importing…');
      try {
        await importJSON(file, pendingMode);
        view.render(host);
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    });
  },
};
