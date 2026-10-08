/**
 * One commit moves assembly-folder part scripts into `parts/`.
 *
 * Surf ids stay. Every `.surf.json` path is rewritten by surf id, then by
 * the old path. A name already in `parts/` becomes `Name 2`. Never overwrite.
 * Callers project this branch's pending outbox onto the tree first.
 * A row with `copiedFrom` is already an assembly-local copy and stays.
 * A second pass is a no-op. A part file is never dropped.
 */
import { fileDelete, fileWrite } from './githubAdapterInterface.js';
import { projectPendingOps, sharedPathForMove } from './gitDeleteAssembly.js';
import { isSurfId, isSurfJsonPath, readSurfId, stripSurfId } from './surfId.js';
import { parseSurfJson, stringifySurfJson } from './surfJson.js';
import { parseVaultPath } from './vaultLayout.js';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isPartScriptPath(path) {
  const kind = parseVaultPath(path)?.kind;
  return kind === 'assembly-part' || kind === 'shared-part';
}

function partScripts(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (!entry?.path || typeof entry.content !== 'string') continue;
    if (!isPartScriptPath(entry.path)) continue;
    map.set(entry.path, entry.content);
  }
  return map;
}

/** Paths a `.surf.json` row already marks as Copy to this assembly. */
function copiedPaths(entries) {
  const skip = new Set();
  for (const entry of entries || []) {
    if (!isSurfJsonPath(entry?.path) || typeof entry.content !== 'string') continue;
    const raw = parseJson(entry.content);
    for (const part of raw?.parts || []) {
      if (part?.path && isSurfId(part.copiedFrom)) skip.add(part.path);
    }
  }
  return skip;
}

function surfIdFor(file, entries) {
  const header = readSurfId(file.content || '');
  if (header && isSurfId(header)) return header;
  for (const entry of entries || []) {
    if (!isSurfJsonPath(entry?.path) || typeof entry.content !== 'string') continue;
    const raw = parseJson(entry.content);
    for (const part of raw?.parts || []) {
      if (part?.path === file.path && isSurfId(part.id)) return part.id;
    }
  }
  return null;
}

function rawRewriteSurfPaths(text, moves) {
  const raw = parseJson(text);
  if (!raw || typeof raw !== 'object') return text;
  const byId = new Map();
  const byPath = new Map();
  for (const move of moves || []) {
    if (move?.surfId && move.to) byId.set(move.surfId, move.to);
    if (move?.from && move.to) byPath.set(move.from, move.to);
  }
  let changed = false;
  if (Array.isArray(raw.parts)) {
    for (const part of raw.parts) {
      const next = (part?.id && byId.get(part.id)) || byPath.get(part?.path) || part?.path;
      if (next && next !== part.path) {
        part.path = next;
        changed = true;
      }
    }
  }
  if (typeof raw.activeId === 'string') {
    const next = byPath.get(raw.activeId);
    if (next && next !== raw.activeId) {
      raw.activeId = next;
      changed = true;
    }
  }
  if (!changed) return text;
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/** Surf id wins over the stored path. `groups[].source` is not rewritten. */
function rewriteSurfPaths(text, moves) {
  try {
    const doc = parseSurfJson(text);
    const applied = applyLayoutMoves(doc, {}, moves);
    if (!applied.changed) return text;
    return stringifySurfJson(applied.doc);
  } catch {
    return rawRewriteSurfPaths(text, moves);
  }
}

/**
 * Throw when the migrated tree drops a part file, changes its body or surf
 * id, or overwrites a file that was already there.
 */
export function assertLayoutFilesPreserved(before, after) {
  const from = partScripts(before);
  const to = partScripts(after);
  if (from.size !== to.size) {
    throw new Error(`Layout migration changed the part file count (${from.size} → ${to.size})`);
  }
  const used = new Set();
  for (const [path, content] of from) {
    const body = stripSurfId(content);
    const id = readSurfId(content);
    let found = null;
    for (const [nextPath, nextContent] of to) {
      if (used.has(nextPath)) continue;
      if (stripSurfId(nextContent) !== body) continue;
      if (readSurfId(nextContent) !== id) continue;
      found = nextPath;
      break;
    }
    if (!found) throw new Error(`Layout migration lost part file ${path}`);
    used.add(found);
    if (to.has(path) && stripSurfId(to.get(path)) !== body) {
      throw new Error(`Layout migration overwrote part file ${path}`);
    }
  }
  for (const [path, content] of from) {
    if (!to.has(path)) continue;
    if (to.get(path) !== content) throw new Error(`Layout migration overwrote part file ${path}`);
  }
  const metas = (entries) => (entries || [])
    .filter((entry) => isSurfJsonPath(entry?.path))
    .map((entry) => entry.path)
    .sort();
  const beforeMetas = metas(before);
  const afterMetas = metas(after);
  if (JSON.stringify(beforeMetas) !== JSON.stringify(afterMetas)) {
    throw new Error('Layout migration changed an assembly .surf.json path');
  }
  const idsOf = (text) => {
    const raw = parseJson(text);
    if (!raw || !Array.isArray(raw.parts)) return null;
    return raw.parts.map((part) => (isSurfId(part?.id) ? part.id : null)).filter(Boolean).sort();
  };
  for (const entry of before || []) {
    if (!isSurfJsonPath(entry?.path) || typeof entry.content !== 'string') continue;
    const next = (after || []).find((item) => item?.path === entry.path);
    if (!next) throw new Error(`Layout migration lost ${entry.path}`);
    const left = idsOf(entry.content);
    const right = idsOf(next.content);
    if (left && right && JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`Layout migration changed surf ids in ${entry.path}`);
    }
  }
}

