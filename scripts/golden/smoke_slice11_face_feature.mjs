#!/usr/bin/env node
/**
 * Slice 11 — Face-select → feature placement: classify, compose, no illegal top.
 */
import {
  composeHelperInsert,
  allocateUniqueName,
  declaredNames,
  HELPER_PALETTE_ITEMS,
} from '../../src/utils/helperPaletteSnippets.js';
import {
  classifySelectedFace,
  isFaceFeature,
  FACE_FEATURE_IDS,
  resolveFaceModal,
  faceAwareParams,
  emitFaceWorkplaneLines,
} from '../../src/utils/faceFeaturePlacement.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('slice-11 face feature placement smoke');

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

// ── Classification ─────────────────────────────────────────────
{
  const p = classifySelectedFace(planarFace);
  check('planar type', p && p.type === 'planar');
  const c = classifySelectedFace(cylFace);
  check('cylindrical type', c && c.type === 'cylindrical');
  const i = classifySelectedFace(irregularFace);
  check('irregular type', i && i.type === 'irregular');
  check('irregular has refuse message', i && typeof i.refuseMessage === 'string' && i.refuseMessage.length > 20);
  check('null face → null', classifySelectedFace(null) === null);
}

// ── Face feature set ───────────────────────────────────────────
{
  check('hole is face feature', isFaceFeature('hole'));
  check('cube is not face feature', !isFaceFeature('cube'));
  for (const id of ['hole', 'clearanceHole', 'cboreHole', 'cskHole', 'holePattern', 'filletEdges', 'chamferEdges']) {
    check(`FACE_FEATURE_IDS has ${id}`, FACE_FEATURE_IDS.has(id));
  }
}

// ── Modal resolve ──────────────────────────────────────────────
{
  const holeItem = HELPER_PALETTE_ITEMS.find((h) => h.id === 'hole');
  const r0 = resolveFaceModal(holeItem, null);
  check('no face → default modal', r0.mode === 'default');
  const r1 = resolveFaceModal(holeItem, planarFace);
  check('planar hole → params modal', r1.mode === 'params');
  check('planar hole has through param', r1.item.params.some((p) => p.name === 'through'));
  check('planar hole has usePattern', r1.item.params.some((p) => p.name === 'usePattern'));
  const r2 = resolveFaceModal(holeItem, irregularFace);
  check('irregular → refuse', r2.mode === 'refuse');
  const cubeItem = HELPER_PALETTE_ITEMS.find((h) => h.id === 'cube');
  check('cube with face still default', resolveFaceModal(cubeItem, planarFace).mode === 'default');
}

// ── Workplane emit ─────────────────────────────────────────────
{
  const names = new Set();
  const face = classifySelectedFace(planarFace);
  const { lines, frVar } = emitFaceWorkplaneLines('part', face, names, allocateUniqueName);
  const joined = lines.join('\n');
  check('workplane uses facesByNormal', /facesByNormal/.test(joined));
  check('workplane uses workplaneFromFace', /workplaneFromFace/.test(joined));
  check('no illegal bare top', !/\btop\b/.test(joined));
  check('fr var allocated', typeof frVar === 'string' && frVar.length > 0);
  check('normal literal present', joined.includes('[0, 0, 1]'));
}

