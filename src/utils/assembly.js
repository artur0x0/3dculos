/**
 * Assembly document and the rules that turn rows into a viewport.
 *
 * The saved JSON lists parts by id. It never contains script source.
 * Git ids are repo paths. Local ids are IndexedDB keys.
 * A position, when present, is a translation. There are no mates.
 */

import { normalizeSheetMetalBinding } from './scs/scsCatalog.js';
import { isSurfId } from './git/surfId.js';

export const ASSEMBLY_VERSION = 1;

export function sortParts(parts) {
  return [...(parts || [])].sort((a, b) => {
    const ao = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
    const bo = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
    if (ao !== bo) return ao - bo;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

/** [x, y, z] when the row stores a finite position, otherwise null. */
export function partPosition(part) {
  const p = part?.position;
  if (!Array.isArray(p) || p.length < 3) return null;
  const x = Number(p[0]);
  const y = Number(p[1]);
  const z = Number(p[2]);
  if (![x, y, z].every(Number.isFinite)) return null;
  return [x, y, z];
}

export function missingRowAction(source) {
  return source === 'git' ? 'add-to-repo' : 'upload';
}

/**
 * Resolve a row id to script text.
 * The script map is separate from the assembly document.
 * Git: id is a repo path. Local: id is an IndexedDB key.
 */
export function resolvePartId(source, id, scripts) {
  const key = id == null ? '' : String(id);
  const script = scripts && typeof scripts[key] === 'string' ? scripts[key] : null;
  if (script != null) return { ok: true, id: key, script };
  return {
    ok: false,
    id: key,
    missing: true,
    action: missingRowAction(source),
  };
}

/** Repo-relative path. Rejects empty, absolute, and parent-segment paths. */
export function normalizeRepoPath(path) {
  const id = String(path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!id || id.startsWith('/') || id.split('/').includes('..')) return null;
  return id;
}

export function newLocalPartId() {
  const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local:${rnd}`;
}

/**
 * Document shape:
 * {
 *   version: 1,
 *   source: 'git' | 'local',
 *   name: string,
 *   activeId: string | null,
 *   parts: [{ id, name, visible, order, position?, surfId? }]
 *   groups?: [{ id, name, source, partIds }]
 * }
 * `name` is the assembly name. A blank name is saved as Assembly.
 * `script` and any other fields are dropped.
 * `groups` lists parts inserted from another assembly. `partIds` are surf
 * ids. A part is in at most one group. Empty groups and dangling ids are
 * dropped. No `groups` key when there are none.
 */

/** Shown and saved when a document has no name of its own. */
export const DEFAULT_ASSEMBLY_NAME = 'Assembly';

/** Default part label used when seeding a blank assembly. */
export const DEFAULT_PART_NAME = 'Part 1';

/**
 * True when the working copy is blank or still the stock default assembly
 * (name Assembly / blank, zero or one Part 1, script empty or a known starter).
 * Used so Assembly New/Existing can skip the Save|Discard leave guard.
 */
export function isDefaultBlankAssembly(doc, scripts = {}, {
  defaultScripts = [],
  liveId = null,
  liveScript = null,
} = {}) {
  if (!doc || typeof doc !== 'object') return true;
  const name = storedAssemblyName(doc);
  if (name && name !== DEFAULT_ASSEMBLY_NAME) return false;
  const parts = Array.isArray(doc.parts) ? doc.parts : [];
  if (parts.length === 0) return true;
  if (parts.length !== 1) return false;
  const part = parts[0];
  const pname = String(part?.name || '').trim();
  if (pname && pname !== DEFAULT_PART_NAME && pname !== 'part1') return false;
  let script = scripts?.[part.id];
  if (liveId != null && String(liveId) === String(part.id) && typeof liveScript === 'string') {
    script = liveScript;
  }
  const text = String(script ?? '');
  if (!text.trim()) return true;
  const known = (Array.isArray(defaultScripts) ? defaultScripts : [])
    .map((s) => String(s ?? ''))
    .filter(Boolean);
  if (!known.length) return false;
  return known.some((s) => s === text);
}

/**
 * True when leaving the current assembly for New/Existing should ask Save|Discard.
 * Skip when blank/default, or when Git is known-saved (has baseline and not dirty).
 */
export function needsAssemblyLeaveGuard(doc, {
  sourceDirty = false,
  hasBaseline = false,
  source = 'local',
  scripts = {},
  defaultScripts = [],
  liveId = null,
  liveScript = null,
} = {}) {
  if (isDefaultBlankAssembly(doc, scripts, { defaultScripts, liveId, liveScript })) {
    return false;
  }
  if (source === 'git' && hasBaseline && !sourceDirty) return false;
  return true;
}


/** Trimmed name stored on the document, or '' when it has none. */
function storedAssemblyName(doc) {
  if (!doc || typeof doc.name !== 'string') return '';
  return doc.name.trim();
}

/**
 * Assembly name for a document. A blank or whitespace name is Assembly.
 * No document stays ''. A custom name is returned unchanged, aside from trim.
 */
export function assemblyName(doc) {
  if (!doc || typeof doc !== 'object') return '';
  return storedAssemblyName(doc) || DEFAULT_ASSEMBLY_NAME;
}

/**
 * Name to store when a file is opened.
 * A custom document name wins. A blank document takes the file name, then Assembly.
 */
export function assemblyNameForLoad(raw, filename) {
  const stored = storedAssemblyName(raw);
  if (stored) return stored;
  return assemblyNameFromFile(filename) || DEFAULT_ASSEMBLY_NAME;
}

/**
 * Path-safe label for a part or an assembly. Same rules as the title chip:
 * no path characters, collapsed whitespace, 60 characters.
 */
export function sanitizeAssemblyName(raw) {
  return String(raw ?? '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * CAD title. With an assembly name: "part1 in Assembly".
 * With a blank string: the part alone. No empty "in", no dash.
 * Callers pass assemblyName(), which turns a blank document into Assembly.
 */
export function formatViewerTitle(partName, assemblyNameValue) {
  const part = String(partName ?? '').trim() || 'Untitled';
  const assembly = String(assemblyNameValue ?? '').trim();
  if (!assembly) return { part, assembly: '', connector: '', text: part };
  return { part, assembly, connector: 'in', text: `${part} in ${assembly}` };
}

/**
 * Delete asks first.
 * - cancel / dismiss → keep
 * - confirm / assembly → drop from assembly only (legacy confirm = assembly)
 * - repo → drop from assembly and delete the vault file when applicable
 */
export function partListDeleteAction(choice) {
  if (choice === 'confirm' || choice === 'assembly') return 'drop';
  if (choice === 'repo') return 'drop-repo';
  return 'keep';
}

/** True when Parts delete can offer "Delete from assembly & repo". */
export function partCanDeleteFromRepo(source, partId) {
  if (source !== 'git') return false;
  const id = String(partId || '');
  if (!id || id.startsWith('local:')) return false;
  // Vault part scripts only (assembly-owned or shared).
  return /\.(js)$/i.test(id) && !id.includes('..');
}

/**
 * Basename of a loaded assembly file, without a trailing `.json`.
 * '' when that file has no name of its own.
 */
export function assemblyNameFromFile(filename) {
  const base = String(filename || '').replace(/\\/g, '/').split('/').pop().trim();
  if (!base || base === '.' || base === '..') return '';
  return base.replace(/\.json$/i, '').trim();
}

/**
 * Keep groups whose part ids still match a row. First group wins when a
 * surf id is listed twice. A group with nothing left is dropped.
 */
export function normalizeGroups(groups, parts) {
  const live = new Set(
    (parts || []).map((part) => part?.surfId).filter((id) => isSurfId(id)),
  );
  const seenParts = new Set();
  const seenIds = new Set();
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || typeof group !== 'object') continue;
    const id = String(group.id || '').trim();
    const name = sanitizeAssemblyName(group.name);
    const source = normalizeRepoPath(group.source);
    if (!isSurfId(id) || !name || !source || source !== String(group.source) || seenIds.has(id)) continue;
    const partIds = [];
    for (const pid of Array.isArray(group.partIds) ? group.partIds : []) {
      if (!isSurfId(pid) || !live.has(pid) || seenParts.has(pid)) continue;
      seenParts.add(pid);
      partIds.push(pid);
    }
    if (!partIds.length) continue;
    seenIds.add(id);
    out.push({ id, name, source, partIds });
  }
  return out;
}

export function serializeAssembly(doc) {
  const source = doc?.source === 'git' ? 'git' : 'local';
  const parts = sortParts(doc?.parts).map((part, index) => {
    const row = {
      id: String(part?.id || ''),
      name: String(part?.name || 'Part'),
      visible: part?.visible !== false,
      order: index,
    };
    const position = partPosition(part);
    if (position) row.position = position;
    const sheetMetal = normalizeSheetMetalBinding(part?.sheetMetal);
    if (sheetMetal) row.sheetMetal = sheetMetal;
    if (typeof part?.surfId === 'string' && part.surfId) row.surfId = part.surfId;
    if (typeof part?.copiedFrom === 'string' && part.copiedFrom) row.copiedFrom = part.copiedFrom;
    return row;
  }).filter((part) => part.id);
  const wanted = doc?.activeId != null ? String(doc.activeId) : '';
  const activeId = parts.some((part) => part.id === wanted)
    ? wanted
    : (parts[0]?.id || null);
  const name = storedAssemblyName(doc) || DEFAULT_ASSEMBLY_NAME;
  const groups = normalizeGroups(doc?.groups, parts);
  const out = {
    version: ASSEMBLY_VERSION,
    source,
    name,
    activeId,
    parts,
  };
  if (groups.length) out.groups = groups;
  return out;
}

export function parseAssemblyDocument(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || !Array.isArray(raw.parts)) {
    throw new Error('Assembly has no parts');
  }
  return serializeAssembly({
    version: ASSEMBLY_VERSION,
    source: raw.source,
    name: raw.name,
    activeId: raw.activeId,
    parts: raw.parts.map((part, index) => ({
      id: part?.id,
      name: part?.name,
      visible: part?.visible,
      order: part?.order ?? index,
      position: part?.position,
      sheetMetal: part?.sheetMetal,
      surfId: part?.surfId,
      copiedFrom: part?.copiedFrom,
    })),
    groups: raw.groups,
  });
}

/** Part names land in `${name}.js` downloads, so keep them path-safe and short. */
export function sanitizePartName(raw) {
  return String(raw ?? '')
    .replace(/[/\\:*?"<>|]/g, '')   // path + Windows-illegal characters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * The part a rename from the viewer title lands on: the part the title shows
 * (the CAD-selected part, which a face / edge / body pick on another part
 * moves without moving the editor), else the editor's active part.
 */
export function renameTargetId(doc, shownId = null) {
  const parts = doc?.parts || [];
  if (shownId != null && parts.some((part) => part.id === shownId)) return shownId;
  return doc?.activeId && parts.some((part) => part.id === doc.activeId) ? doc.activeId : null;
}

/** Rename one part by id. Other rows are untouched; unknown id or blank name → same doc. */
export function renamePart(doc, id, name) {
  const next = sanitizePartName(name);
  const parts = doc?.parts || [];
  if (!next || id == null || !parts.some((part) => part.id === id)) return doc;
  return serializeAssembly({
    ...doc,
    parts: parts.map((part) => (part.id === id ? { ...part, name: next } : part)),
  });
}

export function setPartVisible(doc, id, visible) {
  return serializeAssembly({
    ...doc,
    parts: (doc?.parts || []).map((part) => (
      part.id === id ? { ...part, visible: !!visible } : part
    )),
  });
}

/** The SendCutSend SKU bound to a part (S1 sheet metal), or null. */
export function partSheetMetal(doc, id) {
  const part = (doc?.parts || []).find((row) => row.id === id);
  return normalizeSheetMetalBinding(part?.sheetMetal);
}

/** Bind (or clear with null) a part's SendCutSend SKU. Unknown id → same doc. */
export function setPartSheetMetal(doc, id, binding) {
  if (id == null || !(doc?.parts || []).some((part) => part.id === id)) return doc;
  const clean = normalizeSheetMetalBinding(binding);
  return serializeAssembly({
    ...doc,
    parts: (doc?.parts || []).map((part) => {
      if (part.id !== id) return part;
      const rest = { ...part };
      delete rest.sheetMetal;
      return clean ? { ...rest, sheetMetal: clean } : rest;
    }),
  });
}

/**
 * Drop one part. Other rows stay, including position.
 * The active id stays on a remaining row, or is empty when none remain.
 */
export function removePart(doc, id) {
  const key = id == null ? '' : String(id);
  const parts = (doc?.parts || []).filter((part) => String(part?.id || '') !== key);
  return serializeAssembly({ ...doc, parts });
}

/** Copy a script map or a run map without one part id. */
export function dropPartRecord(map, id) {
  const key = id == null ? '' : String(id);
  const next = { ...(map || {}) };
  delete next[key];
  return next;
}

export function reorderParts(doc, fromIndex, toIndex) {
  const parts = sortParts(doc?.parts);
  const from = Number(fromIndex);
  const to = Number(toIndex);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return serializeAssembly(doc);
  if (from < 0 || to < 0 || from >= parts.length || to >= parts.length) {
    return serializeAssembly(doc);
  }
  const next = parts.slice();
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return serializeAssembly({ ...doc, parts: next.map((part, index) => ({ ...part, order: index })) });
}

/** Script Monaco should load for this row. Never reads a script off the document. */
export function scriptForRow(doc, scripts, id) {
  const part = (doc?.parts || []).find((row) => row.id === id);
  if (!part) return { ok: false, reason: 'unknown-row' };
  const resolved = resolvePartId(doc.source, id, scripts);
  if (!resolved.ok) {
    return { ok: false, reason: 'missing', action: resolved.action, part };
  }
  return { ok: true, script: resolved.script, part };
}

/**
 * Replace one part's latest run. A failure stores no mesh.
 * `previousMesh` and a mesh attached to a failed outcome are ignored,
 * including a mesh already stored for this id.
 */
export function recordPartRun(runs, id, outcome) {
  const next = { ...(runs || {}) };
  const mesh = outcome?.mesh;
  const ok = outcome?.ok === true && !!(mesh && mesh.vertProperties);
  next[id] = ok
    ? { ok: true, mesh, error: null }
    : {
      ok: false,
      mesh: null,
      error: outcome?.error || (outcome?.missing ? 'missing' : 'failed'),
      missing: !!outcome?.missing,
      empty: !!outcome?.empty,
      skipped: !!outcome?.skipped,
    };
  return next;
}

/**
 * Solids the viewport draws. Hidden rows and failed runs are omitted.
 * The latest run is the only source — there is no shadow solid.
 */
export function composeViewportParts(doc, runs) {
  const out = [];
  for (const part of sortParts(doc?.parts)) {
    if (part.visible === false) continue;
    const run = runs?.[part.id];
    if (!run || run.ok !== true || !run.mesh || !run.mesh.vertProperties) continue;
    out.push({
      id: part.id,
      mesh: run.mesh,
      position: partPosition(part) || [0, 0, 0],
    });
  }
  return out;
}

export function partRowFlags(run) {
  if (!run || run.skipped) return { error: false, missing: false };
  if (run.missing) return { error: false, missing: true };
  if (run.empty) return { error: false, missing: false };
  if (run.ok === false) return { error: true, missing: false };
  return { error: false, missing: false };
}

/** Feed rows. Mesh is present only for a successful latest run. */
export function feedRows(doc, runs, scripts) {
  const source = doc?.source === 'git' ? 'git' : 'local';
  return sortParts(doc?.parts).map((part) => {
    const hasScript = !!(scripts && typeof scripts[part.id] === 'string');
    const run = runs?.[part.id] || null;
    const missing = !hasScript;
    const error = !missing && !!run && run.ok === false && !run.empty && !run.skipped;
    return {
      id: part.id,
      name: part.name,
      visible: part.visible !== false,
      order: part.order,
      error,
      missing,
      action: missing ? missingRowAction(source) : null,
      mesh: !missing && run && run.ok === true ? run.mesh : null,
      surfId: part.surfId || null,
      copiedFrom: part.copiedFrom || null,
    };
  });
}
