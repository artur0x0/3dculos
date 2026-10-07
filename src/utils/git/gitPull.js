/**
 * G4: Pull / conflicts in Git mode.
 *
 * After Open (and again on window focus), compare the baseline head to main.
 * When main has moved, the working copy is **behind**: a yellow toast points
 * at the Parts tab, and every part (and the assembly) that main changed
 * gets a marker. Clicking a marker offers Reload / Keep mine / Check in
 * mine to a branch (base auto-detected, same as G3).
 *
 * Mock adapter only; nothing here talks to the network.
 */
import { GitAdapterError, assertGithubAdapter, fileWrite } from './githubAdapterInterface.js';
import { detectCommitBase, commitBranchName } from './gitCommit.js';
import { captureBaseline } from './gitWorkspace.js';
import { parseSurfJson, stringifySurfJson } from './surfJson.js';
import { vaultSegment } from './vaultLayout.js';

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
 * Paths in our document that main changed since the baseline head.
 * `files` is the compare-from-mergeBase-to-head list.
 */
export function behindPathsFromFiles(files, { assemblyPath = null, partIds = [] } = {}) {
  const want = new Set((partIds || []).map(String));
  const asm = assemblyPath || null;
  const partIdsOut = [];
  let assemblyBehind = false;
  const relevant = [];
  for (const f of files || []) {
    const path = f?.path;
    if (!path) continue;
    if (asm && path === asm) {
      assemblyBehind = true;
      relevant.push(f);
    } else if (want.has(path)) {
      partIdsOut.push(path);
      relevant.push(f);
    }
  }
  partIdsOut.sort();
  return { assemblyBehind, partIds: partIdsOut, files: relevant };
}

/**
 * Compare baseline head → main. When main is ahead we are behind.
 * -> {
 *   status: 'identical'|'behind'|'ahead'|'diverged'|'unknown',
 *   behindBy, aheadBy, remoteSha, baseSha, assemblyPath,
 *   files,           // all files main changed since merge base
 *   assemblyBehind, partIds, remoteFiles  // only paths in this document
 * }
 */
export async function checkRemoteBehind(adapter, repo, {
  branch = 'main',
  baselineSha = null,
  assemblyPath = null,
  partIds = [],
} = {}) {
  assertGithubAdapter(adapter);
  const main = await adapter.getBranch(repo, branch);
  const remoteSha = main?.sha || null;
  if (!baselineSha || !remoteSha) {
    return {
      status: 'unknown',
      behindBy: 0,
      aheadBy: 0,
      remoteSha,
      baseSha: remoteSha,
      assemblyPath: assemblyPath || null,
      files: [],
      assemblyBehind: false,
      partIds: [],
      remoteFiles: [],
    };
  }
  if (baselineSha === remoteSha) {
    return {
      status: 'identical',
      behindBy: 0,
      aheadBy: 0,
      remoteSha,
      baseSha: baselineSha,
      assemblyPath: assemblyPath || null,
      files: [],
      assemblyBehind: false,
      partIds: [],
      remoteFiles: [],
    };
  }
  let cmp;
  try {
    cmp = await adapter.compare(repo, baselineSha, remoteSha);
  } catch (err) {
    if (err instanceof GitAdapterError && err.code === 'not_found') {
      return {
        status: 'unknown',
        behindBy: 0,
        aheadBy: 0,
        remoteSha,
        baseSha: remoteSha,
        assemblyPath: assemblyPath || null,
        files: [],
        assemblyBehind: false,
        partIds: [],
        remoteFiles: [],
      };
    }
    throw err;
  }
  // compare(baseline → remote): aheadBy = commits on remote we lack = behindBy for us.
  const behindBy = cmp.aheadBy || 0;
  const aheadBy = cmp.behindBy || 0;
  let status = 'identical';
  if (behindBy && aheadBy) status = 'diverged';
  else if (behindBy) status = 'behind';
  else if (aheadBy) status = 'ahead';
  const scoped = behindPathsFromFiles(cmp.files, { assemblyPath, partIds });
  return {
    status,
    behindBy,
    aheadBy,
    remoteSha,
    baseSha: cmp.mergeBaseSha || baselineSha,
    assemblyPath: assemblyPath || null,
    files: cmp.files || [],
    assemblyBehind: scoped.assemblyBehind,
    partIds: scoped.partIds,
    remoteFiles: scoped.files,
  };
}

/** Toast copy when the working copy is behind main. */
export function behindToastMessage({ behindBy = 0 } = {}) {
  const n = behindBy || 0;
  return `Remote is ahead (${n} new commit${n === 1 ? '' : 's'}). Open Parts to Reload, Keep mine, or Check in mine to a branch.`;
}

