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

  return {
    ok: true,
    status: 200,
    body: {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      scope: data.scope || '',
    },
  };
}
