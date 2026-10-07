/**
 * Delete a user's SurfCAD vault repo on GitHub (DELETE /repos/{owner}/{repo}).
 * Needs Administration / delete_repo permission on the user-to-server token.
 * No Express / mongoose — safe for goldens.
 */
export const GITHUB_API = 'https://api.github.com';

/**
 * @returns {{ ok: true, deleted: boolean, repo: string }
 *   | { ok: false, status: number, error: string, code?: string }}
 */
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

  const url = `${apiBase}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    return { ok: false, status: 502, error: 'GitHub unreachable', code: 'unreachable' };
  }

  // 204 = deleted; 404 = already gone / never created — treat as success for account wipe.
  if (res.status === 204 || res.status === 404) {
    return {
      ok: true,
      deleted: res.status === 204,
      repo: `${repoOwner}/${repoName}`,
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
