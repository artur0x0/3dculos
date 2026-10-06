#!/usr/bin/env node
/**
 * Three-fillet corner wrap — Artur's single-part playtest.
 *
 *   20 mm cube; r=2 on the two −x vertical edges, r=2 variable-profile on the
 *   +x top edge, then a variable-profile r=3.73 along a 24-edge picked chain:
 *   up the (10, 10) vertical edge, over the +y end arc of the r=2 top fillet,
 *   around the top perimeter through both −x corner arcs, over the −y end arc
 *   and down the (10, −10) vertical edge.
 *
 * Since #154 the result had a mangled blob where the three fillets meet and a
 * torn, bulging side wall. Root cause: c4MeshData face groups. faceID is only
 * unique within one source mesh, and every one-ring-per-knot cutter is built
 * with the same triangle numbering, so faceID k is a facet on EACH earlier
 * fillet. On this symmetric cube a +x top-fillet facet and a −x vertical-fillet
 * facet sat at the same offset along their averaged normal and were re-merged
 * into one "planar" face whose normal was 45° off both. signedFeatureEdges
 * returned that as the edge dihedral, the probe read θ = 45°…163° on the arcs
 * (all of them are 90°), and the variable-profile cutter carved the wrong
 * section there: a nested second shell 4 mm under the surface (the blob) and
 * the −x top edge left partly unrounded.
 *
 * Pins: per-knot θ stays at the true ~90° dihedral, one genus-0 body, volume
 * in the measured window (#154/main: 7742.6, genus 1), plain solid inside
 * the part, every picked edge actually rounded, flat walls solid.
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

await import('../../src/workers/sandboxWorker.js');
await send('init');

console.log('fillet three-corner wrap — r=3.73 variable-profile chain through three r=2 fillets');
const full = readFileSync(new URL('./fixtures/artur_playtest_fillet_three_corner_wrap.txt', import.meta.url), 'utf8');
check('fixture fillets the picked chain at 3.73 variable-profile',
  /filletAlongPath\(part, path, 3\.73, \{ variableProfile: true \}\)/.test(full));
const keys = full.match(/key: "coh-[0-9-]+"/g) || [];
check('fixture picks the 24-edge chain', keys.length === 24, `edges=${keys.length}`);

const body = full.replace(/\n*return\s+part\s*;?\s*$/i, '');
const script = `
globalThis.__filletVariableProfileMeta = null;
${body}
const meta = globalThis.__filletVariableProfileMeta;
const ball = (c, r) => {
  const s = Manifold.sphere(r, 16).translate(c);
  return Manifold.intersection(part, s).volume() / s.volume();
};
const mesh = part.getMesh();
const np = mesh.numProp || 3;
let maxAbs = 0;
for (let i = 0; i < mesh.vertProperties.length / np; i++) {
  for (let k = 0; k < 3; k++) maxAbs = Math.max(maxAbs, Math.abs(mesh.vertProperties[i * np + k]));
}
globalThis.__note = {
  thetaMin: meta ? meta.thetaMinDeg : null,
  thetaMax: meta ? meta.thetaMaxDeg : null,
  volume: part.volume(),
  genus: part.genus(),
  bodies: part.decompose().length,
  maxAbs,
  // Inside the part, under the −y/+x corner. #154 left a second, nested shell
  // here: the intersection with a solid ball came back up to 1.8× the ball.
  core: [
    ball([5.8, -6.5, 7], 0.3), ball([6.5, -6.5, 7.7], 0.3), ball([4.96, -6.27, 6.73], 0.3),
    ball([4.33, -3.63, 5.63], 0.3), ball([6, 6, 6], 0.5), ball([0, 0, 0], 1),
  ],
  // On each picked edge, 0.45 mm in along the bisector: inside the r=3.73
  // blend gap (r(√2−1)·√2 ≈ 2.2 mm), so it must be cut away.
  rounded: [
    ball([9.55, 9.55, 0], 0.2), ball([9.55, -9.55, 0], 0.2),
    ball([0, 9.55, 9.55], 0.2), ball([0, -9.55, 9.55], 0.2),
    ball([-9.55, 4, 9.55], 0.2), ball([-9.55, -4, 9.55], 0.2),
  ],
  // Flat walls just under the surface, outside every blend band.
  walls: [
    ball([9.7, 0, 0], 0.2), ball([9.7, 0, 4], 0.2), ball([9.7, 4, -4], 0.2),
    ball([0, 9.7, 3], 0.2), ball([0, -9.7, 3], 0.2), ball([0, 0, 9.7], 0.2),
  ],
};
return part;
`;

const r = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
const p = r.payload || {};
check('playtest script runs', !p.error && p.status !== 'error', p.error || p.message || '');
const n = globalThis.__note;
if (n) {
  check('per-knot θ stays at the true ~90° dihedral (85°..100°)',
    n.thetaMin >= 85 && n.thetaMax <= 100, `θ=${n.thetaMin}..${n.thetaMax}`);
  check('one body', n.bodies === 1, `bodies=${n.bodies}`);
  check('genus 0 (no handle where the three cutters meet)', n.genus === 0, `genus=${n.genus}`);
  check('volume in the measured window (7665..7700)',
    n.volume > 7665 && n.volume < 7700, `volume=${n.volume.toFixed(2)}`);
  check('nothing outside the 20 mm cube', n.maxAbs <= 10 + 1e-3, `maxAbs=${n.maxAbs}`);
  check('interior is plain solid (no carved void, no nested shell)',
    n.core.every((v) => Math.abs(v - 1) < 1e-3), `core=${n.core.map((v) => v.toFixed(4)).join(',')}`);
  check('every picked edge is rounded',
    n.rounded.every((v) => v < 1e-6), `rounded=${n.rounded.map((v) => v.toFixed(4)).join(',')}`);
  check('flat walls stay solid',
    n.walls.every((v) => Math.abs(v - 1) < 1e-3), `walls=${n.walls.map((v) => v.toFixed(4)).join(',')}`);
} else {
  check('golden note recorded', false);
}

if (failed) {
  console.log(`❌ fillet-three-corner-wrap golden FAILED (${failed} checks)`);
  process.exit(1);
}
console.log('fillet-three-corner-wrap golden passed');
