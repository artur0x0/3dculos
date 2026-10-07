#!/usr/bin/env node
/**
 * SCS true-curve STEP. The sheet spec → exact B-rep → STEP AP214: every bend
 * is two CYLINDRICAL_SURFACE faces (inner r = SKU bend radius, outer r + t)
 * about the bend axis, holes are cylinders, countersinks cones. One closed
 * shell, volume = the spec volume. Built from the spec, not the mesh.
 * (OCCT itself is checked outside the repo; see the PR.)
 */
import { readFileSync } from 'node:fs';
import { joinScsCatalog, findScsSku } from '../../src/utils/scs/scsCatalog.js';
import { createSheetSpec, solveSheet } from '../../src/utils/sheetMetal/sheetModel.js';
import { buildSheetBrep, brepVolume, countersinkOf } from '../../src/utils/sheetMetal/sheetBrep.js';
import { brepToStep } from '../../src/utils/sheetMetal/stepExport.js';
import { sheetFlatPattern } from '../../src/utils/sheetMetal/sheetFlat.js';
import { buildSheetExport, meshVolume, sheetExpectedVolume, sheetScriptHasExtras } from '../../src/utils/sheetMetal/sheetExport.js';
import { sheetMetalBlock } from '../../src/utils/sheetMetal/sheetMetalScript.js';
import { loadSandbox } from './scs_sandbox.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(read(`scripts/golden/fixtures/scs/${name}.json`));
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const { records } = joinScsCatalog(fixture('catalog'), fixture('specs'));
const alu = findScsSku(records, 'ALU-090');
const base = () => createSheetSpec(alu, 'XY');
const { exec } = await loadSandbox();

