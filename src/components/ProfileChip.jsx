/**
 * Profile chip — CAD viewport (absolute), Parts ribbon + Script toolbar (inline).
 * Opens Account when signed in, Login when signed out / guest
 * (same handleAccount as before). Initials when available; User icon when
 * signed out (or signed-in with empty profile). Green when signed in / GitHub
 * token present, grey when signed out / guest.
 */
import React, { useMemo } from 'react';
import { User } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { profileInitials } from '../utils/profileInitials.js';
import { hasGithubToken } from '../utils/git/githubAuth.js';

export default function ProfileChip({ onAccount, variant = 'viewport' }) {
  const { user, guest, isAuthenticated, isGuest } = useAuth();

  // Vault token alone is a signed-in affordance until /api/auth/me catches up
  // (session bridge in App). Prefer real session when present.
  const githubLinked = !isAuthenticated && hasGithubToken();
  const signedIn = isAuthenticated || githubLinked;

  const label = useMemo(
    () => profileInitials({
      user,
      guest: (isGuest || guest) ? (guest || true) : null,
      isAuthenticated,
    }),
    [user, guest, isAuthenticated, isGuest],
  );

  const title = isAuthenticated
    ? (user?.email || user?.name || 'Account')
    : githubLinked
      ? 'GitHub connected — completing sign-in…'
      : (isGuest || guest)
        ? 'Guest — sign in'
        : 'Sign in';

  const authState = isAuthenticated
    ? 'signed-in'
    : githubLinked
      ? 'github-token'
      : (isGuest || guest)
        ? 'guest'
        : 'signed-out';

  const tone = signedIn
    ? 'border-green-500/50 text-green-300 hover:bg-green-500/15'
    : 'border-gray-500/50 text-gray-400 hover:bg-gray-500/15';

  const inline = variant === 'inline';
  const shell = inline
    ? `pointer-events-auto relative z-10 flex h-7 w-7 shrink-0 items-center
        justify-center rounded-full border surface-glass-chip bg-gray-900/55
        text-[10px] font-semibold tracking-wide transition-colors
        active:opacity-80 ${tone}`
    : `pointer-events-auto absolute top-4 right-4 z-20 flex h-9 w-9 items-center
        justify-center rounded-full border surface-glass-chip bg-gray-900/55
        text-xs font-semibold tracking-wide shadow-lg transition-colors
        active:opacity-80 ${tone}`;

  const iconSize = inline ? 14 : 16;

  return (
    <button
      type="button"
      data-profile-chip=""
      data-profile-chip-variant={variant}
      data-profile-initials={label || (signedIn ? 'user' : 'out')}
      data-profile-auth={authState}
      onClick={() => onAccount?.()}
      onPointerDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className={shell}
    >
      {label ? (
        <span className="select-none" aria-hidden="true">{label}</span>
      ) : (
        <User size={iconSize} aria-hidden="true" strokeWidth={2.25} data-profile-icon="user" />
      )}
    </button>
  );
}
