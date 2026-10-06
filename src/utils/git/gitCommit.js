/**
 * G3: Commit / push in Git mode.
 *
 * Commit sends the changed part scripts plus the assembly `.surf.json` as
 * ONE commit to main, guarded by the baseline head (`baseSha`). When main
 * has moved since the last Open/Commit, the adapter refuses with
 * `non_fast_forward`; we detect the base (merge base of our baseline head
 * and main), park the same files on a new branch
 * `surfcad/<assembly>-<date>` cut from that base, and hand back a
 * `branched` result so the UI can ASK whether to force merge. Force merge
 * writes the same files on top of the current main; whatever main changed
 * in those files since the base is lost (the warning lists them).
 *
 * Mock adapter only for now; nothing here talks to the network.
 */
import { GitAdapterError, assertGithubAdapter, fileWrite } from './githubAdapter.js';
import { captureBaseline, dirtyPartIds } from './gitWorkspace.js';
import { assemblyFilePath, partPathAllowedFor, vaultSegment } from './vaultLayout.js';
import { stringifySurfJson } from './surfJson.js';

export const COMMIT_BRANCH_PREFIX = 'surfcad/';

/** Scripts with the live editor text folded in for the active part. */
export function effectiveScripts(scripts, { liveId = null, liveScript = null } = {}) {
  const out = { ...(scripts || {}) };
  if (liveId && typeof liveScript === 'string') out[liveId] = liveScript;
  return out;
}

/**
 * Files for one commit: every dirty part still in the document (script
 * changed or added) plus the assembly `.surf.json`. Parts removed from the
 * document are NOT deleted from git (the file may be shared or reused).
 * -> { files, partPaths, assemblyPath, scripts } ; files is [] when clean.
 */
