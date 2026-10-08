/**
 * G3: Commit / push in Git mode.
 *
 * `assembleCommitFiles` builds the changed part scripts plus the assembly
 * `.surf.json` for one commit. The Parts Save button enqueues that list;
 * the sync worker is the only writer. `commitWorkspace` remains for callers
 * that already hold a matching baseline (move-to-git follow-ups, goldens):
 * it commits with `baseSha` and, on `non_fast_forward`, returns `conflict`
 * without writing. It does not open a side branch and it does not overwrite.
 *
 * When the assembly was renamed, the same commit moves the `.surf.json`
 * and assembly-owned parts to the new folder (deletes the old paths);
 * shared `parts/…` stay. Orphan blobs under the old assembly folder are
 * cleared via listTree.
 *
 * Mock adapter only for now; nothing here talks to the network.
 */
import { GitAdapterError, assertGithubAdapter, fileWrite, fileDelete } from './githubAdapterInterface.js';
import { captureBaseline, dirtyPartIds } from './gitWorkspace.js';
import {
  ASSEMBLIES_DIR,
  assemblyFilePath,
  assemblyPartPath,
  legacyCleanupPaths,
  parseVaultPath,
  vaultSegment,
} from './vaultLayout.js';
import { stringifySurfJson } from './surfJson.js';
import { isSurfId, readSurfId, withSurfId } from './surfId.js';

export const COMMIT_BRANCH_PREFIX = 'surfcad/';

/** Commit refused: working copy has parts without a vault path. */
export const NO_REPO_PATH = 'no_repo_path';

/** Scripts with the live editor text folded in for the active part. */
export function effectiveScripts(scripts, { liveId = null, liveScript = null } = {}) {
  const out = { ...(scripts || {}) };
  if (liveId && typeof liveScript === 'string') out[liveId] = liveScript;
  return out;
}

/**
 * Remap assembly-owned part paths when the assembly was renamed.
 * Shared `parts/…` stay put. Returns { doc, scripts, moved: [{ from, to }] }.
 */
export function remapAssemblyPaths(doc, scripts, oldName, newName) {
  const oldSeg = vaultSegment(oldName);
  const newSeg = vaultSegment(newName);
  const moved = [];
  const nextScripts = {};
  const nextParts = [];
  for (const part of doc?.parts || []) {
    const info = parseVaultPath(part.id);
    let nextId = part.id;
    if (info?.kind === 'assembly-part' && info.assembly === oldSeg && oldSeg !== newSeg) {
      nextId = assemblyPartPath(newSeg, info.part);
      if (nextId !== part.id) moved.push({ from: part.id, to: nextId });
    }
    nextParts.push({ ...part, id: nextId });
    const text = scripts?.[part.id];
    nextScripts[nextId] = typeof text === 'string' ? text : (scripts?.[nextId] ?? '');
  }
  let activeId = doc?.activeId;
  const hit = moved.find((m) => m.from === activeId);
  if (hit) activeId = hit.to;
  return {
    doc: { ...doc, parts: nextParts, activeId },
    scripts: nextScripts,
    moved,
  };
}

/**
 * Files for one commit: every dirty part still in the document (script
 * changed or added) plus the assembly `.surf.json`. Parts removed from the
 * document are NOT deleted from git (the file may be shared or reused).
 *
 * When the assembly was renamed since the baseline Open, the commit also
 * moves to the new path in the same commit: write the new `.surf.json` and
 * remapped assembly-owned parts, and delete the old assembly file (plus old
 * part paths that moved). Shared `parts/…` stay. Orphan files left under the
 * old `assemblies/<old>/` tree are deleted by `commitWorkspace` via listTree.
 * -> { files, partPaths, assemblyPath, scripts, doc, renamed, oldName, moved }
 */
