/**
 * Profile chip — CAD viewport (absolute) and Parts ribbon (inline).
 * Opens Account when signed in, Login when signed out / guest
 * (same handleAccount as before). Initials when available; green when
 * signed in, grey when signed out / guest.
 */
import React, { useMemo } from 'react';
import { useAuth } from '../hooks/useAuth';
import { profileInitials } from '../utils/profileInitials.js';

export default function ProfileChip({ onAccount, variant = 'viewport' }) {
  const { user, guest, isAuthenticated, isGuest } = useAuth();

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
    : (isGuest || guest)
      ? 'Guest — sign in'
      : 'Sign in';

  const authState = isAuthenticated
    ? 'signed-in'
    : (isGuest || guest)
      ? 'guest'
      : 'signed-out';

  const signedIn = authState === 'signed-in';
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

  return (
    <button
      type="button"
      data-profile-chip=""
      data-profile-chip-variant={variant}
      data-profile-initials={label}
      data-profile-auth={authState}
      onClick={() => onAccount?.()}
      onPointerDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className={shell}
    >
      <span className="select-none" aria-hidden="true">{label}</span>
    </button>
  );
}
