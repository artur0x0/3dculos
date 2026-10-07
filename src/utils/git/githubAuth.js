/**
 * Browser-only GitHub App user-to-server OAuth helpers.
 *
 * The access token lives in sessionStorage (tab-scoped; cleared when the
 * tab closes). The server only exchanges a one-time code → token and
 * stores nothing. Client secret never reaches the browser.
 *
 * Client ID resolution (first hit wins):
 *   1. runtime `/api/config`.githubAppClientId (from GITHUB_APP_CLIENT_ID)
 *   2. import.meta.env.VITE_GITHUB_APP_CLIENT_ID (static build inject)
 *
 * Callback path is always `/git/callback` (prod https://surfcad.com/git/callback).
 */
export const GITHUB_TOKEN_STORAGE_KEY = 'surfcad.github.token';
export const GITHUB_OAUTH_STATE_KEY = 'surfcad.github.oauth.state';
export const GITHUB_CALLBACK_PATH = '/git/callback';
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_EXCHANGE_PATH = '/api/github/oauth/token';

/** Build absolute redirect_uri for the current origin + /git/callback. */
export function githubRedirectUri(origin = typeof window !== 'undefined' ? window.location.origin : '') {
  const base = String(origin || '').replace(/\/$/, '');
  return `${base}${GITHUB_CALLBACK_PATH}`;
}

/** Random opaque state for CSRF; stored in sessionStorage for the round-trip. */
export function createOAuthState(randomBytes = defaultRandom) {
  const state = randomBytes();
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(GITHUB_OAUTH_STATE_KEY, state);
  }
  return state;
}

export function peekOAuthState() {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage.getItem(GITHUB_OAUTH_STATE_KEY);
}

export function clearOAuthState() {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(GITHUB_OAUTH_STATE_KEY);
}

/** Validate callback state against what we stored; clears it either way. */
export function consumeOAuthState(received) {
  const expected = peekOAuthState();
  clearOAuthState();
  if (!expected || !received || expected !== received) return false;
  return true;
}

function defaultRandom() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Authorize URL for Connect GitHub.
 * GitHub App "Request user authorization during installation" is on, so this
 * OAuth authorize endpoint covers both install and user-to-server token.
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  if (!clientId) return null;
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri || githubRedirectUri());
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** sessionStorage token helpers — token never goes to the server after exchange. */
export function loadGithubToken() {
  if (typeof sessionStorage === 'undefined') return null;
  const t = sessionStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
  return t || null;
}

export function saveGithubToken(token) {
  if (typeof sessionStorage === 'undefined') return;
  if (!token) {
    sessionStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, String(token));
}

export function clearGithubToken() {
  saveGithubToken(null);
}

export function hasGithubToken() {
  return !!loadGithubToken();
}

/**
 * Resolve Client ID from runtime config and/or Vite env.
 * Returns '' when unset — Connect stays disabled with a setup hint.
 */
export function resolveGithubClientId({ configClientId, viteClientId } = {}) {
  const fromConfig = String(configClientId || '').trim();
  if (fromConfig) return fromConfig;
  const fromVite = String(
    viteClientId
    ?? (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITHUB_APP_CLIENT_ID)
    ?? '',
  ).trim();
  return fromVite;
}

/**
 * POST code to the stateless exchange endpoint. Returns
 * `{ access_token, token_type?, scope? }` or throws.
 * Never logs the token.
 */
export async function exchangeCodeForToken({
  code,
  redirectUri,
  fetchImpl = globalThis.fetch,
  exchangePath = GITHUB_TOKEN_EXCHANGE_PATH,
} = {}) {
  if (!code) throw new Error('Missing OAuth code');
  const res = await fetchImpl(exchangePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code: String(code),
      redirect_uri: redirectUri || githubRedirectUri(),
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.error || body?.message || `Token exchange failed (${res.status})`;
    throw new Error(msg);
  }
  if (!body?.access_token) {
    throw new Error(body?.error || 'Token exchange returned no access_token');
  }
  return {
    access_token: body.access_token,
    token_type: body.token_type || 'bearer',
    scope: body.scope || '',
  };
}

/**
 * Handle `/git/callback?code=&state=`: validate state, exchange, store token.
 * Returns `{ ok: true, token }` or `{ ok: false, error }`.
 */
export async function completeGithubCallback(search, options = {}) {
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    : search;
  const code = params.get?.('code') || params.code;
  const state = params.get?.('state') || params.state;
  const err = params.get?.('error') || params.error;
  if (err) {
    return { ok: false, error: String(params.get?.('error_description') || err) };
  }
  if (!code) return { ok: false, error: 'Missing code' };
  if (!consumeOAuthState(state)) {
    return { ok: false, error: 'Invalid or missing OAuth state' };
  }
  try {
    const token = await exchangeCodeForToken({
      code,
      redirectUri: options.redirectUri || githubRedirectUri(options.origin),
      fetchImpl: options.fetchImpl,
      exchangePath: options.exchangePath,
    });
    saveGithubToken(token.access_token);
    return { ok: true, token: token.access_token };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