export function buildCommitFiles(doc, scripts, baseline, opts = {}) {
  const empty = {
    files: [], partPaths: [], assemblyPath: null, scripts: {},
    doc: doc || null, renamed: false, oldName: null, moved: [],
  };
  if (!doc || !baseline) return empty;
  const eff = effectiveScripts(scripts, opts);
  const newName = vaultSegment(doc.name) || baseline.assemblyName || '';
  const oldName = baseline.assemblyName || '';
  const renaming = !!(baseline.assemblyPath && oldName && newName && oldName !== newName);

  let workDoc = { ...doc, source: 'git' };
  let workScripts = eff;
  let moved = [];
  if (renaming) {
    const remapped = remapAssemblyPaths(doc, eff, oldName, newName);
    workDoc = { ...remapped.doc, source: 'git' };
    workScripts = remapped.scripts;
    moved = remapped.moved;
  }

  const inDocOrig = new Set((doc.parts || []).map((p) => p.id));
  const dirty = dirtyPartIds(doc, eff, baseline);
  const movedFrom = new Map(moved.map((m) => [m.from, m.to]));
  const writes = new Map(); // path -> content
  const deletes = new Set();

  for (const { from, to } of moved) {
    writes.set(to, workScripts[to] ?? '');
    deletes.add(from);
  }

  const partPaths = [];
  for (const id of [...dirty].sort()) {
    if (!inDocOrig.has(id)) continue; // removed from doc — do not delete from git
    const dest = movedFrom.get(id) || id;
    writes.set(dest, workScripts[dest] ?? eff[id] ?? '');
    partPaths.push(dest);
  }

  const assemblyText = stringifySurfJson(workDoc);
  const assemblyPath = assemblyFilePath(newName || baseline.assemblyName);
  const assemblyChanged = (
    assemblyText !== baseline.assemblyText
    || assemblyPath !== baseline.assemblyPath
    || renaming
  );
  const anyRemoved = [...dirty].some((id) => !inDocOrig.has(id));
  // Always include the assembly whenever anything is committed (same as G3),
  // so a part-only edit still refreshes `.surf.json` in the same commit.
  const needAssembly = assemblyChanged || writes.size > 0 || deletes.size > 0 || anyRemoved;
  if (needAssembly) {
    writes.set(assemblyPath, assemblyText);
    if (renaming && baseline.assemblyPath && baseline.assemblyPath !== assemblyPath) {
      deletes.add(baseline.assemblyPath);
    }
  }

  if (!writes.size && !deletes.size) {
    return {
      files: [], partPaths: [], assemblyPath, scripts: workScripts,
      doc: workDoc, renamed: renaming, oldName: renaming ? oldName : null, moved,
    };
  }

  for (const part of workDoc.parts || []) {
    if (!part?.surfId || !isSurfId(part.surfId)) continue;
    const dest = movedFrom.get(part.id) || part.id;
    const info = parseVaultPath(dest);
    if (!info || (info.kind !== 'assembly-part' && info.kind !== 'shared-part')) continue;
    const text = writes.has(dest) ? writes.get(dest) : (workScripts[dest] ?? workScripts[part.id]);
    if (typeof text !== 'string' || readSurfId(text) === part.surfId) continue;
    const stamped = withSurfId(text, part.surfId);
    writes.set(dest, stamped);
    workScripts[dest] = stamped;
  }

  for (const path of [...deletes]) {
    if (writes.has(path)) deletes.delete(path);
  }

  // Parts (sorted), then assembly, then deletes — matches G3 golden order.
  const partWritePaths = [...writes.keys()].filter((path) => path !== assemblyPath).sort();
  const files = [
    ...partWritePaths.map((path) => fileWrite(path, writes.get(path))),
    ...(writes.has(assemblyPath) ? [fileWrite(assemblyPath, writes.get(assemblyPath))] : []),
    ...[...deletes].sort().map((path) => fileDelete(path)),
  ];
    return {
    files,
    partPaths: [...new Set(partPaths)].sort(),
    assemblyPath,
    scripts: workScripts,
    doc: workDoc,
    renamed: renaming,
    oldName: renaming ? oldName : null,
    moved,
  };
}

