#!/usr/bin/env node
/**
 * Slice C3.3 — varying cross-section for the hard variableProfile fillet.
 *
 * WHY THIS GOLDEN EXISTS
 * C3.1 approximated a ramping dihedral with piecewise-constant θ runs → visible
 * staircase. C3.2 replaced that with ONE median-θ run → no staircase, but it
 * gouged: on the playtest loft ridge θ ramps 161.5° → 92.8°, so a single 109.7°
 * profile set the wall back 1.39 mm where the geometry wanted 0.32 mm (4.3×),
 * removing 11× the correct volume in the shallowest quarter of the path.
 *
 * Every volume guard passed through both, because the median-θ TOTAL lands
 * within 1.2× of the true integral. The error was DISTRIBUTIONAL. So the
 * load-bearing check here is per-quarter removal along the path, not total
 * volume — a total-only net cannot tell C3.2 from C3.3 and never could.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  varyingProfileTubeMesh,
  dihedralFilletContour,
  expandDihedralCutterContour,
} from '../../src/utils/filletAlongPath.js';

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

console.log('fillet C3.3 varying profile — pure helper + source pins');

// ---------------------------------------------------------------- pure helper
{
  const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const ring = (z) => sq.map(([u, v]) => [u, v, z]);
  const { vertProperties: V, triVerts: T } = varyingProfileTubeMesh([ring(0), ring(1)], false);
  check('unit tube has 8 verts / 12 tris', V.length / 3 === 8 && T.length / 3 === 12);

  const signedVol = (Vp, Tp) => {
    let vol = 0;
    for (let t = 0; t < Tp.length; t += 3) {
      const a = Tp[t] * 3, b = Tp[t + 1] * 3, c = Tp[t + 2] * 3;
      vol += (Vp[a] * (Vp[b + 1] * Vp[c + 2] - Vp[b + 2] * Vp[c + 1])
        - Vp[a + 1] * (Vp[b] * Vp[c + 2] - Vp[b + 2] * Vp[c])
        + Vp[a + 2] * (Vp[b] * Vp[c + 1] - Vp[b + 1] * Vp[c])) / 6;
    }
    return vol;
  };
  check('winding is outward (signed volume +1)', Math.abs(signedVol(V, T) - 1) < 1e-9,
    `got ${signedVol(V, T)}`);

  // Manifold topology: every DIRECTED edge exactly once ⇔ closed + consistent.
  const directed = new Map();
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]];
    for (let k = 0; k < 3; k++) {
      const key = `${v[k]}_${v[(k + 1) % 3]}`;
      directed.set(key, (directed.get(key) || 0) + 1);
    }
  }
  check('every directed edge appears exactly once',
    [...directed.values()].every((c) => c === 1));

  check('mismatched ring vertex counts loud-fail', (() => {
    try { varyingProfileTubeMesh([ring(0), [[0, 0, 1], [1, 0, 1], [1, 1, 1]]], false); return false; }
    catch { return true; }
  })());
  check('< 2 rings loud-fail', (() => {
    try { varyingProfileTubeMesh([ring(0)], false); return false; } catch { return true; }
  })());

  // A real ramping-θ tube: sections differ per ring yet still stitch + close.
  const r = 1.98, L = 19.78843, n = 48;
  const thAt = (i) => ((161.5 + (92.8 - 161.5) * (i / (n - 1))) * Math.PI) / 180;
  const sec = (t) => {
    const c = expandDihedralCutterContour(dihedralFilletContour(r, t, 24), r, t);
    let a2 = 0;
    for (let i = 0; i < c.length; i++) {
      const p = c[i], q = c[(i + 1) % c.length];
      a2 += p[0] * q[1] - q[0] * p[1];
    }
    return a2 < 0 ? c.slice().reverse() : c;
  };
  const rings = [];
  for (let i = 0; i < n; i++) rings.push(sec(thAt(i)).map(([u, v]) => [u, v, (L * i) / (n - 1)]));
  check('every θ tessellates to the same vertex count (rings stitchable)',
    new Set(rings.map((x) => x.length)).size === 1);
  const ramp = varyingProfileTubeMesh(rings, false);
  check('ramping-θ tube is outward + closed', signedVol(ramp.vertProperties, ramp.triVerts) > 0);
  const d2 = new Map();
  for (let t = 0; t < ramp.triVerts.length; t += 3) {
    const v = [ramp.triVerts[t], ramp.triVerts[t + 1], ramp.triVerts[t + 2]];
    for (let k = 0; k < 3; k++) {
      const key = `${v[k]}_${v[(k + 1) % 3]}`;
      d2.set(key, (d2.get(key) || 0) + 1);
    }
  }
  check('ramping-θ tube stays manifold', [...d2.values()].every((c) => c === 1));

  // Closed rings carry no caps.
  const closed = varyingProfileTubeMesh([ring(0), ring(1), ring(2)], true);
  check('closed tube emits no cap triangles', closed.triVerts.length / 3 === 3 * 4 * 2);
}

// ---------------------------------------------------------------- source pins
{
  const workerSrc = readRepo('src/workers/sandboxWorker.js');
  check('worker builds a varying-profile cutter',
    /function _s23VaryingProfileCutter\s*\(/.test(workerSrc));
  check('variableProfile routes to _s23VaryingProfileCutter',
    /_s23BuildVariableProfileCutter[\s\S]{0,2000}_s23VaryingProfileCutter\s*\(/.test(workerSrc));
  check('hard path no longer collapses θ to a single median run',
    !/_s23BuildVariableProfileCutter[\s\S]{0,2000}singleRun:\s*true/.test(workerSrc));
  check('per-knot θ is clamped, not thrown (one noisy knot must not kill a blend)',
    /_S23_THETA_MIN/.test(workerSrc) && /clampedKnots/.test(workerSrc));
  check('cutter that needed mesh repair is a loud fail',
    /needed mesh repair/.test(workerSrc));

  const utilSrc = readRepo('src/utils/filletAlongPath.js');
  check('varyingProfileTubeMesh is exported from the shared pure module',
    /export function varyingProfileTubeMesh\s*\(/.test(utilSrc));
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

const LOFT = `
const fr = { center: [0.006788, -0.000177, 125], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs2 = makeCrossSection(fr, profileCircle(5, 32));
const xs3 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
`;
const SEL = `const selEdges = [{ a: 11718, b: 14670, va: [4.631338,-2.774907,126.230766], vb: [10.006788,-6.000177,145], length: 19.78843, key: "coh-6-0", n0: [0.690095,-0.653957,-0.310015], n1: [0.867393,-0.385508,-0.314663] }];`;

console.log('');
console.log('fillet C3.3 — WASM distribution net (the check C3.2 could not fail)');

{
  // Removed volume in four z-slabs along the ridge. The ridge dihedral ramps
  // 161.5° (smooth circle end) → 92.8° (rect corner), so a CORRECT blend
  // removes steadily MORE material per quarter: 0.29 / 1.26 / 2.35 / 3.29.
  //
  // A single median-θ cutter INVERTS that ramp — measured C3.2 quarters were
  // 3.32 / 2.39 / 1.52 / 1.32: 11× too much where the wall is nearly flat
  // (the visible gouge) and under-cut at the corner that actually needed a
  // blend. Totals differ by only 1.19×, which is why every volume guard let
  // it through. This net keys on the SHAPE of the ramp, not its integral.
  const r = await exec(`${LOFT}
const before = placeInFrame(fr, makeLoft([xs2, xs3]));
${SEL}
const after = filletAlongPath(before, makeSweepPath(selEdges), 1.98, { variableProfile: true });
const cutPiece = Manifold.difference(before, after);
const z0 = 126.230766, z1 = 145, h = (z1 - z0) / 4;
const q = [];
for (let k = 0; k < 4; k++) {
  q.push(Manifold.intersection(cutPiece, Manifold.cube([200,200,h], true).translate([0,0,z0 + h*(k+0.5)])).volume());
}
globalThis.__q = q;
globalThis.__removed = before.volume() - after.volume();
return after;`);
  check('loft ridge fillet succeeds', !r.error, r.error || '');

  if (!r.error) {
    const q = globalThis.__q;
    const removed = globalThis.__removed;
    const meta = globalThis.__filletVariableProfileMeta;
    console.log(`     quarters: ${q.map((v) => v.toFixed(3)).join('  ')}   total ${removed.toFixed(3)}`);

    // Analytic per-knot integral for this ridge ≈ 7.202; per quarter ≈
    // 0.291 / 1.262 / 2.354 / 3.294. Tolerances leave room for the rear pad.
    check('total tracks the per-knot integral (not a median-θ total)',
      removed > 6.6 && removed < 8.0, `removed=${removed.toFixed(3)}`);

    // THE net. C3.2 produced ~1.758 in the shallow quarter (6× too much).
    check('shallow quarter is NOT gouged (C3.2 measured ≈3.32 here)',
      q[0] < 0.8, `q1=${q[0].toFixed(3)} — a single median-θ cutter puts ≈3.32 here`);
    check('corner quarter is fully cut (a median-θ cutter under-cuts it)',
      q[3] > 2.5, `q4=${q[3].toFixed(3)}`);
    check('removal increases monotonically as the dihedral sharpens',
      q[0] < q[1] && q[1] < q[2] && q[2] < q[3],
      `q=${q.map((v) => v.toFixed(3)).join(',')}`);
    check('each quarter is within 25% of its analytic share',
      [0.291, 1.262, 2.354, 3.294].every((exp, i) => Math.abs(q[i] - exp) <= 0.25 * exp + 0.05),
      `q=${q.map((v) => v.toFixed(3)).join(',')}`);

    check('meta reports a varying profile with one ring per knot',
      !!meta && meta.varyingProfile === true && meta.ringCount === meta.frameCount + 1,
      JSON.stringify(meta));
    check('no knot needed θ clamping on a normal loft ridge',
      !!meta && meta.clampedKnots === 0);
    check('meta records the real θ span (not a collapsed median)',
      !!meta && meta.thetaMaxDeg > 155 && meta.thetaMinDeg < 100,
      `${meta?.thetaMinDeg}…${meta?.thetaMaxDeg}`);
  }
}

{
  // Constant-θ control: a box edge must stay analytically exact. The varying
  // machinery must not cost accuracy where there is nothing to vary.
  const r = await exec(`
const b = Manifold.cube([40,30,20], true);
const es = convexEdges(b).filter(e => Math.abs(e.va[0]-20)<1e-6 && Math.abs(e.vb[0]-20)<1e-6 && Math.abs(e.va[1]-15)<1e-6 && Math.abs(e.vb[1]-15)<1e-6);
return filletAlongPath(b, makeSweepPath(es), 3, { variableProfile: true });`);
  check('constant-θ box edge still succeeds', !r.error, r.error || '');
  if (!r.error) {
    const removed = 24000 - r.volume;
    const exact = 3 * 3 * (1 - Math.PI / 4) * 20;
    check('box edge stays analytically exact (within 2%)',
      Math.abs(removed - exact) / exact < 0.02,
      `removed=${removed.toFixed(3)} exact=${exact.toFixed(3)}`);
  }
}

{
  // Closed loop: rings must wrap with no caps and still produce a valid solid.
  const r = await exec(`
const cyl = Manifold.cylinder(20, 10, 10, 64, true);
const es = convexEdges(cyl).filter(e => Math.min(e.va[2], e.vb[2]) > 9.9);
return filletAlongPath(cyl, makeSweepPath(es), 1.5, { variableProfile: true });`);
  check('closed rim loop builds a valid solid', !r.error, r.error || '');
  if (!r.error) {
    check('closed rim removes a sane amount', 6283.185 - r.volume > 20 && 6283.185 - r.volume < 55,
      `removed=${(6283.185 - r.volume).toFixed(3)}`);
  }
}

console.log('');
if (failed) {
  console.log(`❌ fillet C3.3 golden FAILED (${failed} checks)`);
  process.exit(1);
}
console.log('fillet C3.3 varying-profile golden passed');
