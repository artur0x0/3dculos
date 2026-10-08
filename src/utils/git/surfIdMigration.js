/**
 * One-time migration off the legacy `local-` surf-id prefix.
 *
 * IndexedDB is rewritten first (callers). Then one outbox commit rewrites
 * `@surf-id` headers and `.surf.json` id / copiedFrom / group partIds.
 * Only a value that passes `isLocalSurfId` changes, and only by dropping
 * the prefix. A second pass is a no-op. Part paths and script bodies stay.
 * The commit has no deletes.
 */
import {
  isLocalSurfId,
  isSurfId,
  isSurfJsonPath,
  promoteSurfId,
  readSurfId,
  rewriteSurfIdFields,
  stripSurfId,
  withSurfId,
} from './surfId.js';

/** Bare id when `value` is a legacy local surf id. Every other string stays. */
export function canonicalSurfId(value) {
  return isLocalSurfId(value) ? promoteSurfId(value) : value;
}

/** True when two ids are the same body, with or without a legacy prefix. */
export function sameSurfIdentity(a, b) {
  if (!a || !b) return false;
  const left = canonicalSurfId(a);
  const right = canonicalSurfId(b);
  return left === right && isSurfId(left);
}

function noteLocal(map, value) {
  if (isLocalSurfId(value) && !map.has(value)) map.set(value, promoteSurfId(value));
}

function mapFromSurfJson(text) {
  const map = new Map();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return map;
  }
  if (!raw || typeof raw !== 'object') return map;
  for (const part of raw.parts || []) {
    noteLocal(map, part?.id);
    noteLocal(map, part?.copiedFrom);
  }
  for (const group of raw.groups || []) {
    noteLocal(map, group?.id);
    for (const id of group?.partIds || []) noteLocal(map, id);
  }
  return map;
}

/**
 * Rewrite one vault file. `.js` changes only a legacy header. `.surf.json`
 * changes only surf-id fields. Anything else is returned as-is.
 */
export function rewriteVaultFile(path, content) {
  if (typeof content !== 'string') return content;
  const filePath = String(path || '');
  if (filePath.endsWith('.js')) {
    const id = readSurfId(content);
    if (!id || !isLocalSurfId(id)) return content;
    return withSurfId(content, promoteSurfId(id));
  }
  if (isSurfJsonPath(filePath)) {
    const map = mapFromSurfJson(content);
    if (!map.size) return content;
    return rewriteSurfIdFields(content, map);
  }
  return content;
}

function rewriteScriptMap(scripts) {
  let changed = false;
  const next = {};
  for (const [path, text] of Object.entries(scripts)) {
    if (typeof text !== 'string') {
      next[path] = text;
      continue;
    }
    const filePath = /\.js$|\.surf\.json$/.test(path) ? path : `${path}.js`;
    const rewritten = rewriteVaultFile(filePath, text);
    if (rewritten !== text) changed = true;
    next[path] = rewritten;
  }
  return changed ? next : scripts;
}

function rewriteExactIds(value) {
  if (typeof value === 'string') return canonicalSurfId(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteExactIds(item);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    let rewritten = item;
    if (key === 'content' && typeof item === 'string') {
      rewritten = rewriteVaultFile(value.path || value.to || 'part.js', item);
    } else if (key === 'assemblyText' && typeof item === 'string') {
      rewritten = rewriteVaultFile(value.assemblyPath || 'assemblies/Assembly/.surf.json', item);
    } else if (key === 'scripts' && item && typeof item === 'object' && !Array.isArray(item)) {
      rewritten = rewriteScriptMap(item);
    } else {
      rewritten = rewriteExactIds(item);
    }
    if (rewritten !== item) changed = true;
    next[key] = rewritten;
  }
  return changed ? next : value;
}

/** Rewrite surf ids on one outbox op. Returns the same object when nothing changes. */
export function migrateOutboxOp(op) {
  if (!op || typeof op !== 'object') return op;
  let changed = false;
  const files = Array.isArray(op.files)
    ? op.files.map((file) => {
      if (!file || file.delete || typeof file.content !== 'string') return file;
      const content = rewriteVaultFile(file.path, file.content);
      if (content === file.content) return file;
      changed = true;
      return { ...file, content };
    })
    : op.files;
  const payload = rewriteExactIds(op.payload || {});
  if (payload !== (op.payload || {})) changed = true;
  if (!changed) return op;
  return { ...op, files, payload };
}

/**
 * Rewrite a working assembly and its scripts. Row ids (paths, `local:` keys,
 * and non-surf `local-` keys) stay. Returns the same objects when nothing changes.
 */
export function migrateAssemblyRecords({ doc, scripts } = {}) {
  const map = new Map();
  for (const part of doc?.parts || []) {
    noteLocal(map, part?.surfId);
    noteLocal(map, part?.copiedFrom);
  }
  for (const group of doc?.groups || []) {
    noteLocal(map, group?.id);
    for (const id of group?.partIds || []) noteLocal(map, id);
  }
  for (const text of Object.values(scripts || {})) noteLocal(map, readSurfId(text));
  if (!map.size) return { doc, scripts: scripts || {}, map: {}, changed: false };

  let scriptsChanged = false;
  const nextScripts = {};
  for (const [path, text] of Object.entries(scripts || {})) {
    const id = readSurfId(text);
    if (id && map.has(id)) {
      nextScripts[path] = withSurfId(text, map.get(id));
      scriptsChanged = true;
    } else {
      nextScripts[path] = text;
    }
  }
  const parts = (doc?.parts || []).map((part) => {
    const surfId = map.get(part?.surfId) || part?.surfId;
    const copiedFrom = map.get(part?.copiedFrom) || part?.copiedFrom;
    if (surfId === part?.surfId && copiedFrom === part?.copiedFrom) return part;
    return {
      ...part,
      ...(surfId ? { surfId } : {}),
      ...(copiedFrom ? { copiedFrom } : {}),
    };
  });
  const groups = Array.isArray(doc?.groups)
    ? doc.groups.map((group) => {
      const id = map.get(group?.id) || group?.id;
      const partIds = (group?.partIds || []).map((partId) => map.get(partId) || partId);
      if (id === group?.id && partIds.every((partId, i) => partId === group.partIds[i])) return group;
      return { ...group, id, partIds };
    })
    : doc?.groups;
  return {
    doc: { ...doc, parts, ...(Array.isArray(groups) ? { groups } : {}) },
    scripts: scriptsChanged ? nextScripts : (scripts || {}),
    map: Object.fromEntries(map),
    changed: true,
  };
}