/**
 * Baseline for an assembly that has never been in the vault (Git mode
 * without an Open): nothing committed yet, so every part and the assembly
 * are new. `headSha` is the vault branch head the first commit builds on.
 */
export function firstCommitBaseline({ branch = 'main', headSha = null } = {}) {
  return {
    assemblyPath: null,
    assemblyName: '',
    assemblyText: '',
    scripts: {},
    partIds: [],
    branch,
    headSha,
  };
}

/**
 * Instantly commit one part (plus the assembly `.surf.json`) to the working
 * branch. Used by Parts "Add to Repo" for local content not yet in the vault.
 * Remaps `local:` / foreign ids to `assemblies/<asm>/<name>.js`.
 * -> { status: 'committed'|'clean'|'error', ... } (branched on non_fast_forward)
 */
export async function commitPartToRepo(adapter, repo, {
  doc,
  scripts,
  baseline,
  partId,
  message = null,
  liveId = null,
  liveScript = null,
} = {}) {
  assertGithubAdapter(adapter);
  if (!doc || doc.source !== 'git') {
    return { status: 'error', error: 'Not in Git mode' };
  }
  const id = String(partId || '');
  if (!id) return { status: 'error', error: 'Part required' };

  const row = (doc.parts || []).find((p) => p.id === id);
  if (!row) return { status: 'error', error: 'Part not in assembly' };

  const asmName = vaultSegment(doc.name) || baseline?.assemblyName || 'Assembly';
  let destId = id;
  let workDoc = { ...doc, source: 'git' };
  let workScripts = effectiveScripts(scripts, { liveId, liveScript });

  const info = parseVaultPath(destId);
  const allowed = info
    && ((info.kind === 'assembly-part' && info.assembly === asmName)
      || info.kind === 'shared-part');
  if (!allowed) {
    const base = vaultSegment(String(row.name || '').replace(/\.js$/i, '')) || 'Part';
    let candidate = assemblyPartPath(asmName, base);
    const taken = new Set((workDoc.parts || []).map((p) => p.id));
    if (taken.has(candidate) && candidate !== id) {
      for (let n = 2; n < 1000; n += 1) {
        const alt = assemblyPartPath(asmName, `${base} ${n}`);
        if (!taken.has(alt)) { candidate = alt; break; }
      }
    }
    destId = candidate;
    workDoc = {
      ...workDoc,
      parts: workDoc.parts.map((p) => (p.id === id ? { ...p, id: destId } : p)),
      activeId: workDoc.activeId === id ? destId : workDoc.activeId,
    };
    const text = workScripts[id];
    workScripts = { ...workScripts };
    delete workScripts[id];
    workScripts[destId] = typeof text === 'string' ? text : '';
  }

  let content = workScripts[destId];
  if (typeof content !== 'string') {
    content = '';
    workScripts = { ...workScripts, [destId]: content };
  }

  const base = baseline || firstCommitBaseline({
    branch: baseline?.branch || 'main',
    headSha: baseline?.headSha || null,
  });
  const branch = base.branch || 'main';
  const assemblyPath = assemblyFilePath(asmName);
  const assemblyText = stringifySurfJson(workDoc);
  const files = [
    fileWrite(destId, content),
    fileWrite(assemblyPath, assemblyText),
  ];
  // Skip no-op when baseline already has identical content.
  if (
    base.scripts
    && Object.prototype.hasOwnProperty.call(base.scripts, destId)
    && base.scripts[destId] === content
    && base.assemblyText === assemblyText
  ) {
    return { status: 'clean', partId: destId, doc: workDoc, scripts: workScripts };
  }

  const msg = String(message || '').trim()
    || `Add ${vaultSegment(row.name) || destId.split('/').pop() || 'part'}`;

  let expectedBase = base.headSha || null;
  if (!expectedBase) {
    const tip = await adapter.getBranch(repo, branch);
    expectedBase = tip?.sha || null;
  }

  const pushContent = workScripts[destId] ?? content;
  try {
    const res = await adapter.commitFiles(repo, {
      branch,
      message: msg,
      files,
      baseSha: expectedBase,
    });
    const nextScripts = { ...(base.scripts || {}), ...workScripts, [destId]: pushContent };
    const next = captureBaseline({
      assemblyPath,
      assemblyName: asmName,
      doc: workDoc,
      scripts: nextScripts,
      branch,
      headSha: res.sha,
    });
    return {
      status: 'committed',
      sha: res.sha,
      branch,
      partId: destId,
      fromId: id !== destId ? id : null,
      files: files.map((f) => f.path),
      baseline: next,
      doc: workDoc,
      scripts: workScripts,
      promoted: {},
    };
  } catch (err) {
    if (err instanceof GitAdapterError && err.code === 'non_fast_forward') {
      return {
        status: 'error',
        error: 'Repo moved — Save the assembly (or resolve the conflict), then try again.',
        code: 'non_fast_forward',
      };
    }
    return { status: 'error', error: err?.message || 'Add to Repo failed' };
  }
}

