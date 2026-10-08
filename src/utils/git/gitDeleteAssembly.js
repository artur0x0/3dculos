/**
 * Delete an assembly in one commit.
 *
 * Keep parts: every part script in assemblies/<Name>/ moves to parts/.
 * A name already in parts/ gets a numeric suffix (Bracket 2.js).
 * Delete parts: unreferenced scripts are removed; a part any other
 * assembly references is still moved to parts/. Either way the folder's
 * .surf.json is deleted, and every other .surf.json that pointed at those
 * paths is rewritten in the same commit. Match a ref by stable id first,
 * then by path.
 *
 * Groups whose source was the deleted assembly keep their name. source
 * becomes null.
 *
 * The local cache is one snapshot. Swap it only after the next tree is
 * fully built, so a failure cannot leave some paths moved and others not.
 */
import { serializeAssembly, DEFAULT_ASSEMBLY_NAME } from '../assembly.js';
import { fileDelete, fileWrite } from './githubAdapterInterface.js';
import {
  assemblyDir,
  assemblyFilePath,
  legacyAssemblyFilePath,
  listAssemblies,
  parseVaultPath,
  sharedPartPath,
  vaultSegment,
} from './vaultLayout.js';
import { isSurfId, readSurfId } from './surfId.js';
import { parseSurfJson, stringifySurfJson } from './surfJson.js';
import { buildRenameCommitFiles, projectFiles } from './gitRename.js';

const DELETE_MESSAGE = (name) => `Delete assembly ${name}`;