// ── Compose planar hole ────────────────────────────────────────
{
  const face = classifySelectedFace(planarFace);
  const buf = composeHelperInsert('', 'hole', null, { dia: 6, u: 2, v: -1, through: true }, face);
  check('planar hole composes', typeof buf === 'string' && buf.length > 0);
  check('planar hole: facesByNormal', /facesByNormal/.test(buf));
  check('planar hole: workplaneFromFace', /workplaneFromFace/.test(buf));
  check('planar hole: no bare top', !/\btop\b/.test(buf));
  check('planar hole: uses selFace pick', /selFace/.test(buf));
  check('planar hole: hole call', /hole\(/.test(buf));
  check('planar hole: u,v', /hole\([^)]*,\s*2,\s*-1,\s*6/.test(buf));
  check('planar hole: single return', (buf.match(/\breturn\s+part\s*;/g) || []).length === 1);
  console.log('\n--- example planar hole ---\n' + buf + '\n---');
}

// ── Compose planar hole pattern ────────────────────────────────
{
  const face = classifySelectedFace(planarFace);
  const buf = composeHelperInsert(
    '',
    'hole',
    null,
    { dia: 4, usePattern: true, n: 3, m: 2, spacingU: 18, spacingV: 14, through: true },
    face,
  );
  check('pattern uses holePattern', /holePattern/.test(buf));
  check('pattern n,m,spacing', /n:\s*3/.test(buf) && /m:\s*2/.test(buf) && /spacingU:\s*18/.test(buf));
  check('pattern no illegal top', !/\btop\b/.test(buf));
  console.log('\n--- example planar hole pattern ---\n' + buf + '\n---');
}

// ── Without face: palette v2 defaults preserved ────────────────
{
  const buf = composeHelperInsert('', 'hole', null, { dia: 8 });
  check('no-face hole uses topFace', /\btopFace\b/.test(buf));
  check('no-face hole facesByNormal +Z', /facesByNormal\([^,]+,\s*\[0,\s*0,\s*1\]\)/.test(buf));
  check('no-face cube still works', /let\s+box1\s*=/.test(composeHelperInsert('', 'cube')));
}

// ── Fillet with face edges ─────────────────────────────────────
{
  const face = classifySelectedFace(planarFace);
  const buf = composeHelperInsert('', 'filletEdges', null, { radius: 2, edgeScope: 'face' }, face);
  check('fillet face filters convexEdges', /convexEdges\(/.test(buf) && /\.filter\(/.test(buf));
  check('fillet faceEdges var', /faceEdges/.test(buf));
  check('fillet signed parallel (not abs)', /_dot\(n, _n\) > 0\.95/.test(buf) && !/Math\.abs\(_dot/.test(buf));
}

// ── Clearance pattern preserves size/fit via fastenerClearanceDia ─
{
  const face = classifySelectedFace(planarFace);
  const buf = composeHelperInsert(
    '',
    'clearanceHole',
    null,
    { size: 'M6', fit: 'loose', usePattern: true, n: 2, m: 2, spacingU: 20, spacingV: 16, through: true },
    face,
  );
  check('clearance pattern uses holePattern', /holePattern/.test(buf));
  check('clearance pattern fastenerClearanceDia', /fastenerClearanceDia\(\s*'M6'\s*,\s*'loose'\s*\)/.test(buf));
  check('clearance pattern no hardcoded 3.4', !/dia:\s*3\.4/.test(buf));
  check('clearance pattern dia from _cd', /dia:\s*_cd\b/.test(buf));
}

// ── Cylindrical hole ───────────────────────────────────────────
{
  const face = classifySelectedFace(cylFace);
  check('cyl params include angleDeg', faceAwareParams('hole', 'cylindrical').some((p) => p.name === 'angleDeg'));
  const buf = composeHelperInsert('', 'hole', null, { dia: 5, angleDeg: 0, axial: 5, through: true }, face);
  check('cyl hole composes', /hole\(/.test(buf));
  check('cyl hole no bare top', !/\btop\b/.test(buf));
}

// ── Declared names still unique after face compose ─────────────
{
  const face = classifySelectedFace(planarFace);
  let buf = composeHelperInsert('', 'cube');
  buf = composeHelperInsert(buf, 'hole', null, { dia: 6, through: true }, face);
  buf = composeHelperInsert(buf, 'hole', null, { dia: 4, through: true }, face);
  const names = declaredNames(buf);
  check('second face hole unique fr/selFace', names.has('fr2') || names.has('selFace2'));
  check('still one return', (buf.match(/\breturn\s+part\s*;/g) || []).length === 1);
}

if (failed) {
  console.log(`\nFAILED: ${failed}`);
  process.exit(1);
}
console.log('\nAll slice-11 face feature checks passed.');
