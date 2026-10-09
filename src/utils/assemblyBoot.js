/**
 * What a reload is allowed to open.
 *
 * The last-opened pointer is localStorage `surfcad.lastAssembly`, a map
 * keyed by user id: `{ name, activeId, source, savedAt }`. `activeId` may
 * still be a legacy `local:` row id; comparisons use the bare id.
 *
 * The working copy is global IndexedDB `surfcad-assembly` / store
 * `assembly` / key `current` (not per-user). A reload must not treat a
 * missing or timed-out read as "no assembly" and write the stock demo
 * (`Part (1)` in `Assembly`) over that key, and it must not enqueue an
 * outbox op or create a vault assembly while auth or the vault is unresolved.
 */
import { stripLocalRowPrefix } from './git/localPartIdMigration.js';

export const LAST_OPENED_STORAGE_KEY = 'surfcad.lastAssembly';
export const ASSEMBLY_DOC_DB = 'surfcad-assembly';
export const ASSEMBLY_DOC_STORE = 'assembly';
export const ASSEMBLY_DOC_KEY = 'current';

const STOCK_PART_NAMES = new Set(['Part (1)', 'Part 1', 'part1']);

export function bootUserId(user) {
  if (!user || typeof user !== 'object') return '';
  const id = user.id || user._id || user.githubId || user.email || '';
  return String(id || '');
}

/** Bare row id. A legacy `local:` prefix (possibly repeated) is stripped. */
export function canonicalRowId(id) {
  return stripLocalRowPrefix(id);
}

export function isBootDemoDocument(doc) {
  if (!doc || typeof doc !== 'object') return false;
  const name = String(doc.name || '').trim();
  if (name && name !== 'Assembly') return false;
  const parts = Array.isArray(doc.parts) ? doc.parts : [];
  if (parts.length !== 1) return false;
  const pname = String(parts[0]?.name || '').trim();
  return !pname || STOCK_PART_NAMES.has(pname);
}

export function assemblyIdentity(doc) {
  if (!doc || typeof doc !== 'object') return '';
  return String(doc.name || '').trim() || 'Assembly';
}

export function sameOpenedAssembly(pointer, doc) {
  if (!pointer || !doc) return false;
  const left = String(pointer.name || '').trim();
  if (!left) return false;
  return left === assemblyIdentity(doc);
}

/**
 * `me` is `/api/auth/me`: pending | in | out.
 * `refresh` is the quiet session / GitHub-token retry: idle | pending | ok | failed.
 */
export function resolveBootAuth({ me = 'pending', refresh = 'idle' } = {}) {
  if (me === 'pending' || me === 'in') return me === 'in' ? 'in' : 'pending';
  if (refresh === 'pending' || refresh === 'ok') return refresh === 'ok' ? 'in' : 'pending';
  return 'out';
}

