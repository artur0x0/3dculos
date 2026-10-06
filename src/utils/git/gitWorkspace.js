/**
 * G2: open / save in Git mode (working copy).
 *
 * IndexedDB remains the intermittent autosave. Opening a vault assembly
 * loads `.surf.json` + every part script by path into that working copy and
 * captures a baseline. Dirty = working copy differs from that baseline.
 * Commit (G3) is the only write back to git; this module never commits.
 */
import { normalizeRepoPath, serializeAssembly } from '../assembly.js';
import { assertGithubAdapter } from './githubAdapter.js';
import {
  assemblyFilePath,
  assemblyPartPath,
  listAssemblies,
  listPartScripts,
  partPathAllowedFor,
  vaultSegment,
} from './vaultLayout.js';
import { parseSurfJson, stringifySurfJson } from './surfJson.js';

/** Working-copy baseline taken at the last vault open (or explicit reset). */
export function captureBaseline({
  assemblyPath,
  assemblyName,
  doc,
  scripts,
  branch = 'main',
  headSha = null,
} = {}) {
  const clean = serializeAssembly({ ...doc, source: 'git' });
  const scriptMap = {};
  for (const part of clean.parts) {
    const text = scripts?.[part.id];
    scriptMap[part.id] = typeof text === 'string' ? text : '';
  }
  return {
    assemblyPath: assemblyPath || assemblyFilePath(assemblyName || clean.name),
    assemblyName: vaultSegment(assemblyName || clean.name),
    assemblyText: stringifySurfJson(clean),
    scripts: scriptMap,
    partIds: clean.parts.map((p) => p.id),
    branch,
    headSha,
  };
}

/** True when the assembly document (rows / order / name / active) changed. */
export function isAssemblyDirty(doc, baseline) {
  if (!baseline) return false;
  try {
    const text = stringifySurfJson({ ...doc, source: 'git' });
    return text !== baseline.assemblyText;
  } catch {
    return true;
  }
}

/** True when one part's script differs from the baseline (missing = dirty). */
export function isPartDirty(path, script, baseline) {
  if (!baseline) return false;
  const id = String(path || '');
  if (!id) return false;
  const had = Object.prototype.hasOwnProperty.call(baseline.scripts, id);
  if (!had) return true; // added since open
  const base = baseline.scripts[id] ?? '';
  return String(script ?? '') !== base;
}

/**
 * Part ids that are dirty: script change, newly added, or removed from the
 * working document (removed ids are returned too so the UI can warn).
 */
export function dirtyPartIds(doc, scripts, baseline, { liveId = null, liveScript = null } = {}) {
  const out = new Set();
  if (!baseline) return out;
  const parts = doc?.parts || [];
  const seen = new Set();
  for (const part of parts) {
    const id = part.id;
    seen.add(id);
    let text = scripts?.[id];
    if (liveId && id === liveId && typeof liveScript === 'string') text = liveScript;
    if (isPartDirty(id, text, baseline)) out.add(id);
  }
  for (const id of baseline.partIds || []) {
    if (!seen.has(id)) out.add(id);
  }
  return out;
}

/** Assembly and/or any part dirty. */
export function isWorkspaceDirty(doc, scripts, baseline, opts) {
  if (!baseline) return false;
  if (isAssemblyDirty(doc, baseline)) return true;
  return dirtyPartIds(doc, scripts, baseline, opts).size > 0;
}

/** Assembly names in the vault on `ref` (default branch). */
export async function listVaultAssemblies(adapter, repo, ref) {
  assertGithubAdapter(adapter);
  const tree = await adapter.listTree(repo, ref);
  return listAssemblies(tree);
}

/**
 * Load one assembly from the vault: parse `.surf.json`, read every part
 * script by path. Missing scripts become '' (row shows Find in repo).
 * -> { doc, scripts, assemblyPath, baseline }
 */
export async function openVaultAssembly(adapter, repo, assemblyName, {
  branch = 'main',
  headSha = null,
} = {}) {
  assertGithubAdapter(adapter);
  const name = vaultSegment(assemblyName);
  if (!name) throw new Error('Empty assembly name');
  const assemblyPath = assemblyFilePath(name);
  const file = await adapter.readFile(repo, assemblyPath, branch);
  if (!file) throw new Error(`Assembly not found: ${assemblyPath}`);
  const doc = parseSurfJson(file.content);
  const scripts = {};
  for (const part of doc.parts) {
    const got = await adapter.readFile(repo, part.id, branch);
    scripts[part.id] = got ? got.content : '';
  }
  const head = headSha || (await adapter.getBranch(repo, branch))?.sha || null;
  const baseline = captureBaseline({
    assemblyPath,
    assemblyName: name,
    doc,
    scripts,
    branch,
    headSha: head,
  });
  return { doc, scripts, assemblyPath, baseline };
}

/**
 * Default path for a new part under this assembly.
 * `partName` may be a bare name or a full repo path.
 */
export function resolveNewPartPath(assemblyName, partName) {
  const raw = String(partName ?? '').trim();
  if (!raw) return null;
  if (raw.includes('/') || raw.toLowerCase().endsWith('.js')) {
    const path = normalizeRepoPath(raw.endsWith('.js') ? raw : `${raw}.js`);
    if (!path) return null;
    if (!partPathAllowedFor(assemblyName, path)) return null;
    return path;
  }
  try {
    return assemblyPartPath(assemblyName, raw);
  } catch {
    return null;
  }
}

/** Suggest `assemblies/<asm>/parts/Part N.js` for the next empty slot. */
export function suggestNewPartPath(assemblyName, existingParts = []) {
  const used = new Set((existingParts || []).map((p) => p?.id || p));
  for (let n = 1; n < 1000; n += 1) {
    const path = assemblyPartPath(assemblyName, `Part ${n}`);
    if (!used.has(path)) return path;
  }
  return assemblyPartPath(assemblyName, `Part ${Date.now()}`);
}

/**
 * Vault part scripts the assembly may add: this assembly's parts/ plus
 * shared parts/, minus paths already in the document.
 * -> [{ path, kind: 'assembly-part'|'shared-part', label }]
 */
export async function listAddableVaultParts(adapter, repo, assemblyName, {
  branch = 'main',
  existingIds = [],
} = {}) {
  assertGithubAdapter(adapter);
  const name = vaultSegment(assemblyName);
  const tree = await adapter.listTree(repo, branch);
  const { shared, byAssembly } = listPartScripts(tree);
  const have = new Set(existingIds);
  const out = [];
  for (const path of byAssembly[name] || []) {
    if (have.has(path)) continue;
    out.push({ path, kind: 'assembly-part', label: path.split('/').pop() });
  }
  for (const path of shared) {
    if (have.has(path)) continue;
    out.push({ path, kind: 'shared-part', label: path });
  }
  return out;
}

/** Read one part script from the vault, or null when missing. */
export async function readVaultPart(adapter, repo, path, ref = 'main') {
  assertGithubAdapter(adapter);
  const id = normalizeRepoPath(path);
  if (!id) return null;
  const file = await adapter.readFile(repo, id, ref);
  return file ? { path: id, content: file.content } : null;
}
