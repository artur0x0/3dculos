#!/usr/bin/env node
/**
 * Fillet + chamfer along a chain that rotates more than once — Artur's
 * FilletKiller.
 *
 *   20 mm cube; r=2 on edgesBetween(3, 6) and (2, 5), r=2 variable-profile on
 *   edgesBetween(0, 2); then ONE ~24-edge chain (B's fixture): up the (10, 10)
 *   vertical edge, over the +y end arc of the top fillet, round the top
 *   perimeter through both −x corner arcs, over the −y end arc and down the
 *   (10, −10) vertical edge. The path turns 360° in total in 90° steps about
 *   three different axes, and four of those turns are R = 2 prior-fillet arcs.
 *
 *   chamfer: filletAlongPath(part, makeSweepPath(selEdges4), 2, { profile: 'chamfer' })
 *   fillet:  filletAlongPath(part, path, 3.73, { variableProfile: true })   (B's case)
 *
 * Three root causes, all where the sweep frame meets the rotating chain:
 *
 *  1. Chamfer lip + step on the y = −10 top leg. The leg's start knot is the
 *     last point of the resampled −x/−y corner arc (y = −9.9957), so its
 *     segment runs 0.015° off the mesh edge. The edge's front-face triangle is
 *     a sliver (third vertex 0.004 mm off a 16 mm edge), and the in-face ray
 *     was read ⊥ the SEGMENT: the tilt was as large as the offset, the ray came
 *     out 45° off the front face, and the whole leg was chamfered with a 45°
 *     section turned about the edge (front face uncut = lip, top cut too deep =
 *     step). A solo pick of the same edge (exact tangent) was fine.
 *     Fix: read the ray against the matched mesh edge, and take it from the
 *     face normal when the third vertex is that close to the edge.
 *
 *  2. Fillet section 94° on the (10, 10) leg and the +y arc. The +y wall's
 *     face group also held a 1.3 mm² facet of the +x top fillet (faceID reuse
 *     across cutters, sharing an edge with the wall), and the group normal was
 *     an unweighted sum: (0.070, 0.997, 0.012), 4° off. Fix: a planar group
 *     (≥ 90% of its area within 2°) averages only its in-plane triangles.
 *
 *  3. Fillet fins / bow-tie notches on the top face at each R = 2 corner. The
 *     r = 3.73 section was swept round R = 2 arcs in one tube; the arc center
 *     lies inside the section, so rings on the inside of the bend cross each
 *     other (6.8 mm² of inverted, downward-facing top facets). Fix: on an
 *     all-convex fillet path, arcs tighter than the cutter split into semi-arc
 *     runs like the chamfer already does.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./manifold-resolve-hook.mjs', import.meta.url);

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const w = pending.get(msg.id);
    if (!w) return;
    pending.delete(msg.id);
    if (msg.type === 'error') w.reject(new Error(msg.payload?.message || 'err'));
    else w.resolve(msg);
  },
};
globalThis.self = workerSelf;
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => workerSelf.onmessage({ data: { type, payload, id } }));
  });
}

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const fmt = (a) => a.map((v) => v.toFixed(3)).join(',');

await import('../../src/workers/sandboxWorker.js');
await send('init');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\n*return\s+part\s*;?\s*$/i, '');
const chamferSrc = fixture('artur_playtest_chamfer_multi_rotation.txt');
const filletSrc = fixture('artur_playtest_fillet_three_corner_wrap.txt');

// Shared probes, appended to each fixture body.
const PROBES = `
const ball = (c, r = 0.1) => {
  const s = Manifold.sphere(r, 12).translate(c);
  return Manifold.intersection(part, s).volume() / s.volume();
};
// Path turning: sum of |turn| between consecutive chain segments (deg).
const pp = makeSweepPath(selEdges4).points;
let turn = 0;
for (let i = 1; i + 1 < pp.length; i++) {
  const a = [pp[i][0] - pp[i-1][0], pp[i][1] - pp[i-1][1], pp[i][2] - pp[i-1][2]];
  const b = [pp[i+1][0] - pp[i][0], pp[i+1][1] - pp[i][1], pp[i+1][2] - pp[i][2]];
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  if (la < 1e-9 || lb < 1e-9) continue;
  turn += Math.acos(Math.max(-1, Math.min(1, (a[0]*b[0] + a[1]*b[1] + a[2]*b[2]) / (la * lb)))) * 180 / Math.PI;
}
const mesh = part.getMesh();
const np = mesh.numProp || 3;
let maxAbs = 0;
for (let i = 0; i < mesh.vertProperties.length / np; i++) {
  for (let k = 0; k < 3; k++) maxAbs = Math.max(maxAbs, Math.abs(mesh.vertProperties[i * np + k]));
}
// Inverted surface near the top: blended top faces up or out, never down.
let downTop = 0;
const V = (i) => [mesh.vertProperties[i*np], mesh.vertProperties[i*np+1], mesh.vertProperties[i*np+2]];
for (let t = 0; t < mesh.numTri; t++) {
  const a = V(mesh.triVerts[t*3]), b = V(mesh.triVerts[t*3+1]), c = V(mesh.triVerts[t*3+2]);
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], w = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
  const L = Math.hypot(...n);
  if (L < 1e-12) continue;
  if ((a[2] + b[2] + c[2]) / 3 > 9.5 && n[2] / L < -0.2) downTop += L / 2;
}
globalThis.__note = {
  turn, maxAbs, downTop,
  volume: part.volume(), genus: part.genus(), bodies: part.decompose().length,
  meta: globalThis.__filletVariableProfileMeta || null,
  probes: typeof __probes === 'function' ? __probes() : null,
};
return part;
`;

async function runCase(label, src, probes) {
  globalThis.__note = null;
  const script = `globalThis.__filletVariableProfileMeta = null;\n${strip(src)}\n${probes}\n${PROBES}`;
  const r = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 }).catch((e) => ({ payload: { error: e.message } }));
  const p = r.payload || {};
  check(`${label}: script runs`, !p.error && p.status !== 'error', p.error || p.message || '');
  return globalThis.__note;
}

// ── chamfer r=2 along the chain ────────────────────────────────
console.log('fillet/chamfer multi-rotation — chamfer r=2 on B\'s chain');
check('chamfer fixture chamfers selEdges4 at 2',
  /filletAlongPath\(part, makeSweepPath\(selEdges4\), 2, \{ profile: 'chamfer' \}\)/.test(chamferSrc));
check('chamfer fixture is B\'s chain (24 edges, same keys)',
  (chamferSrc.match(/key: "coh-[0-9-]+"/g) || []).join() === (filletSrc.match(/key: "coh-[0-9-]+"/g) || []).join()
  && (chamferSrc.match(/key: "coh-[0-9-]+"/g) || []).length === 24);
{
  // Chamfer planes (legs 2): y=−10 top leg z − y = 18; −x top leg z − x = 18;
  // (10, −10) vertical leg x − y = 18. Cut = 0.15 mm past the plane on each
  // face; keep = 0.35 mm inside the chamfer face.
  const n = await runCase('chamfer', chamferSrc, `
function __probes() {
  const xs = [-4, 0, 4];
  return {
    frontLegFront: xs.map((x) => ball([x, -9.85, 8.6])),
    frontLegTop: xs.map((x) => ball([x, -8.6, 9.85])),
    frontLegKeep: xs.map((x) => ball([x, -8.5, 9.0])),
    xLegFront: xs.map((y) => ball([-9.85, y, 8.6])),
    xLegTop: xs.map((y) => ball([-8.6, y, 9.85])),
    xLegKeep: xs.map((y) => ball([-8.5, y, 9.0])),
    vLegA: [-6, 0, 4].map((z) => ball([9.85, -8.6, z])),
    vLegB: [-6, 0, 4].map((z) => ball([8.6, -9.85, z])),
    vLegKeep: [-6, 0, 4].map((z) => ball([9.0, -8.5, z])),
    core: [ball([0, 0, 0], 1), ball([6, 6, 6], 0.5), ball([-6, -6, 6], 0.5)],
  };
}`);
  if (n) {
    const q = n.probes;
    check(`chain turns a full 360° in total, several 90° turns about different axes (Σ|turn|=${n.turn.toFixed(0)}°)`, n.turn > 350);
    check('one body, genus 0', n.bodies === 1 && n.genus === 0, `bodies=${n.bodies} genus=${n.genus}`);
    check('nothing outside the 20 mm cube', n.maxAbs <= 10 + 1e-3, `maxAbs=${n.maxAbs}`);
    check('volume in the measured window (7755..7768; was 7762.8 with the 45° leg)',
      n.volume > 7755 && n.volume < 7768, `volume=${n.volume.toFixed(3)}`);
    check('y=−10 top leg: the front face is chamfered (no lip)',
      q.frontLegFront.every((v) => v < 1e-6), fmt(q.frontLegFront));
    check('y=−10 top leg: the top face is chamfered',
      q.frontLegTop.every((v) => v < 1e-6), fmt(q.frontLegTop));
    check('y=−10 top leg: solid just inside the 45° face (no step)',
      q.frontLegKeep.every((v) => v > 1 - 1e-6), fmt(q.frontLegKeep));
    check('−x top leg chamfered the same way (control)',
      q.xLegFront.every((v) => v < 1e-6) && q.xLegTop.every((v) => v < 1e-6)
        && q.xLegKeep.every((v) => v > 1 - 1e-6),
      `${fmt(q.xLegFront)} | ${fmt(q.xLegTop)} | ${fmt(q.xLegKeep)}`);
    check('(10, −10) vertical leg chamfered down to the bottom',
      q.vLegA.every((v) => v < 1e-6) && q.vLegB.every((v) => v < 1e-6)
        && q.vLegKeep.every((v) => v > 1 - 1e-6),
      `${fmt(q.vLegA)} | ${fmt(q.vLegB)} | ${fmt(q.vLegKeep)}`);
    check('interior stays solid', q.core.every((v) => Math.abs(v - 1) < 1e-3), fmt(q.core));
  }
}

// ── fillet r=3.73 variable-profile along the same chain ────────
console.log('\nfillet/chamfer multi-rotation — fillet r=3.73 variable-profile (B\'s case)');
{
  const n = await runCase('fillet', filletSrc, `
function __probes() {
  return {
    rounded: [
      ball([9.55, 9.55, 0], 0.2), ball([9.55, -9.55, 0], 0.2),
      ball([0, 9.55, 9.55], 0.2), ball([0, -9.55, 9.55], 0.2),
      ball([-9.55, 4, 9.55], 0.2), ball([-9.55, -4, 9.55], 0.2),
    ],
    walls: [
      ball([9.7, 0, 0], 0.2), ball([0, 9.7, 3], 0.2), ball([0, -9.7, 3], 0.2), ball([0, 0, 9.7], 0.2),
    ],
    core: [ball([0, 0, 0], 1), ball([6, 6, 6], 0.5), ball([5.8, -6.5, 7], 0.3)],
  };
}`);
  if (n) {
    const q = n.probes;
    check('one body, genus 0', n.bodies === 1 && n.genus === 0, `bodies=${n.bodies} genus=${n.genus}`);
    check('nothing outside the 20 mm cube', n.maxAbs <= 10 + 1e-3, `maxAbs=${n.maxAbs}`);
    check('per-knot θ at the true 90° dihedral (88°..92°; was 94.1° off the polluted +y wall)',
      n.meta && n.meta.thetaMinDeg >= 88 && n.meta.thetaMaxDeg <= 92,
      `θ=${n.meta?.thetaMinDeg}..${n.meta?.thetaMaxDeg}`);
    check('no inverted top facets at the R=2 corners (< 0.05 mm²; was 6.8 mm²)',
      n.downTop < 0.05, `downTop=${n.downTop.toFixed(4)} mm²`);
    check('volume in the measured window (7665..7690)',
      n.volume > 7665 && n.volume < 7690, `volume=${n.volume.toFixed(3)}`);
    check('every picked edge is rounded', q.rounded.every((v) => v < 1e-6), fmt(q.rounded));
    check('flat walls stay solid', q.walls.every((v) => Math.abs(v - 1) < 1e-3), fmt(q.walls));
    check('interior stays solid', q.core.every((v) => Math.abs(v - 1) < 1e-3), fmt(q.core));
  }
}

// ── Wiring ─────────────────────────────────────────────────────
{
  const worker = readFileSync(new URL('../../src/workers/sandboxWorker.js', import.meta.url), 'utf8');
  const fap = readFileSync(new URL('../../src/utils/filletAlongPath.js', import.meta.url), 'utf8');
  check('sweep probe reads in-face rays against the mesh edge (sliver-safe)',
    /_c6InFaceDirSafe\(X0, best\.va, seg\.T, nA, nB, eDir\)/.test(worker));
  check('planar face groups drop foreign facets from their normal',
    /normal: _c4PlanarGroupNormal\(/.test(worker));
  check('all-convex fillet paths split arcs tighter than the cutter',
    /splitTighterArcs: pathConvex/.test(worker) && /tighter && med < r/.test(fap));
  const arch = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');
  check('architecture.md documents the multi-rotation fixes', /golden:fillet-chamfer-multi-rotation/.test(arch));
}

if (failed) {
  console.log(`\n❌ fillet-chamfer-multi-rotation golden FAILED (${failed} checks)`);
  process.exit(1);
}
console.log('\nfillet-chamfer-multi-rotation golden passed');
process.exit(0);
