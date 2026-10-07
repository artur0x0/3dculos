/**
 * Initials for the CAD viewport profile chip (G9).
 *
 * Priority when signed in: first+last → name words → email local-part → "?".
 * Guest → "G". Signed out → "?".
 */
export function profileInitials({
  user = null,
  guest = null,
  isAuthenticated = false,
} = {}) {
  if (isAuthenticated && user) {
    const first = String(user.firstName || '').trim();
    const last = String(user.lastName || '').trim();
    if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
    if (first) return first.slice(0, 2).toUpperCase();
    if (last) return last.slice(0, 2).toUpperCase();

    const name = String(user.name || '').trim();
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
      }
      return name.slice(0, 2).toUpperCase();
    }

    const email = String(user.email || '').trim();
    if (email) {
      const local = email.split('@')[0] || '';
      const segs = local.split(/[._+-]/).filter(Boolean);
      if (segs.length >= 2) {
        return `${segs[0][0]}${segs[1][0]}`.toUpperCase();
      }
      const two = local.slice(0, 2).toUpperCase();
      return two || '?';
    }

    return '?';
  }

  if (guest) return 'G';
  return '?';
}
