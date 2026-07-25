import * as store from '../store.js';
import * as db from '../db.js';
import { processImage, trackURL, releaseURLs } from '../images.js';
import { CABINS, ROUTE_TYPES, STATES, STATUSES, MONTHS } from '../store.js';
import { replace } from '../router.js';
import { combobox } from '../combobox.js';
import { toast } from '../app.js';

let urls = [];

// Photo edits are staged here and only committed when the form is saved, so
// backing out of an edit doesn't leave orphaned blobs in IndexedDB.
let staged = { existing: [], added: [], removedIds: [] };

const optionsHTML = (list, selected) => list
  .map((o) => `<option value="${o.value}"${o.value === selected ? ' selected' : ''}>${o.label}</option>`)
  .join('');

// A single-select row of tappable pills, backed by a hidden input so the save
// handler and prefill keep reading `form[name].value` exactly as with a <select>.
const choiceGroupHTML = (name, list) => `
  <input type="hidden" name="${name}">
  <div class="choice-group" data-choice="${name}" role="radiogroup">
    ${list.map((o) => `<button type="button" class="choice" role="radio"
        aria-checked="false" data-value="${o.value}">${o.label}</button>`).join('')}
  </div>`;

function wireChoice(host, name, value) {
  const input = host.querySelector(`input[name="${name}"]`);
  const group = host.querySelector(`[data-choice="${name}"]`);
  const set = (v) => {
    input.value = v;
    for (const btn of group.querySelectorAll('.choice')) {
      const on = btn.dataset.value === v;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.choice');
    if (btn) set(btn.dataset.value);
  });
  set(value);
}

function renderPreviews(container) {
  releaseURLs(urls);
  container.textContent = '';

  const all = [
    ...staged.existing.map((p) => ({ id: p.id, blob: p.thumbBlob || p.blob, kind: 'existing' })),
    ...staged.added.map((p) => ({ id: p.id, blob: p.thumbBlob, kind: 'added' })),
  ];

  for (const p of all) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.alt = '';
    img.src = trackURL(urls, p.blob);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'photo-remove';
    rm.setAttribute('aria-label', 'Remove photo');
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      if (p.kind === 'existing') {
        staged.existing = staged.existing.filter((x) => x.id !== p.id);
        staged.removedIds.push(p.id);
      } else {
        staged.added = staged.added.filter((x) => x.id !== p.id);
      }
      renderPreviews(container);
    });
    fig.append(img, rm);
    container.appendChild(fig);
  }
}

