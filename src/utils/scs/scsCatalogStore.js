/**
 * IndexedDB cache for the joined SendCutSend catalog (one entry).
 * Separate DB from CAD data so Clear local cache keeps the catalog.
 */
import { idbWithTimeout, IDB_OP_TIMEOUT_MS } from '../idbWithTimeout.js';

const DB_NAME = 'surfcad-scs';
const DB_VERSION = 1;
const STORE = 'catalog';
const KEY = 'catalog-v1.2';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

function tx(mode, run) {
  return idbWithTimeout(openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = run(store);
    t.oncomplete = () => {
      db.close();
      resolve(req?.result ?? null);
    };
    t.onerror = () => {
      db.close();
      reject(t.error || new Error('IndexedDB transaction failed'));
    };
  })), IDB_OP_TIMEOUT_MS, 'SCS catalog cache');
}

export const scsCatalogCache = {
  get: () => tx('readonly', (store) => store.get(KEY)),
  put: (entry) => tx('readwrite', (store) => store.put(entry, KEY)),
};
