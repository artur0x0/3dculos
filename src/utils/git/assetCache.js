/**
 * IndexedDB cache of vault mesh bytes, keyed by git blob sha.
 *
 * `putAsset(bytes)` stores a copy and returns sha1("blob " + len + NUL + bytes),
 * the same id GitHub uses for that blob. `getAssetBytes(sha)` returns a
 * Uint8Array copy, or null. Memory mirrors the database so a flush in the
 * same turn (and goldens without IndexedDB) can read the bytes back.
 * Clear local cache calls `clearAssetCache`.
 */
import { idbWithTimeout, IDB_OP_TIMEOUT_MS } from '../idbWithTimeout.js';
import { gitBlobSha, toUint8Array } from './binaryContent.js';

const DB_NAME = 'surfcad-assets';
const DB_VERSION = 1;
const STORE = 'assets';

let dbPromise = null;
const memory = new Map();

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
      console.warn('[AssetCache] indexedDB.open threw:', err);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
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
      console.warn('[AssetCache] indexedDB.open failed:', req.error);
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
  return idbWithTimeout(dbPromise, IDB_OP_TIMEOUT_MS, 'AssetCache open').catch((err) => {
    console.warn('[AssetCache] indexedDB.open timed out:', err?.message || err);
    dbPromise = null;
    return null;
  });
}

function txDone(db, mode, work) {
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      console.warn('[AssetCache] transaction failed:', err);
      resolve(null);
      return;
    }
    let out = null;
    const req = work(tx.objectStore(STORE));
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => resolve(out);
    tx.onabort = () => resolve(null);
    tx.onerror = () => resolve(null);
  });
}

/**
 * Store `bytes` and return the git blob sha.
 * Accepts Uint8Array or ArrayBuffer.
 */
export async function putAsset(bytes) {
  const data = toUint8Array(bytes);
  const sha = gitBlobSha(data);
  memory.set(sha, data.slice());
  const db = await openDB();
  if (db) await txDone(db, 'readwrite', (store) => store.put(data.slice(), sha));
  return sha;
}

/** Uint8Array copy, or null when this sha is not cached. */
export async function getAssetBytes(sha) {
  const key = String(sha || '');
  if (!key) return null;
  const hit = memory.get(key);
  if (hit) return hit.slice();
  const db = await openDB();
  if (!db) return null;
  const stored = await txDone(db, 'readonly', (store) => store.get(key));
  if (!(stored instanceof Uint8Array) && !(stored instanceof ArrayBuffer) && !ArrayBuffer.isView(stored)) {
    return null;
  }
  const bytes = stored instanceof Uint8Array ? stored.slice() : toUint8Array(stored);
  memory.set(key, bytes.slice());
  return bytes;
}

/** Drop the mesh cache (Clear local cache). */
export async function clearAssetCache() {
  memory.clear();
  const db = await openDB();
  if (!db) return false;
  const out = await txDone(db, 'readwrite', (store) => store.clear());
  return out != null;
}
