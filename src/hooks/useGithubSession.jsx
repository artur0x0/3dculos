/**
 * Live session + GitHub token, shared by the profile chip, Open, and boot.
 * /me unauthenticated is signed out. /me in with no usable token is reauth
 * (grey chip, reconnect Open) — never a green chip over the local file browser.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './useAuth';
import { phaseFromProbe } from '../utils/authPhase.js';
import { establishGithubSession } from '../utils/git/githubAuth.js';
import { refreshGithubAccessToken } from '../utils/git/githubTokenRefresh.js';
import {
  runReconnectAttempt,
  startInteractiveGithubOAuth,
} from '../utils/git/githubSilentAuth.js';

const GithubSessionContext = createContext(null);

export function GithubSessionProvider({ children }) {
  const { isAuthenticated, isLoading, checkAuth } = useAuth();
  const [settled, setSettled] = useState(false);
  const [tokenOk, setTokenOk] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [offerReconnect, setOfferReconnect] = useState(false);
  const [bootEmpty, setBootEmpty] = useState(false);
  const [lastError, setLastError] = useState('');
  const lockRef = useRef(false);
  const epochRef = useRef(0);

  useEffect(() => {
    if (isLoading) return undefined;
    let cancelled = false;
    const epoch = epochRef.current;
    setSettled(false);
    (async () => {
      const fresh = await refreshGithubAccessToken();
      if (cancelled || epoch !== epochRef.current) return;
      if (!isAuthenticated) {
        if (fresh?.ok && fresh.accessToken) {
          const session = await establishGithubSession({ accessToken: fresh.accessToken });
          if (cancelled || epoch !== epochRef.current) return;
          if (session.ok) {
            await checkAuth();
            return;
          }
        }
        if (!cancelled && epoch === epochRef.current) {
          setTokenOk(false);
          setOfferReconnect(false);
          setSettled(true);
        }
        return;
      }
      const ok = !!(fresh?.ok && fresh.accessToken);
      if (!cancelled && epoch === epochRef.current) {
        setTokenOk(ok);
        setSettled(true);
        if (ok) {
          setOfferReconnect(false);
          setLastError('');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isLoading, isAuthenticated, checkAuth]);

  const me = (isLoading || !settled) ? 'pending' : (isAuthenticated ? 'in' : 'out');
  const phase = phaseFromProbe({
    me,
    refreshResult: me === 'in'
      ? { ok: tokenOk, accessToken: tokenOk ? 'present' : '' }
      : null,
  });

  const noteBootEmpty = useCallback((empty) => {
    setBootEmpty(!!empty);
  }, []);

  /** Explicit Disconnect: session cookie remains, GitHub credential is gone. */
  const markNeedsReauth = useCallback(() => {
    epochRef.current += 1;
    setTokenOk(false);
    setSettled(true);
    setOfferReconnect(false);
    setReconnecting(false);
    setLastError('');
  }, []);

  const reconnect = useCallback(async () => {
    if (lockRef.current) return { ok: false, via: 'busy' };
    lockRef.current = true;
    setReconnecting(true);
    setOfferReconnect(false);
    setLastError('');
    try {
      const result = await runReconnectAttempt({
        refresh: () => refreshGithubAccessToken(),
      });
      if (result.ok && result.accessToken) {
        setTokenOk(true);
        setSettled(true);
        setOfferReconnect(false);
        const session = await establishGithubSession({ accessToken: result.accessToken });
        if (session.ok) await checkAuth();
        return result;
      }
      setTokenOk(false);
      setSettled(true);
      setOfferReconnect(true);
      if (result.via === 'no-client') setLastError('GitHub sign-in is not configured');
      return result;
    } finally {
      lockRef.current = false;
      setReconnecting(false);
    }
  }, [checkAuth]);

  const reconnectInteractive = useCallback(() => {
    const started = startInteractiveGithubOAuth();
    if (!started) setLastError('GitHub sign-in is not configured');
    return started;
  }, []);

  const value = useMemo(() => ({
    phase,
    reconnecting,
    offerReconnect,
    bootEmpty,
    lastError,
    noteBootEmpty,
    markNeedsReauth,
    reconnect,
    reconnectInteractive,
  }), [
    phase,
    reconnecting,
    offerReconnect,
    bootEmpty,
    lastError,
    noteBootEmpty,
    markNeedsReauth,
    reconnect,
    reconnectInteractive,
  ]);

  return (
    <GithubSessionContext.Provider value={value}>
      {children}
    </GithubSessionContext.Provider>
  );
}

export function useGithubSession() {
  const context = useContext(GithubSessionContext);
  if (!context) {
    throw new Error('useGithubSession must be used within a GithubSessionProvider');
  }
  return context;
}

export default useGithubSession;
