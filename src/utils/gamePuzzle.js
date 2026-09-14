// Match-the-part game constants + re-exports (Slices 02–04).
// Puzzle definitions live in gamePuzzles.js.

export {
  GAME_PUZZLES,
  DEFAULT_PUZZLE_ID,
  DEMO_PUZZLE,
  getPuzzle,
  listPuzzles,
} from './gamePuzzles.js';

/**
 * Editor content when entering game mode.
 * Blank on purpose — spoilers live only in the Hint modal (slice 02.1).
 */
export const GAME_STARTER_SCRIPT = '';

/**
 * Match epsilon (tessellation-safe).
 *
 * After a successful Run, attempt vs ghost is compared in the worker on the
 * live Manifold handles (same kernel as execute — no remesh):
 *
 *   V_symdiff = vol(attempt − target) + vol(target − attempt)
 *   match iff  V_symdiff / max(V_target, MATCH_VOL_FLOOR_MM3) < MATCH_REL_EPS
 *
 * 0.002 (0.2%) covers fillet/chamfer segment slivers on the demo part
 * (~2e4 mm³) while still rejecting a ~0.1 mm miss on a primary dimension.
 * Empty boolean diffs have volume 0, so exact match is covered by the
 * volume criterion (isEmpty is only an optional fast-path).
 *
 * Tiny-solid note: for sub-~0.3 mm features / tiny volumes the volume
 * pre-filter is weak and grading is dominated by the symdiff branch; the
 * demo part (~2e4 mm³) is the intended regime.
 *
 * Pose is compared as-built (no recenter / rotation search) so the attempt
 * must sit on the ghost.
 */
export const MATCH_REL_EPS = 0.002;
export const MATCH_VOL_FLOOR_MM3 = 1e-6;

/** Brief success banner, then auto-clear attempt + blank editor (no Submit). */
export const SUCCESS_CLEAR_MS = 1600;

/** Elapsed display: m:ss.t (lower is better). */
export function formatGameTime(ms) {
  const clamped = Math.max(0, Number(ms) || 0);
  const totalTenths = Math.floor(clamped / 100);
  const minutes = Math.floor(totalTenths / 600);
  // seconds is 0.0–59.9; padStart(4,'0') yields m:ss.t e.g. 0:05.0 / 1:01.2
  const seconds = (totalTenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}
