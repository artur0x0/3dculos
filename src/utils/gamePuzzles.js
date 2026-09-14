// Curated match-the-part puzzle pack (Slice 04).
// Targets rebuildable with official puzzle helper vocabulary where possible.
// Editor stays blank on enter — spoilers live only in optional hint/blurb UI.

/** Blank on purpose — spoilers live only in the Hint modal / blurb. */
const BLANK_STARTER = '';

/** @typedef {{
 *   id: string,
 *   title: string,
 *   blurb: string,
 *   targetScript: string,
 *   starterScript?: string,
 *   difficulty?: 'easy' | 'medium' | 'hard',
 *   hint?: string,
 * }} GamePuzzle */

/** @type {GamePuzzle[]} */
export const GAME_PUZZLES = [
  {
    id: 'demo-fillet-box',
    title: 'Filleted box',
    blurb: 'Match the ghost: a 40×30×20 box with r=3 fillets on all convex edges.',
    difficulty: 'easy',
    targetScript: `// Demo target — 40×30×20 box, all convex edges filleted r=3
let part = Manifold.cube([40, 30, 20], true);
part = filletEdges(part, convexEdges(part), 3, { sphericalCorners: true });
return part;
`,
    starterScript: BLANK_STARTER,
    hint: `let part = Manifold.cube([40, 30, 20], true);
part = filletEdges(part, convexEdges(part), 3, { sphericalCorners: true });
return part;`,
  },
  {
    id: 'chamfer-cube',
    title: 'Chamfered cube',
    blurb: '30×30×30 cube with equal-leg chamfer c=2 on all convex edges.',
    difficulty: 'easy',
    targetScript: `// Chamfered cube — 30³, c=2 on all convex edges
let part = Manifold.cube([30, 30, 30], true);
part = chamferEdges(part, convexEdges(part), 2);
return part;
`,
    starterScript: BLANK_STARTER,
  },
  {
    id: 'rounded-box',
    title: 'Rounded box',
    blurb: '50×30×20 box with edge radius 4 via roundedBox.',
    difficulty: 'easy',
    targetScript: `// Rounded box via helper
return roundedBox([50, 30, 20], 4, 16);
`,
    starterScript: BLANK_STARTER,
  },
  {
    id: 'simple-tube',
    title: 'Pipe section',
    blurb: 'Tube: outer r=15, inner r=10, height 40.',
    difficulty: 'easy',
    targetScript: `// Pipe / tube section
return tube(15, 10, 40, 32);
`,
    starterScript: BLANK_STARTER,
  },
  {
    id: 'hex-spacer',
    title: 'Hex spacer',
    blurb: 'Hexagonal prism, circumscribed radius 12, height 8.',
    difficulty: 'easy',
    targetScript: `// Hex spacer
return hexPrism(12, 8);
`,
    starterScript: BLANK_STARTER,
  },
  {
    id: 'clearance-plate',
    title: 'Clearance plate',
    blurb: '60×40×6 plate sitting on z=0 with a centered M3 clearance hole.',
    difficulty: 'medium',
    targetScript: `// Plate with centered M3 clearance hole
let part = Manifold.cube([60, 40, 6], true);
part = align(part, { min: [undefined, undefined, 0] });
const top = facesByNormal(part, [0, 0, 1])[0];
const fr = workplaneFromFace(part, top);
const span = holeSpan(part, fr);
part = clearanceHole(part, fr, 0, 0, 'M3', span, 'normal');
return part;
`,
    starterScript: BLANK_STARTER,
  },
];

export const DEFAULT_PUZZLE_ID = GAME_PUZZLES[0].id;

/** @deprecated Prefer GAME_PUZZLES / getPuzzle — kept for slice 02/03 call sites */
export const DEMO_PUZZLE = GAME_PUZZLES[0];

export function getPuzzle(id) {
  return GAME_PUZZLES.find((p) => p.id === id) || null;
}

export function listPuzzles() {
  return GAME_PUZZLES;
}
