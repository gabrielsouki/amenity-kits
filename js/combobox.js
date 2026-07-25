// A text input with a filtered suggestion list built from values already in the
// collection.
//
// This exists because <datalist> — the obvious way to do this — is not
// supported by Safari on iOS at all. On the phone a datalist input degrades to
// a plain text box with no suggestions and no indication that anything is
// missing. Everything here is built from ordinary elements that do work there.
//
// Free text is always allowed: the list suggests, it never restricts. Typing a
// new airline is the normal case the first time you record one.

const MAX_VISIBLE = 8;

/**
 * @param {{name: string, label: string, placeholder?: string,
 *          values: string[], value?: string}} opts
 * @returns {HTMLElement} a .field wrapper; find the input via [name=…]
 */
export function combobox({ name, label, placeholder = '', values, value = '' }) {
  const wrap = document.createElement('label');
  wrap.className = 'field combo';

  const span = document.createElement('span');
  span.textContent = label;

  const input = document.createElement('input');
  input.type = 'text';
  input.name = name;
  input.placeholder = placeholder;
  input.value = value;
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');

  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  wrap.append(span, input, list);

  let matches = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    list.textContent = '';
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const pick = (text) => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  };

  const highlight = () => {
    [...list.children].forEach((li, i) => {
      li.classList.toggle('is-active', i === active);
      if (i === active) li.scrollIntoView({ block: 'nearest' });
    });
  };

  const open = () => {
    const q = input.value.trim().toLowerCase();
    // Prefix matches first — typing "bul" should surface Bulgari above a
    // hypothetical "Acqua di Bulgari".
    const scored = values
      .filter((v) => !q || v.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.localeCompare(b);
      });

    // An exact match is not worth suggesting — the field already says it.
    matches = scored.filter((v) => v.toLowerCase() !== q).slice(0, MAX_VISIBLE);

    if (!matches.length) return close();

    list.textContent = '';
    matches.forEach((text, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = text;
      // pointerdown, not click: the input's blur would tear the list down
      // before a click ever landed.
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pick(text);
      });
      li.addEventListener('pointerenter', () => { active = i; highlight(); });
      list.appendChild(li);
    });

    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  };

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', () => setTimeout(close, 120));

  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'ArrowDown') { open(); e.preventDefault(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      active = (active + 1) % matches.length;
      highlight();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      active = active <= 0 ? matches.length - 1 : active - 1;
      highlight();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      // Only swallow Enter when a suggestion is actually selected, so Enter
      // still submits the form in the normal case.
      if (active >= 0) {
        pick(matches[active]);
        e.preventDefault();
      } else {
        close();
      }
    } else if (e.key === 'Escape') {
      close();
      e.stopPropagation();
    }
  });

  return wrap;
}