/**
 * Throw when a migration result drops a part file, changes its script body,
 * deletes a path, or moves a `.surf.json` part path.
 */
export function assertPartFilesPreserved(before, after) {
  const beforeJs = new Map();
  for (const entry of before || []) {
    if (!entry?.path || typeof entry.content !== 'string') continue;
    if (String(entry.path).endsWith('.js')) beforeJs.set(entry.path, entry.content);
  }
  const afterJs = new Map();
  for (const entry of after || []) {
    if (entry?.delete) {
      throw new Error(`Surf id migration refuses to delete ${entry.path || 'a file'}`);
    }
    if (!entry?.path || typeof entry.content !== 'string') continue;
    if (String(entry.path).endsWith('.js')) afterJs.set(entry.path, entry.content);
  }
  for (const [path, content] of beforeJs) {
    if (!afterJs.has(path)) throw new Error(`Surf id migration lost part file ${path}`);
    if (stripSurfId(afterJs.get(path)) !== stripSurfId(content)) {
      throw new Error(`Surf id migration overwrote part file ${path}`);
    }
  }
  const partPaths = (text) => {
    try {
      const raw = JSON.parse(text);
      if (!raw || !Array.isArray(raw.parts)) return null;
      return raw.parts.map((part) => part?.path);
    } catch {
      return null;
    }
  };
  for (const entry of before || []) {
    if (!isSurfJsonPath(entry?.path) || typeof entry.content !== 'string') continue;
    const next = (after || []).find((item) => item?.path === entry.path && typeof item.content === 'string');
    if (!next) throw new Error(`Surf id migration lost ${entry.path}`);
    const from = partPaths(entry.content);
    const to = partPaths(next.content);
    if (from && to && JSON.stringify(from) !== JSON.stringify(to)) {
      throw new Error(`Surf id migration changed part paths in ${entry.path}`);
    }
  }
}

/** The outbox commit must not carry a delete. */
export function assertMigrationCommitSafe(files) {
  for (const file of files || []) {
    if (file?.delete) throw new Error('Surf id migration refuses to delete a part file');
  }
}

function applyWrites(entries, writes) {
  const byPath = new Map(writes.map((file) => [file.path, file.content]));
  return (entries || []).map((entry) => (
    byPath.has(entry.path) ? { path: entry.path, content: byPath.get(entry.path) } : entry
  ));
}

/**
 * One commit of rewritten vault files. No deletes. Empty when nothing is
 * still prefixed. Throws instead of returning a plan that loses a part file.
 */
export function planSurfIdMigrationCommit(entries) {
  const list = (entries || []).filter((entry) => entry?.path && typeof entry.content === 'string');
  const writes = [];
  for (const entry of list) {
    const content = rewriteVaultFile(entry.path, entry.content);
    if (content !== entry.content) writes.push({ path: entry.path, content });
  }
  const after = applyWrites(list, writes);
  assertPartFilesPreserved(list, after);
  assertMigrationCommitSafe(writes);
  return { files: writes, changed: writes.length > 0 };
}

/** Read part scripts and assembly documents for the migration scan. */
export async function readVaultIdEntries(adapter, repo, branch) {
  const tree = await adapter.listTree(repo, branch);
  const entries = [];
  for (const entry of tree || []) {
    const path = entry?.path ?? entry;
    if (typeof path !== 'string') continue;
    if (!path.endsWith('.js') && !isSurfJsonPath(path)) continue;
    // eslint-disable-next-line no-await-in-loop
    const file = await adapter.readFile(repo, path, branch);
    if (typeof file?.content === 'string') entries.push({ path, content: file.content });
  }
  return entries;
}

/**
 * A part whose tip file is this row is already in the repo. Set `isSynced`
 * so a reload between the commit and the local flag update does not leave
 * Add to Repo showing. A legacy prefixed header matches the bare id.
 */
export function reconcileSyncedFromTip(doc, tipScripts) {
  let changed = false;
  const parts = (doc?.parts || []).map((part) => {
    const text = tipScripts?.[part?.id];
    if (typeof text !== 'string') return part;
    const header = readSurfId(text);
    const onTip = !header || !part?.surfId || sameSurfIdentity(part.surfId, header);
    if (!onTip || part.isSynced === true) return part;
    changed = true;
    return { ...part, isSynced: true };
  });
  if (!changed) return { doc, changed: false };
  return { doc: { ...doc, parts }, changed: true };
}

/** Set `isSynced` true on rows whose path was in a successful push. */
export function markPartsSynced(doc, partIds) {
  const ids = new Set((partIds || []).map((id) => String(id)));
  if (!ids.size || !doc) return { doc, changed: false };
  let changed = false;
  const parts = (doc.parts || []).map((part) => {
    if (!ids.has(String(part?.id)) || part.isSynced === true) return part;
    changed = true;
    return { ...part, isSynced: true };
  });
  if (!changed) return { doc, changed: false };
  return { doc: { ...doc, parts }, changed: true };
}
