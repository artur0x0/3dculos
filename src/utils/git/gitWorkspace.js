/**
 * G2: open / save in Git mode (working copy).
 *
 * IndexedDB remains the intermittent autosave. Opening a vault assembly
 * loads `.surf.json` + every part script by path into that working copy and
 * captures a baseline. Dirty = working copy differs from that baseline.
 * Commit (G3) is the only write back to git; this module never commits.
 */
import {
  DEFAULT_ASSEMBLY_NAME,
  DEFAULT_PART_NAME,
  normalizeRepoPath,
  serializeAssembly,
} from '../assembly.js';
import { assertGithubAdapter } from './githubAdapterInterface.js';
import {
  assemblyFilePath,
  assemblyFilePathCandidates,
  assemblyPartPath,
  listAssemblies,
  listPartScripts,
  migrateDocToCurrentLayout,
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

/** Assembly and/or any part dirty (or awaiting legacy-layout rewrite). */
export function isWorkspaceDirty(doc, scripts, baseline, opts) {
  if (!baseline) return false;
  if (baseline.legacyCleanup) return true;
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
 * Empty git working copy for a branch tip that has no `.surf.json` yet.
 * Used when switching onto a new branch before the default Assembly is
 * committed — avoids hard-erroring on assemblies/Assembly/.surf.json.
 * -> { doc, scripts, assemblyPath, baseline, seeded: true }
 */
export function seedEmptyVaultAssembly(assemblyName, {
  branch = 'main',
  headSha = null,
} = {}) {
  const name = vaultSegment(assemblyName) || DEFAULT_ASSEMBLY_NAME;
  const partId = assemblyPartPath(name, DEFAULT_PART_NAME);
  const doc = serializeAssembly({
    source: 'git',
    name,
    activeId: partId,
    parts: [{ id: partId, name: DEFAULT_PART_NAME, visible: true, order: 0 }],
  });
  const scripts = { [partId]: '' };
  const assemblyPath = assemblyFilePath(name);
  const baseline = captureBaseline({
    assemblyPath,
    assemblyName: name,
    doc,
    scripts,
    branch,
    headSha,
  });
  return { doc, scripts, assemblyPath, baseline, seeded: true };
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
  let file = null;
  let foundPath = null;
  for (const candidate of assemblyFilePathCandidates(name)) {
    // eslint-disable-next-line no-await-in-loop
    file = await adapter.readFile(repo, candidate, branch);
    if (file) { foundPath = candidate; break; }
  }
  if (!file || !foundPath) {
    throw new Error(`Assembly not found: ${assemblyFilePath(name)}`);
  }
  let doc = parseSurfJson(file.content);
  const rawScripts = {};
  for (const part of doc.parts) {
    // eslint-disable-next-line no-await-in-loop
    const got = await adapter.readFile(repo, part.id, branch);
    rawScripts[part.id] = got ? got.content : '';
  }
  // Working copy always uses the current flat layout; legacy paths remap here.
  const migrated = migrateDocToCurrentLayout(doc, rawScripts);
  doc = migrated.doc;
  const scripts = migrated.scripts;
  const assemblyPath = assemblyFilePath(name);
  const head = headSha || (await adapter.getBranch(repo, branch))?.sha || null;
  const baseline = captureBaseline({
    assemblyPath,
    assemblyName: name,
    doc,
    scripts,
    branch,
    headSha: head,
  });
  if (foundPath !== assemblyPath || migrated.changed) {
    baseline.legacyCleanup = true;
    baseline.legacyAssemblyPath = foundPath !== assemblyPath ? foundPath : null;
  }
  return { doc, scripts, assemblyPath, baseline, migrated: migrated.changed };
}

/**
 * Resolve a new part under this assembly.
 * Prefer a bare part name (UI is name-only). A full repo path is still
 * accepted when it is allowed for this assembly (tests / paste).
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

/** Suggest `assemblies/<asm>/Part N.js` for the next empty slot. */
export function suggestNewPartPath(assemblyName, existingParts = []) {
  const used = new Set((existingParts || []).map((p) => p?.id || p));
  for (let n = 1; n < 1000; n += 1) {
    const path = assemblyPartPath(assemblyName, `Part ${n}`);
    if (!used.has(path)) return path;
  }
  return assemblyPartPath(assemblyName, `Part ${Date.now()}`);
}

/**
 * Vault part scripts the assembly may add: this assembly's folder plus
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

/**
 * G11: browse vault for Open — assemblies and part scripts on `ref`.
 * -> { assemblies: [{ kind:'assembly', name, label }], parts: [{ kind:'part', path, label, scope }] }
 */
export async function listVaultBrowseItems(adapter, repo, ref) {
  assertGithubAdapter(adapter);
  const tree = await adapter.listTree(repo, ref);
  const assemblies = listAssemblies(tree).map((name) => ({
    kind: 'assembly',
    name,
    label: name,
  }));
  const { shared, byAssembly } = listPartScripts(tree);
  const parts = [];
  for (const path of shared) {
    parts.push({
      kind: 'part',
      path,
      label: path.split('/').pop() || path,
      scope: 'shared',
    });
  }
  for (const [asm, paths] of Object.entries(byAssembly)) {
    for (const path of paths) {
      parts.push({
        kind: 'part',
        path,
        label: path.split('/').pop() || path,
        scope: asm,
      });
    }
  }
  parts.sort((a, b) => a.path.localeCompare(b.path));
  return { assemblies, parts };
}

/**
 * Client-side live filter for the git Open pane index (assemblies + parts).
 * Empty / whitespace query returns the full index. Matching is case-insensitive
 * substring on assembly name/label and part path/label/scope — no network.
 */
export function filterVaultOpenIndex(index, query) {
  const assemblies = Array.isArray(index?.assemblies) ? index.assemblies : [];
  const parts = Array.isArray(index?.parts) ? index.parts : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { assemblies, parts };
  const hit = (...vals) => vals.some((v) => String(v || '').toLowerCase().includes(q));
  return {
    assemblies: assemblies.filter((item) => {
      if (typeof item === 'string') return hit(item);
      return hit(item?.name, item?.label);
    }),
    parts: parts.filter((item) => hit(item?.path, item?.label, item?.scope)),
  };
}

/**
 * Same live filter for Add-existing part lists (folder → Part).
 */
export function filterVaultPartItems(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((item) => {
    const hay = [item?.path, item?.label, item?.kind, item?.scope]
      .map((v) => String(v || '').toLowerCase());
    return hay.some((h) => h.includes(q));
  });
}

/**
 * G11: plan inserting another assembly's parts into the current document.
 * Shared paths stay; other-assembly parts remap under this assembly's folder.
 * -> { additions: [{ id, name, content, fromPath }] }
 */
export async function planInsertVaultAssemblyParts(adapter, repo, sourceAssembly, targetDoc, {
  branch = 'main',
} = {}) {
  assertGithubAdapter(adapter);
  const source = vaultSegment(sourceAssembly);
  const target = vaultSegment(targetDoc?.name);
  if (!source) throw new Error('Empty source assembly');
  if (!target) throw new Error('Empty target assembly');
  const opened = await openVaultAssembly(adapter, repo, source, { branch });
  const existing = new Set((targetDoc.parts || []).map((p) => p.id));
  const taken = new Set(existing);
  const additions = [];
  for (const part of opened.doc.parts || []) {
    const fromPath = part.id;
    const content = opened.scripts[fromPath] || '';
    if (partPathAllowedFor(target, fromPath)) {
      if (taken.has(fromPath)) continue;
      taken.add(fromPath);
      additions.push({
        id: fromPath,
        name: part.name || fromPath.split('/').pop()?.replace(/\.js$/i, '') || fromPath,
        content,
        fromPath,
      });
      continue;
    }
    const baseName = part.name
      || fromPath.split('/').pop()?.replace(/\.js$/i, '')
      || 'Part';
    let toPath = assemblyPartPath(target, baseName);
    let n = 2;
    while (taken.has(toPath)) {
      toPath = assemblyPartPath(target, `${baseName} ${n}`);
      n += 1;
    }
    taken.add(toPath);
    additions.push({
      id: toPath,
      name: toPath.split('/').pop()?.replace(/\.js$/i, '') || baseName,
      content,
      fromPath,
    });
  }
  return { additions, sourceName: source, scripts: opened.scripts };
}