/**
 * Delete a part script from the vault and write the assembly without that row.
 * Caller has already removed the part from the local working copy.
 * -> { status: 'committed'|'error', ... }
 */
export async function deletePartFromRepo(adapter, repo, {
  doc,
  scripts,
  baseline,
  partPath,
  message = null,
} = {}) {
  assertGithubAdapter(adapter);
  if (!doc || doc.source !== 'git') {
    return { status: 'error', error: 'Not in Git mode' };
  }
  const path = String(partPath || '');
  if (!path || path.startsWith('local:')) {
    return { status: 'error', error: 'Part is not in the repo' };
  }
  const info = parseVaultPath(path);
  if (!info || (info.kind !== 'assembly-part' && info.kind !== 'shared-part')) {
    return { status: 'error', error: 'Not a vault part path' };
  }
  // Refusing if the part is still listed (caller must remove first).
  if ((doc.parts || []).some((p) => p.id === path)) {
    return { status: 'error', error: 'Part still in assembly — remove it first' };
  }

  const asmName = vaultSegment(doc.name) || baseline?.assemblyName || 'Assembly';
  const base = baseline || {
    branch: 'main',
    headSha: null,
    scripts: {},
    assemblyText: '',
  };
  const branch = base.branch || 'main';
  const assemblyPath = assemblyFilePath(asmName);
  const assemblyText = stringifySurfJson(doc);
  const files = [
    fileDelete(path),
    fileWrite(assemblyPath, assemblyText),
  ];
  const leaf = path.split('/').pop()?.replace(/\.js$/i, '') || 'part';
  const msg = String(message || '').trim() || `Delete ${leaf}`;

  let expectedBase = base.headSha || null;
  if (!expectedBase) {
    const tip = await adapter.getBranch(repo, branch);
    expectedBase = tip?.sha || null;
  }

  try {
    const res = await adapter.commitFiles(repo, {
      branch,
      message: msg,
      files,
      baseSha: expectedBase,
    });
    const nextScripts = { ...(base.scripts || {}), ...(scripts || {}) };
    delete nextScripts[path];
    const next = captureBaseline({
      assemblyPath,
      assemblyName: asmName,
      doc,
      scripts: nextScripts,
      branch,
      headSha: res.sha,
    });
    return {
      status: 'committed',
      sha: res.sha,
      branch,
      partPath: path,
      files: files.map((f) => f.path),
      baseline: next,
    };
  } catch (err) {
    if (err instanceof GitAdapterError && err.code === 'non_fast_forward') {
      return {
        status: 'error',
        error: 'Repo moved — Save the assembly (or resolve the conflict), then try again.',
        code: 'non_fast_forward',
      };
    }
    return { status: 'error', error: err?.message || 'Delete from repo failed' };
  }
}


