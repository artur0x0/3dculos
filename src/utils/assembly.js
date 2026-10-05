/**
 * Assembly document and the rules that turn rows into a viewport.
 *
 * The saved JSON lists parts by id. It never contains script source.
 * Git ids are repo paths. Local ids are IndexedDB keys.
 * A position, when present, is a translation. There are no mates.
 */

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
  return source === 'git' ? 'find-in-repo' : 'upload';
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
 *   activeId: string | null,
 *   parts: [{ id, name, visible, order, position? }]
 * }
 * `script` and any other fields are dropped.
 */
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
    return row;
  }).filter((part) => part.id);
  const wanted = doc?.activeId != null ? String(doc.activeId) : '';
  const activeId = parts.some((part) => part.id === wanted)
    ? wanted
    : (parts[0]?.id || null);
  return {
    version: ASSEMBLY_VERSION,
    source,
    activeId,
    parts,
  };
}

export function parseAssemblyDocument(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || !Array.isArray(raw.parts)) {
    throw new Error('Assembly has no parts');
  }
  return serializeAssembly({
    version: ASSEMBLY_VERSION,
    source: raw.source,
    activeId: raw.activeId,
    parts: raw.parts.map((part, index) => ({
      id: part?.id,
      name: part?.name,
      visible: part?.visible,
      order: part?.order ?? index,
      position: part?.position,
    })),
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
    };
  });
}
