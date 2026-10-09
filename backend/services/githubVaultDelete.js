/**
 * Delete a user's SurfCAD vault repo on GitHub.
 *
 * The target is resolved the same way as the client: stored vaultName, then
 * surfcad-vault, then a marked legacy surfcad. The caller's string is not an
 * argument. DELETE runs only after surfcad.json matches. A 404 on lookup is
 * already gone. An unmarked repo is left in place (`skipped`).
 */
import { lookupGithubRepo, resolveGithubVault } from './vaultName.js';

export const GITHUB_API = 'https://api.github.com';

async function deleteByName({
  accessToken,
  owner,
  name,
  fetchImpl,
  apiBase,
}) {
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    return { ok: false, status: 502, error: 'GitHub unreachable', code: 'unreachable' };
  }

  if (res.status === 204 || res.status === 404) {
    return {
      ok: true,
      deleted: res.status === 204,
      skipped: false,
      gone: res.status === 404,
      repo: `${owner}/${name}`,
    };
  }

  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const msg = body?.message || `GitHub delete failed (${res.status})`;

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      status: 403,
      code: 'missing_delete_permission',
      error: `${msg}. Deleting the vault needs GitHub Administration / delete_repo permission. Reconnect GitHub after enabling it on the App, then try again.`,
    };
  }

  return { ok: false, status: res.status || 502, error: msg, code: 'delete_failed' };
}

/**
 * @returns {{ ok: true, deleted: boolean, skipped: boolean, gone?: boolean, repo: string|null, reason?: string }
 *   | { ok: false, status: number, error: string, code?: string }}
 */
export async function deleteResolvedGithubVault({
  accessToken,
  owner,
  storedName = null,
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API,
} = {}) {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  const repoOwner = String(owner || '').trim();
  if (!token) {
    return { ok: false, status: 400, error: 'access_token is required', code: 'missing_token' };
  }
  if (!repoOwner) {
    return { ok: false, status: 400, error: 'owner and name are required', code: 'invalid_repo' };
  }

  const resolved = await resolveGithubVault({
    accessToken: token,
    owner: repoOwner,
    storedName,
    fetchImpl,
    apiBase,
  });
  if (!resolved.ok) return resolved;

  if (resolved.action === 'refuse') {
    const repo = resolved.repo;
    const label = repo?.name ? `${repo.owner || repoOwner}/${repo.name}` : null;
    return {
      ok: true,
      deleted: false,
      skipped: true,
      reason: 'not-a-vault',
      repo: label,
    };
  }

  if (resolved.action !== 'adopt' || !resolved.repo?.name) {
    return { ok: true, deleted: false, skipped: false, gone: true, repo: null };
  }

  // Marker matched on lookup. Delete that repo, using GitHub's name.
  return deleteByName({
    accessToken: token,
    owner: resolved.repo.owner || repoOwner,
    name: resolved.repo.name,
    fetchImpl,
    apiBase,
  });
}

/** @deprecated use deleteResolvedGithubVault — kept so a direct name can be tested only behind the marker. */
export async function deleteGithubVaultRepo({
  accessToken,
  owner,
  name,
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API,
} = {}) {
  const token = typeof accessToken === 'string' ? accessToken.trim() : '';
  const repoOwner = String(owner || '').trim();
  const repoName = String(name || '').trim();
  if (!token) {
    return { ok: false, status: 400, error: 'access_token is required', code: 'missing_token' };
  }
  if (!repoOwner || !repoName) {
    return { ok: false, status: 400, error: 'owner and name are required', code: 'invalid_repo' };
  }
  const looked = await lookupGithubRepo({
    accessToken: token, owner: repoOwner, name: repoName, fetchImpl, apiBase,
  });
  if (!looked.ok) return looked;
  if (looked.presence === 'missing') {
    return { ok: true, deleted: false, skipped: false, gone: true, repo: `${repoOwner}/${repoName}` };
  }
  if (looked.presence !== 'marked') {
    return {
      ok: true,
      deleted: false,
      skipped: true,
      reason: 'not-a-vault',
      repo: `${looked.repo.owner}/${looked.repo.name}`,
    };
  }
  return deleteByName({
    accessToken: token,
    owner: looked.repo.owner,
    name: looked.repo.name,
    fetchImpl,
    apiBase,
  });
}