function pad(n) {
  return String(n).padStart(2, '0');
}

/** `surfcad/<assembly-slug>-YYYY-MM-DD` (git-ref safe). */
export function commitBranchName(assemblyName, date = new Date()) {
  const slug = vaultSegment(assemblyName)
    .replace(/\s+/g, '-')
    .replace(/[~^:?*[\]\\@{}'"`]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\.lock$/i, '')
    .replace(/^[-.]+|[-.]+$/g, '') || 'assembly';
  const d = date instanceof Date ? date : new Date(date);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${COMMIT_BRANCH_PREFIX}${slug}-${stamp}`;
}

/**
 * Detect the base for a stale commit: the merge base of our baseline head
 * and main. Falls back to main's head when the baseline commit is gone.
 * -> { baseSha, mainSha, behindBy, remoteFiles: [{ path, status }] }
 */
export async function detectCommitBase(adapter, repo, { branch = 'main', baselineSha = null } = {}) {
  const main = await adapter.getBranch(repo, branch);
  const mainSha = main?.sha || null;
  if (!baselineSha || !mainSha) {
    return { baseSha: mainSha, mainSha, behindBy: 0, remoteFiles: [] };
  }
  try {
    const cmp = await adapter.compare(repo, baselineSha, mainSha);
    return {
      baseSha: cmp.mergeBaseSha || mainSha,
      mainSha,
      behindBy: cmp.aheadBy, // main is ahead of our base by this many commits
      remoteFiles: cmp.files || [],
    };
  } catch (err) {
    if (err instanceof GitAdapterError && err.code === 'not_found') {
      return { baseSha: mainSha, mainSha, behindBy: 0, remoteFiles: [] };
    }
    throw err;
  }
}

function nextBaseline(doc, scripts, baseline, assemblyPath, branch, headSha) {
  return captureBaseline({
    assemblyPath,
    assemblyName: vaultSegment(doc.name) || baseline.assemblyName,
    doc,
    scripts,
    branch,
    headSha,
  });
}

/**
 * Files for one Save, without writing git.
 * -> { status: 'clean' }
 *  | { status: 'ready', files, doc, scripts, message, branch, assemblyPath,
 *      renamed, moved, partIds }
 */
export async function assembleCommitFiles(adapter, repo, {
  doc,
  scripts,
  baseline,
  message = '',
  liveId = null,
  liveScript = null,
} = {}) {
  assertGithubAdapter(adapter);
  if (!baseline) throw new Error('Open an assembly from the vault before committing');
  // Refuse non-repo rows before buildCommitFiles stringifies `.surf.json`
  // (invalid ids throw inside stringify). Linked parts in another assembly
  // are real vault paths and are kept.
  const stray = (doc?.parts || []).filter((p) => {
    const info = parseVaultPath(p.id);
    // Linked external parts are real vault paths. Only local / non-path rows are stray.
    if (!info || (info.kind !== 'assembly-part' && info.kind !== 'shared-part')) return true;
    return false;
  });
  if (stray.length) {
    const err = new Error(`No repo path for ${stray.map((p) => p.name || p.id).join(', ')}. `
      + 'Remove it, or add parts under this assembly\'s folder or shared parts/.');
    err.code = NO_REPO_PATH;
    err.stray = stray.map((p) => ({ id: p.id, name: p.name || p.id }));
    throw err;
  }
  const built = buildCommitFiles(doc, scripts, baseline, { liveId, liveScript });
  const workDoc = built.doc || doc;
  // Rename move: delete any leftover blobs under the old assemblies/<old>/ tree
  // (Spare.js etc.) so the old folder does not linger after the move.
  if (built.renamed && built.oldName) {
    const ref = baseline.branch || 'main';
    const prefix = `${ASSEMBLIES_DIR}/${built.oldName}/`;
    const tree = await adapter.listTree(repo, ref, { prefix });
    const scheduled = new Set(built.files.map((f) => f.path));
    for (const entry of tree) {
      const p = entry?.path;
      if (!p || scheduled.has(p)) continue;
      built.files.push(fileDelete(p));
      scheduled.add(p);
    }
  }
  // One-shot rewrite: drop legacy named .surf.json + nested parts/ when the
  // working copy already uses the flat nameless layout.
  if (baseline.legacyCleanup) {
    const ref = baseline.branch || 'main';
    const asmName = vaultSegment(workDoc.name) || baseline.assemblyName;
    const tree = await adapter.listTree(repo, ref);
    const scheduled = new Set(built.files.map((f) => f.path));
    const toDelete = legacyCleanupPaths(asmName, tree);
    if (baseline.legacyAssemblyPath) toDelete.push(baseline.legacyAssemblyPath);
    for (const path of [...new Set(toDelete)].sort()) {
      if (!path || scheduled.has(path)) continue;
      // Never delete the current assembly metadata or current part paths.
      if (path === built.assemblyPath) continue;
      if ((workDoc.parts || []).some((part) => part.id === path)) continue;
      built.files.push(fileDelete(path));
      scheduled.add(path);
    }
    // Ensure the current .surf.json is written even when only cleanup remains.
    if (built.assemblyPath && !scheduled.has(built.assemblyPath)) {
      built.files.push(fileWrite(built.assemblyPath, stringifySurfJson(workDoc)));
      scheduled.add(built.assemblyPath);
    }
  }
  if (!built.files.length) return { status: 'clean' };
  const branch = baseline.branch || 'main';
  const msg = String(message || '').trim() || `Update ${vaultSegment(workDoc.name) || 'assembly'}`;
  return {
    status: 'ready',
    files: built.files,
    doc: workDoc,
    scripts: built.scripts,
    message: msg,
    branch,
    assemblyPath: built.assemblyPath,
    renamed: built.renamed,
    moved: built.moved,
    partIds: built.partPaths || [],
  };
}

/**
 * Commit a prepared workspace when the baseline still matches the tip.
 * On `non_fast_forward` this returns `conflict` and writes nothing.
 * Save in the app does not call this — it enqueues `assembleCommitFiles`.
 * -> { status: 'clean' | 'committed' | 'conflict', ... }
 */
export async function commitWorkspace(adapter, repo, opts = {}) {
  const assembled = await assembleCommitFiles(adapter, repo, opts);
  if (assembled.status === 'clean') return assembled;
  const { branch } = assembled;
  let expectedBase = opts.baseline?.headSha || null;
  if (!expectedBase) {
    const tip = await adapter.getBranch(repo, branch);
    expectedBase = tip?.sha || null;
  }
  try {
    const res = await adapter.commitFiles(repo, {
      branch,
      message: assembled.message,
      files: assembled.files,
      baseSha: expectedBase,
    });
    return {
      status: 'committed',
      sha: res.sha,
      branch,
      files: assembled.files.map((file) => file.path),
      baseline: nextBaseline(assembled.doc, assembled.scripts, opts.baseline, assembled.assemblyPath, branch, res.sha),
      doc: assembled.doc,
      scripts: assembled.scripts,
      renamed: assembled.renamed,
      moved: assembled.moved,
      promoted: {},
    };
  } catch (err) {
    if (!(err instanceof GitAdapterError) || err.code !== 'non_fast_forward') throw err;
    return {
      status: 'conflict',
      syncHold: true,
      branch,
      baseSha: expectedBase,
      warning: 'The repo moved since the last sync. Nothing was overwritten.',
    };
  }
}

/** Retired with force merge. The conflict popup explains that nothing was overwritten. */
export function forceMergeWarning() {
  return 'The repo moved since the last sync. Nothing was overwritten.';
}

/**
 * Retired. Force merge wrote local files on top of a moved tip.
 * Calling it throws and does not touch the repo.
 */
export async function forceMergeCommit() {
  throw new Error('Force merge is retired. Sync will not overwrite the remote repo.');
}
