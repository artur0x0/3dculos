/**
 * Per-user vault name.
 *
 * The User schema default lives in `backend/db/vaultNameDefaults.js` and
 * returns `surfcad-vault` only while `isNew`. Existing documents stay unset,
 * so resolution can still adopt a marked legacy `surfcad` and write that
 * name back. Nothing here creates a GitHub repo.
 */
import { rememberResolvedVaultName } from '../db/vaultNameDefaults.js';
import {
  VAULT_MARKER_PATH,
  isVaultMarker,
  sanitizeVaultName,
  storedVaultNameFromUser,
  walkVaultCandidates,
} from '../../src/utils/git/vaultNames.js';

export { rememberResolvedVaultName, storedVaultNameFromUser };

export const GITHUB_API = 'https://api.github.com';

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function decodeContent(data) {
  if (!data || data.type !== 'file') return null;
  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
  }
  return typeof data.content === 'string' ? data.content : null;
}

/**
 * GET the repo and its surfcad.json. 404 on the repo is `missing`.
 * A repo that exists without a matching marker is `unmarked` (including empty).
 */
export async function lookupGithubRepo({
  accessToken,
  owner,
  name,
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API,
} = {}) {
  const repoOwner = String(owner || '').trim();
  const repoName = sanitizeVaultName(name);
  if (!repoOwner || !repoName) {
    return { ok: false, status: 400, error: 'owner and name are required', code: 'invalid_repo' };
  }
  const repoUrl = `${apiBase}/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`;
  let res;
  try {
    res = await fetchImpl(repoUrl, { method: 'GET', headers: headers(accessToken) });
  } catch {
    return { ok: false, status: 502, error: 'GitHub unreachable', code: 'unreachable' };
  }
  if (res.status === 404) {
    return { ok: true, presence: 'missing', repo: { owner: repoOwner, name: repoName } };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  // Status, not Response.ok: goldens and unit stubs often return a plain object.
  if (res.status < 200 || res.status >= 300) {
    const status = res.status === 401 || res.status === 403 ? res.status : (res.status || 502);
    return {
      ok: false,
      status,
      error: body?.message || `GitHub lookup failed (${res.status})`,
      code: status === 401 || status === 403 ? 'github_lookup_failed' : 'lookup_failed',
    };
  }
  const actual = {
    owner: body?.owner?.login || repoOwner,
    name: body?.name || repoName,
  };
  const branch = body?.default_branch || 'main';
  const markerUrl = `${apiBase}/repos/${encodeURIComponent(actual.owner)}/${encodeURIComponent(actual.name)}/contents/${encodeURIComponent(VAULT_MARKER_PATH)}?ref=${encodeURIComponent(branch)}`;
  let markerRes;
  try {
    markerRes = await fetchImpl(markerUrl, { method: 'GET', headers: headers(accessToken) });
  } catch {
    return { ok: false, status: 502, error: 'GitHub unreachable', code: 'unreachable' };
  }
  if (markerRes.status === 404) {
    return { ok: true, presence: 'unmarked', repo: actual, defaultBranch: branch };
  }
  let markerBody = null;
  try { markerBody = await markerRes.json(); } catch { markerBody = null; }
  if (markerRes.status < 200 || markerRes.status >= 300) {
    return {
      ok: false,
      status: markerRes.status || 502,
      error: markerBody?.message || 'Marker lookup failed',
      code: 'lookup_failed',
    };
  }
  const content = decodeContent(markerBody);
  if (!isVaultMarker(content)) {
    return { ok: true, presence: 'unmarked', repo: actual, defaultBranch: branch };
  }
  return { ok: true, presence: 'marked', repo: actual, defaultBranch: branch };
}

/**
 * Same order as the client. Does not create a repo.
 * -> { ok: true, action: 'adopt'|'refuse'|'missing', repo? }
 *  | { ok: false, status, error, code }
 */
export async function resolveGithubVault({
  accessToken,
  owner,
  storedName = null,
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API,
} = {}) {
  try {
    const walked = await walkVaultCandidates(storedName, async (candidate) => {
      const looked = await lookupGithubRepo({
        accessToken, owner, name: candidate, fetchImpl, apiBase,
      });
      if (!looked.ok) {
        const err = new Error(looked.error || 'GitHub lookup failed');
        err.lookup = looked;
        throw err;
      }
      return looked;
    });
    if (walked.action === 'adopt') {
      return { ok: true, action: 'adopt', repo: walked.looked.repo };
    }
    if (walked.action === 'refuse') {
      return { ok: true, action: 'refuse', repo: walked.looked?.repo || null };
    }
    return { ok: true, action: 'missing', repo: null };
  } catch (err) {
    if (err?.lookup) return err.lookup;
    return { ok: false, status: 502, error: err?.message || 'GitHub lookup failed', code: 'lookup_failed' };
  }
}

/**
 * Persist a name the client resolved, but only after this server reads a
 * matching marker. Stores GitHub's `name`, not the raw client string.
 */
export async function confirmAndRememberVaultName(user, {
  accessToken,
  owner,
  vaultName,
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API,
} = {}) {
  const requested = sanitizeVaultName(vaultName);
  if (!requested) {
    return { ok: false, status: 400, error: 'vault name is required', code: 'invalid_repo' };
  }
  const looked = await lookupGithubRepo({
    accessToken, owner, name: requested, fetchImpl, apiBase,
  });
  if (!looked.ok) return looked;
  if (looked.presence !== 'marked') {
    const label = `${owner}/${looked.repo?.name || requested}`;
    return {
      ok: false,
      status: 409,
      code: 'not_a_vault',
      error: `Refusing to store ${label}: surfcad.json is not a SurfCAD vault marker.`,
    };
  }
  const remembered = rememberResolvedVaultName(user, looked.repo.name);
  return { ok: true, repo: looked.repo, ...remembered };
}
