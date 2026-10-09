/**
 * One auth phase for the profile chip, Open, and boot.
 *
 * connected  — /api/auth/me is in and a GitHub access token is usable.
 * reauth     — /me is in, but the token is missing or expired and a quiet
 *              refresh did not restore it. HTTP 404/405 means the backend
 *              has no refresh route (staging/prod lag). That is reauth, not
 *              signed-out, and not a license to open the local file browser.
 * signed-out — /me is unauthenticated (after a token, if we still had one,
 *              failed to upsert the session).
 * pending    — /me or the quiet token check has not finished.
 *
 * Open never reads a different signal than the chip.
 */
import { planReloadAssembly } from './assemblyBoot.js';

export function planOpenTarget(phase) {
  if (phase === 'connected') return 'vault';
  if (phase === 'reauth') return 'reconnect';
  if (phase === 'pending') return 'wait';
  return 'local';
}

/**
 * One snapshot of the live session. Chip, Open, boot, and other features
 * (a puzzle easter egg) read this instead of combining `/me` with a token.
 *
 * signedIn        — `/api/auth/me` is in. Grey reauth still counts.
 * githubConnected — that session also has a usable GitHub token (vault).
 * needsReconnect  — signed in, token missing or expired.
 */
export function authStateFromPhase(phase = 'pending') {
  const name = (
    phase === 'connected'
    || phase === 'reauth'
    || phase === 'signed-out'
    || phase === 'pending'
  ) ? phase : 'pending';
  return {
    phase: name,
    pending: name === 'pending',
    signedIn: name === 'connected' || name === 'reauth',
    githubConnected: name === 'connected',
    needsReconnect: name === 'reauth',
    signedOut: name === 'signed-out',
    openTarget: planOpenTarget(name),
  };
}

/** Grey + exclamation while GitHub needs a person. Spinner only during a tap. */
export function chipView({ phase = 'signed-out', motion = 'idle' } = {}) {
  if (phase === 'connected') {
    return { look: 'signed-in', badge: false, spinner: false, reconnect: false, auth: 'signed-in' };
  }
  if (phase === 'pending') {
    return { look: 'pending', badge: false, spinner: false, reconnect: false, auth: 'pending' };
  }
  if (phase === 'reauth') {
    const spinning = motion === 'spinning';
    return {
      look: 'reauth',
      badge: !spinning,
      spinner: spinning,
      reconnect: motion === 'reconnect',
      auth: 'reauth',
    };
  }
  return { look: 'signed-out', badge: false, spinner: false, reconnect: false, auth: 'signed-out' };
}

/**
 * Tap order: quiet refresh, then silent OAuth, then stop on Reconnect.
 * `refresh` / `silent`: idle | pending | ok | unsupported | failed | blocked | needs-user.
 */
export function reconnectMachine({ refresh = 'idle', silent = 'idle' } = {}) {
  if (refresh === 'idle' || refresh === 'pending') {
    return { motion: 'spinning', step: 'refresh', connected: false, offerReconnect: false };
  }
  if (refresh === 'ok') {
    return { motion: 'idle', step: 'done', connected: true, offerReconnect: false };
  }
  if (silent === 'idle' || silent === 'pending') {
    return { motion: 'spinning', step: 'silent', connected: false, offerReconnect: false };
  }
  if (silent === 'ok') {
    return { motion: 'idle', step: 'done', connected: true, offerReconnect: false };
  }
  return { motion: 'reconnect', step: 'reconnect', connected: false, offerReconnect: true };
}

/** Chip phase from a finished /me plus the quiet refresh result. */
export function phaseFromProbe({ me = 'pending', refreshResult = null } = {}) {
  if (me === 'pending') return 'pending';
  if (me !== 'in') return 'signed-out';
  if (refreshResult?.ok && refreshResult.accessToken) return 'connected';
  return 'reauth';
}

/**
 * /me out stays signed out unless a still-valid token upserts the session.
 * A 404 refresh cannot invent that session.
 */
export function phaseAfterSessionAttempt({
  me = 'out',
  refreshResult = null,
  sessionUpsert = 'skipped',
} = {}) {
  if (me === 'pending') return 'pending';
  if (me === 'in') return phaseFromProbe({ me: 'in', refreshResult });
  if (refreshResult?.ok && refreshResult.accessToken && sessionUpsert === 'ok') return 'connected';
  return 'signed-out';
}

/** Labelled probe used by tests. A still-valid token does not need refresh. */
export function refreshResultFor({ token = 'missing', http = 401 } = {}) {
  if (token === 'valid' || token === 'present') {
    return {
      ok: true,
      accessToken: 'ghu_live',
      refreshed: false,
      plan: 'keep',
      unsupported: false,
      failure: null,
    };
  }
  const code = Number(http);
  if (code === 200) {
    return {
      ok: true,
      accessToken: 'ghu_new',
      refreshed: true,
      plan: 'refresh',
      unsupported: false,
      failure: null,
    };
  }
  if (code === 404 || code === 405) {
    return {
      ok: false,
      accessToken: '',
      refreshed: false,
      plan: 'refresh',
      unsupported: true,
      failure: 'unsupported',
    };
  }
  return {
    ok: false,
    accessToken: '',
    refreshed: false,
    plan: 'refresh',
    unsupported: false,
    failure: 'failed',
  };
}

export function bootPlanForPhase(phase, {
  cacheStatus = 'miss',
  cachedDoc = null,
  pointer = null,
  userId = 'user-1',
  vaultStatus = 'ready',
} = {}) {
  if (phase === 'pending') {
    return planReloadAssembly({
      me: 'pending',
      cacheStatus,
      cachedDoc,
      pointer,
      userId,
    });
  }
  if (phase === 'signed-out') {
    return planReloadAssembly({
      me: 'out',
      refresh: 'idle',
      cacheStatus,
      cachedDoc,
      pointer,
      userId,
      githubConnected: false,
      vaultStatus,
    });
  }
  if (phase === 'reauth') {
    return planReloadAssembly({
      me: 'in',
      reauth: true,
      cacheStatus,
      cachedDoc,
      pointer,
      userId,
      githubConnected: false,
      vaultStatus,
    });
  }
  return planReloadAssembly({
    me: 'in',
    reauth: false,
    cacheStatus,
    cachedDoc,
    pointer,
    userId,
    githubConnected: true,
    vaultStatus,
  });
}

/**
 * Chip × Open × boot for one probe.
 * `sessionUpsert` applies only when /me is out and the token is still usable.
 */
export function describeAuthOutcome({
  me = 'out',
  token = 'missing',
  http = 401,
  sessionUpsert = 'skipped',
  motion = 'idle',
  cacheStatus = 'miss',
  cachedDoc = null,
  pointer = null,
  userId = 'user-1',
  vaultStatus = 'ready',
} = {}) {
  const refreshResult = refreshResultFor({ token, http });
  const phase = phaseAfterSessionAttempt({ me, refreshResult, sessionUpsert });
  const chipMotion = phase === 'reauth' ? motion : 'idle';
  return {
    phase,
    refreshResult,
    chip: chipView({ phase, motion: chipMotion }),
    open: planOpenTarget(phase),
    boot: bootPlanForPhase(phase, {
      cacheStatus,
      cachedDoc,
      pointer,
      userId,
      vaultStatus,
    }),
  };
}
