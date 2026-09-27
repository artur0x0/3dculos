#!/usr/bin/env node
/**
 * Slice C4 — signed feature edges + concave (material-add) fillets.
 *
 * Three things land together because they are one chain of consequence:
 *
 * 1. convexEdges' per-edge CSG ball probe becomes a local winding test.
 *    The probe measured what fraction of a tiny sphere at the edge midpoint sat
 *    inside the solid and kept f < 0.45. That fraction is exactly
 *    (180 - dihedral)/360 — a dihedral threshold wearing a CSG costume, at
 *    ~4.5 ms per edge (5.5 s of a 5.6 s loft fillet). It was also WRONG on fine
 *    meshes: on a 384-segment filleted box the probe sphere shrinks to ~0.012 mm,
 *    where Manifold returns f = 0.5 for plainly 90° edges and even negative
 *    volumes. The local test has no scale dependence.
 *
 * 2. The test returns a SIGN, so concave edges stop being discarded — which is
 *    what makes concave fillets reachable at all.
 *
 * 3. Convexity becomes per-knot. It used to be sampled ONCE per path, so a
 *    chain that changed sign mid-way was cut as whatever its first segment was.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inFaceDirsFromNormals } from '../../src/utils/edgeTangencyField.js';

const __here = dirname(fileURLToPath(import.meta.url));
const readRepo = (rel) => readFileSync(join(__here, '../..', rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('fillet C4 — source pins');
{
  const w = readRepo('src/workers/sandboxWorker.js');
  check('signedFeatureEdges exists and carries a sign',
    /function signedFeatureEdges\s*\(/.test(w) && /convex,\s*dihedralDeg/.test(w));
  check('convexEdges and concaveEdges are thin filters over it',
    /function convexEdges[\s\S]{0,300}signedFeatureEdges\([\s\S]{0,120}\.convex\)/.test(w)
      && /function concaveEdges[\s\S]{0,300}signedFeatureEdges\([\s\S]{0,120}!e\.convex\)/.test(w));
  check('concaveEdges is exposed to user scripts', /^\s{2}concaveEdges,$/m.test(w));

  // THE perf pin: no CSG inside the convexity test. A sphere+intersection per
  // edge is what cost 5.5 s; if it comes back, this goes red.
  const fn = w.slice(w.indexOf('function signedFeatureEdges'), w.indexOf('function convexEdges'));
  check('no CSG ball probe inside signedFeatureEdges',
    !/M\.sphere|\.intersection\(/.test(fn), 'a per-edge sphere probe reintroduces the 5.5 s cost');
  check('ball-probe-equivalent threshold is documented as 18°',
    /FEATURE_EDGE_MIN_DEG = 18/.test(w));
  check('face-group normals that degenerate to zero fall back to the triangle',
    /gOK0/.test(w) && /outN0/.test(w));

  // Per-knot sign: the once-per-path sample is gone from BOTH probes.
  check('convexity is no longer sampled once per path',
    !/checkedConvex/.test(w), 'checkedConvex means the old single sample is back');
  check('knot probe returns a per-segment sign', /segmentConvex/.test(w));
  check('concave runs become fillers, unioned not subtracted',
    /concaveRuns/.test(w) && /M\.union\(\[out, filler\]\)/.test(w));
  check('filler has its own mirrored guards',
    /union added ~0 volume/.test(w) && /filler far larger than requested radius/.test(w));
}

console.log('');
console.log('fillet C4 — in-face direction flip (pure)');
{
  // L-shape interior edge: material in x<0 ∪ y<0, so the faces carry outward
  // normals +X and +Y and the EMPTY corner is the +X/+Y quadrant.
  const T = [0, 0, 1];
  const n0 = [1, 0, 0];
  const n1 = [0, 1, 0];
  const cvx = inFaceDirsFromNormals(T, n0, n1, true);
  const ccv = inFaceDirsFromNormals(T, n0, n1, false);
  check('convex dirs point into the material wedge',
    cvx.f0[1] < -0.99 && cvx.f1[0] < -0.99,
    `f0=${cvx.f0} f1=${cvx.f1}`);
  check('concave dirs flip onto the walls, spanning the empty corner',
    ccv.f0[1] > 0.99 && ccv.f1[0] > 0.99,
    `f0=${ccv.f0} f1=${ccv.f1}`);
  const ang = (a, b) => (Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI;
  check('both measure the same 90° wedge (only its side differs)',
    Math.abs(ang(cvx.f0, cvx.f1) - 90) < 1e-6 && Math.abs(ang(ccv.f0, ccv.f1) - 90) < 1e-6);
}

// ---------------------------------------------------------------- WASM
register('./manifold-resolve-hook.mjs', import.meta.url);
const pending = new Map();
let msgId = 0;
globalThis.self = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const w = pending.get(msg.id);
    if (!w) return;
    pending.delete(msg.id);
    if (msg.type === 'error') w.reject(new Error(msg.payload?.message || 'worker error'));
    else w.resolve(msg);
  },
};
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => globalThis.self.onmessage({ data: { type, payload, id } }));
  });
}
await import('../../src/workers/sandboxWorker.js');
await send('init');
async function exec(script) {
  try { return (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload; }
  catch (e) { return { error: e.message }; }
}

const LSHAPE = `const part0 = Manifold.difference(
  Manifold.cube([40, 40, 20], true),
  Manifold.cube([20, 20, 22], true).translate([10, 10, 0]));`;

console.log('');
console.log('fillet C4 — WASM sign classification');
{
  const r = await exec(`
const box = Manifold.cube([40, 30, 20], true);
${LSHAPE}
const cyl = Manifold.cylinder(20, 10, 10, 64, true);
globalThis.__c = {
  boxCvx: convexEdges(box).length, boxCcv: concaveEdges(box).length,
  lCvx: convexEdges(part0).length, lCcv: concaveEdges(part0).length,
  cylCvx: convexEdges(cyl).length, cylCcv: concaveEdges(cyl).length,
  lZeroN: convexEdges(part0).filter((e) => Math.hypot(e.n0[0], e.n0[1], e.n0[2]) < 0.5
    || Math.hypot(e.n1[0], e.n1[1], e.n1[2]) < 0.5).length,
  ccEdge: concaveEdges(part0).map((e) => ({ va: e.va, vb: e.vb, d: e.dihedralDeg })),
};
return box;`);
  check('classification runs', !r.error, r.error || '');
  const c = globalThis.__c;
  if (c) {
    check('box: 12 convex, 0 concave', c.boxCvx === 12 && c.boxCcv === 0, `${c.boxCvx}/${c.boxCcv}`);
    check('cylinder: 128 convex (2 rims × 64), 0 concave',
      c.cylCvx === 128 && c.cylCcv === 0, `${c.cylCvx}/${c.cylCcv}`);
    check('L-shape: 17 convex, exactly 1 concave', c.lCvx === 17 && c.lCcv === 1,
      `${c.lCvx}/${c.lCcv}`);
    check('the concave edge is the interior vertical one, 90°',
      c.ccEdge.length === 1 && Math.abs(c.ccEdge[0].d - 90) < 1
        && Math.abs(c.ccEdge[0].va[0]) < 1e-6 && Math.abs(c.ccEdge[0].va[1]) < 1e-6,
      JSON.stringify(c.ccEdge));
    // Regression: c4MeshData sums a face group's triangle normals, and on a
    // difference-derived solid a group can cancel to zero. 13 of 17 L-shape
    // edges used to carry a zero normal straight into the fillet framing.
    check('no returned edge carries a degenerate normal', c.lZeroN === 0, `${c.lZeroN} zero-normal edges`);
  }
}

console.log('');
console.log('fillet C4 — concave fillet is material ADD');
{
  const base = await exec(LSHAPE + ' return part0;');
  const r = await exec(LSHAPE + `
const cc = concaveEdges(part0).filter((e) => Math.abs(e.tangent[2]) > 0.99);
return filletAlongPath(part0, makeSweepPath(cc), 3);`);
  check('concave fillet succeeds without variableProfile being asked for',
    !r.error, r.error || '');
  if (!r.error) {
    const added = r.volume - base.volume;
    const exact = 3 * 3 * (1 - Math.PI / 4) * 20;
    check('volume went UP', added > 0, `Δ=${added.toFixed(3)}`);
    check('added ≈ the analytic round (within 5%)',
      Math.abs(added - exact) / exact < 0.05,
      `added=${added.toFixed(3)} exact=${exact.toFixed(3)}`);
    const m = globalThis.__filletVariableProfileMeta;
    check('routed to a filler run, no cutter run',
      !!m && m.concaveRuns === 1 && m.convexRuns === 0, JSON.stringify(m));
  }
}

console.log('');
console.log('fillet C4 — mixed-sign chain');
{
  const r = await exec(LSHAPE + `
const all = signedFeatureEdges(part0);
const near = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]) < 1e-6;
const has = (e, p) => near(e.va, p) || near(e.vb, p);
const vert = all.find((e) => !e.convex && has(e, [0,0,-10]) && has(e, [0,0,10]));
const top  = all.find((e) => e.convex && has(e, [0,0,10]) && has(e, [0,20,10]));
if (!vert || !top) throw new Error('fixture edges missing');
return filletAlongPath(part0, makeSweepPath([vert, top]), 2);`);
  check('a chain that changes sign mid-way succeeds', !r.error, r.error || '');
  if (!r.error) {
    const m = globalThis.__filletVariableProfileMeta;
    // The whole point of the per-knot sign: one run each, not one sign for all.
    check('split into one cutter run and one filler run',
      !!m && m.convexRuns === 1 && m.concaveRuns === 1 && m.runCount === 2,
      JSON.stringify(m));
  }
}

console.log('');
console.log('fillet C4 — convex path unchanged');
{
  const r = await exec(`
const b = Manifold.cube([40,30,20], true);
const es = convexEdges(b).filter((e) => Math.abs(e.va[0]-20)<1e-6 && Math.abs(e.vb[0]-20)<1e-6
  && Math.abs(e.va[1]-15)<1e-6 && Math.abs(e.vb[1]-15)<1e-6);
return filletAlongPath(b, makeSweepPath(es), 3, { variableProfile: true });`);
  check('box edge still succeeds', !r.error, r.error || '');
  if (!r.error) {
    const removed = 24000 - r.volume;
    const exact = 3 * 3 * (1 - Math.PI / 4) * 20;
    check('box edge stays analytically exact (within 2%)',
      Math.abs(removed - exact) / exact < 0.02,
      `removed=${removed.toFixed(3)} exact=${exact.toFixed(3)}`);
    check('volume went DOWN', removed > 0);
  }
}

console.log('');
if (failed) {
  console.log(`❌ fillet C4 golden FAILED (${failed} checks)`);
  process.exit(1);
}
console.log('fillet C4 signed/concave golden passed');