export const view = {
  el: '#view-form',
  title: (params) => (params.id ? 'Edit kit' : 'New kit'),
  tab: 'collection',
  // Editing returns to the kit; a new kit returns to the collection.
  back: (params) => (params.id ? `/kit/${params.id}` : '/collection'),

  async render(host, { id }) {
    releaseURLs(urls);
    const kit = id ? store.byId(id) : null;
    if (id && !kit) {
      host.innerHTML = '<div class="empty"><p class="empty-title">Kit not found</p></div>';
      return;
    }

    staged = {
      existing: kit ? await db.getPhotos(kit.photoIds || []) : [],
      added: [],
      removedIds: [],
    };

    const thisYear = new Date().getFullYear();

    host.innerHTML = `
      <form class="form-grid" id="kitForm" novalidate>
        <label class="field">
          <span>Status</span>
          <select name="status">${optionsHTML(STATUSES)}</select>
        </label>

        <div class="photo-drop">
          <div class="photo-previews" id="previews"></div>
          <button type="button" class="btn" id="pickBtn">Add photo</button>
          <input type="file" id="fileInput" accept="image/*" multiple>
          <p class="hint">Photos are resized on save to keep the app small.</p>
        </div>

        <div id="airlineMount"></div>

        <div class="row">
          <label class="field">
            <span>Month</span>
            <select name="month">
              <option value="">Unknown</option>
              ${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span>Year</span>
            <input name="year" type="number" inputmode="numeric" min="1950" max="${thisYear + 1}"
                   placeholder="Unknown">
          </label>
        </div>

        <div class="field">
          <span>Route type</span>
          ${choiceGroupHTML('routeType', ROUTE_TYPES)}
        </div>

        <div class="field">
          <span>Cabin</span>
          ${choiceGroupHTML('cabin', CABINS)}
        </div>

        <fieldset class="field counts" id="stateField">
          <span>How many, and in what state</span>
          <div class="counts-grid">
            ${STATES.map((s) => `
              <div class="count-cell">
                <span>${s.label}</span>
                <div class="stepper">
                  <button type="button" class="stepper-btn" data-step="-1"
                          aria-label="One fewer ${s.label.toLowerCase()}">−</button>
                  <input type="number" name="count_${s.value}" inputmode="numeric"
                         min="0" max="999" step="1" value="0" readonly
                         aria-label="${s.label} copies">
                  <button type="button" class="stepper-btn" data-step="1"
                          aria-label="One more ${s.label.toLowerCase()}">+</button>
                </div>
              </div>`).join('')}
          </div>
          <p class="hint" id="countsTotal"></p>
        </fieldset>

        <div id="designerMount"></div>

        <div class="row">
          <div id="seriesMount"></div>
          <label class="field">
            <span>Variant</span>
            <input name="variant" autocomplete="off" placeholder="e.g. 2 of 4 — teal">
          </label>
        </div>

        <label class="field">
          <span>Notes</span>
          <textarea name="notes" placeholder="Flight, contents, how you got it…"></textarea>
        </label>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" id="saveBtn">Save kit</button>
          <a class="btn btn-quiet" href="${kit ? `#/kit/${kit.id}` : '#/collection'}">Cancel</a>
        </div>
      </form>`;

    const form = host.querySelector('#kitForm');

    // Suggestion fields are built in JS rather than markup — see combobox.js for
    // why <datalist> can't be used here.
    host.querySelector('#airlineMount').replaceWith(combobox({
      name: 'airline', label: 'Airline', placeholder: 'e.g. Qatar Airways',
      values: store.vocabulary('airline'),
    }));
    host.querySelector('#designerMount').replaceWith(combobox({
      name: 'designer', label: 'Designer', placeholder: 'e.g. Bulgari',
      values: store.vocabulary('designer'),
    }));
    host.querySelector('#seriesMount').replaceWith(combobox({
      name: 'series', label: 'Series', placeholder: 'e.g. Bulgari Amber',
      values: store.vocabulary('series'),
    }));

    const previews = host.querySelector('#previews');
    const fileInput = host.querySelector('#fileInput');
    const stateField = host.querySelector('#stateField');

    // Route type and cabin are pill groups backed by hidden inputs. New kits
    // default to long-haul (the common case) and economy.
    wireChoice(form, 'routeType', kit?.routeType || 'longhaul');
    wireChoice(form, 'cabin', kit?.cabin || 'economy');

    // Steppers only ever change their input from JS, which doesn't fire 'input',
    // so each button nudges the value and refreshes the total by hand.
    for (const st of host.querySelectorAll('.stepper')) {
      const input = st.querySelector('input');
      for (const btn of st.querySelectorAll('.stepper-btn')) {
        btn.addEventListener('click', () => {
          const cur = parseInt(input.value, 10) || 0;
          input.value = Math.min(999, Math.max(0, cur + parseInt(btn.dataset.step, 10)));
          syncTotal();
        });
      }
    }

    /* Prefill ----------------------------------------------------- */
    if (kit) {
      form.status.value = kit.status;
      form.airline.value = kit.airline || '';
      form.month.value = kit.month || '';
      form.year.value = kit.year || '';
      form.designer.value = kit.designer || '';
      form.series.value = kit.series || '';
      form.variant.value = kit.variant || '';
      form.notes.value = kit.notes || '';
      // countsOf() copes with records saved before duplicates existed.
      const c = store.countsOf(kit);
      for (const s of STATES) form[`count_${s.value}`].value = c[s.value] || 0;
    } else {
      form.year.value = thisYear;
      // Counts start at 0 across the board — nothing is preselected.
    }

    const readCounts = () => {
      const out = {};
      for (const s of STATES) {
        const n = parseInt(form[`count_${s.value}`].value, 10);
        out[s.value] = Number.isFinite(n) && n > 0 ? n : 0;
      }
      return out;
    };

    const totalLine = host.querySelector('#countsTotal');
    const syncTotal = () => {
      const c = readCounts();
      const total = STATES.reduce((sum, s) => sum + c[s.value], 0);
      totalLine.textContent = total === 0
        ? 'Enter at least one copy.'
        : `${total} ${total === 1 ? 'copy' : 'copies'} of this kit.`;
    };
    for (const s of STATES) {
      form[`count_${s.value}`].addEventListener('input', syncTotal);
    }
    syncTotal();

    // Counts describe kits you physically have; they are meaningless on a
    // wishlist entry, so the whole block disappears for those.
    const syncStateField = () => {
      stateField.hidden = form.status.value === 'wanted';
    };
    form.status.addEventListener('change', syncStateField);
    syncStateField();

    renderPreviews(previews);

    /* Photos ------------------------------------------------------ */
    host.querySelector('#pickBtn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      if (!files.length) return;
      toast(`Processing ${files.length} photo${files.length === 1 ? '' : 's'}…`);
      for (const file of files) {
        try {
          staged.added.push(await processImage(file));
        } catch (err) {
          toast(err.message || 'Could not read that image');
        }
      }
      renderPreviews(previews);
    });

    /* Save -------------------------------------------------------- */
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const airline = form.airline.value.trim();
      // Year is optional: an unmarked kit with no packaging often can't be dated.
      const yearRaw = form.year.value.trim();
      const year = yearRaw ? parseInt(yearRaw, 10) : null;
      const isWishlist = form.status.value === 'wanted';
      const counts = readCounts();
      const total = STATES.reduce((sum, s) => sum + counts[s.value], 0);

      if (!airline) return toast('An airline is required');
      if (yearRaw && (!Number.isFinite(year) || year < 1950 || year > thisYear + 1)) {
        return toast('Enter a valid year, or leave it blank');
      }
      if (!isWishlist && total < 1) return toast('Enter how many copies you have');

      const saveBtn = host.querySelector('#saveBtn');
      saveBtn.disabled = true;

      try {
        const record = {
          ...(kit || {}),
          status: form.status.value,
          airline,
          month: form.month.value ? parseInt(form.month.value, 10) : null,
          year,
          routeType: form.routeType.value,
          cabin: form.cabin.value,
          // A wishlist entry keeps whatever counts it had, so switching a kit
          // to Wishlist and back doesn't silently lose the breakdown.
          counts: isWishlist ? store.countsOf(kit || {}) : counts,
          designer: form.designer.value.trim(),
          series: form.series.value.trim(),
          variant: form.variant.value.trim(),
          notes: form.notes.value.trim(),
        };

        // `counts` supersedes the old single `state` field; drop it so a record
        // never carries two competing answers.
        delete record.state;

        const kitId = record.id || crypto.randomUUID();
        record.id = kitId;

        // Commit staged photo changes, then point the kit at what survived.
        await db.putPhotos(staged.added.map((p) => ({ ...p, kitId })));
        await db.deletePhotos(staged.removedIds);
        record.photoIds = [
          ...staged.existing.map((p) => p.id),
          ...staged.added.map((p) => p.id),
        ];

        await store.save(record);
        toast(kit ? 'Kit updated' : 'Kit added');
        // replace() so Back skips the form rather than reopening it.
        replace(`/kit/${kitId}`);
      } catch (err) {
        saveBtn.disabled = false;
        toast(err.name === 'QuotaExceededError'
          ? 'Out of storage — export a backup and remove some photos.'
          : `Could not save: ${err.message}`);
      }
    });
  },

  teardown() {
    releaseURLs(urls);
  },
};
