/**
 * Circular profile chip — top-right of the CAD viewport (G9).
 * Opens Account when signed in, Login when signed out / guest
 * (same behaviour as the old Toolbar Account control).
 */
import React, { useMemo } from 'react';
import { useAuth } from '../hooks/useAuth';
import { profileInitials } from '../utils/profileInitials.js';

export default function ProfileChip({ onAccount }) {
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

  const tone = isAuthenticated
    ? 'border-green-500/50 text-green-300 hover:bg-green-500/15'
    : 'border-blue-500/40 text-blue-300 hover:bg-blue-500/15';

  return (
    <button
      type="button"
      data-profile-chip=""
      data-profile-initials={label}
      data-profile-auth={authState}
      onClick={() => onAccount?.()}
      onPointerDown={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className={`pointer-events-auto absolute top-4 right-4 z-20 flex h-9 w-9 items-center
        justify-center rounded-full border surface-glass-chip bg-gray-900/55
        text-xs font-semibold tracking-wide shadow-lg transition-colors
        active:opacity-80 ${tone}`}
    >
      <span className="select-none" aria-hidden="true">{label}</span>
    </button>
  );
}