/**
 * The outbox file list is a move: each deleted assembly script has a new
 * `parts/` write, and no `.surf.json` is deleted.
 */
export function assertLayoutCommitSafe(files) {
  const writes = [];
  const deletes = [];
  const seenWrite = new Set();
  for (const file of files || []) {
    if (!file?.path) continue;
    if (file.delete) {
      deletes.push(file.path);
      continue;
    }
    if (seenWrite.has(file.path)) throw new Error(`Layout migration writes ${file.path} twice`);
    seenWrite.add(file.path);
    writes.push(file.path);
  }
  const writeSet = new Set(writes);
  for (const path of deletes) {
    if (isSurfJsonPath(path)) throw new Error(`Layout migration refuses to delete ${path}`);
    if (writeSet.has(path)) throw new Error(`Layout migration deletes and writes ${path}`);
    const kind = parseVaultPath(path)?.kind;
    if (kind !== 'assembly-part') {
      throw new Error(`Layout migration refuses to delete ${path}`);
    }
  }
  const partWrites = writes.filter((path) => parseVaultPath(path)?.kind === 'shared-part');
  const partDeletes = deletes.filter((path) => parseVaultPath(path)?.kind === 'assembly-part');
  if (partWrites.length !== partDeletes.length) {
    throw new Error('Layout migration part write/delete count mismatch');
  }
}

function treeAfter(entries, moves, surfWrites) {
  const map = new Map((entries || []).map((entry) => [entry.path, entry.content ?? '']));
  for (const move of moves) {
    map.set(move.to, move.content);
    if (move.from !== move.to) map.delete(move.from);
  }
  for (const write of surfWrites) map.set(write.path, write.content);
  return [...map.entries()].map(([path, content]) => ({ path, content }));
}

/**
 * Plan the move from one tree snapshot.
 * -> { files, moves, changed }
 * Throws instead of returning a plan that loses a part file.
 */
