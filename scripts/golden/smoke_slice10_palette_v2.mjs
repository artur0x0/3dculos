#!/usr/bin/env node
/**
 * Slice 10 — Palette v2: params, unique body vars, no illegal `top`, compose+defaults.
 */
import { readFileSync } from 'node:fs';
import {
  composeHelperInsert,
  buildHelperSnippet,
  allocateUniqueName,
  declaredNames,
  listBodyNames,
  HELPER_PALETTE_ITEMS,
  HELPER_PALETTE_GROUPS,
  itemsByGroup,
  defaultParamsFor,
  coerceNumberParam,
} from '../../src/utils/helperPaletteSnippets.js';
import {
  isContourEntry,
  isExtrudeEntry,
  isRevolveEntry,
  isLoftEntry,
  isSweepEntry,
} from '../../src/utils/contourMode.js';
import { isFilletEntry } from '../../src/utils/filletMode.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('slice-10 palette v2 smoke');

// ── Allocator ──────────────────────────────────────────────────
{
  const s = new Set();
  check('box → box1', allocateUniqueName(s, 'box') === 'box1');
  check('box again → box2', allocateUniqueName(s, 'box') === 'box2');
  check('part → part', allocateUniqueName(s, 'part') === 'part');
  check('part again → part2', allocateUniqueName(s, 'part') === 'part2');
  check('fr → fr', allocateUniqueName(s, 'fr') === 'fr');
  check('fr again → fr2', allocateUniqueName(s, 'fr') === 'fr2');
}

// ── Defaults + params schema on every item ─────────────────────
{
  for (const item of HELPER_PALETTE_ITEMS) {
    check(`${item.id} has params array`, Array.isArray(item.params));
    const d = defaultParamsFor(item.id);
    check(`${item.id} defaultParams keys`, Object.keys(d).length === item.params.length);
  }
}

// ── Unique bodies on repeated cube ─────────────────────────────
{
  let buf = composeHelperInsert('', 'cube', null, { width: 40, depth: 30, height: 20, center: true });
  check('cube1 uses box1', /let\s+box1\s*=/.test(buf));
  check('cube1 binds part', /let\s+part\s*=\s*box1/.test(buf));
  buf = composeHelperInsert(buf, 'cube', null, { width: 50, depth: 40, height: 30, center: true });
  check('cube2 uses box2', /let\s+box2\s*=/.test(buf));
  check('no box1 overwrite', (buf.match(/\blet\s+box1\s*=/g) || []).length === 1);
  check('single return', (buf.match(/\breturn\s+part\s*;/g) || []).length === 1);
}

// ── Illegal top keyword ────────────────────────────────────────
{
  for (const id of ['hole', 'clearanceHole', 'tapDrillHole', 'workplane', 'holePattern', 'cboreHole', 'cskHole']) {
    const buf = composeHelperInsert('', id);
    check(`${id}: no \\btop\\b`, !/\btop\b/.test(buf), buf.slice(0, 120));
    check(`${id}: uses topFace`, /\btopFace\b/.test(buf));
    check(`${id}: facesByNormal`, /facesByNormal/.test(buf));
    check(`${id}: workplaneFromFace`, /workplaneFromFace/.test(buf));
  }
}

// ── Params flow into snippet ───────────────────────────────────
{
  const buf = composeHelperInsert('', 'hole', null, { dia: 8.5, u: 2, v: -3 });
  check('hole dia from params', /hole\([^)]*8\.5/.test(buf));
  check('hole u,v from params', /hole\([^)]*,\s*2,\s*-3,\s*8\.5/.test(buf));
}

{
  const buf = composeHelperInsert('', 'clearanceHole', null, { size: 'M6', fit: 'close', u: 1, v: 2 });
  check('clearance size/fit', /clearanceHole\([^)]*'M6'[^)]*'close'/.test(buf));
}

