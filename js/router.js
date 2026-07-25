// Tiny hash router. Each route names a view module; the module gets mounted
// into its own <section> and told to tear down when navigation leaves it.

const routes = [];
let current = null;

/**
 * @param {string} pattern  e.g. '/kit/:id'
 * @param {{el: string, title: string|Function, tab?: string,
 *          render: Function, teardown?: Function}} view
 */
export function route(pattern, view) {
  const names = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => {
    names.push(n);
    return '([^/]+)';
  }) + '$');
  routes.push({ rx, names, view });
}

function parse() {
  const raw = (location.hash || '#/collection').slice(1);
  for (const r of routes) {
    const m = raw.match(r.rx);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { view: r.view, params };
  }
  return null;
}

export function go(path) {
  location.hash = path;
}

/** Replaces the hash without adding a history entry — used after deleting a
 *  record, so Back doesn't return to a detail page that no longer exists. */
export function replace(path) {
  history.replaceState(null, '', '#' + path);
  handle();
}

async function handle() {
  const match = parse();
  if (!match) return go('/collection');

  if (current?.view.teardown) current.view.teardown();

  for (const section of document.querySelectorAll('.view')) section.hidden = true;

  const { view, params } = match;
  const host = document.querySelector(view.el);
  host.hidden = false;

  const title = typeof view.title === 'function' ? view.title(params) : view.title;
  document.getElementById('viewTitle').textContent = title;

  for (const a of document.querySelectorAll('.tabbar a')) {
    a.classList.toggle('is-on', a.dataset.tab === view.tab);
  }

  current = match;
  await view.render(host, params);
}

export function start() {
  window.addEventListener('hashchange', handle);
  handle();
}
