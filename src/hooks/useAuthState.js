/**
 * The auth state other features import.
 *
 *   import { useAuthState } from '../hooks/useAuthState';
 *   const { signedIn, githubConnected, needsReconnect, openTarget } = useAuthState();
 *
 * `signedIn` is the live SurfCAD session (`/api/auth/me`), including the grey
 * reauth chip. `githubConnected` is the vault. Do not pair `useAuth` with
 * `hasGithubToken` — those two signals are what split the chip from Open.
 *
 * Must sit under `GithubSessionProvider` (see `main.jsx`).
 */
import { authStateFromPhase } from '../utils/authPhase.js';
import { useGithubSession } from './useGithubSession';

export function useAuthState() {
  const session = useGithubSession();
  return {
    ...session,
    ...authStateFromPhase(session.phase),
  };
}

export { authStateFromPhase } from '../utils/authPhase.js';

export default useAuthState;
