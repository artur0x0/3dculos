/**
 * Golden: editor draft survives a reload.
 *
 * - IndexedDB round-trip (save → load → clear) through a minimal fake IDB
 * - localStorage fallback when IndexedDB is missing (private mode / old Safari)
 * - a store that throws never throws out of the module (the editor must not
 *   break because site data is disabled)
 * - the picked-face contour profile stays readable as a plane (bug: Profile
 *   Confirm emitted a host workplaneFromFace query, so the saved contour read
 *   back plane-less and ghosted on the default +Z top instead of the pick).
 */

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Fakes ──────────────────────────────────────────────────────
function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/** Enough of IndexedDB for one keyed object store. */
function fakeIndexedDB() {
  const stores = new Map();
  const later = (fn) => setTimeout(fn, 0);
  return {
    open() {
      const req = { result: null, error: null };
      later(() => {
        if (!stores.has('editorDraft')) stores.set('editorDraft', new Map());
        req.result = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => stores.set(n, new Map()),
          close() {},
          transaction(name) {
            const data = stores.get(name);
            const tx = { pending: 0 };
            // Real IDB fires every request's onsuccess BEFORE oncomplete.
            const settle = () => later(() => {
              if (tx.pending > 0) { settle(); return; }
              if (tx.oncomplete) tx.oncomplete();
            });
            const request = (fn) => {
              tx.pending += 1;
              const r = {};
              later(() => {
                fn(r);
                tx.pending -= 1;
                if (r.onsuccess) r.onsuccess();
              });
              return r;
            };
            settle();
            return {
              objectStore: () => ({
                put: (value, key) => request(() => data.set(key, value)),
                get: (key) => request((r) => { r.result = data.get(key); }),
                delete: (key) => request(() => data.delete(key)),
              }),
              set oncomplete(fn) { tx.oncomplete = fn; },
              set onabort(_fn) {},
              set onerror(_fn) {},
            };
          },
        };
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    _stores: stores,
  };
}

async function freshModule() {
  // Cache-bust so each scenario re-evaluates the module's lazy db handle.
  return import(`../../src/utils/editorDraft.js?t=${Math.random()}`);
}

// ── IndexedDB path ─────────────────────────────────────────────
console.log('editor draft — IndexedDB round-trip');
{
  const idb = fakeIndexedDB();
  globalThis.indexedDB = idb;
  globalThis.localStorage = fakeLocalStorage();
  const { saveEditorDraft, loadEditorDraft, clearEditorDraft } = await freshModule();

  const script = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n';
  check('save reports durable', (await saveEditorDraft({ script, filename: 'bracket.js' })) === true);
  check('draft did NOT fall back to localStorage', globalThis.localStorage._map.size === 0);

  const back = await loadEditorDraft();
  check('load returns the same script', back?.script === script);
  check('load returns the filename', back?.filename === 'bracket.js');
  check('load stamps savedAt', Number.isFinite(back?.savedAt) && back.savedAt > 0);

  // An emptied editor is a real state: reload must not resurrect old code.
  await saveEditorDraft({ script: '' });
  const emptied = await loadEditorDraft();
  check('empty buffer round-trips as empty', emptied?.script === '' && emptied.filename === null);

  await clearEditorDraft();
  check('clear removes the draft', (await loadEditorDraft()) === null);

  check('non-string script is refused', (await saveEditorDraft({ script: null })) === false);
}

// ── localStorage fallback ──────────────────────────────────────
console.log('editor draft — localStorage fallback (no IndexedDB)');
{
  globalThis.indexedDB = undefined;
  globalThis.localStorage = fakeLocalStorage();
  const { saveEditorDraft, loadEditorDraft, clearEditorDraft } = await freshModule();

  check('save still reports durable', (await saveEditorDraft({ script: 'return 1;' })) === true);
  check('fallback wrote localStorage', globalThis.localStorage._map.size === 1);
  check('fallback load round-trips', (await loadEditorDraft())?.script === 'return 1;');
  await clearEditorDraft();
  check('fallback clear empties storage', globalThis.localStorage._map.size === 0);
}

// ── Hostile storage never throws ───────────────────────────────
console.log('editor draft — disabled site data degrades quietly');
{
  globalThis.indexedDB = { open() { throw new Error('site data disabled'); } };
  globalThis.localStorage = {
    getItem() { throw new Error('site data disabled'); },
    setItem() { throw new Error('site data disabled'); },
    removeItem() { throw new Error('site data disabled'); },
  };
  const { saveEditorDraft, loadEditorDraft, clearEditorDraft } = await freshModule();
  const warn = console.warn;
  console.warn = () => {}; // the module is expected to be loud; not here
  let threw = null;
  let saved = null;
  let loaded = 'unset';
  try {
    saved = await saveEditorDraft({ script: 'return 1;' });
    loaded = await loadEditorDraft();
    await clearEditorDraft();
  } catch (e) {
    threw = e;
  } finally {
    console.warn = warn;
  }
  check('no throw escapes the module', threw === null, String(threw));
  check('save reports not durable', saved === false);
  check('load reports nothing', loaded === null);
}

// ── Picked-face contour keeps its plane ────────────────────────
console.log('contour profile — picked face commits a readable plane');
{
  delete globalThis.indexedDB;
  delete globalThis.localStorage;
  const { composeContourProfile, resolveContourWorkplane } =
    await import('../../src/utils/contourMode.js');
  const { listSavedContours } = await import('../../src/utils/savedContours.js');

  // +X side face of a 40×30×20 box — NOT the default +Z top.
  const face = resolveContourWorkplane({
    center: [20, 0, 0],
    normal: [1, 0, 0],
    area: 600,
    triangleCount: 2,
    selectionMode: 'coplanar',
    vertices: [[20, -15, -10], [20, 15, -10], [20, 15, 10], [20, -15, 10]],
  }).face;

  const res = composeContourProfile(
    'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n',
    { face, tool: 'circle', params: { radius: 5, segments: 32 } },
  );
  check('compose ok', res.ok === true, res.message || '');
  check('no opaque host workplane query', !/workplaneFromFace/.test(res.buffer || ''));

  const saved = listSavedContours(res.buffer || '');
  check('one saved contour', saved.length === 1);
  check('contour is not host-plane-bound', saved[0]?.host === false);
  check('contour plane is the picked side face',
    Math.abs((saved[0]?.plane?.center?.[0] ?? 0) - 20) < 1e-9
    && Math.abs((saved[0]?.plane?.normal?.[0] ?? 0) - 1) < 1e-9);
}

if (failed) {
  console.log(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('All editor-draft / contour-plane checks passed.');