// ── Feature on chosen body ─────────────────────────────────────
{
  let buf = composeHelperInsert('', 'cube');
  buf = composeHelperInsert(buf, 'cylinder');
  // bodies: part, box1, cyl1
  const bodies = listBodyNames(buf);
  check('lists box1', bodies.includes('box1'));
  check('lists cyl1', bodies.includes('cyl1'));
  buf = composeHelperInsert(buf, 'filletEdges', null, { body: 'box1', radius: 2, sphericalCorners: false });
  check('fillets box1', /box1\s*=\s*filletEdges\(box1/.test(buf));
  check('syncs part from box1', /part\s*=\s*box1/.test(buf));
}

// ── Body selector: exact/numbered only (not prefix); skip const ─
{
  const bodies = listBodyNames(
    'const boxCount = 4; const boreRadius = 3; const box1 = cube([1,1,1]);',
  );
  check('includes part fallback', bodies.includes('part'));
  check('excludes const box1', !bodies.includes('box1'));
  check('excludes boxCount prefix', !bodies.includes('boxCount'));
  check('excludes boreRadius prefix', !bodies.includes('boreRadius'));
}

{
  const bodies = listBodyNames('let box1 = Manifold.cube([10,10,10], true);\nlet part = box1;');
  check('includes let box1', bodies.includes('box1'));
  check('includes part with let box1', bodies.includes('part'));
}

// ── Const body must not be mutated by features ─────────────────
{
  const prefix = 'const box1 = Manifold.cube([10,10,10], true);\nlet part = box1;';
  const buf = composeHelperInsert(prefix, 'filletEdges', null, { body: 'box1', radius: 2, sphericalCorners: true });
  check('const box1 fillet does not assign box1', !/box1\s*=\s*filletEdges/.test(buf));
  check('const box1 fillet mutates part instead', /part\s*=\s*filletEdges\(part/.test(buf));
  const polar = composeHelperInsert(prefix, 'polarArray', null, { body: 'box1', count: 4, boltCircleRadius: 20, axis: 'z' });
  check('const box1 polar does not assign box1', !/box1\s*=\s*polarArray/.test(polar));
  check('const box1 polar mutates part instead', /part\s*=\s*polarArray\(part/.test(polar));
}


// ── coerceNumberParam: blank → default, min/max clamp ──────────
{
  const p = { default: 40, min: 0.1, max: 100 };
  check('blank → default', coerceNumberParam('', p) === 40);
  check('null → default', coerceNumberParam(null, p) === 40);
  check('dash in-progress → default', coerceNumberParam('-', p) === 40);
  check('dot in-progress → default', coerceNumberParam('.', p) === 40);
  check('below min clamps', coerceNumberParam(-5, p) === 0.1);
  check('above max clamps', coerceNumberParam(999, p) === 100);
  check('finite in range passthrough', coerceNumberParam(12.5, p) === 12.5);
}

// ── Empty number params fall back via num() ────────────────────
{
  const buf = composeHelperInsert('', 'cube', null, { width: '', depth: 30, height: 20, center: true });
  check('empty width uses default 40 not 0', /Manifold\.cube\(\[40,\s*30,\s*20\]/.test(buf));
  check('empty width does not emit cube([0', !/Manifold\.cube\(\[0,/.test(buf));
}

// ── All items compose with defaults (no redecl, one return) ────
{
  // Slice 22 Path soft-fails without edges — supply a tiny open chain.
  const pathEdges = [
    { key: '0-1', a: 0, b: 1, va: [0, 0, 0], vb: [10, 0, 0], mid: [5, 0, 0], length: 10 },
    { key: '1-2', a: 1, b: 2, va: [10, 0, 0], vb: [10, 8, 0], mid: [10, 4, 0], length: 8 },
  ];
  let buf = '';
  const seen = new Set();
  for (const item of HELPER_PALETTE_ITEMS) {
    const next = item.id === 'sweepPath'
      ? composeHelperInsert(buf, item.id, null, null, null, pathEdges)
      : composeHelperInsert(buf, item.id);
    check(`compose ${item.id}`, typeof next === 'string' && next.length > 0);
    // no illegal top
    if (/\btop\b/.test(next)) {
      failed++;
      console.log(`  ❌ compose ${item.id}: contains illegal top`);
    }
    buf = next;
  }
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  const decls = [];
  while ((m = re.exec(buf))) {
    if (seen.has(m[1])) {
      failed++;
      console.log(`  ❌ redeclared ${m[1]}`);
    }
    seen.add(m[1]);
    decls.push(m[1]);
  }
  check('all items: no redeclarations', decls.length === seen.size);
  check('all items: one return part', (buf.match(/\breturn\s+part\s*;/g) || []).length === 1);
}

// ── buildHelperSnippet still works ─────────────────────────────
{
  const s = buildHelperSnippet('tube', { bufferEmpty: true, params: { outerRadius: 12, innerRadius: 8, height: 20, segments: 24 } });
  check('build tube snippet', /let\s+tube1\s*=\s*tube\(12,\s*8,\s*20,\s*24\)/.test(s));
}

check('unknown id → null', composeHelperInsert('', 'nope') === null);
check('declaredNames export', declaredNames('let box1 = 1;').has('box1'));

// ── Slice 29: Prim / Adv / Feat / Xform ────────────────────────
{
  check(
    'group order',
    HELPER_PALETTE_GROUPS.join('|') === 'Primitives|Advanced|Features|Transforms',
  );
  const grouped = itemsByGroup();
  check(
    'Prim contents',
    grouped.Primitives.map((i) => i.id).join(',')
      === 'cube,cylinder,sphere,tube,hexPrism,roundedBox',
  );
  check(
    'Advanced order Profile Workplane Extrude Revolve Sweep Loft',
    grouped.Advanced.map((i) => i.id).join(',')
      === 'crossSection,workplane,makeExtrude,makeRevolve,makeSweep,makeLoft',
  );
  const sweep = grouped.Advanced.find((i) => i.id === 'makeSweep');
  check('Sweep is a real Advanced tool', sweep && sweep.placeholder !== true && sweep.label === 'Sweep');
  const sweepBuf = composeHelperInsert('let part = box1;\n', 'makeSweep');
  check('Sweep one-shot keeps part binding', sweepBuf && /let part = box1/.test(sweepBuf));
  check(
    'Sweep one-shot uses profile + path + sweepPoints + placeInFrame',
    sweepBuf
      && /makeCrossSection\s*\(/.test(sweepBuf)
      && /makeSweepPath\s*\(/.test(sweepBuf)
      && /sweepPoints\s*\(/.test(sweepBuf)
      && /placeInFrame\s*\(/.test(sweepBuf),
  );
  check('Sweep one-shot is not the placeholder comment', sweepBuf && !/Sweep placeholder/.test(sweepBuf));
  check('Sweep one-shot has no host add', sweepBuf && !/part\.add\(/.test(sweepBuf));
  const feat = grouped.Features.map((i) => i.id);
  check('Fillet stays in Features', feat.includes('filletEdges'));
  check('holes stay in Features', ['hole', 'holePattern', 'clearanceHole', 'tapDrillHole', 'cboreHole', 'cskHole'].every((id) => feat.includes(id)));
  check('Profile moved to Advanced', grouped.Advanced.some((i) => i.id === 'crossSection') && !feat.includes('crossSection'));
  check('Path stays in Features', feat.includes('sweepPath'));
  const xform = grouped.Transforms.map((i) => i.id);
  check('Workplane moved to Advanced', grouped.Advanced.some((i) => i.id === 'workplane') && !xform.includes('workplane'));
  check('Draft moved to Transforms', xform.includes('addDraft') && !feat.includes('addDraft'));
  check(
    'Xform mirror then array then draft',
    xform.indexOf('mirror') < xform.indexOf('array3D')
      && xform.indexOf('array3D') < xform.indexOf('addDraft'),
  );
  check('Extrude left Transforms', !xform.includes('makeExtrude') && !xform.includes('makeLoft'));
  check('Sweep is a contour entry', isContourEntry('makeSweep') && isSweepEntry('makeSweep'));
  check('Extrude contour entry preserved', isContourEntry('makeExtrude') && isExtrudeEntry('makeExtrude'));
  check('Revolve contour entry preserved', isContourEntry('makeRevolve') && isRevolveEntry('makeRevolve'));
  check('Loft contour entry preserved', isContourEntry('makeLoft') && isLoftEntry('makeLoft'));
  check('Fillet entry preserved', isFilletEntry('filletEdges') && !isFilletEntry('makeSweep'));

  const rail = readFileSync(new URL('../../src/components/HelperInsertPalette.jsx', import.meta.url), 'utf8');
  check('Fillet icon is Squircle', /filletEdges:\s*Squircle/.test(rail));
  check('cbore icon is Cylinder', /cboreHole:\s*Cylinder/.test(rail));
  check('Sweep icon is Spline', /makeSweep:\s*Spline/.test(rail));
  check('compact labels Prim Adv Feat Xform', /Primitives:\s*'Prim'/.test(rail) && /Advanced:\s*'Adv'/.test(rail) && /Features:\s*'Feat'/.test(rail) && /Transforms:\s*'Xform'/.test(rail));
}

if (failed) {
  console.log(`\nFAILED: ${failed}`);
  process.exit(1);
}
console.log('\nAll slice-10 palette v2 checks passed.');
