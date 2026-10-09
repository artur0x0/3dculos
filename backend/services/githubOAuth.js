/**
 * Stateless GitHub App user-to-server OAuth code → token exchange.
 * No Express / config imports — safe for goldens. Never persists.
 */
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * @returns {{ ok: boolean, status: number, body: object }}
 */
export async function exchangeGithubOAuthToken({
  code,
  redirectUri = '',
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  tokenUrl = GITHUB_TOKEN_URL,
} = {}) {
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'GitHub App OAuth is not configured',
        hint: 'Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET on the server',
      },
    };
  }
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    return { ok: false, status: 400, body: { error: 'code is required' } };
  }

  const payload = {
    client_id: clientId,
    client_secret: clientSecret,
    code: trimmed,
  };
  if (redirectUri) payload.redirect_uri = redirectUri;

  let ghRes;
  try {
    ghRes = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, status: 502, body: { error: 'GitHub token exchange unreachable' } };
  }

  let data;
  try {
    data = await ghRes.json();
  } catch {
    return { ok: false, status: 502, body: { error: 'GitHub token exchange failed' } };
  }

  if (!ghRes.ok || data.error || !data.access_token) {
    const err = data.error_description || data.error || 'Token exchange failed';
    return { ok: false, status: 400, body: { error: err } };
  }

  const body = {
    access_token: data.access_token,
    token_type: data.token_type || 'bearer',
    scope: data.scope || '',
  };
  if (data.refresh_token) body.refresh_token = data.refresh_token;
  if (data.expires_in) body.expires_in = data.expires_in;
  if (data.refresh_token_expires_in) body.refresh_token_expires_in = data.refresh_token_expires_in;
  return { ok: true, status: 200, body };
}

/**
 * GitHub App user tokens expire. `grant_type=refresh_token` mints a new
 * access token (and usually a rotated refresh token). Stores nothing.
 */
export async function refreshGithubOAuthToken({
  refreshToken,
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  tokenUrl = GITHUB_TOKEN_URL,
} = {}) {
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'GitHub App OAuth is not configured',
        hint: 'Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET on the server',
      },
    };
  }
  const trimmed = typeof refreshToken === 'string' ? refreshToken.trim() : '';
  if (!trimmed) {
    return { ok: false, status: 400, body: { error: 'refresh_token is required' } };
  }

  let ghRes;
  try {
    ghRes = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: trimmed,
      }),
    });
  } catch {
    return { ok: false, status: 502, body: { error: 'GitHub token refresh unreachable' } };
  }

  let data;
  try {
    data = await ghRes.json();
  } catch {
    return { ok: false, status: 502, body: { error: 'GitHub token refresh failed' } };
  }

  if (!ghRes.ok || data.error || !data.access_token) {
    const err = data.error_description || data.error || 'Token refresh failed';
    return { ok: false, status: 400, body: { error: err } };
  }

  const body = {
    access_token: data.access_token,
    token_type: data.token_type || 'bearer',
    scope: data.scope || '',
  };
  if (data.refresh_token) body.refresh_token = data.refresh_token;
  if (data.expires_in) body.expires_in = data.expires_in;
  if (data.refresh_token_expires_in) body.refresh_token_expires_in = data.refresh_token_expires_in;
  return { ok: true, status: 200, body };
}
