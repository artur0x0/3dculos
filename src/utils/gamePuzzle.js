// Demo match-the-part puzzle for Slice 02 game shell.
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
