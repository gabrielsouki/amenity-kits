// Hand-rolled SVG charts. Two forms only, because the data only has two jobs:
//
//   barChart    — magnitude across many categories (kits per airline/designer).
//                 One measure, one series, so a single hue; no legend, the
//                 panel title names it. Values are direct-labelled at the bar end.
//   compositionBar — parts of a whole across a few ORDERED buckets (cabin,
//                 route type, state). Ordered data gets the single-hue ordinal
//                 ramp, never categorical hues.
//
// Colours come from CSS custom properties (--seq-1..4, --bar-fill) so the
// light/dark swap happens in the stylesheet and the ramp is validated in one
// place. See css/app.css.

const NS = 'http://www.w3.org/2000/svg';

const el = (name, attrs = {}, text) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

/** Ordinal ramp slots for a bucket count. Ends of the ramp are always used. */
export function rampFor(count) {
  if (count <= 1) return ['var(--seq-4)'];
  if (count === 2) return ['var(--seq-1)', 'var(--seq-4)'];
  if (count === 3) return ['var(--seq-1)', 'var(--seq-3)', 'var(--seq-4)'];
  return ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)'];
}

/* ── Shared tooltip ───────────────────────────────────────────── */

let tipEl = null;
function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function attachTip(node, text) {
  // A native <title> alone doesn't appear on touch, so wire a real tooltip and
  // keep <title> for screen readers.
  node.appendChild(el('title', {}, text));
  const show = (e) => {
    const t = tooltip();
    t.textContent = text;
    t.hidden = false;
    const p = e.touches ? e.touches[0] : e;
    const w = t.offsetWidth;
    const x = Math.min(Math.max(p.clientX, w / 2 + 8), window.innerWidth - w / 2 - 8);
    t.style.left = `${x}px`;
    t.style.top = `${p.clientY - 12}px`;
  };
  const hide = () => { if (tipEl) tipEl.hidden = true; };
  node.addEventListener('pointerenter', show);
  node.addEventListener('pointermove', show);
  node.addEventListener('pointerleave', hide);
  node.addEventListener('pointercancel', hide);
}

export function hideTooltip() {
  if (tipEl) tipEl.hidden = true;
}

/* ── Horizontal bar chart ─────────────────────────────────────── */

/**
 * @param {{label: string, value: number}[]} rows  already sorted, descending
 * @param {{labelWidth?: number}} opts
 */
export function barChart(rows, opts = {}) {
  const labelW = opts.labelWidth ?? 118;
  const valueW = 34;
  const rowH = 26;
  const barH = 13;
  const width = 520;
  const height = rows.length * rowH + 4;
  const plotW = width - labelW - valueW;
  const max = Math.max(...rows.map((r) => r.value), 1);

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width, height,
    role: 'img',
    'aria-label': opts.ariaLabel || 'Bar chart',
  });

  rows.forEach((r, i) => {
    const y = i * rowH + 2;
    const cy = y + rowH / 2;

    const label = el('text', {
      x: labelW - 10, y: cy, 'text-anchor': 'end', 'dominant-baseline': 'middle',
      class: 'c-label',
    }, r.label);
    svg.appendChild(label);

    // Track keeps short bars legible as "small" rather than "missing".
    svg.appendChild(el('rect', {
      x: labelW, y: cy - barH / 2, width: plotW, height: barH, rx: 4, class: 'c-track',
    }));

    const w = Math.max(3, (r.value / max) * plotW);
    const bar = el('rect', {
      x: labelW, y: cy - barH / 2, width: w, height: barH, rx: 4,
      fill: r.isOther ? 'var(--seq-1)' : 'var(--bar-fill)',
      class: 'c-bar',
    });
    attachTip(bar, `${r.label}: ${r.value} kit${r.value === 1 ? '' : 's'}`);
    svg.appendChild(bar);

    svg.appendChild(el('text', {
      x: labelW + plotW + 8, y: cy, 'dominant-baseline': 'middle', class: 'c-value',
    }, String(r.value)));
  });

  return svg;
}

/* ── Composition bar (ordered buckets, parts of a whole) ──────── */

/**
 * A single full-width bar split into ordered segments, with a legend beneath.
 * @param {{label: string, value: number}[]} rows  in vocabulary order
 */
export function compositionBar(rows) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const width = 520;
  const height = 26;
  const gap = 2;            // surface gap between adjacent fills
  const colors = rampFor(rows.length);

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width, height,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': 'Composition bar',
  });

  let x = 0;
  rows.forEach((r, i) => {
    const isLast = i === rows.length - 1;
    const raw = (r.value / total) * width;
    const w = Math.max(4, isLast ? width - x : raw - gap);
    const seg = el('rect', {
      x, y: 0, width: w, height, rx: 4, fill: colors[i], class: 'c-seg',
    });
    const pct = Math.round((r.value / total) * 100);
    attachTip(seg, `${r.label}: ${r.value} (${pct}%)`);
    svg.appendChild(seg);
    x += raw;
  });

  return svg;
}

/** Legend for a composition bar. Identity is never colour-alone: each entry
 *  pairs a swatch with its label and count. */
export function legend(rows) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const colors = rampFor(rows.length);
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  rows.forEach((r, i) => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = colors[i];
    item.append(sw, document.createTextNode(r.label + ' '));
    const b = document.createElement('b');
    b.textContent = `${r.value} (${Math.round((r.value / total) * 100)}%)`;
    item.appendChild(b);
    wrap.appendChild(item);
  });
  return wrap;
}
