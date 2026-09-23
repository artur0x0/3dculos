#!/usr/bin/env node
/**
 * Slice 21 — Cross-section substrate smoke.
 * - profile builders + makeCrossSection (pure mirror + worker helpers via Manifold)
 * - planar face → plane frame; non-planar refuse
 * - palette compose emits makeCrossSection / profile*
 * - preview rings on plane
 */
import Module from '../../built/manifold.js';
import {
  composeHelperInsert,
  allocateUniqueName,
  HELPER_PALETTE_ITEMS,
} from '../../src/utils/helperPaletteSnippets.js';
import {
  classifySelectedFace,
  resolveFaceModal,
  isFaceFeature,
  FACE_FEATURE_IDS,
  PLANAR_ONLY_FEATURE_IDS,
  emitFaceWorkplaneLines,
} from '../../src/utils/faceFeaturePlacement.js';
import {
  planeFrameFromFaceData,
  defaultTopPlaneFrame,
  circleContours,
  rectangleContours,
  regularPolygonContours,
  quarterCircleFilletContours,
  normalizeClosedPolyline,
  buildProfileFromParams,
  assembleCrossSection,
  buildCrossSectionPreview,
  contoursToWorldRings,
  contourArea2D,
  CROSS_SECTION_REFUSE_NON_PLANAR,
} from '../../src/utils/crossSectionSubstrate.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function expectThrow(label, fn, re) {
  let ok = false;
  try { fn(); } catch (e) { ok = re.test((e && e.message) || ''); }
  check(label, ok);
}

console.log('slice-21 cross-section substrate smoke');

const planarFace = {
  center: [0, 0, 10],
  normal: [0, 0, 1],
  area: 1200,
  triangleCount: 2,
  selectionMode: 'coplanar',
};

const cylFace = {
  center: [15, 0, 5],
  normal: [1, 0, 0],
  area: 800,
  triangleCount: 24,
  selectionMode: 'angular-tolerance',
};

const irregularFace = {
  center: [0, 0, 0],
  normal: [0.1, 0.2, 0.9],
  area: 500,
  triangleCount: 40,
  selectionMode: 'all-connected',
};

// ── Classification / modal ─────────────────────────────────────
{
  check('crossSection is face feature', isFaceFeature('crossSection'));
  check('crossSection in FACE_FEATURE_IDS', FACE_FEATURE_IDS.has('crossSection'));
  check('crossSection is planar-only', PLANAR_ONLY_FEATURE_IDS.has('crossSection'));

  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === 'crossSection');
  check('palette has crossSection', !!item);
  check('palette in Advanced group', item && item.group === 'Advanced');

  const r0 = resolveFaceModal(item, null);
  check('no face → default modal', r0.mode === 'default');

  const r1 = resolveFaceModal(item, planarFace);
  check('planar → params modal', r1.mode === 'params');
  check('planar face type on modal', r1.face && r1.face.type === 'planar');

  const r2 = resolveFaceModal(item, cylFace);
  check('cylindrical → refuse', r2.mode === 'refuse');
  check('refuse mentions planar', /planar/i.test(r2.message || ''));

  const r3 = resolveFaceModal(item, irregularFace);
  check('irregular → refuse', r3.mode === 'refuse');
  check('refuse constant present', typeof CROSS_SECTION_REFUSE_NON_PLANAR === 'string');
}

