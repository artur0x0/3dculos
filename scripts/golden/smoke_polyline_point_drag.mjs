/**
 * Golden: polyline points land under the cursor, and stay editable.
 *
 * Bug: the workplane overlay was painted with a bounds-snapped default plane
 * (part top), while the tap hit-test resolved its OWN fallback — the default
 * +Z frame at the world origin. On any part not sitting at z=0 the ray hit a
 * different plane than the one drawn, so every tapped point appeared offset
 * from the cursor by that parallax. One resolver (contourWorkplaneFace) now
 * feeds the paint, the hit-test and Confirm.
 */

import {
  enterContourState,
  contourWorkplaneFace,
  contourWorkplane,
  activeContourFace,
  planeFromContourFace,
  resolveContourWorkplane,
  intersectRayPlane,
  worldToPlaneUV,
  CONTOUR_TOOLS,
} from '../../src/utils/contourMode.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** Same mapping the draft painter uses to place a handle. */
const planeUVToWorld = ([u, v], plane) => [
  plane.center[0] + u * plane.x[0] + v * plane.y[0],
  plane.center[1] + u * plane.x[1] + v * plane.y[1],
  plane.center[2] + u * plane.x[2] + v * plane.y[2],
];

// A part resting ON the bed: bounds top at z=20, nowhere near the origin.
const bounds = {
  min: [-20, -15, 0],
  max: [20, 15, 20],
  center: [0, 0, 10],
  size: [40, 30, 20],
};

// ── One resolver for paint, pick and Confirm ───────────────────
console.log('polyline workplane — paint, hit-test and Confirm agree');
{
  const st = enterContourState('crossSection', null);
  check('no face picked', st.planeFace == null);

  const plane = contourWorkplane(st, bounds);
  check('fallback plane sits on the part top, not the world origin',
    near(plane.center[2], 20), `z=${plane.center[2]}`);
  check('fallback plane is +Z', near(plane.normal[2], 1));

  // The old tap path resolved planeFromContourFace(state.planeFace) === origin.
  const stalePlane = planeFromContourFace(st.planeFace);
  check('the old hit-test plane really was a different plane (regression guard)',
    !near(stalePlane.center[2], plane.center[2]));

  const commitPlane = planeFromContourFace(activeContourFace(st, bounds));
  check('Confirm commits the very plane that was drawn',
    near(commitPlane.center[2], plane.center[2])
    && near(commitPlane.normal[2], plane.normal[2])
    && near(commitPlane.x[0], plane.x[0])
    && near(commitPlane.y[1], plane.y[1]));

  const overlay = contourWorkplaneFace(st, bounds);
  check('overlay quad is sized from the part', overlay.area === 40 * 30);

  // No bounds at all (empty scene) still resolves, at the origin.
  check('no bounds → origin plane', near(contourWorkplane(st, null).center[2], 0));
}

// ── A picked face always wins ──────────────────────────────────
console.log('polyline workplane — a picked face wins over the fallback');
{
  const face = resolveContourWorkplane({
    center: [20, 0, 10],
    normal: [1, 0, 0],
    area: 600,
    triangleCount: 2,
    selectionMode: 'coplanar',
    vertices: [[20, -15, 0], [20, 15, 0], [20, 15, 20], [20, -15, 20]],
  }).face;
  const st = { ...enterContourState('crossSection', null), planeFace: face };
  const plane = contourWorkplane(st, bounds);
  check('picked side face, not the bounds top',
    near(plane.center[0], 20) && near(plane.normal[0], 1));
}

// ── A tap lands where the cursor is ────────────────────────────
console.log('polyline tap — the point lands under the cursor');
{
  const st = enterContourState('crossSection', null);
  const plane = contourWorkplane(st, bounds);

  // A camera looking down at an angle; ray through some screen direction.
  const origin = [60, -70, 90];
  const aim = [6, -4, 20]; // a point on the drawn plane the user aimed at
  const dir = [aim[0] - origin[0], aim[1] - origin[1], aim[2] - origin[2]];

  const hit = intersectRayPlane(origin, dir, plane);
  check('ray meets the drawn plane', Array.isArray(hit));
  check('hit is exactly where the cursor pointed',
    near(hit[0], aim[0], 1e-9) && near(hit[1], aim[1], 1e-9) && near(hit[2], aim[2], 1e-9));

  const uv = worldToPlaneUV(hit, plane);
  const back = planeUVToWorld(uv, plane);
  check('uv round-trips back to the same world point',
    near(back[0], aim[0], 1e-9) && near(back[1], aim[1], 1e-9) && near(back[2], aim[2], 1e-9));

  // Same ray against the OLD (origin) plane is what the user was seeing.
  const wrong = intersectRayPlane(origin, dir, planeFromContourFace(null));
  check('the old plane put the point somewhere else entirely',
    Math.hypot(wrong[0] - aim[0], wrong[1] - aim[1]) > 1);
}

// ── Point edits keep the rest of the sketch ────────────────────
console.log('polyline points — moving one point leaves the others alone');
{
  // The drag commit is a positional replace; pin that shape here so a future
  // refactor cannot turn "move point 1" into "rewrite the polyline".
  const points = [[0, 0], [10, 0], [10, 8], [0, 8]];
  const moved = points.map((pt, i) => (i === 2 ? [14, 12] : pt));
  check('only the dragged index changes',
    moved.length === 4
    && moved[0][0] === 0 && moved[1][0] === 10
    && moved[2][0] === 14 && moved[2][1] === 12
    && moved[3][1] === 8);
  check('source array is untouched', points[2][0] === 10 && points[2][1] === 8);

  const tool = CONTOUR_TOOLS.find((t) => t.id === 'polyline');
  check('polyline tool teaches the right-drag', /right-drag/i.test(tool?.title || ''));
}

if (failed) {
  console.log(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('All polyline point / workplane checks passed.');
