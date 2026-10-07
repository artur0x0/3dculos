/**
 * SPA page at /git/callback — receives ?code=&state= from GitHub OAuth,
 * POSTs the code to the stateless exchange endpoint, stores the token in
 * sessionStorage, then redirects home. Never persists the token server-side.
 */
import { useEffect, useState } from 'react';
import { completeGithubCallback, githubRedirectUri } from '../utils/git/githubAuth.js';

export default function GitCallback() {
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
        // Clean URL then go home so App picks up the token.
        window.history.replaceState({}, '', '/');
        window.location.replace('/');
      } else {
        setStatus('error');
        setError(result.error || 'OAuth failed');
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