// ── Plane frame ────────────────────────────────────────────────
// Mirrors sandboxWorker workplaneFromFace mapping table (±X/±Y/±Z):
//   +Z → u→+X,v→+Y ; -Z → u→+X,v→-Y ; +X → u→+Y,v→+Z ;
//   -X → u→+Y,v→-Z ; +Y → u→+X,v→-Z ; -Y → u→+X,v→+Z.
{
  const near = (a, b, eps = 1e-9) =>
    Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
  const frameFor = (normal) =>
    planeFrameFromFaceData({ center: [0, 0, 0], normal, type: 'planar' });

  const table = [
    { label: '+Z', n: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
    { label: '-Z', n: [0, 0, -1], x: [1, 0, 0], y: [0, -1, 0] },
    { label: '+X', n: [1, 0, 0], x: [0, 1, 0], y: [0, 0, 1] },
    { label: '-X', n: [-1, 0, 0], x: [0, 1, 0], y: [0, 0, -1] },
    { label: '+Y', n: [0, 1, 0], x: [1, 0, 0], y: [0, 0, -1] },
    { label: '-Y', n: [0, -1, 0], x: [1, 0, 0], y: [0, 0, 1] },
  ];
  for (const row of table) {
    const fr = frameFor(row.n);
    check(`${row.label} face normal`, near(fr.normal, row.n));
    check(`${row.label} face x`, near(fr.x, row.x));
    check(`${row.label} face y`, near(fr.y, row.y));
  }

  // Keep the classifySelectedFace path for the original +Z planar fixture.
  const fr = planeFrameFromFaceData(classifySelectedFace(planarFace));
  check('+Z face (classified) x → +X', Math.abs(fr.x[0] - 1) < 1e-9 && Math.abs(fr.x[1]) < 1e-9);
  check('+Z face (classified) y → +Y', Math.abs(fr.y[1] - 1) < 1e-9 && Math.abs(fr.y[0]) < 1e-9);

  // Diagonal fallback (best > 0.9): when no world axis is sufficiently in-plane,
  // planeFrameFromFaceData projects the first usable vert onto the plane
  // (sandboxWorker.js:1368-1372 mirror). For unit n≈[1,1,1]/√3, best=1/√3 < 0.9
  // so axis-min still wins (x=+X, not projected onto plane — x·n may be ≠0);
  // verts are ignored. Frame must stay finite with unit x,y and y ⟂ n,x.
  const dLen = (v) => Math.hypot(v[0], v[1], v[2]);
  const dDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const inv = 1 / Math.sqrt(3);
  const diagVerts = [
    [0, 0, 0],
    [0, 1, -1], // in plane of [1,1,1]
    [0, -1, 1],
  ];
  const diag = planeFrameFromFaceData({
    center: [0, 0, 0],
    normal: [inv, inv, inv],
    type: 'planar',
    verts: diagVerts,
  });
  check('diagonal |n|=1', Math.abs(dLen(diag.normal) - 1) < 1e-9);
  check('diagonal finite frame',
    diag.x.every((c) => Number.isFinite(c)) && diag.y.every((c) => Number.isFinite(c))
    && Math.abs(dLen(diag.x) - 1) < 1e-9
    && Math.abs(dLen(diag.y) - 1) < 1e-9
    && Math.abs(dDot(diag.y, diag.normal)) < 1e-9
    && Math.abs(dDot(diag.x, diag.y)) < 1e-9);
  check('diagonal x → +X (axis-min, best<0.9)', near(diag.x, [1, 0, 0]));
  check('diagonal y ⟂ n', Math.abs(dDot(diag.y, diag.normal)) < 1e-9);
  const diagNoVerts = frameFor([1, 1, 1]);
  check('diagonal+verts ≡ axis-min (verts ignored)', near(diag.x, diagNoVerts.x) && near(diag.y, diagNoVerts.y));

  const top = defaultTopPlaneFrame();
  check('default top plane +Z', top.normal[2] === 1);
}

// ── Profiles ───────────────────────────────────────────────────
{
  const circ = circleContours(5, 32);
  check('circle has 1 contour', circ.length === 1 && circ[0].length === 32);
  check('circle area ~ πr²', Math.abs(Math.abs(contourArea2D(circ[0])) - Math.PI * 25) < 1.5);

  const rect = rectangleContours(20, 12, true);
  check('rectangle 4 verts', rect[0].length === 4);
  check('rectangle area 240', Math.abs(Math.abs(contourArea2D(rect[0])) - 240) < 1e-6);

  const hex = regularPolygonContours(6, 8);
  check('hexagon 6 verts', hex[0].length === 6);

  const qc = quarterCircleFilletContours(3, 8);
  check('quarter-circle closed', qc[0].length >= 4);
  check('quarter-circle area > 0', contourArea2D(qc[0]) > 0);

  // Message-shape coverage for normalizeClosedPolyline throw branches.
  expectThrow('2-point → /polyline/', () => normalizeClosedPolyline([[0, 0], [1, 0]]), /polyline/);
  expectThrow('NaN coords → /finite/', () => normalizeClosedPolyline([[NaN, 0], [1, 0], [0, 1]]), /finite/);
  // [[0,0],[1,0],[0,0]]: drop-close (length>=3) pops → 2 pts → /distinct/.
  expectThrow(
    'closed digon → /distinct/',
    () => normalizeClosedPolyline([[0, 0], [1, 0], [0, 0]]),
    /distinct/,
  );
  expectThrow(
    'collinear ≥3 → /zero area|degenerate/',
    () => normalizeClosedPolyline([[0, 0], [1, 0], [2, 0]]),
    /zero area|degenerate/,
  );

  const built = buildProfileFromParams({ profileType: 'circle', radius: 4, segments: 16 });
  check('buildProfileFromParams circle', built.profile.type === 'circle' && built.contours[0].length === 16);
}

// ── assembleCrossSection ───────────────────────────────────────
{
  const plane = planeFrameFromFaceData(classifySelectedFace(planarFace));
  const xs = assembleCrossSection(plane, { type: 'circle', radius: 5, segments: 24 });
  check('kind tag', xs.kind === 'crossSection');
  check('has contours', Array.isArray(xs.contours) && xs.contours[0].length === 24);
  check('plane copied', xs.plane.center[2] === 10);

  const rings = contoursToWorldRings(xs.plane, xs.contours);
  check('world ring closed', rings[0].length === 25); // 24 + close
  // All points should have z ≈ 10 (on +Z face plane at z=10)
  const zOk = rings[0].every((p) => Math.abs(p[2] - 10) < 1e-6);
  check('ring lies on plane z=10', zOk);
}

// ── Preview ────────────────────────────────────────────────────
{
  const prev = buildCrossSectionPreview(classifySelectedFace(planarFace), {
    profileType: 'rectangle',
    width: 10,
    height: 6,
    centered: true,
  });
  check('preview builds rings', prev && prev.rings.length === 1);
  check('preview profile rectangle', prev.profile.type === 'rectangle');

  const prevPoly = buildCrossSectionPreview(classifySelectedFace(planarFace), {
    profileType: 'polygon',
    polygonPreset: 'quarterCircle',
    radius: 3,
  });
  check('preview quarterCircle', prevPoly && prevPoly.profile.preset === 'quarterCircle');
}

// ── Compose / emit ─────────────────────────────────────────────
{
  const buf = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n';
  const face = classifySelectedFace(planarFace);
  const out = composeHelperInsert(buf, 'crossSection', null, {
    profileType: 'circle',
    radius: 5,
    segments: 32,
    body: 'part',
  }, face, null);
  check('compose returns buffer', typeof out === 'string' && out.length > 20);
  check('compose has makeCrossSection', /makeCrossSection\s*\(/.test(out));
  check('compose has profileCircle', /profileCircle\s*\(/.test(out));
  check('compose has workplaneFromFace', /workplaneFromFace/.test(out));
  check('compose has facesByNormal', /facesByNormal/.test(out));
  check('no illegal bare top', !/\btop\b/.test(out.replace(/topFace/g, 'FACE')));
  check('still returns part', /return\s+part\s*;/.test(out));
  check('declares xs named let', /const\s+xs\d*\s*=/.test(out));

  const outRect = composeHelperInsert(buf, 'crossSection', null, {
    profileType: 'rectangle',
    width: 16,
    height: 8,
    centered: true,
  }, face, null);
  check('compose rectangle uses profileRectangle', /profileRectangle\s*\(/.test(outRect));

  const outPoly = composeHelperInsert(buf, 'crossSection', null, {
    profileType: 'polygon',
    polygonPreset: 'hexagon',
    radius: 7,
  }, face, null);
  check('compose polygon uses profilePolygon', /profilePolygon\s*\(/.test(outPoly));

  const names = new Set();
  const { lines } = emitFaceWorkplaneLines('part', face, names, allocateUniqueName);
  check('workplane emit non-empty', lines.length > 2);
}

// ── Worker helpers via Manifold WASM ───────────────────────────
{
  const wasm = await Module();
  wasm.setup();
  // Mirror worker helpers inline (same math) — execute a tiny script scope.
  // Importing sandboxWorker is awkward in Node; re-check assemble + CrossSection.extrude path.
  const plane = planeFrameFromFaceData(classifySelectedFace(planarFace));
  const xs = assembleCrossSection(plane, { type: 'circle', radius: 5, segments: 32 });
  const { CrossSection } = wasm;
  const cs = new CrossSection(xs.contours);
  const solid = cs.extrude(2);
  check('CrossSection from contours extrudes', typeof solid.volume === 'function' && solid.volume() > 0);
  // Approximate volume π r² h
  const expected = Math.PI * 25 * 2;
  check('extrude volume ~ πr²h', Math.abs(solid.volume() - expected) / expected < 0.05);

  // Rectangle path
  const xsR = assembleCrossSection(plane, {
    type: 'rectangle', width: 10, height: 4, centered: true,
  });
  const solidR = new CrossSection(xsR.contours).extrude(3);
  check('rect extrude volume ~ 120', Math.abs(solidR.volume() - 120) < 1e-3);
}

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll slice-21 checks passed.');
