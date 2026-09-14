// Curated match-the-part puzzle pack (Slice 04 + Slice 06 harder pack).
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
  // --- Slice 06: harder pack ---
  {
    id: 'flanged-tube',
    title: 'Flanged tube',
    blurb: 'Revolved silhouette: flange ⌀50×6 under a tube OD24 ID16, overall height 40.',
    difficulty: 'medium',
    targetScript: `// Flanged tube via makeRevolve silhouette
// Flange ⌀50×6, tube OD24 ID16, overall H40
return makeRevolve([
  [[8, 0], [25, 0], [25, 6], [12, 6], [12, 40], [8, 40]]
], 64);
`,
    starterScript: BLANK_STARTER,
    hint: `Profile x = radial (≥0), y = height. One closed contour leaves the ID hollow.`,
  },
  {
    id: 'hole-pattern-plate',
    title: 'Hole-pattern plate',
    blurb: '60×40×5 plate on z=0 with a centered 3×2 grid of Ø4 holes (18×14 spacing).',
    difficulty: 'medium',
    targetScript: `// Plate with 3×2 hole pattern
let part = Manifold.cube([60, 40, 5], true);
part = align(part, { min: [undefined, undefined, 0] });
const fr = workplaneFromFace(part, facesByNormal(part, [0, 0, 1])[0]);
part = holePattern(part, fr, { n: 3, m: 2, spacingU: 18, spacingV: 14, dia: 4 });
return part;
`,
    starterScript: BLANK_STARTER,
    hint: `Use holePattern on the top face workplane: n×m grid, spacingU/V, dia.`,
  },
  {
    id: 'cbore-mount',
    title: 'Counterbore mount',
    blurb: '50×50×14 block on z=0 with four corner counterbores (thru Ø5.5, cbore Ø10×4 deep at ±15).',
    difficulty: 'hard',
    targetScript: `// Counterbore mount block — 50×50×14 with 4 corner cbores
let part = Manifold.cube([50, 50, 14], true);
part = align(part, { min: [undefined, undefined, 0] });
const fr = workplaneFromFace(part, facesByNormal(part, [0, 0, 1])[0]);
const span = holeSpan(part, fr);
const o = 15;
for (const [u, v] of [[o, o], [o, -o], [-o, o], [-o, -o]]) {
  part = cboreHole(part, fr, u, v, 5.5, 10, 4, span);
}
return part;
`,
    starterScript: BLANK_STARTER,
    hint: `cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span)`,
  },
  {
    id: 'hex-nut',
    title: 'Hex nut',
    blurb: 'Hex prism (circumradius 10, height 6) on z=0 with a centered M8 clearance hole.',
    difficulty: 'medium',
    targetScript: `// Hex nut-like — hexPrism r=10 H=6 with centered M8 clearance
let part = hexPrism(10, 6);
part = center(part, [true, true, false]);
part = align(part, { min: [undefined, undefined, 0] });
const fr = workplaneFromFace(part, facesByNormal(part, [0, 0, 1])[0]);
part = clearanceHole(part, fr, 0, 0, 'M8');
return part;
`,
    starterScript: BLANK_STARTER,
    hint: `hexPrism + clearanceHole('M8') on the top face.`,
  },
  {
    id: 'shelled-draft-box',
    title: 'Shelled draft box',
    blurb: '50×40×30 box hollowed to 2.5 mm walls (open on Z-min) then tapered with 2° draft.',
    difficulty: 'hard',
    targetScript: `// Shelled box with 2° draft — 50×40×30, wall 2.5, open on Z-min
const box = Manifold.cube([50, 40, 30], true);
const hollowed = box.subtract(shell(box, 2.5, 'z'));
return addDraft(hollowed, 2, 'z');
`,
    starterScript: BLANK_STARTER,
    hint: `shell() returns the inner tool — subtract it, then addDraft(..., 2, 'z').`,
  },
  {
    id: 'polar-flange',
    title: 'Polar flange',
    blurb: 'Tube OD30 ID24 ×40 with a ⌀50×5 flange and four Ø6 mounting holes on a Ø40 bolt circle.',
    difficulty: 'hard',
    targetScript: `// Flanged tube with 4 polar mounting holes
const mainTube = tube(15, 12, 40, 64);
const flange = Manifold.cylinder(5, 25, 25, 64);
const bore = Manifold.cylinder(10, 3, 3, 32);
const holes = polarArray(bore, 4, 20, 'z');
let part = mainTube.add(flange);
part = part.subtract(holes);
part = center(part, [true, true, false]);
part = align(part, { min: [undefined, undefined, 0] });
return part;
`,
    starterScript: BLANK_STARTER,
    hint: `Union tube + flange, then subtract polarArray of bore cylinders.`,
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

/** Index of puzzle in pack order, or -1. */
export function getPuzzleIndex(id) {
  return GAME_PUZZLES.findIndex((p) => p.id === id);
}

/**
 * Next puzzle in pack order after `id`.
 * @returns {GamePuzzle | null} null at end of pack
 */
export function getNextPuzzle(id) {
  const i = getPuzzleIndex(id);
  if (i < 0 || i >= GAME_PUZZLES.length - 1) return null;
  return GAME_PUZZLES[i + 1];
}
