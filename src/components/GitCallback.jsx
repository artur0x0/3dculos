/**
 * SPA page at /git/callback — receives ?code=&state= from GitHub OAuth,
 * POSTs the code to the stateless exchange endpoint, stores the token in
 * sessionStorage, then hands off to App. Never persists the token server-side.
 *
 * Mounted outside React StrictMode (see main.jsx) so the effect does not
 * double-fire and clear OAuth state before exchange. completeGithubCallback
 * also dedupes by code for defense in depth.
 *
 * Success uses onComplete (soft navigate) when provided so the already-loaded
 * module graph mounts App once. Falls back to location.replace('/') only when
 * mounted without a parent router (tests / unexpected entry).
 */
import { useEffect, useState } from 'react';
import {
  completeGithubCallback,
  githubRedirectUri,
  GITHUB_OAUTH_STATE_MISSING_HINT,
} from '../utils/git/githubAuth.js';

export default function GitCallback({ onComplete } = {}) {
  const [status, setStatus] = useState('exchanging'); // exchanging | ok | error
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await completeGithubCallback(window.location.search, {
        redirectUri: githubRedirectUri(window.location.origin),
      });
      if (cancelled) return;
      if (result.ok) {
        setStatus('ok');
        // Drop ?code=&state= from the URL, then mount App without a full reload.
        window.history.replaceState({}, '', '/');
        if (typeof onComplete === 'function') {
          onComplete();
        } else {
          window.location.replace('/');
        }
      } else {
        setStatus('error');
        setError(result.error || 'OAuth failed');
      }
    })();
    return () => { cancelled = true; };
  }, [onComplete]);

  const sameOriginHint = error === GITHUB_OAUTH_STATE_MISSING_HINT
    || /OAuth state/i.test(error);

  return (
    <div
      data-git-callback=""
      data-git-callback-status={status}
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-gray-950 px-6 text-gray-200"
    >
      {status === 'exchanging' && (
        <p data-git-callback-busy="">Connecting GitHub…</p>
      )}
      {status === 'ok' && (
        <p data-git-callback-ok="">Connected. Redirecting…</p>
      )}
      {status === 'error' && (
        <>
          <p data-git-callback-error="" className="text-red-400">
            GitHub connect failed: {error}
          </p>
          {sameOriginHint && (
            <p data-git-callback-origin-hint="" className="max-w-md text-center text-sm text-gray-400">
              Open Connect and finish authorization on the same origin
              (same host and port) that you used to start — for example
              {' '}
              <code className="text-gray-300">http://100.106.101.1:&lt;port&gt;/</code>
              {' '}
              if you started there. Do not mix localhost, surfcad.com, and a Tailscale IP.
            </p>
          )}
          <a
            href="/"
            className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-300 hover:bg-gray-800"
          >
            Back to SurfCAD
          </a>
        </>
      )}
    </div>
  );
}