function partLabel(path) {
  const info = parseVaultPath(path);
  return info?.part || String(path || '').split('/').pop()?.replace(/\.js$/i, '') || 'Part';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Next free parts/<Name>.js. `taken` includes paths already claimed. */
export function sharedPathForMove(partName, taken) {
  const base = vaultSegment(partName) || 'Part';
  let path = sharedPartPath(base);
  if (!taken.has(path)) {
    taken.add(path);
    return path;
  }
  for (let n = 2; n < 1000; n += 1) {
    path = sharedPartPath(`${base} ${n}`);
    if (!taken.has(path)) {
      taken.add(path);
      return path;
    }
  }
  throw new Error(`No free parts/ name for ${base}`);
}

function assemblyPartFiles(entries, name) {
  return (entries || []).filter((entry) => {
    const info = parseVaultPath(entry?.path);
    return info?.kind === 'assembly-part' && info.assembly === name;
  });
}

function otherAssemblyFiles(entries, name) {
  return (entries || []).filter((entry) => {
    const info = parseVaultPath(entry?.path);
    return info?.kind === 'assembly' && info.assembly !== name;
  });
}

/**
 * A ref hits a part when its stable id matches, otherwise when its path does.
 * Id wins when it matches; a missing or unknown id falls back to the path.
 */
export function refMatchesPart(ref, part) {
  if (!ref || !part) return false;
  if (ref.id && part.surfId && ref.id === part.surfId) return true;
  if (ref.id && part.surfId && ref.id !== part.surfId) {
    return ref.path === part.path;
  }
  return !!ref.path && ref.path === part.path;
}

function describeParts(entries, name) {
  const metaPath = assemblyFilePath(name);
  const legacyPath = legacyAssemblyFilePath(name);
  const meta = (entries || []).find((entry) => entry.path === metaPath)
    || (entries || []).find((entry) => entry.path === legacyPath);
  const raw = meta ? parseJson(meta.content) : null;
  const rows = Array.isArray(raw?.parts) ? raw.parts : [];
  return assemblyPartFiles(entries, name).map((file) => {
    const row = rows.find((part) => part?.path === file.path);
    const header = readSurfId(file.content || '');
    const surfId = (header && isSurfId(header))
      ? header
      : (isSurfId(row?.id) ? row.id : null);
    const nameFromRow = typeof row?.name === 'string' ? row.name.trim() : '';
    return {
      path: file.path,
      content: file.content ?? '',
      surfId,
      name: nameFromRow || partLabel(file.path),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function findReferencedPart(ref, parts) {
  if (!ref) return null;
  if (ref.id) {
    const byId = parts.find((part) => part.surfId && part.surfId === ref.id);
    if (byId) return byId;
  }
  if (ref.path) return parts.find((part) => part.path === ref.path) || null;
  return null;
}

function referencesFrom(entries, name, parts) {
  const used = new Map(parts.map((part) => [part.path, []]));
  for (const file of otherAssemblyFiles(entries, name)) {
    const raw = parseJson(file.content);
    if (!raw || !Array.isArray(raw.parts)) continue;
    const asm = typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : parseVaultPath(file.path)?.assembly;
    if (!asm) continue;
    for (const ref of raw.parts) {
      const hit = findReferencedPart(ref, parts);
      if (!hit) continue;
      const list = used.get(hit.path);
      if (!list.includes(asm)) list.push(asm);
    }
  }
  for (const list of used.values()) list.sort((a, b) => a.localeCompare(b));
  return used;
}

function rewriteSurfForDelete(text, { moves, sourcePaths }) {
  const raw = parseJson(text);
  if (!raw || typeof raw !== 'object') return text;
  const byId = new Map(moves.filter((move) => move.surfId).map((move) => [move.surfId, move]));
  const byPath = new Map(moves.map((move) => [move.from, move]));
  const matchRef = (ref) => {
    if (!ref) return null;
    if (ref.id && byId.has(ref.id)) return byId.get(ref.id);
    if (ref.path && byPath.has(ref.path)) return byPath.get(ref.path);
    return null;
  };
  let changed = false;
  if (Array.isArray(raw.parts)) {
    for (const part of raw.parts) {
      const move = matchRef(part);
      if (move && move.to !== part.path) {
        part.path = move.to;
        changed = true;
      }
    }
  }
  if (typeof raw.activeId === 'string') {
    const move = byPath.get(raw.activeId)
      || moves.find((row) => row.from === raw.activeId);
    if (move && move.to !== raw.activeId) {
      raw.activeId = move.to;
      changed = true;
    }
  }
  if (Array.isArray(raw.groups)) {
    for (const group of raw.groups) {
      if (group && sourcePaths.has(group.source)) {
        group.source = null;
        changed = true;
      }
    }
  }
  if (!changed) return text;
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/**
 * File list for one delete commit.
 * mode 'keep' moves every part script in the folder.
 * mode 'drop' deletes scripts no other assembly references.
 * -> { assemblyName, assemblyPath, legacyPath, mode, message, partCount,
 *      referenced, moves, files }
 */
export function planDeleteAssembly(entries, assemblyName, mode = 'keep', { scripts = null } = {}) {
  const name = vaultSegment(assemblyName);
  if (!name) throw new Error('Empty assembly name');
  if (mode !== 'keep' && mode !== 'drop') throw new Error(`Unknown delete mode "${mode}"`);
  const parts = describeParts(entries, name);
  const usedBy = referencesFrom(entries, name, parts);
  const referenced = parts
    .filter((part) => (usedBy.get(part.path) || []).length > 0)
    .map((part) => ({
      name: part.name,
      path: part.path,
      surfId: part.surfId,
      assemblies: usedBy.get(part.path) || [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const keepSet = new Set(
    mode === 'keep' ? parts.map((part) => part.path) : referenced.map((part) => part.path),
  );
  const taken = new Set(
    (entries || [])
      .map((entry) => entry.path)
      .filter((path) => parseVaultPath(path)?.kind === 'shared-part'),
  );
  const moves = [];
  for (const part of parts) {
    if (!keepSet.has(part.path)) continue;
    const override = scripts && typeof scripts[part.path] === 'string' ? scripts[part.path] : null;
    moves.push({
      from: part.path,
      to: sharedPathForMove(partLabel(part.path), taken),
      surfId: part.surfId,
      name: part.name,
      content: override != null ? override : part.content,
    });
  }
  const sourcePaths = new Set([assemblyFilePath(name), legacyAssemblyFilePath(name)]);
  const prefix = `${assemblyDir(name)}/`;
  const writes = new Map();
  const deletes = new Set();
  for (const entry of entries || []) {
    if (typeof entry?.path === 'string' && entry.path.startsWith(prefix)) deletes.add(entry.path);
  }
  for (const move of moves) {
    writes.set(move.to, move.content ?? '');
    deletes.add(move.from);
  }
  for (const file of otherAssemblyFiles(entries, name)) {
    const next = rewriteSurfForDelete(file.content || '', { moves, sourcePaths });
    if (next !== (file.content || '')) writes.set(file.path, next);
  }
  for (const path of writes.keys()) deletes.delete(path);
  const files = [
    ...[...writes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, content]) => fileWrite(path, content)),
    ...[...deletes].sort().map((path) => fileDelete(path)),
  ];
  return {
    assemblyName: name,
    assemblyPath: assemblyFilePath(name),
    legacyPath: legacyAssemblyFilePath(name),
    mode,
    message: DELETE_MESSAGE(name),
    partCount: parts.length,
    referenced,
    moves,
    files,
  };
}

/** Dialog facts: part count and the parts other assemblies still reference. */
export function previewDeleteAssembly(entries, assemblyName, opts) {
  const plan = planDeleteAssembly(entries, assemblyName, 'keep', opts);
  return {
    assemblyName: plan.assemblyName,
    partCount: plan.partCount,
    referenced: plan.referenced,
  };
}

/**
 * Baseline after a delete. A switch or an empty document is the new copy.
 * An in-place update keeps the previous baseline for any file this commit
 * did not write, so an unsaved edit stays dirty.
 */
export function baselineAfterDelete(captured, { kind, files = [], pairs = [], previous = null } = {}) {
  if (kind !== 'update' || !previous || !captured) return captured;
  const wrote = (path) => (files || []).some((file) => file?.path === path && !file.delete);
  const next = {
    ...captured,
    scripts: { ...(captured.scripts || {}) },
  };
  if (!wrote(next.assemblyPath)) next.assemblyText = previous.assemblyText;
  const fromPath = new Map((pairs || []).map((pair) => [pair.to, pair.from]));
  for (const id of Object.keys(next.scripts)) {
    if (wrote(id)) continue;
    const priorPath = fromPath.get(id) || id;
    if (previous.scripts && Object.prototype.hasOwnProperty.call(previous.scripts, priorPath)) {
      next.scripts[id] = previous.scripts[priorPath];
    }
  }
  return next;
}

/**
 * When the open assembly's .surf.json is part of the commit, write the
 * in-memory document so local edits and the baseline match that file.
 */
export function commitOpenAssemblyText(files, assemblyPath, doc) {
  if (!assemblyPath || !doc) return files || [];
  const text = stringifySurfJson(doc);
  let found = false;
  const next = (files || []).map((file) => {
    if (file?.path !== assemblyPath || file.delete) return file;
    found = true;
    return fileWrite(assemblyPath, text);
  });
  return found ? next : (files || []);
}

/** Apply queued ops onto a tree so a delete sees renames that are not pushed yet. */
export function projectPendingOps(entries, ops) {
  let current = entries || [];
  for (const op of ops || []) {
    if (!op || op.status === 'done') continue;
    if (op.op === 'rename' && op.payload) {
      const payload = op.payload;
      const plan = payload.kind === 'assembly'
        ? {
          kind: 'assembly',
          fromName: payload.fromName,
          toName: payload.toName,
          assemblyPath: payload.assemblyPath,
          assemblyText: payload.assemblyText,
          localFiles: payload.localFiles || [],
        }
        : {
          kind: 'part',
          surfId: payload.surfId,
          from: payload.from,
          to: payload.to,
          content: payload.content,
        };
      current = projectFiles(current, buildRenameCommitFiles({ entries: current, plan }).files);
    } else if (Array.isArray(op.files) && op.files.length) {
      current = projectFiles(current, op.files);
    }
  }
  return current;
}

function matchMove(part, moves) {
  if (part?.surfId) {
    const byId = moves.find((move) => move.surfId && move.surfId === part.surfId);
    if (byId) return byId;
  }
  return moves.find((move) => move.from === part?.id) || null;
}

/**
 * Open document after another assembly's parts moved.
 * Paths follow the stable id, then the old path. A group whose source was
 * the deleted assembly keeps its name and source becomes null.
 */
export function applyAssemblyDeleteToDoc(doc, scripts, plan) {
  const moves = plan?.moves || [];
  const sourcePaths = new Set([plan?.assemblyPath, plan?.legacyPath].filter(Boolean));
  const parts = (doc?.parts || []).map((part) => {
    const move = matchMove(part, moves);
    if (!move || move.to === part.id) return part;
    return { ...part, id: move.to };
  });
  const active = (doc?.parts || []).find((part) => part.id === doc?.activeId);
  const activeMove = active ? matchMove(active, moves) : null;
  const activeId = activeMove ? activeMove.to : doc?.activeId;
  const groups = (doc?.groups || []).map((group) => (
    sourcePaths.has(group?.source) ? { ...group, source: null } : group
  ));
  const nextScripts = { ...(scripts || {}) };
  const pairs = [];
  for (const move of moves) {
    if (!move?.from || !move?.to || move.from === move.to) continue;
    if (Object.prototype.hasOwnProperty.call(nextScripts, move.from)) {
      if (nextScripts[move.to] == null) nextScripts[move.to] = nextScripts[move.from];
      delete nextScripts[move.from];
      pairs.push({ from: move.from, to: move.to });
    }
  }
  return {
    doc: serializeAssembly({ ...doc, source: 'git', parts, groups, activeId }),
    scripts: nextScripts,
    pairs,
  };
}

/** Load one assembly out of a projected tree. Null when that folder is gone. */
export function assemblyFromEntries(entries, assemblyName) {
  const name = vaultSegment(assemblyName);
  if (!name) return null;
  const path = assemblyFilePath(name);
  const file = (entries || []).find((entry) => entry.path === path);
  if (!file) return null;
  let doc;
  try {
    doc = parseSurfJson(file.content);
  } catch {
    return null;
  }
  const byPath = new Map((entries || []).map((entry) => [entry.path, entry.content ?? '']));
  const scripts = {};
  for (const part of doc.parts || []) scripts[part.id] = byPath.get(part.id) ?? '';
  return { doc, scripts, assemblyPath: path };
}

/**
 * After the open assembly is deleted: the most recently opened remaining
 * assembly, else the first remaining name, else null (empty working copy).
 */
export function chooseAssemblyAfterDelete(names, { deleted, recent = [] } = {}) {
  const rest = [];
  const seen = new Set();
  for (const name of names || []) {
    const seg = vaultSegment(name) || '';
    if (!seg || seg === deleted || seen.has(seg)) continue;
    seen.add(seg);
    rest.push(seg);
  }
  if (!rest.length) return null;
  for (let i = (recent || []).length - 1; i >= 0; i -= 1) {
    const seg = vaultSegment(recent[i]) || '';
    if (seg && seg !== deleted && seen.has(seg)) return seg;
  }
  return rest[0];
}

/** Working copy with no parts, used when the last assembly was deleted. */
export function emptyGitAssembly() {
  return serializeAssembly({
    source: 'git',
    name: DEFAULT_ASSEMBLY_NAME,
    activeId: null,
    parts: [],
  });
}

/**
 * What the open document becomes. `entries` is the tree after the delete.
 * -> { kind: 'switch'|'update'|'empty', doc, scripts, pairs, name? }
 */
export function workingCopyAfterDelete(doc, scripts, entries, plan, { recent = [] } = {}) {
  const openName = vaultSegment(doc?.name);
  if (openName && openName === plan?.assemblyName) {
    const nextName = chooseAssemblyAfterDelete(listAssemblies(entries), {
      deleted: plan.assemblyName,
      recent,
    });
    if (!nextName) {
      return { kind: 'empty', doc: emptyGitAssembly(), scripts: {}, pairs: [] };
    }
    const opened = assemblyFromEntries(entries, nextName);
    if (!opened) {
      return { kind: 'empty', doc: emptyGitAssembly(), scripts: {}, pairs: [] };
    }
    return { kind: 'switch', name: nextName, doc: opened.doc, scripts: opened.scripts, pairs: [], assemblyPath: opened.assemblyPath };
  }
  const applied = applyAssemblyDeleteToDoc(doc, scripts, plan);
  return { kind: 'update', doc: applied.doc, scripts: applied.scripts, pairs: applied.pairs };
}

/**
 * Reload overlay. A queued delete remaps paths in the assembly that is
 * still open. `removed` is set when this document is the deleted assembly.
 */
export function overlayPendingAssemblyDeletes(doc, scripts, ops) {
  let nextDoc = doc;
  let nextScripts = { ...(scripts || {}) };
  let removed = false;
  const pairs = [];
  for (const op of ops || []) {
    if (op?.op !== 'delete-assembly' || op.status === 'done') continue;
    const deleted = op.payload?.name;
    if (deleted && vaultSegment(nextDoc?.name) === deleted) {
      removed = true;
      continue;
    }
    const applied = applyAssemblyDeleteToDoc(nextDoc, nextScripts, {
      moves: op.payload?.moves || [],
      assemblyPath: op.payload?.assemblyPath,
      legacyPath: op.payload?.legacyPath,
    });
    nextDoc = applied.doc;
    nextScripts = applied.scripts;
    pairs.push(...applied.pairs);
  }
  return { doc: nextDoc, scripts: nextScripts, removed, pairs };
}

/** Hide assemblies a queued or failed delete has already removed locally. */
export function hidePendingDeletedAssemblies(browse, ops) {
  const hidden = new Set();
  for (const op of ops || []) {
    if (op?.op !== 'delete-assembly' || op.status === 'done') continue;
    if (op.payload?.name) hidden.add(op.payload.name);
  }
  if (!hidden.size || !browse) return browse;
  return {
    ...browse,
    assemblies: (browse.assemblies || []).filter((item) => !hidden.has(item?.name || item)),
    parts: (browse.parts || []).filter((item) => {
      const info = parseVaultPath(item?.path);
      return !(info?.kind === 'assembly-part' && hidden.has(info.assembly));
    }),
  };
}

/**
 * Replace a cache snapshot in one assignment.
 * Building `next` happens first. A throw before the assignment leaves
 * `cache.entries` as it was.
 */
export function swapDeleteCache(cache, next) {
  if (!cache || typeof cache !== 'object') throw new Error('Delete cache swap needs a cache');
  if (!Array.isArray(next)) throw new Error('Delete cache swap needs a full snapshot');
  const built = [];
  for (const entry of next) {
    if (!entry?.path) throw new Error('Delete cache snapshot has an empty path');
    built.push({ path: entry.path, content: entry.content ?? '' });
  }
  cache.entries = built;
  return cache;
}

export function deleteAssemblyFailureToast(item, err) {
  const label = item?.payload?.name || item?.payload?.label || 'assembly';
  return {
    kind: 'delete-assembly-failed',
    message: `Could not delete assembly ${label}: ${err?.message || 'failed'}`,
    actions: ['retry', 'revert'],
    opId: item?.id ?? null,
    partId: item?.payload?.partId || null,
  };
}
