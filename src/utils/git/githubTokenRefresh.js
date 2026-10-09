/**
 * GitHub App user-to-server tokens expire (about 8h) and come back with a
 * refresh token. The access token stays in sessionStorage (`surfcad.github.token`).
 * The refresh bundle lives beside it so a reload can mint a new access token
 * without sending the user through OAuth again.
 *
 * This file is the only place that persists the refresh token. githubAuth.js
 * keeps the access token in sessionStorage and does not mention the other store.
 */
export const GITHUB_TOKEN_BUNDLE_KEY = 'surfcad.github.tokenBundle';
export const GITHUB_ACCESS_TOKEN_KEY = 'surfcad.github.token';
export const GITHUB_REFRESH_PATH = '/api/github/oauth/refresh';
/** Refresh a little early so a vault call does not race the expiry. */
export const GITHUB_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * 404/405: this backend has no refresh route (old staging/prod process).
 * That is "unsupported", not a dead session and not a bad refresh token.
 */
export function classifyRefreshStatus(status) {
  const code = Number(status) || 0;
  if (code === 404 || code === 405) return 'unsupported';
  return 'failed';
}

function sessionStore() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function localStore() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function emptyTokenBundle() {
  return {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    refreshExpiresAt: 0,
  };
}

export function loadGithubTokenBundle(storage = localStore()) {
  if (!storage || typeof storage.getItem !== 'function') return emptyTokenBundle();
  try {
    const raw = storage.getItem(GITHUB_TOKEN_BUNDLE_KEY);
    if (!raw) return emptyTokenBundle();
    const parsed = JSON.parse(raw);
    return {
      accessToken: typeof parsed?.accessToken === 'string' ? parsed.accessToken : '',
      refreshToken: typeof parsed?.refreshToken === 'string' ? parsed.refreshToken : '',
      expiresAt: Number(parsed?.expiresAt) || 0,
      refreshExpiresAt: Number(parsed?.refreshExpiresAt) || 0,
    };
  } catch {
    return emptyTokenBundle();
  }
}

export function saveGithubTokenBundle(bundle, storage = localStore(), session = sessionStore()) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  const next = {
    accessToken: String(bundle?.accessToken || ''),
    refreshToken: String(bundle?.refreshToken || ''),
    expiresAt: Number(bundle?.expiresAt) || 0,
    refreshExpiresAt: Number(bundle?.refreshExpiresAt) || 0,
  };
  try {
    if (!next.accessToken && !next.refreshToken) storage.removeItem(GITHUB_TOKEN_BUNDLE_KEY);
    else storage.setItem(GITHUB_TOKEN_BUNDLE_KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  if (session) {
    try {
      if (next.accessToken) session.setItem(GITHUB_ACCESS_TOKEN_KEY, next.accessToken);
      else session.removeItem(GITHUB_ACCESS_TOKEN_KEY);
    } catch { /* private mode */ }
  }
  return true;
}

/** Persist a token-endpoint body. Access token is mirrored into the session store. */
export function rememberGithubTokenBundle(body, now = Date.now(), storage = localStore(), session = sessionStore()) {
  const bundle = bundleFromTokenResponse(body, now);
  if (!bundle.accessToken && !bundle.refreshToken) return null;
  saveGithubTokenBundle(bundle, storage, session);
  return bundle;
}

export function clearGithubTokenBundle(storage = localStore()) {
  return saveGithubTokenBundle(emptyTokenBundle(), storage);
}

/**
 * keep — access token is still inside its lifetime.
 * refresh — call the refresh endpoint before vault / session calls.
 * sign-out — nothing to refresh and no access token.
 */
export function planTokenRefresh(bundle, now = Date.now()) {
  const access = String(bundle?.accessToken || '');
  const refresh = String(bundle?.refreshToken || '');
  const refreshExpiresAt = Number(bundle?.refreshExpiresAt) || 0;
  if (refresh && refreshExpiresAt && refreshExpiresAt <= now) {
    return access ? 'keep' : 'sign-out';
  }
  if (!refresh && !access) return 'sign-out';
  if (!refresh) return 'keep';
  const expiresAt = Number(bundle?.expiresAt) || 0;
  if (!expiresAt || expiresAt - GITHUB_REFRESH_SKEW_MS <= now) return 'refresh';
  return 'keep';
}

export function bundleFromTokenResponse(body, now = Date.now()) {
  const accessToken = String(body?.access_token || '');
  const refreshToken = String(body?.refresh_token || '');
  const expiresIn = Number(body?.expires_in) || 0;
  const refreshIn = Number(body?.refresh_token_expires_in) || 0;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : 0,
    refreshExpiresAt: refreshIn > 0 ? now + refreshIn * 1000 : 0,
  };
}

/**
 * Quiet refresh. Does not clear a still-valid access token when the network fails.
 * Returns `{ ok, accessToken, refreshed, plan }`.
 */
export async function refreshGithubAccessToken({
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  storage = localStore(),
  session = sessionStore(),
  refreshPath = GITHUB_REFRESH_PATH,
} = {}) {
  const bundle = loadGithubTokenBundle(storage);
  if (!bundle.accessToken && session && typeof session.getItem === 'function') {
    try {
      bundle.accessToken = session.getItem(GITHUB_ACCESS_TOKEN_KEY) || '';
    } catch { /* ignore */ }
  }
  const plan = planTokenRefresh(bundle, now);
  if (plan !== 'refresh') {
    // sessionStorage dies when iOS evicts the tab. The bundle already lives
    // in the durable store; mirror a still-valid access token back so Open
    // and the chip see the same credential.
    if (plan === 'keep' && bundle.accessToken) {
      saveGithubTokenBundle(bundle, storage, session);
    }
    return {
      ok: plan === 'keep' && !!bundle.accessToken,
      accessToken: bundle.accessToken || '',
      refreshed: false,
      plan,
      unsupported: false,
      failure: plan === 'sign-out' ? 'absent' : null,
    };
  }
  let res;
  try {
    res = await fetchImpl(refreshPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ refresh_token: bundle.refreshToken }),
    });
  } catch (err) {
    return {
      ok: !!bundle.accessToken && (bundle.expiresAt || 0) > now,
      accessToken: bundle.accessToken || '',
      refreshed: false,
      plan,
      unsupported: false,
      failure: 'failed',
      error: err?.message || 'refresh unreachable',
    };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body?.access_token) {
    const expired = !bundle.expiresAt || bundle.expiresAt <= now;
    const unsupported = classifyRefreshStatus(res.status) === 'unsupported';
    if (!expired && bundle.accessToken && session && typeof session.setItem === 'function') {
      try { session.setItem(GITHUB_ACCESS_TOKEN_KEY, bundle.accessToken); } catch { /* ignore */ }
    }
    if (expired && session && typeof session.removeItem === 'function') {
      try { session.removeItem(GITHUB_ACCESS_TOKEN_KEY); } catch { /* ignore */ }
    }
    return {
      ok: !!bundle.accessToken && !expired,
      accessToken: expired ? '' : (bundle.accessToken || ''),
      refreshed: false,
      plan,
      unsupported,
      failure: unsupported ? 'unsupported' : 'failed',
      error: body?.error || (unsupported
        ? `refresh unsupported (${res.status})`
        : `refresh failed (${res.status})`),
    };
  }
  const next = bundleFromTokenResponse({
    ...body,
    refresh_token: body.refresh_token || bundle.refreshToken,
  }, now);
  saveGithubTokenBundle(next, storage, session);
  return {
    ok: true,
    accessToken: next.accessToken,
    refreshed: true,
    plan,
    unsupported: false,
    failure: null,
  };
}