export function planLayoutMigration(entries) {
  const list = (entries || []).filter((entry) => entry?.path && typeof entry.content === 'string');
  const skip = copiedPaths(list);
  const taken = new Set();
  for (const entry of list) {
    if (parseVaultPath(entry.path)?.kind === 'shared-part') taken.add(entry.path);
  }
  const sources = list
    .filter((entry) => parseVaultPath(entry.path)?.kind === 'assembly-part' && !skip.has(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const moves = [];
  for (const file of sources) {
    const info = parseVaultPath(file.path);
    const to = sharedPathForMove(info?.part || 'Part', taken);
    moves.push({
      from: file.path,
      to,
      surfId: surfIdFor(file, list),
      content: file.content,
    });
  }
  const surfWrites = [];
  if (moves.length) {
    for (const entry of list) {
      if (!isSurfJsonPath(entry.path)) continue;
      const next = rewriteSurfPaths(entry.content, moves);
      if (next !== entry.content) surfWrites.push({ path: entry.path, content: next });
    }
  }
  const after = treeAfter(list, moves, surfWrites);
  assertLayoutFilesPreserved(list, after);
  const files = [
    ...moves.map((move) => fileWrite(move.to, move.content)).sort((a, b) => a.path.localeCompare(b.path)),
    ...surfWrites.map((write) => fileWrite(write.path, write.content)).sort((a, b) => a.path.localeCompare(b.path)),
    ...moves.map((move) => fileDelete(move.from)).sort((a, b) => a.path.localeCompare(b.path)),
  ];
  assertLayoutCommitSafe(files);
  return { files, moves, changed: moves.length > 0 };
}

/** Project pending outbox ops, then plan. Pending renames are visible. */
export function planLayoutMigrationCommit(entries, ops) {
  return planLayoutMigration(projectPendingOps(entries, ops));
}

function looseMatch(partId, move) {
  const left = parseVaultPath(partId);
  const right = parseVaultPath(move?.from);
  if (!left || !right) return false;
  return left.kind === 'assembly-part' && right.kind === 'assembly-part'
    && left.assembly === right.assembly && left.part === right.part;
}

function moveForPart(partOrId, moves) {
  const partId = typeof partOrId === 'string' ? partOrId : partOrId?.id;
  const surfId = typeof partOrId === 'string' ? null : partOrId?.surfId;
  if (surfId) {
    const byId = (moves || []).filter((move) => move?.surfId && move.surfId === surfId);
    if (byId.length === 1) return byId[0];
  }
  const exact = (moves || []).find((move) => move?.from === partId);
  if (exact) return exact;
  const loose = (moves || []).filter((move) => move?.from !== partId && looseMatch(partId, move));
  return loose.length === 1 ? loose[0] : null;
}

/**
 * Point the open document at the migrated paths. Script bytes stay.
 * Surf ids stay. A second call with the same moves changes nothing.
 */
export function applyLayoutMoves(doc, scripts, moves) {
  const list = Array.isArray(moves) ? moves : [];
  const nextScripts = { ...(scripts || {}) };
  const pairs = [];
  let changed = false;
  const parts = (doc?.parts || []).map((part) => {
    const move = moveForPart(part, list);
    if (!move || move.to === part.id) return part;
    changed = true;
    if (Object.prototype.hasOwnProperty.call(nextScripts, part.id) && nextScripts[move.to] == null) {
      nextScripts[move.to] = nextScripts[part.id];
    }
    delete nextScripts[part.id];
    pairs.push({ from: part.id, to: move.to });
    return { ...part, id: move.to };
  });
  let activeId = doc?.activeId;
  const activeMove = moveForPart(activeId, list);
  if (activeMove && activeMove.to !== activeId) {
    activeId = activeMove.to;
    changed = true;
  }
  if (!changed) return { doc, scripts: scripts || {}, changed: false, pairs: [] };
  return { doc: { ...doc, parts, activeId }, scripts: nextScripts, changed: true, pairs };
}

/** A reload while the layout commit is still queued follows the same paths. */
export function overlayPendingLayoutMigration(doc, scripts, ops) {
  let nextDoc = doc;
  let nextScripts = scripts || {};
  for (const op of ops || []) {
    if (op?.op !== 'migrate-layout' || op.status === 'done') continue;
    const applied = applyLayoutMoves(nextDoc, nextScripts, op.payload?.moves || []);
    nextDoc = applied.doc;
    nextScripts = applied.scripts;
  }
  return { doc: nextDoc, scripts: nextScripts };
}
