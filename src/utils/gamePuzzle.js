// Demo match-the-part puzzle + match/scoring constants (Slice 03).
// Target is intentionally simple and rebuildable with official puzzle helpers.

/** Script that builds the ghost target solid (not shown in the editor). */
export const DEMO_TARGET_SCRIPT = `// Demo target — 40×30×20 box, all convex edges filleted r=3
let part = Manifold.cube([40, 30, 20], true);
part = filletEdges(part, convexEdges(part), 3, { sphericalCorners: true });
return part;
`;

/**
 * Editor content when entering game mode.
 * Blank on purpose — spoilers live only in the Hint modal (slice 02.1).
 */
export const GAME_STARTER_SCRIPT = '';

export const DEMO_PUZZLE = {
  id: 'demo-fillet-box',
  title: 'Filleted box',
  blurb: 'Match the ghost: a 40×30×20 box with r=3 fillets on all convex edges.',
  targetScript: DEMO_TARGET_SCRIPT,
  starterScript: GAME_STARTER_SCRIPT,
};

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
 * Empty boolean difference (isEmpty on both sides) also counts as a match.
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
  const seconds = (totalTenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}
