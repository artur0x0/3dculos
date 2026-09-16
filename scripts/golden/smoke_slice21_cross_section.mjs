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
  check('palette in Features group', item && item.group === 'Features');

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
{
  const fr = planeFrameFromFaceData(classifySelectedFace(planarFace));
  check('+Z face normal', Math.abs(fr.normal[2] - 1) < 1e-9);
  check('+Z face x → +X', Math.abs(fr.x[0] - 1) < 1e-9 && Math.abs(fr.x[1]) < 1e-9);
  check('+Z face y → +Y', Math.abs(fr.y[1] - 1) < 1e-9 && Math.abs(fr.y[0]) < 1e-9);
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

  let threw = false;
  try { normalizeClosedPolyline([[0, 0], [1, 0]]); } catch { threw = true; }
  check('2-point polygon throws', threw);

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