/** STEP entity table: id → { type, args }. */
function parseStep(text) {
  const ents = new Map();
  for (const m of text.matchAll(/^#(\d+)=([A-Z_0-9]+)\((.*)\);$/gm)) ents.set(Number(m[1]), { type: m[2], args: m[3] });
  return ents;
}
const refs = (s) => [...s.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
const reals = (s) => [...s.matchAll(/-?\d+\.\d*(?:E[-+]?\d+)?/g)].map((m) => Number(m[0]));

/** Faces in the STEP: [{ surface type, radius, axis point, axis dir }]. */
function stepFaces(text) {
  const E = parseStep(text);
  const point = (id) => reals(E.get(id).args);
  const dir = (id) => reals(E.get(id).args);
  const out = [];
  for (const [, e] of E) {
    if (e.type !== 'ADVANCED_FACE') continue;
    const r = refs(e.args);
    const surf = E.get(r[r.length - 1]);
    const f = { type: surf.type };
    if (surf.type === 'CYLINDRICAL_SURFACE' || surf.type === 'CONICAL_SURFACE') {
      const [ax] = refs(surf.args);
      const [pId, dId] = refs(E.get(ax).args);
      const nums = reals(surf.args.slice(surf.args.indexOf(',', surf.args.indexOf('#')) + 1));
      f.radius = nums[0];
      f.semiAngle = nums[1];
      f.origin = point(pId);
      f.axis = dir(dId);
    }
    out.push(f);
  }
  return { E, faces: out };
}

function closedShell(text) {
  const uses = new Map();
  for (const m of text.matchAll(/ORIENTED_EDGE\('',\*,\*,#(\d+),\.(T|F)\.\)/g)) {
    const u = uses.get(m[1]) || { T: 0, F: 0 };
    u[m[2]] += 1;
    uses.set(m[1], u);
  }
  const edges = (text.match(/=EDGE_CURVE\(/g) || []).length;
  return uses.size === edges && [...uses.values()].every((u) => u.T === 1 && u.F === 1);
}

async function solid(spec) {
  const res = await exec(`${sheetMetalBlock(spec)}\nreturn part;`);
  return meshVolume(res.mesh || res.meshData || res);
}

function bendCylinders(spec, faces) {
  const folded = solveSheet(spec);
  const cyl = faces.filter((f) => f.type === 'CYLINDRICAL_SURFACE');
  return folded.bends.filter((b) => b.theta > 0).map((b) => {
    const onAxis = cyl.filter((f) => {
      const d = [f.origin[0] - b.axis[0], f.origin[1] - b.axis[1], f.origin[2] - b.axis[2]];
      const along = d[0] * b.e[0] + d[1] * b.e[1] + d[2] * b.e[2];
      const off = Math.hypot(d[0] - along * b.e[0], d[1] - along * b.e[1], d[2] - along * b.e[2]);
      const par = Math.abs(f.axis[0] * b.e[0] + f.axis[1] * b.e[1] + f.axis[2] * b.e[2]);
      return off < 1e-5 && par > 1 - 1e-9;
    });
    return { id: b.id, radii: onAxis.map((f) => f.radius).sort((x, y) => x - y) };
  });
}

console.log('SCS true-curve STEP — 4-bend tray');
{
  const tray = {
    ...base(),
    bends: ['u+', 'u-', 'v+', 'v-'].map((edge, i) => ({ id: `b${i + 1}`, panel: 'base', edge, angle: 90, length: 20 })),
    holes: [{ id: 'h1', panel: 'base', u: 0, v: 0, d: 6, type: 'hole' }, { id: 'h2', panel: 'b1', u: 12, v: 0, d: 4, type: 'hole' }],
  };
  const { t, r } = tray;
  const brep = buildSheetBrep(tray);
  const step = brepToStep(brep, { name: 'tray', timestamp: '2026-10-07T00:00:00' });
  const { faces } = stepFaces(step.text);
  const cyl = faces.filter((f) => f.type === 'CYLINDRICAL_SURFACE');
  check('one MANIFOLD_SOLID_BREP / CLOSED_SHELL', (step.text.match(/MANIFOLD_SOLID_BREP\(/g) || []).length === 1 && (step.text.match(/CLOSED_SHELL\(/g) || []).length === 1);
  check('every edge used once each way (closed, oriented)', closedShell(step.text));
  check('faces: 38 planes + 12 cylinders (8 bend + 4 hole halves), nothing else',
    faces.length === 50 && faces.filter((f) => f.type === 'PLANE').length === 38 && cyl.length === 12, JSON.stringify(brep.stats));
  const bends = bendCylinders(tray, faces);
  check('each of the 4 bends: inner cylinder r = SKU bend radius, outer r + t, on the bend axis',
    bends.length === 4 && bends.every((b) => b.radii.length === 2 && near(b.radii[0], r) && near(b.radii[1], r + t)), JSON.stringify(bends));
  check('hole walls are cylinders of the hole radius', cyl.filter((f) => near(f.radius, 3)).length === 2 && cyl.filter((f) => near(f.radius, 2)).length === 2);
  const lines = (step.text.match(/=LINE\(/g) || []).length;
  const circles = (step.text.match(/=CIRCLE\(/g) || []).length;
  check('bend side edges and hole rims are CIRCLEs (4 bends × 2 sides × 2 + 2 holes × 2 rims × 2)', circles === 16 + 8, `${circles} circles, ${lines} lines`);
  const flat = sheetFlatPattern(tray);
  const want = sheetExpectedVolume(tray, flat);
  const got = brepVolume(brep);
  check('B-rep volume = spec volume (<1e-5)', Math.abs(got - want) / want < 1e-5, `${got} vs ${want}`);
  const mesh = await solid(tray);
  check('B-rep volume ≈ sandbox solid (faceted, <0.5%)', Math.abs(got - mesh) / mesh < 0.005, `${got} vs ${mesh}`);
  const V = brep.vertices.length;
  const E = brep.edges.length;
  const F = brep.faces.length;
  const L = brep.faces.reduce((s, f) => s + f.loops.length, 0);
  check('Euler–Poincaré V − E + F − (L − F) = 2 − 2·genus (2 holes)', V - E + F - (L - F) === 2 - 2 * 2, `${V}-${E}+${F}-${L - F}`);
}

console.log('SCS true-curve STEP — tab + countersink + chained flip bend');
{
  const part = {
    ...base(),
    bends: [{ id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 25 }, { id: 'b2', panel: 'b1', edge: 'u+', angle: 45, length: 15, flip: true }],
    tabs: [{ id: 't1', panel: 'base', edge: 'u-', width: 20, depth: 10, centered: true }, { id: 't2', panel: 'b1', edge: 'v+', width: 10, depth: 6, centered: true }],
    holes: [{ id: 'h1', panel: 'base', u: -10, v: 5, d: 5, type: 'countersink', cskDia: 8, cskAngle: 82 }, { id: 'h2', panel: 'base', u: 20, v: -10, d: 4, type: 'hole' }],
  };
  const { t, r } = part;
  const brep = buildSheetBrep(part);
  const step = brepToStep(brep, { name: 'tab-csk', timestamp: '2026-10-07T00:00:00' });
  const { faces } = stepFaces(step.text);
  check('one closed shell', closedShell(step.text) && (step.text.match(/CLOSED_SHELL\(/g) || []).length === 1);
  const bends = bendCylinders(part, faces);
  check('both bends (up 90°, flip 45°) are r / r + t cylinders on their axes',
    bends.length === 2 && bends.every((b) => b.radii.length === 2 && near(b.radii[0], r) && near(b.radii[1], r + t)), JSON.stringify(bends));
  const csk = countersinkOf(part.holes[0], t);
  const cones = faces.filter((f) => f.type === 'CONICAL_SURFACE');
  check('countersink: two half cones, 41° semi-angle, from the hole Ø', cones.length === 2 && cones.every((f) => near(f.semiAngle, (41 * Math.PI) / 180, 1e-6) && near(f.radius, 2.5)), JSON.stringify(cones));
  check('countersink stops short of the back face (cylinder below it)', csk.depth < t && faces.filter((f) => f.type === 'CYLINDRICAL_SURFACE' && near(f.radius, 2.5)).length === 2);
  check('tabs stay in their panels\' planes (no extra curved faces)', brep.stats.cylinders === 4 + 2 + 2 && brep.stats.cones === 2, JSON.stringify(brep.stats));
  const want = sheetExpectedVolume(part, sheetFlatPattern(part));
  const got = brepVolume(brep);
  check('spec volume counts the countersink cone; B-rep matches (<1e-5)', Math.abs(got - want) / want < 1e-5, `${got} vs ${want}`);
  const mesh = await solid(part);
  check('B-rep volume ≈ sandbox solid (<0.5%)', Math.abs(got - mesh) / mesh < 0.005, `${got} vs ${mesh}`);
}

console.log('SCS true-curve STEP — every plane, flips, 180°, chained bends');
{
  let ok = 0;
  let worst = 0;
  const angles = [0, 30, 90, 135, 180];
  const cases = [];
  for (const plane of ['XY', 'XZ', 'YZ']) {
    for (const angle of angles) {
      for (const flip of [false, true]) {
        cases.push({
          ...createSheetSpec(alu, plane, { width: 80, height: 50 }),
          bends: [
            { id: 'b1', panel: 'base', edge: 'v+', angle, length: 18, flip },
            { id: 'b2', panel: 'base', edge: 'u-', angle: 90, length: 15, flip: !flip },
            { id: 'b3', panel: 'b1', edge: 'u+', angle: 60, length: 12, flip },
          ],
          tabs: [{ id: 't1', panel: 'b2', edge: 'v-', width: 6, depth: 5, centered: false, offset: 0 }],
          holes: [{ id: 'h1', panel: 'base', u: 5, v: -5, d: 6, type: 'countersink', cskDia: 14, cskAngle: 90 }],
        });
      }
    }
  }
  for (const spec of cases) {
    try {
      const b = buildSheetBrep(spec);
      const want = sheetExpectedVolume(spec, sheetFlatPattern(spec));
      const rel = Math.abs(brepVolume(b, 128) - want) / want;
      worst = Math.max(worst, rel);
      if (rel < 1e-4 && closedShell(brepToStep(b, { name: 'x', timestamp: 'x' }).text)) ok += 1;
    } catch (err) {
      console.log(`     ${spec.plane} ${spec.bends[0].angle}° flip=${spec.bends[0].flip}: ${err.message}`);
    }
  }
  check(`${cases.length} variants build closed shells at the spec volume`, ok === cases.length, `${ok}/${cases.length}, worst ${worst.toExponential(2)}`);
}

console.log('SCS true-curve STEP — export bundle + mesh-stale');
{
  const tray = { ...base(), bends: [{ id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20 }] };
  const bundle = buildSheetExport(tray, { partName: 'Tray' });
  check('no run needed: STEP from the spec', bundle.stepSource === 'spec' && /CYLINDRICAL_SURFACE/.test(bundle.files.step.text) && bundle.files.step.stats.bendFaces === 2);
  check('no mesh-stale on the spec path', !bundle.dfm.issues.some((i) => i.rule === 'mesh-stale'));
  const block = sheetMetalBlock(tray);
  check('plain sheet script → no script-extras', !sheetScriptHasExtras(`${block}\n// note\nreturn part;\n`));
  check('code outside the block → script-extras warn', sheetScriptHasExtras(`${block}\npart = part.subtract(cube([5, 5, 5]));\nreturn part;`)
    && buildSheetExport(tray, { script: `${block}\npart = part.translate([1, 0, 0]);` }).dfm.issues.some((i) => i.rule === 'script-extras' && i.level === 'warn'));
  check('a script without a sheet block is not flagged', !sheetScriptHasExtras('let part = cube([1, 1, 1]);'));
}

console.log('SCS true-curve STEP — UI + docs');
{
  const flow = read('src/components/sheetMetal/SheetMetalFlow.jsx');
  const view = read('src/components/Viewport.jsx');
  const arch = read('docs/architecture.md');
  check('export popup names the STEP source', /data-sm-step-source=\{stepSource/.test(flow));
  check('Viewport hands the part script to the export popup', /script=\{sheetMetalMode\.exportOpen && typeof getHelperBuffer === 'function' \? getHelperBuffer\(\) : null\}/.test(view));
  check('architecture.md documents the true-curve STEP pipeline', /sheetBrep\.js/.test(arch) && /CYLINDRICAL_SURFACE/.test(arch) && /script-extras/.test(arch));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll SCS true-curve STEP checks passed');
process.exit(0);
