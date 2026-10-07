/**
 * Profile chip — CAD viewport (absolute), Parts ribbon + Script toolbar (inline).
 *
 * CAD (viewport): green → ProfilePanel; grey → Login (onAccount). No Clear
 * local CAD data popup here.
 *
 * Parts + Script (inline): always opens a panel. Signed out → Sign in + Clear
 * local CAD data. Signed in → account panel + Clear local CAD data when wired.
 */
import React, { useMemo, useState } from 'react';
import { User } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { profileInitials } from '../utils/profileInitials.js';
import {
  clearGithubToken,
  hasGithubToken,
  loadGithubToken,
} from '../utils/git/githubAuth.js';
import { DEFAULT_VAULT_NAME } from '../utils/git/vault.js';
import ProfilePanel from './ProfilePanel';

export default function ProfileChip({
  onAccount,
  onSignedOut = null,
  onClearLocalCadData = null,
  vaultName = DEFAULT_VAULT_NAME,
  variant = 'viewport',
}) {
  const { user, guest, isAuthenticated, isGuest, logout, checkAuth } = useAuth();
  const [panelOpen, setPanelOpen] = useState(false);

  const githubLinked = !isAuthenticated && hasGithubToken();
  const signedIn = isAuthenticated || githubLinked;
  // Parts / Script: panel even when signed out (Sign in + Clear local CAD data).
  const localMenu = variant === 'inline' && typeof onClearLocalCadData === 'function';

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
      ? 'GitHub connected — account'
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
    : `pointer-events-auto absolute top-4 right-4 z-50 flex h-9 w-9 items-center
        justify-center rounded-full border surface-glass-chip bg-gray-900/55
        text-xs font-semibold tracking-wide shadow-lg transition-colors
        active:opacity-80 ${tone}`;

  const iconSize = inline ? 14 : 16;
  const wrapClass = inline
    ? 'pointer-events-auto relative z-10 shrink-0'
    : 'pointer-events-auto absolute top-4 right-4 z-50';

  const handleClick = () => {
    // Parts / Script: always open the local menu panel.
    if (localMenu) {
      setPanelOpen((open) => !open);
      return;
    }
    // CAD: green chip = signed in (session and/or GitHub token). Always open
    // the account panel — never bounce a green chip to Login/AuthStep.
    if (signedIn) {
      setPanelOpen((open) => !open);
      return;
    }
    onAccount?.();
  };

  const handleSignOut = async () => {
    clearGithubToken();
    await logout();
    onSignedOut?.();
  };

  const handleDeleteAccount = async () => {
    const token = loadGithubToken();
    const res = await fetch('/api/auth/account', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        access_token: token || undefined,
        vault_name: vaultName || DEFAULT_VAULT_NAME,
      }),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      throw new Error(body?.error || `Delete failed (${res.status})`);
    }
    clearGithubToken();
    await checkAuth();
    onSignedOut?.();
  };

  const showPanel = signedIn || localMenu;

  return (
    <div className={wrapClass} data-profile-chip-wrap="">
      <button
        type="button"
        data-profile-chip=""
        data-profile-chip-variant={variant}
        data-profile-initials={label || (signedIn ? 'user' : 'out')}
        data-profile-auth={authState}
        aria-expanded={showPanel ? (panelOpen ? 'true' : 'false') : undefined}
        aria-haspopup={showPanel ? 'dialog' : undefined}
        onClick={handleClick}
        onPointerDown={(e) => e.stopPropagation()}
        title={title}
        aria-label={title}
        className={inline
          ? shell.replace('relative z-10 ', '')
          : shell.replace('absolute top-4 right-4 z-50 ', '')}
      >
        {label ? (
          <span className="select-none" aria-hidden="true">{label}</span>
        ) : (
          <User size={iconSize} aria-hidden="true" strokeWidth={2.25} data-profile-icon="user" />
        )}
      </button>
      {showPanel && (
        <ProfilePanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          onSignOut={handleSignOut}
          onDeleteAccount={handleDeleteAccount}
          onSignIn={localMenu ? () => { onAccount?.(); } : null}
          onClearLocalCadData={localMenu ? onClearLocalCadData : null}
          signedIn={signedIn}
          align="right"
        />
      )}
    </div>
  );
}
