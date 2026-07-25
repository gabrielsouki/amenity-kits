import * as store from '../store.js';
import * as db from '../db.js';
import { trackURL, releaseURLs } from '../images.js';
import { go, replace } from '../router.js';
import { toast } from '../app.js';

let urls = [];

function fact(dt, dd) {
  const d = document.createElement('div');
  d.className = 'fact';
  const t = document.createElement('dt');
  t.textContent = dt;
  const v = document.createElement('dd');
  v.textContent = dd || '—';
  d.append(t, v);
  return d;
}

/** Series panel: progress plus every sibling, owned and wanted. This is the
 *  "3 of 4" view — the reason series/variant are recorded at all. */
async function seriesPanel(kit) {
  const members = store.seriesMembers(kit.series);
  if (members.length < 2) return null;

  const owned = members.filter((m) => m.status === 'owned').length;

  const wrap = document.createElement('div');

  const head = document.createElement('h2');
  head.className = 'section-head';
  head.textContent = `Series · ${kit.series}`;
  wrap.appendChild(head);

  const prog = document.createElement('div');
  prog.className = 'series-progress';
  prog.innerHTML = `
    <strong></strong>
    <div class="bar-track"><div class="bar-fill"></div></div>`;
  prog.querySelector('strong').textContent =
    `${owned} of ${members.length} in this series`;
  prog.querySelector('.bar-fill').style.width = `${(owned / members.length) * 100}%`;
  wrap.appendChild(prog);

  const list = document.createElement('div');
  list.className = 'sibling-list';

  const thumbIds = members.map((m) => m.photoIds?.[0]).filter(Boolean);
  const photos = await db.getPhotos(thumbIds);
  const byId = new Map(photos.map((p) => [p.id, p]));

  for (const m of members) {
    const a = document.createElement('a');
    a.className = 'sibling' + (m.id === kit.id ? ' is-current' : '');
    a.href = `#/kit/${m.id}`;

    const p = byId.get(m.photoIds?.[0]);
    if (p) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = trackURL(urls, p.thumbBlob || p.blob);
      a.appendChild(img);
    } else {
      const blank = document.createElement('span');
      blank.className = 'thumb-blank';
      a.appendChild(blank);
    }

    const main = document.createElement('div');
    main.className = 'sibling-main';
    const strong = document.createElement('strong');
    strong.textContent = m.variant || m.airline || 'Untitled';
    const span = document.createElement('span');
    span.textContent = m.status === 'owned'
      ? `Collected · ${store.stateSummary(m)}`
      : 'Wishlist';
    main.append(strong, span);
    a.appendChild(main);

    list.appendChild(a);
  }

  wrap.appendChild(list);
  return wrap;
}

export const view = {
  el: '#view-detail',
  title: 'Kit',
  tab: 'collection',
  back: '/collection',

  async render(host, { id }) {
    releaseURLs(urls);
    host.textContent = '';

    const kit = store.byId(id);
    if (!kit) {
      host.innerHTML = '<div class="empty"><p class="empty-title">Kit not found</p></div>';
      return;
    }

    /* Photos ------------------------------------------------------ */
    const photos = await db.getPhotos(kit.photoIds || []);

    const hero = document.createElement('div');
    hero.className = 'detail-hero';

    if (photos.length) {
      const img = document.createElement('img');
      img.alt = `${kit.airline} amenity kit`;
      img.src = trackURL(urls, photos[0].blob);
      hero.appendChild(img);

      if (photos.length > 1) {
        const strip = document.createElement('div');
        strip.className = 'photo-strip';
        photos.forEach((p, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = i === 0 ? 'is-on' : '';
          b.setAttribute('aria-label', `Photo ${i + 1}`);
          const t = document.createElement('img');
          t.alt = '';
          t.src = trackURL(urls, p.thumbBlob || p.blob);
          b.appendChild(t);
          b.addEventListener('click', () => {
            img.src = trackURL(urls, p.blob);
            for (const other of strip.children) other.classList.toggle('is-on', other === b);
          });
          strip.appendChild(b);
        });
        hero.appendChild(strip);
      }
    } else {
      const blank = document.createElement('div');
      blank.className = 'noimg';
      blank.textContent = '✈';
      hero.appendChild(blank);
    }
    host.appendChild(hero);

    /* Heading ----------------------------------------------------- */
    const h = document.createElement('h2');
    h.className = 'detail-title';
    h.textContent = kit.airline || 'Unknown airline';
    host.appendChild(h);

    const sub = document.createElement('p');
    sub.className = 'detail-sub';
    const qty = store.quantityOf(kit);
    sub.textContent = [
      kit.status === 'wanted'
        ? 'On the wishlist'
        : qty > 1 ? `Collected · ${qty} copies` : 'Collected',
      store.dateLabel(kit),
    ].filter(Boolean).join(' · ');
    host.appendChild(sub);

    /* Facts ------------------------------------------------------- */
    const facts = document.createElement('dl');
    facts.className = 'facts';
    facts.append(
      fact('Cabin', store.cabinLabel(kit.cabin)),
      fact('Route', store.routeLabel(kit.routeType)),
      fact('Copies', kit.status === 'wanted' ? '—' : String(store.quantityOf(kit))),
      fact('State', kit.status === 'wanted' ? '—' : store.stateSummary(kit)),
      fact('Designer', kit.designer),
      fact('Series', kit.series),
      fact('Variant', kit.variant),
    );
    host.appendChild(facts);

    if (kit.notes) {
      const n = document.createElement('div');
      n.className = 'notes';
      n.textContent = kit.notes;
      host.appendChild(n);
    }

    /* Series ------------------------------------------------------ */
    const panel = await seriesPanel(kit);
    if (panel) host.appendChild(panel);

    /* Actions ----------------------------------------------------- */
    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-primary';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => go(`/edit/${kit.id}`));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete this ${kit.airline || 'kit'} entry? This cannot be undone.`)) return;
      await store.remove(kit.id);
      toast('Kit deleted');
      // replace(), not go() — Back must not land on a detail page for a record
      // that no longer exists.
      replace('/collection');
    });

    // Going back is the topbar arrow's job now, so it isn't repeated here.
    actions.append(edit, del);
    host.appendChild(actions);
  },

  teardown() {
    releaseURLs(urls);
  },
};
