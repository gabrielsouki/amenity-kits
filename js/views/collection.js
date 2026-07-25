import * as store from '../store.js';
import * as db from '../db.js';
import { trackURL, releaseURLs } from '../images.js';
import { CABINS, ROUTE_TYPES, STATES } from '../store.js';

// Filter state lives at module scope so it survives a trip to a detail page
// and back — losing your filters on every navigation is maddening.
const filters = { status: 'owned', q: '', cabin: '', routeType: '', state: '', decade: '' };

let urls = [];
let wired = false;

const grid = () => document.getElementById('kitGrid');

function buildFilterBar() {
  const bar = document.getElementById('filterBar');
  bar.textContent = '';

  const groups = [
    ['cabin', CABINS],
    ['routeType', ROUTE_TYPES],
    ['state', STATES],
    ['decade', store.decades().map((d) => ({ value: String(d), label: `${d}s` }))],
  ];

  for (const [key, options] of groups) {
    for (const opt of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (filters[key] === opt.value ? ' is-on' : '');
      b.textContent = opt.label;
      b.addEventListener('click', () => {
        // Clicking an active chip clears it — chips toggle, they don't stick.
        filters[key] = filters[key] === opt.value ? '' : opt.value;
        buildFilterBar();
        paint();
      });
      bar.appendChild(b);
    }
  }

  const anyOn = ['cabin', 'routeType', 'state', 'decade'].some((k) => filters[k]);
  if (anyOn) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chip';
    clear.textContent = '✕ Clear';
    clear.addEventListener('click', () => {
      filters.cabin = filters.routeType = filters.state = filters.decade = '';
      buildFilterBar();
      paint();
    });
    bar.appendChild(clear);
  }
}

async function paint() {
  releaseURLs(urls);
  const rows = store.filter(filters);
  const g = grid();
  g.textContent = '';

  const empty = document.getElementById('collectionEmpty');
  const count = document.getElementById('resultCount');
  const totalInTab = store.filter({ status: filters.status }).length;

  if (!rows.length) {
    empty.hidden = false;
    count.textContent = '';
    document.getElementById('emptyBody').textContent = totalInTab
      ? 'No kits match these filters.'
      : filters.status === 'owned'
        ? 'Add your first kit to start the collection.'
        : 'Nothing on the wishlist yet. Add a kit you are hunting for.';
    return;
  }

  empty.hidden = true;
  // Records and physical copies differ once anything is duplicated; showing
  // only one of the two numbers reads as wrong whichever one you pick.
  const copies = rows.reduce((sum, k) => sum + store.quantityOf(k), 0);
  count.textContent = `${rows.length} kit${rows.length === 1 ? '' : 's'}`
    + (rows.length !== totalInTab ? ` of ${totalInTab}` : '')
    + (filters.status === 'owned' && copies !== rows.length ? ` · ${copies} copies` : '');

  // Cards render immediately; thumbnails stream in as they come out of IDB, so
  // a large collection doesn't block on image reads.
  const pending = [];
  for (const kit of rows) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = `#/kit/${kit.id}`;

    const photo = document.createElement('div');
    photo.className = 'card-photo';
    photo.innerHTML = '<span class="noimg">✈</span>';

    const badge = document.createElement('span');
    badge.className = 'badge' + (kit.status === 'wanted' ? ' badge-want' : '');
    // Once there are duplicates the count is the more useful thing to surface;
    // the state breakdown moves to the meta line below.
    badge.textContent = kit.status === 'wanted' ? 'Wishlist' : store.quantityBadge(kit);
    photo.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-airline"></div>
      <div class="card-meta"></div>
      <div class="card-designer"></div>`;
    body.querySelector('.card-airline').textContent = kit.airline || 'Unknown airline';
    body.querySelector('.card-meta').textContent =
      `${store.cabinLabel(kit.cabin)} · ${store.dateLabel(kit)}`;

    // The state breakdown gets its own line rather than displacing the date,
    // and only appears when there is actually more than one copy.
    if (kit.status === 'owned' && store.quantityOf(kit) > 1) {
      const states = document.createElement('div');
      states.className = 'card-states';
      states.textContent = store.stateSummary(kit);
      body.querySelector('.card-meta').after(states);
    }
    const des = body.querySelector('.card-designer');
    if (kit.designer) des.textContent = kit.designer; else des.remove();

    a.append(photo, body);
    g.appendChild(a);

    const firstPhotoId = kit.photoIds?.[0];
    if (firstPhotoId) pending.push([firstPhotoId, photo]);
  }

  const rowsOut = await db.getPhotos(pending.map(([id]) => id));
  const byId = new Map(rowsOut.map((p) => [p.id, p]));
  for (const [id, holder] of pending) {
    const p = byId.get(id);
    if (!p) continue;
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = trackURL(urls, p.thumbBlob || p.blob);
    holder.prepend(img);
    holder.querySelector('.noimg')?.remove();
  }
}

function wire() {
  if (wired) return;
  wired = true;

  document.getElementById('statusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-status]');
    if (!btn) return;
    filters.status = btn.dataset.status;
    for (const b of document.querySelectorAll('#statusTabs button')) {
      b.classList.toggle('is-active', b === btn);
    }
    paint();
  });

  const search = document.getElementById('searchInput');
  search.addEventListener('input', () => {
    filters.q = search.value;
    paint();
  });

  document.getElementById('collectionEmpty')
    .addEventListener('click', (e) => {
      if (e.target.dataset.action === 'add') location.hash = '/new';
    });

  // Repaint whenever the store changes so a save on the form view is reflected
  // here without the collection needing to re-mount.
  store.subscribe(() => {
    if (!document.getElementById('view-collection').hidden) {
      buildFilterBar();
      paint();
    }
  });
}

export const view = {
  el: '#view-collection',
  title: 'Collection',
  tab: 'collection',
  async render() {
    wire();
    document.getElementById('searchInput').value = filters.q;
    for (const b of document.querySelectorAll('#statusTabs button')) {
      b.classList.toggle('is-active', b.dataset.status === filters.status);
    }
    buildFilterBar();
    await paint();
  },
  teardown() {
    releaseURLs(urls);
  },
};

/** Lets the wishlist tab be opened directly from elsewhere. */
export function setStatus(status) {
  filters.status = status;
}
