/**
 * Assembly document + part script bytes.
 *
 * The document store holds serializeAssembly() output only (ids, names,
 * visibility, order, optional position). Script text lives in the parts
 * store, keyed by the row id: a repo path in git mode, an IndexedDB key
 * in local mode. A separate database from the editor draft so the two
 * schemas do not fight.
 */
import { serializeAssembly } from './assembly.js';
import { idbWithTimeout, IDB_OP_TIMEOUT_MS } from './idbWithTimeout.js';

const DB_NAME = 'surfcad-assembly';
const DB_VERSION = 1;
const DOC_STORE = 'assembly';
const PART_STORE = 'parts';
const DOC_KEY = 'current';

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
      console.warn('[Assembly] indexedDB.open threw:', err);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
      if (!db.objectStoreNames.contains(PART_STORE)) db.createObjectStore(PART_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch { /* already closing */ }
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      console.warn('[Assembly] indexedDB.open failed:', req.error);
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
  return idbWithTimeout(dbPromise, IDB_OP_TIMEOUT_MS, 'Assembly open').catch((err) => {
    console.warn('[Assembly] indexedDB.open timed out:', err?.message || err);
    dbPromise = null;
    return null;
  });
}

function runTx(storeName, mode, work) {
  const op = openDB().then((db) => {
    if (!db) return { ok: false, value: null };
    return new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(storeName, mode);
      } catch (err) {
        console.warn('[Assembly] transaction failed:', err);
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
      const req = work(tx.objectStore(storeName));
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => finish({ ok: true, value: out });
      tx.onabort = () => finish({ ok: false, value: null });
      tx.onerror = () => finish({ ok: false, value: null });
    });
  }).catch((err) => {
    console.warn('[Assembly] store unavailable:', err);
    return { ok: false, value: null };
  });
  return idbWithTimeout(op, IDB_OP_TIMEOUT_MS, 'Assembly tx').catch((err) => {
    console.warn('[Assembly] tx timed out:', err?.message || err);
    return { ok: false, value: null };
  });
}

export async function loadAssemblyDocument() {
  const { ok, value } = await runTx(DOC_STORE, 'readonly', (store) => store.get(DOC_KEY));
  if (!ok || !value) return null;
  try {
    const clean = serializeAssembly(value);
    const raw = typeof value.name === 'string' ? value.name.trim() : '';
    // Older documents omitted a blank name. Write Assembly back so the next
    // load already has it.
    if (!raw && clean.name) await saveAssemblyDocument(clean);
    return clean;
  } catch {
    return null;
  }
}

export async function saveAssemblyDocument(doc) {
  const clean = serializeAssembly(doc);
  const { ok } = await runTx(DOC_STORE, 'readwrite', (store) => store.put(clean, DOC_KEY));
  return ok ? clean : null;
}

export async function loadPartScript(id) {
  if (!id) return null;
  const { ok, value } = await runTx(PART_STORE, 'readonly', (store) => store.get(String(id)));
  if (!ok || !value || typeof value.script !== 'string') return null;
  return value.script;
}

export async function savePartScript(id, script) {
  if (!id || typeof script !== 'string') return false;
  const record = { id: String(id), script, savedAt: Date.now() };
  const { ok } = await runTx(PART_STORE, 'readwrite', (store) => store.put(record, record.id));
  return ok;
}

export async function deletePartScript(id) {
  if (!id) return false;
  const { ok } = await runTx(PART_STORE, 'readwrite', (store) => store.delete(String(id)));
  return ok;
}

export async function loadPartScripts(ids) {
  const out = {};
  for (const id of ids || []) {
    const script = await loadPartScript(id);
    if (typeof script === 'string') out[id] = script;
  }
  return out;
}
