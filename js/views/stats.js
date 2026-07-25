import * as store from '../store.js';
import { barChart, compositionBar, legend, hideTooltip } from '../charts.js';

function tile(value, label) {
  const d = document.createElement('div');
  d.className = 'tile';
  const b = document.createElement('b');
  b.textContent = value;
  const s = document.createElement('span');
  s.textContent = label;
  d.append(b, s);
  return d;
}

function panel(title, node, note) {
  const p = document.createElement('section');
  p.className = 'panel';
  const h = document.createElement('h3');
  h.textContent = title;
  p.append(h, node);
  if (note) {
    const n = document.createElement('p');
    n.className = 'panel-note';
    n.textContent = note;
    p.appendChild(n);
  }
  return p;
}

function scroller(svg) {
  const d = document.createElement('div');
  d.className = 'chart-scroll';
  d.appendChild(svg);
  return d;
}

/** Composition of an ordered, small-cardinality field: one bar + legend. */
function compositionPanel(title, rows) {
  if (!rows.length) return null;
  const wrap = document.createElement('div');
  wrap.append(scroller(compositionBar(rows)), legend(rows));
  return panel(title, wrap);
}

export const view = {
  el: '#view-stats',
  title: 'Stats',
  tab: 'stats',

  render(host) {
    host.textContent = '';
    const s = store.stats();

    if (!s.owned.length) {
      host.innerHTML = `
        <div class="empty">
          <p class="empty-title">No stats yet</p>
          <p class="empty-body">Add a few kits you own and the breakdowns will appear here.</p>
          <a class="btn btn-primary" href="#/new">Add a kit</a>
        </div>`;
      return;
    }

    /* Headline numbers -------------------------------------------- */
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    tiles.append(
      tile(s.totals.items, 'kits collected'),
      tile(s.totals.wanted, 'on wishlist'),
      tile(s.totals.airlines, s.totals.airlines === 1 ? 'airline' : 'airlines'),
      tile(s.totals.designers, s.totals.designers === 1 ? 'designer' : 'designers'),
    );
    // Only worth the space once something is actually duplicated.
    if (s.totals.items !== s.totals.owned) {
      tiles.appendChild(tile(s.totals.owned, 'distinct kits'));
    }
    if (s.totals.oldest != null) {
      tiles.appendChild(tile(
        s.totals.oldest === s.totals.newest
          ? String(s.totals.oldest)
          : `${s.totals.oldest}–${s.totals.newest}`,
        'years covered',
      ));
    }
    host.appendChild(tiles);

    /* Airlines ----------------------------------------------------- */
    const airlines = store.topN(s.byAirline, 10);
    host.appendChild(panel(
      'Kits per airline',
      scroller(barChart(airlines.rows, { ariaLabel: 'Kits per airline' })),
      airlines.hiddenCount
        ? `${airlines.hiddenCount} more airline${airlines.hiddenCount === 1 ? '' : 's'} grouped into “Other”.`
        : null,
    ));

    /* Designers ---------------------------------------------------- */
    if (s.byDesigner.length) {
      const designers = store.topN(s.byDesigner, 10);
      host.appendChild(panel(
        'Kits per designer',
        scroller(barChart(designers.rows, { ariaLabel: 'Kits per designer' })),
        designers.hiddenCount
          ? `${designers.hiddenCount} more designer${designers.hiddenCount === 1 ? '' : 's'} grouped into “Other”.`
          : null,
      ));
    }

    /* Ordered compositions ----------------------------------------- */
    for (const [title, rows] of [
      ['Cabin', s.byCabin],
      ['Route type', s.byRoute],
      ['Condition', s.byState],
    ]) {
      const p = compositionPanel(title, rows);
      if (p) host.appendChild(p);
    }

    const note = document.createElement('p');
    note.className = 'count';
    note.textContent = s.totals.items !== s.totals.owned
      ? 'Breakdowns count every copy you own, so duplicates are included. Wishlist entries are counted separately above.'
      : 'Breakdowns cover kits you own. Wishlist entries are counted separately above.';
    host.appendChild(note);
  },

  teardown() {
    hideTooltip();
  },
};
