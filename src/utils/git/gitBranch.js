/**
 * G5/G11: branch view helpers.
 *
 * List / switch / create / delete vault branches. Merge opens a GitHub
 * compare URL in the browser (no server-side merge).
 */
import { assertGithubAdapter, GitAdapterError } from './githubAdapterInterface.js';
import { openVaultAssembly } from './gitWorkspace.js';
import { vaultSegment } from './vaultLayout.js';

/** Branches in the vault, sorted; `current` marked when it matches. */
export async function listVaultBranches(adapter, repo, { current = null } = {}) {
  assertGithubAdapter(adapter);
  const branches = await adapter.listBranches(repo);
  const cur = current || null;
  return [...branches]
    .map((b) => ({ name: b.name, sha: b.sha, current: !!cur && b.name === cur }))
    .sort((a, b) => {
      if (a.name === 'main') return -1;
      if (b.name === 'main') return 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Open the named assembly on `branch` (reload working copy + baseline).
 * -> { doc, scripts, assemblyPath, baseline }
 */
export async function switchVaultBranch(adapter, repo, assemblyName, branch) {
  assertGithubAdapter(adapter);
  const name = vaultSegment(assemblyName);
  if (!name) throw new Error('Empty assembly name');
  if (!branch) throw new Error('Empty branch name');
  const tip = await adapter.getBranch(repo, branch);
  if (!tip) throw new Error(`Branch not found: ${branch}`);
  return openVaultAssembly(adapter, repo, name, { branch, headSha: tip.sha });
}

/**
 * Create a branch from `fromSha` (default: tip of `fromBranch` or main).
 * -> { name, sha }
 */
export async function createVaultBranch(adapter, repo, branchName, {
  fromBranch = 'main',
  fromSha = null,
} = {}) {
  assertGithubAdapter(adapter);
  const name = String(branchName || '').trim();
  if (!name) throw new GitAdapterError('invalid', 'Branch name required');
  if (name === 'main') throw new GitAdapterError('invalid', 'Cannot recreate main');
  let sha = fromSha;
  if (!sha) {
    const tip = await adapter.getBranch(repo, fromBranch);
    if (!tip?.sha) throw new GitAdapterError('not_found', `Branch ${fromBranch} not found`);
    sha = tip.sha;
  }
  return adapter.createBranch(repo, name, sha);
}

/**
 * Delete a branch. Refuses `main` and the current working branch.
 */
export async function deleteVaultBranch(adapter, repo, branchName, {
  current = null,
} = {}) {
  assertGithubAdapter(adapter);
  const name = String(branchName || '').trim();
  if (!name) throw new GitAdapterError('invalid', 'Branch name required');
  if (name === 'main') throw new GitAdapterError('invalid', 'Cannot delete main');
  if (current && name === current) {
    throw new GitAdapterError('invalid', 'Cannot delete the current branch');
  }
  await adapter.deleteBranch(repo, name);
  return { status: 'deleted', branch: name };
}

/**
 * GitHub compare / "Open a pull request" URL for merging `head` into `base`.
 * Opens in the browser — SurfCAD does not merge server-side.
 */
export function githubCompareUrl(repo, { base = 'main', head } = {}) {
  const owner = repo?.owner;
  const name = repo?.name;
  if (!owner || !name || !head) return null;
  const baseEnc = encodeURIComponent(base);
  const headEnc = encodeURIComponent(head);
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${baseEnc}...${headEnc}?expand=1`;
}

/** True when a branch may be deleted (not main, not current). */
export function canDeleteVaultBranch(branchName, { current = null } = {}) {
  const name = String(branchName || '');
  if (!name || name === 'main') return false;
  if (current && name === current) return false;
  return true;
}
