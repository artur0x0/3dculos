/**
 * Parts ribbon session identity (G10).
 * Display-only: Guest | Apple | Google | GitHub — not a Local|Git data mode.
 * Vault/git chrome is gated separately on a GitHub OAuth token (githubConnected).
 * IndexedDB remains silent autosave for every identity.
 */
export const SESSION_IDENTITIES = Object.freeze(['guest', 'apple', 'google', 'github']);

/**
 * @param {{ user?: object|null, isAuthenticated?: boolean }} opts
 * @returns {{ kind: 'guest'|'apple'|'google'|'github', label: string }}
 */
export function sessionIdentity({ user = null, isAuthenticated = false } = {}) {
  if (isAuthenticated && user) {
    const provider = String(user.authProvider || '').toLowerCase();
    if (provider === 'github') return { kind: 'github', label: 'GitHub' };
    if (provider === 'apple') return { kind: 'apple', label: 'Apple' };
    if (provider === 'google') return { kind: 'google', label: 'Google' };
  }
  // Signed out, guest checkout, or local email/password → Guest on the strip.
  return { kind: 'guest', label: 'Guest' };
}