/**
 * Markers still showing after the user Reloaded / Kept / Checked-in some paths.
 * `resolvedPaths` holds the assembly path and/or part ids already handled.
 */
export function remainingBehindMarkers(check, resolvedPaths = []) {
  const done = new Set(resolvedPaths || []);
  const asm = check?.assemblyPath || null;
  const partIds = (check?.partIds || []).filter((id) => !done.has(id));
  const assemblyBehind = !!(asm && check?.assemblyBehind && !done.has(asm));
  return {
    assemblyBehind,
    partIds,
    any: assemblyBehind || partIds.length > 0,
  };
}

/**
 * Reload one path from remote into the working copy and refresh that path
 * in the baseline. baseline.headSha is left alone — the caller advances it
 * with `advanceBaselineHead` once every remaining marker was Reloaded.
 *
 * -> {
 *   kind: 'part'|'assembly',
 *   path,
 *   content,
 *   doc?,       // new assembly doc when kind=assembly
 *   scripts,    // updated scripts map (part reload only changes one entry)
 *   baseline,
 * }
 */
export async function reloadFromRemote(adapter, repo, {
  path,
  kind, // 'part' | 'assembly'
  branch = 'main',
  scripts,
  baseline,
} = {}) {
  assertGithubAdapter(adapter);
  if (!path || !baseline) throw new Error('Nothing to reload');
  const file = await adapter.readFile(repo, path, branch);
  if (!file) throw new Error(`Missing on remote: ${path}`);
  const content = file.content ?? '';
  if (kind === 'assembly') {
    const nextDoc = { ...parseSurfJson(content), source: 'git' };
    const nextScripts = { ...(scripts || {}) };
    const baselineNext = captureBaseline({
      assemblyPath: path,
      assemblyName: vaultSegment(nextDoc.name) || baseline.assemblyName,
      doc: nextDoc,
      scripts: nextScripts,
      branch: baseline.branch || branch,
      headSha: baseline.headSha,
    });
    // Exact remote bytes so dirty clears even if serializeAssembly reorders.
    baselineNext.assemblyText = content;
    baselineNext.assemblyPath = path;
    return {
      kind: 'assembly',
      path,
      content,
      doc: nextDoc,
      scripts: nextScripts,
      baseline: baselineNext,
    };
  }
  const nextScripts = { ...(scripts || {}), [path]: content };
  const baselineNext = {
    ...baseline,
    scripts: { ...(baseline.scripts || {}), [path]: content },
    partIds: baseline.partIds?.includes(path)
      ? baseline.partIds
      : [...(baseline.partIds || []), path],
  };
  return {
    kind: 'part',
    path,
    content,
    scripts: nextScripts,
    baseline: baselineNext,
  };
}

/**
 * After every remaining behind marker was resolved via Reload, advance the
 * baseline head to remoteSha so a later focus check is clean. Keep mine /
 * check-in leave headSha alone so G3 still sees a moved main on Commit.
 */
export function advanceBaselineHead(baseline, remoteSha) {
  if (!baseline || !remoteSha) return baseline;
  return { ...baseline, headSha: remoteSha };
}

/**
 * Park my version of one path on a side branch cut from the auto-detected
 * base (same naming as G3). Main and the working-copy baseline are untouched.
 * -> { status: 'branched', branch, sha, path, baseSha, mainSha, behindBy }
 */
export async function checkInMineToBranch(adapter, repo, {
  doc,
  scripts,
  baseline,
  path,
  kind, // 'part' | 'assembly'
  message = '',
  now = new Date(),
} = {}) {
  assertGithubAdapter(adapter);
  if (!path || !baseline || !doc) throw new Error('Nothing to check in');
  const branch = baseline.branch || 'main';
  const base = await detectCommitBase(adapter, repo, {
    branch,
    baselineSha: baseline.headSha,
  });
  const sideName = await freeBranchName(adapter, repo, commitBranchName(doc.name, now));
  await adapter.createBranch(repo, sideName, base.baseSha);
  const content = kind === 'assembly'
    ? stringifySurfJson({ ...doc, source: 'git' })
    : (scripts?.[path] ?? '');
  const msg = String(message || '').trim()
    || `Keep mine: ${path.split('/').pop() || path}`;
  const side = await adapter.commitFiles(repo, {
    branch: sideName,
    message: msg,
    files: [fileWrite(path, content)],
    baseSha: base.baseSha,
  });
  return {
    status: 'branched',
    branch: sideName,
    sha: side.sha,
    path,
    baseSha: base.baseSha,
    mainSha: base.mainSha,
    behindBy: base.behindBy,
  };
}
