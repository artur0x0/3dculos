import { idbWithTimeout, IDB_OP_TIMEOUT_MS } from './idbWithTimeout.js';
/**
 * utils/editorDraft.js — crash/reload-proof editor draft in IndexedDB.
 *
 * editorStorage.js is the OAuth hand-off (localStorage, one hour, cleared on
 * return). This is the always-on draft: every keystroke the CAD editor takes
 * is mirrored here, so a reload, a phone tab eviction or a browser crash puts
 * the same buffer back instead of the default script. The draft carries the
 * active part id so restore cannot bleed one part's script into another.
 *
 * IndexedDB (not localStorage) because a script with an inlined mesh or a long
 * helper history blows past the 5 MB string quota, and IDB writes do not block
 * the main thread while the user is typing.
 *
 * Every entry point is a no-throw promise: private-mode Safari, disabled site
 * data and old browsers fall back to localStorage, and a total failure just
 * means the draft is not restored — never a broken editor.
 */

const DB_NAME = 'surfcad';
const DB_VERSION = 1;
const STORE = 'editorDraft';
const DRAFT_KEY = 'current';
/** localStorage fallback when IndexedDB is unavailable (private mode, etc). */
const FALLBACK_KEY = 'surfcad_editor_draft';

let dbPromise = null;

function idbAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDB() {
  if (!idbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      console.warn('[EditorDraft] indexedDB.open threw:', err);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // A second tab upgrading the schema would otherwise wedge this handle.
      db.onversionchange = () => {
        try {
          db.close();
        } catch { /* already closing */ }
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      console.warn('[EditorDraft] indexedDB.open failed:', req.error);
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
  return idbWithTimeout(dbPromise, IDB_OP_TIMEOUT_MS, 'EditorDraft open').catch((err) => {
    console.warn('[EditorDraft] indexedDB.open timed out:', err?.message || err);
    dbPromise = null;
    return null;
  });
}

function runTx(mode, work) {
  const op = openDB().then((db) => {
    if (!db) return { ok: false, value: null };
    return new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, mode);
      } catch (err) {
        console.warn('[EditorDraft] transaction failed:', err);
        resolve({ ok: false, value: null });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let out;
      const req = work(tx.objectStore(STORE));
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => finish({ ok: true, value: out });
      tx.onabort = () => finish({ ok: false, value: null });
      tx.onerror = () => finish({ ok: false, value: null });
    });
  }).catch((err) => {
    console.warn('[EditorDraft] store unavailable:', err);
    return { ok: false, value: null };
  });
  return idbWithTimeout(op, IDB_OP_TIMEOUT_MS, 'EditorDraft tx').catch((err) => {
    console.warn('[EditorDraft] tx timed out:', err?.message || err);
    return { ok: false, value: null };
  });
}

function writeFallback(record) {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(record));
    return true;
  } catch (err) {
    console.warn('[EditorDraft] localStorage fallback failed:', err);
    return false;
  }
}

function readFallback() {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalize(record) {
  if (!record || typeof record.script !== 'string') return null;
  const partId = record.partId != null && String(record.partId) !== ''
    ? String(record.partId)
    : null;
  return {
    script: record.script,
    filename: typeof record.filename === 'string' ? record.filename : null,
    partId,
    savedAt: Number(record.savedAt) || 0,
  };
}

/**
 * Mirror the live editor buffer. Callers should debounce; this is safe to call
 * on every keystroke either way.
 *
 * `partId` binds the draft to the active assembly row so hydrate never applies
 * FilletKilla's buffer onto a newly created cube part (or any other row).
 *
 * @param {{ script: string, filename?: string|null, partId?: string|null }} state
 * @returns {Promise<boolean>} true when the draft is durable
 */
export async function saveEditorDraft({ script, filename = null, partId = null } = {}) {
  if (typeof script !== 'string') return false;
  const bound = partId != null && String(partId) !== '' ? String(partId) : null;
  const record = {
    script,
    filename: filename || null,
    partId: bound,
    savedAt: Date.now(),
  };
  const { ok } = await runTx('readwrite', (store) => store.put(record, DRAFT_KEY));
  if (ok) return true;
  return writeFallback(record);
}

/**
 * @returns {Promise<{ script: string, filename: string|null, partId: string|null, savedAt: number }|null>}
 */
export async function loadEditorDraft() {
  const { ok, value } = await runTx('readonly', (store) => store.get(DRAFT_KEY));
  const record = ok ? normalize(value) : null;
  return record || normalize(readFallback());
}

/** Drop the draft (New / explicit reset). */
export async function clearEditorDraft() {
  await runTx('readwrite', (store) => store.delete(DRAFT_KEY));
  try {
    localStorage.removeItem(FALLBACK_KEY);
  } catch { /* nothing to clear */ }
}

export default {
  saveEditorDraft,
  loadEditorDraft,
  clearEditorDraft,
};