export function readLastOpenedMap(storage) {
  if (!storage || typeof storage.getItem !== 'function') return {};
  try {
    const raw = storage.getItem(LAST_OPENED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function pointerForUser(map, userId) {
  const id = String(userId || '');
  if (!id || !map || typeof map !== 'object') return null;
  const row = map[id];
  if (!row || typeof row !== 'object') return null;
  const name = String(row.name || '').trim();
  if (!name) return null;
  return {
    name,
    activeId: row.activeId != null ? String(row.activeId) : '',
    source: row.source === 'git' ? 'git' : 'local',
    savedAt: Number(row.savedAt) || 0,
  };
}

export function writeLastOpenedMap(storage, map) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(LAST_OPENED_STORAGE_KEY, JSON.stringify(map || {}));
    return true;
  } catch {
    return false;
  }
}

/** Remember the assembly the signed-in user actually has open. Not a boot seed. */
export function rememberLastOpened(storage, userId, doc) {
  const id = String(userId || '');
  const name = assemblyIdentity(doc);
  if (!id || !doc || !Array.isArray(doc.parts) || !doc.parts.length || !name) return null;
  const map = readLastOpenedMap(storage);
  map[id] = {
    name,
    activeId: doc.activeId != null ? String(doc.activeId) : '',
    source: doc.source === 'git' ? 'git' : 'local',
    savedAt: Date.now(),
  };
  writeLastOpenedMap(storage, map);
  return map[id];
}

/**
 * Signed-in target. A per-user pointer that names a different assembly than
 * the global working copy wins (another user, or the demo seed that used to
 * overwrite `current`). A legacy `local:` active id still counts as the
 * same assembly when the names match.
 */
export function chooseSignedInTarget({
  cacheStatus = 'pending',
  cachedDoc = null,
  pointer = null,
} = {}) {
  const cacheHit = cacheStatus === 'hit' && cachedDoc && Array.isArray(cachedDoc.parts) && cachedDoc.parts.length > 0;
  if (pointer && cacheHit && !sameOpenedAssembly(pointer, cachedDoc)) {
    return {
      kind: 'vault',
      name: pointer.name,
      reason: isBootDemoDocument(cachedDoc) ? 'pointer-over-demo' : 'pointer-over-other-doc',
    };
  }
  if (cacheHit) {
    return { kind: 'cache', doc: cachedDoc, reason: 'cache' };
  }
  if (pointer?.name) {
    return { kind: 'vault', name: pointer.name, reason: cacheStatus === 'timeout' ? 'pointer-after-timeout' : 'pointer' };
  }
  return { kind: 'none', reason: cacheStatus === 'timeout' ? 'timeout' : 'empty' };
}

function blocked() {
  return { persist: false, commit: false, enqueue: false, createAssembly: false };
}

/**
 * Reload decision. `persist`, `commit`, `enqueue`, and `createAssembly` are
 * always false: opening must not write the demo or push an outbox op.
 */
export function planReloadAssembly({
  me = 'pending',
  refresh = 'idle',
  cacheStatus = 'pending',
  cachedDoc = null,
  pointer = null,
  userId = '',
  vaultStatus = 'idle',
  githubConnected = false,
} = {}) {
  const auth = resolveBootAuth({ me, refresh });
  const base = blocked();
  if (auth === 'pending') {
    return { ...base, action: 'wait', chip: 'unchanged', reason: 'auth-pending', doc: null, name: '' };
  }
  if (auth === 'out') {
    const reason = refresh === 'failed' ? 'session-refresh-failed' : 'signed-out';
    return { ...base, action: 'clear', chip: 'clear', reason, doc: null, name: '' };
  }

  if (cacheStatus === 'pending') {
    return { ...base, action: 'wait', chip: 'unchanged', reason: 'cache-pending', doc: null, name: '' };
  }

  const ownedPointer = pointerForUser({ [String(userId || '')]: pointer }, userId) || pointer;
  const target = chooseSignedInTarget({
    cacheStatus,
    cachedDoc,
    pointer: ownedPointer,
  });

  if (target.kind === 'cache') {
    return {
      ...base,
      action: 'reopen-cache',
      chip: 'show',
      reason: target.reason,
      doc: target.doc,
      name: assemblyIdentity(target.doc),
    };
  }

  if (target.kind === 'vault') {
    if (!githubConnected || vaultStatus === 'unavailable') {
      return {
        ...base,
        action: 'clear',
        chip: 'clear',
        reason: 'vault-unavailable',
        doc: null,
        name: target.name,
      };
    }
    if (vaultStatus === 'failed') {
      return {
        ...base,
        action: 'clear',
        chip: 'clear',
        reason: 'vault-failed',
        doc: null,
        name: target.name,
      };
    }
    if (vaultStatus !== 'ready') {
      return {
        ...base,
        action: 'wait',
        chip: 'unchanged',
        reason: 'vault-pending',
        doc: null,
        name: target.name,
      };
    }
    return {
      ...base,
      action: 'reopen-vault',
      chip: 'show',
      reason: target.reason,
      doc: null,
      name: target.name,
    };
  }

  return {
    ...base,
    action: 'clear',
    chip: 'clear',
    reason: 'nothing-stored',
    doc: null,
    name: '',
  };
}

/** A boot plan never writes. Used so a demo seed cannot land in IndexedDB or the outbox. */
export function bootWriteAllowed(plan) {
  if (!plan) return false;
  return plan.persist === true || plan.commit === true || plan.enqueue === true || plan.createAssembly === true;
}

/**
 * True when saving `incoming` would replace a real last-opened assembly
 * with the stock demo. A timed-out read (stored doc still on disk) is the
 * same clobber.
 */
export function bootWouldClobber(storedDoc, incoming) {
  if (!incoming || !isBootDemoDocument(incoming)) return false;
  if (!storedDoc) return true;
  return !isBootDemoDocument(storedDoc);
}
