/**
 * Match-the-part entry. Five stationary taps inside three seconds.
 *
 * The sequence does not persist. Unlocking calls the same start path the
 * old toolbar button used, then forgets the taps. Leaving the puzzle
 * (Back to CAD) requires another five taps. Nothing is written to
 * sessionStorage or localStorage.
 *
 * `signedIn` is `useAuthState().signedIn` in React, or
 * `authStateFromPhase(phase).signedIn` elsewhere. Grey reauth counts.
 * Signed-out and pending do not: those taps return an empty list and
 * never unlock.
 */

export const PUZZLE_UNLOCK_TAPS = 5;
export const PUZZLE_UNLOCK_WINDOW_MS = 3000;
/** A pointer that travels farther than this is a drag, not a tap. */
export const PUZZLE_UNLOCK_DRAG_PX = 8;

export function emptyPuzzleTaps() {
  return [];
}

/**
 * @param {number[]} taps
 * @param {{ now: number, signedIn: boolean }} input
 * @returns {{ taps: number[], unlocked: boolean }}
 */
export function notePuzzleTap(taps, { now, signedIn } = {}) {
  if (!signedIn || !Number.isFinite(now)) {
    return { taps: [], unlocked: false };
  }
  const start = now - PUZZLE_UNLOCK_WINDOW_MS;
  const next = [];
  if (Array.isArray(taps)) {
    for (const t of taps) {
      if (typeof t === 'number' && t >= start && t <= now) next.push(t);
    }
  }
  next.push(now);
  if (next.length >= PUZZLE_UNLOCK_TAPS) {
    return { taps: [], unlocked: true };
  }
  return { taps: next, unlocked: false };
}

/** True when the pointer barely moved between down and up. */
export function isStationaryTap(dx, dy, limit = PUZZLE_UNLOCK_DRAG_PX) {
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  return (x * x) + (y * y) <= limit * limit;
}