export function buildCommitFiles(doc, scripts, baseline, opts = {}) {
  if (!doc || !baseline) return { files: [], partPaths: [], assemblyPath: null, scripts: {} };
  const eff = effectiveScripts(scripts, opts);
  const inDoc = new Set((doc.parts || []).map((p) => p.id));
  const dirty = dirtyPartIds(doc, eff, baseline);
  const partPaths = [...dirty].filter((id) => inDoc.has(id)).sort();
  const assemblyText = stringifySurfJson({ ...doc, source: 'git' });
  const assemblyPath = assemblyFilePath(vaultSegment(doc.name) || baseline.assemblyName);
  const assemblyChanged = assemblyText !== baseline.assemblyText || assemblyPath !== baseline.assemblyPath;
  const anyRemoved = [...dirty].some((id) => !inDoc.has(id));
  if (!partPaths.length && !assemblyChanged && !anyRemoved) {
    return { files: [], partPaths: [], assemblyPath, scripts: eff };
  }
  const files = partPaths.map((id) => fileWrite(id, eff[id] ?? ''));
  files.push(fileWrite(assemblyPath, assemblyText));
  return { files, partPaths, assemblyPath, scripts: eff };
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

/** First free branch name: base, base-2, base-3 … */
async function freeBranchName(adapter, repo, base) {
  const taken = new Set((await adapter.listBranches(repo)).map((b) => b.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const name = `${base}-${n}`;
    if (!taken.has(name)) return name;
  }
  throw new GitAdapterError('name_exists', `No free branch name for ${base}`);
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
 * Commit the working copy.
 * -> { status: 'clean' }
 *  | { status: 'committed', sha, branch, files, baseline }
 *  | { status: 'branched', branch, branchSha, baseSha, mainSha, behindBy,
 *      remoteFiles, overlap, files, message, pending }   (ask: force merge?)
 */
export async function commitWorkspace(adapter, repo, {
  doc,
  scripts,
  baseline,
  message = '',
  liveId = null,
  liveScript = null,
  now = new Date(),
} = {}) {
  assertGithubAdapter(adapter);
  if (!baseline) throw new Error('Open an assembly from the vault before committing');
  const stray = (doc?.parts || []).filter((p) => !partPathAllowedFor(doc.name, p.id));
  if (stray.length) {
    throw new Error(`No repo path for ${stray.map((p) => p.name || p.id).join(', ')}. `
      + 'Remove it, or add parts under this assembly\'s parts/ or shared parts/.');
  }
  const built = buildCommitFiles(doc, scripts, baseline, { liveId, liveScript });
  if (!built.files.length) return { status: 'clean' };
  const branch = baseline.branch || 'main';
  const msg = String(message || '').trim() || `Update ${vaultSegment(doc.name) || 'assembly'}`;
  try {
    const res = await adapter.commitFiles(repo, {
      branch,
      message: msg,
      files: built.files,
      baseSha: baseline.headSha || null,
    });
    return {
      status: 'committed',
      sha: res.sha,
      branch,
      files: built.files.map((f) => f.path),
      baseline: nextBaseline(doc, built.scripts, baseline, built.assemblyPath, branch, res.sha),
    };
  } catch (err) {
    if (!(err instanceof GitAdapterError) || err.code !== 'non_fast_forward') throw err;
  }
  // Main moved: detect base, park the commit on a side branch, then ask.
  const base = await detectCommitBase(adapter, repo, { branch, baselineSha: baseline.headSha });
  const sideName = await freeBranchName(adapter, repo, commitBranchName(doc.name, now));
  await adapter.createBranch(repo, sideName, base.baseSha);
  const side = await adapter.commitFiles(repo, {
    branch: sideName,
    message: msg,
    files: built.files,
    baseSha: base.baseSha,
  });
  const mine = new Set(built.files.map((f) => f.path));
  const overlap = base.remoteFiles.map((f) => f.path).filter((p) => mine.has(p)).sort();
  return {
    status: 'branched',
    branch: sideName,
    branchSha: side.sha,
    targetBranch: branch,
    baseSha: base.baseSha,
    mainSha: base.mainSha,
    behindBy: base.behindBy,
    remoteFiles: base.remoteFiles,
    overlap,
    files: built.files.map((f) => f.path),
    message: msg,
    pending: {
      files: built.files,
      scripts: built.scripts,
      assemblyPath: built.assemblyPath,
      doc,
      baseline,
    },
  };
}

/** Warning text for the force-merge ask. */
export function forceMergeWarning(result) {
  if (!result || result.status !== 'branched') return '';
  const n = result.behindBy || 0;
  const lost = result.overlap?.length
    ? ` Main's changes to ${result.overlap.join(', ')} will be lost.`
    : ' Any change main made to these files will be lost.';
  return `Main moved since you opened this assembly (${n} new commit${n === 1 ? '' : 's'}). `
    + `Your commit is safe on ${result.branch}. Force merge writes your versions on top of main.${lost}`;
}

/**
 * Force merge a `branched` result: write the same files on top of the
 * current main (one commit, guarded by main's current head). Main's diff in
 * those files since the base is overwritten. A second race returns
 * `moved-again` so the UI can ask again.
 * -> { status: 'merged', sha, branch, files, baseline } | { status: 'moved-again', mainSha }
 */
export async function forceMergeCommit(adapter, repo, result) {
  assertGithubAdapter(adapter);
  if (!result || result.status !== 'branched' || !result.pending) {
    throw new Error('Nothing to force merge');
  }
  const { files, scripts, assemblyPath, doc, baseline } = result.pending;
  const target = result.targetBranch || 'main';
  const head = (await adapter.getBranch(repo, target))?.sha || null;
  try {
    const res = await adapter.commitFiles(repo, {
      branch: target,
      message: `${result.message} (force merge from ${result.branch})`,
      files,
      baseSha: head,
    });
    return {
      status: 'merged',
      sha: res.sha,
      branch: target,
      files: files.map((f) => f.path),
      baseline: nextBaseline(doc, scripts, baseline, assemblyPath, target, res.sha),
    };
  } catch (err) {
    if (err instanceof GitAdapterError && err.code === 'non_fast_forward') {
      return { status: 'moved-again', mainSha: (await adapter.getBranch(repo, target))?.sha || null };
    }
    throw err;
  }
}
