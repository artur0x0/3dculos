/**
 * G5: branch view helpers.
 *
 * List vault branches and open the current assembly on another branch.
 * Commit / Open / Add-existing use the working-copy branch from the
 * baseline (`baseline.branch`); switching reloads the assembly from the
 * chosen tip. Mock adapter only — no network, no tokens.
 */
import { assertGithubAdapter } from './githubAdapter.js';
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
