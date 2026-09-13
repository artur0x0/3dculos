// Demo match-the-part puzzle for Slice 02 game shell.
// Target is intentionally simple and rebuildable with official puzzle helpers.

/** Script that builds the ghost target solid (not shown in the editor). */
export const DEMO_TARGET_SCRIPT = `// Demo target — 40×30×20 box, all convex edges filleted r=3
let part = Manifold.cube([40, 30, 20], true);
part = filletEdges(part, convexEdges(part), 3, { sphericalCorners: true });
return part;
`;

/**
 * Starter script loaded into the editor when the player enters game mode.
 * Starts as an unfilleted box so the ghost (filleted) is visually distinct.
 */
export const GAME_STARTER_SCRIPT = `// Match the translucent cyan ghost target.
// Rebuild the same solid with helpers, then hit Run.
// Hint: filletEdges(part, convexEdges(part), 3, { sphericalCorners: true })

return Manifold.cube([40, 30, 20], true);
`;

export const DEMO_PUZZLE = {
  id: 'demo-fillet-box',
  title: 'Filleted box',
  blurb: 'Match the ghost: a 40×30×20 box with r=3 fillets on all convex edges.',
  targetScript: DEMO_TARGET_SCRIPT,
  starterScript: GAME_STARTER_SCRIPT,
};
