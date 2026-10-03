#!/usr/bin/env node
/**
 * Draft hinge when a blend sits between the neutral plane and the wall.
 *
 * Cube 40×30×20 centered. Fillet (and, separately, chamfer) the bottom edge
 * of the +X wall, radius/leg 4. The +X wall then runs from the tangency
 * (z ≈ −6) up to z = 10; it no longer reaches the −Z face.
 *
 * Neutral = −Z. The blend is between that plane and the +X wall, so the
 * hinge moves off the neutral plane onto the blend–wall tangency:
 *   - tangency vertices stay on the original wall plane x = 20 (no ledge)
 *   - the top edge tilts by tan(5°) × (zTop − zTangency)
 *   - fillet/chamfer vertices that are not on that tangency stay put
 *     (the blend face is not drafted)
 *
 * Neutral = +Z on the same fillet. The wall meets that plane, so the fillet
 * is not between them and the hinge stays on the neutral plane: the top edge
 * does not move, and the tangency slides by tan(5°) × the full height.
 */
import { register } from 'node:module';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const near = (a, b, tol = 2e-3) => Math.abs(a - b) <= tol;

const TAN = Math.tan((5 * Math.PI) / 180);

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(msg.payload?.message || 'worker error'));
    else waiter.resolve(msg);
  },
};
globalThis.self = workerSelf;

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => {
      if (!workerSelf.onmessage) {
        reject(new Error('sandboxWorker handler missing'));
        return;
      }
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

register('./manifold-resolve-hook.mjs', import.meta.url);
await import('../../src/workers/sandboxWorker.js');
await send('init');

async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}

function verts(mesh) {
  const np = mesh.numProp || 3;
  const out = [];
  for (let i = 0; i < mesh.vertProperties.length; i += np) {
    out.push([mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]]);
  }
  return out;
}
function hasVertex(vs, x, y, z, tol = 1e-3) {
  return vs.some((v) => Math.abs(v[0] - x) <= tol && Math.abs(v[1] - y) <= tol && Math.abs(v[2] - z) <= tol);
}
function wallCorners(vs) {
  return vs.filter((v) => v[0] > 19.995 && Math.abs(Math.abs(v[1]) - 15) < 0.05);
}
function filletBody(vs, zT) {
  return vs.filter((v) => (
    Math.abs(Math.abs(v[1]) - 15) < 0.05
    && v[0] > 17 && v[0] < 19.6
    && v[2] < zT - 0.8 && v[2] > zT - 3.2
  ));
}

const BLEND_SETUP = `
let part = Manifold.cube([40, 30, 20], true);
const bottom = convexEdges(part).filter((e) => {
  const mz = (e.va[2] + e.vb[2]) / 2;
  const mx = (e.va[0] + e.vb[0]) / 2;
  const dy = Math.abs(e.va[1] - e.vb[1]);
  return Math.abs(mz + 10) < 0.2 && Math.abs(mx - 20) < 0.2 && dy > 20;
});
if (bottom.length !== 1) throw new Error('expected the +X bottom edge, got ' + bottom.length);
`;

function draftWall(pull, reference) {
  return `
const wall = facesByNormal(part, [1, 0, 0], 2)[0];
if (!wall || Math.abs(wall.normal[0] - 1) > 1e-3 || Math.abs(wall.normal[2]) > 1e-3) {
  throw new Error('draft pick is not the planar +X wall');
}
part = draftFaces(part, wall, 5, { pull: ${pull}, reference: ${reference} });
`;
}

console.log('draft hinge at fillet/chamfer tangency');

{
  console.log('\nfillet between −Z and +X');
  const before = await exec(`
    ${BLEND_SETUP}
    part = filletAlongPath(part, makeSweepPath(bottom), 4);
    return part;
  `);
  const bvs = verts(before.mesh);
  const corners = wallCorners(bvs);
  const zT = Math.min(...corners.map((v) => v[2]));
  const zTop = Math.max(...corners.map((v) => v[2]));
  const tang = corners.filter((v) => Math.abs(v[2] - zT) < 0.02);
  const body = filletBody(bvs, zT);
  check('pre-draft wall has a tangency and a top edge',
    tang.length >= 2 && near(zTop, 10, 1e-3) && zT < -5 && zT > -8,
    `zT=${zT} zTop=${zTop} tang=${tang.length}`);
  check('fillet body has sample vertices', body.length >= 8, `n=${body.length}`);

  const after = await exec(`
    ${BLEND_SETUP}
    part = filletAlongPath(part, makeSweepPath(bottom), 4);
    ${draftWall('[0, 0, -1]', '{ center: [0, 0, -10], normal: [0, 0, -1] }')}
    return part;
  `);
  check('drafted solid is valid', after.status === 'NoError' && after.volume > 0,
    `${after.status} vol ${after.volume}`);
  const avs = verts(after.mesh);
  const shift = TAN * (zTop - zT);
  check('tangency stays on x=20 (no ledge)',
    tang.every((v) => hasVertex(avs, v[0], v[1], v[2])),
    `zT=${zT.toFixed(4)}`);
  check('no vertex steps out at the tangency',
    !avs.some((v) => Math.abs(v[2] - zT) < 0.1 && v[0] > 20.02));
  const tops = avs.filter((v) => Math.abs(v[2] - zTop) < 0.02 && Math.abs(Math.abs(v[1]) - 15) < 0.05 && v[0] > 19);
  check('top edge tilts from the tangency by tan(5°)·height',
    tops.length >= 2 && tops.every((v) => near(v[0], 20 + shift)),
    `x=${tops.map((v) => v[0].toFixed(4)).join(',')} want ${(20 + shift).toFixed(4)} (height ${(zTop - zT).toFixed(4)})`);
  check('fillet face was not drafted',
    body.every((v) => hasVertex(avs, v[0], v[1], v[2])));
  check('−X and the Y extent stay put',
    hasVertex(avs, -20, 15, 10) && hasVertex(avs, -20, -15, -10)
    && avs.every((v) => v[0] >= -20 - 1e-2)
    && avs.every((v) => Math.abs(v[1]) <= 15 + 1e-2));
}

{
  console.log('\nfillet on the far side of a +Z neutral plane');
  const before = await exec(`
    ${BLEND_SETUP}
    part = filletAlongPath(part, makeSweepPath(bottom), 4);
    return part;
  `);
  const bvs = verts(before.mesh);
  const corners = wallCorners(bvs);
  const zT = Math.min(...corners.map((v) => v[2]));
  const zTop = Math.max(...corners.map((v) => v[2]));
  const tang = corners.filter((v) => Math.abs(v[2] - zT) < 0.02);
  const tops = corners.filter((v) => Math.abs(v[2] - zTop) < 0.02);
  const body = filletBody(bvs, zT);
  const after = await exec(`
    ${BLEND_SETUP}
    part = filletAlongPath(part, makeSweepPath(bottom), 4);
    ${draftWall('[0, 0, 1]', '{ center: [0, 0, 10], normal: [0, 0, 1] }')}
    return part;
  `);
  const avs = verts(after.mesh);
  const shift = TAN * (zTop - zT);
  check('far-side fillet keeps the neutral-plane hinge at the top',
    after.status === 'NoError'
    && tops.every((v) => hasVertex(avs, v[0], v[1], v[2]))
    && tang.every((v) => hasVertex(avs, v[0] + shift, v[1], v[2])),
    `shift=${shift.toFixed(4)}`);
  check('far-side fillet face was not drafted',
    body.length >= 8 && body.every((v) => hasVertex(avs, v[0], v[1], v[2])),
    `n=${body.length}`);
}

{
  console.log('\nchamfer between −Z and +X');
  const before = await exec(`
    ${BLEND_SETUP}
    part = chamferEdges(part, bottom, 4);
    return part;
  `);
  const bvs = verts(before.mesh);
  const corners = wallCorners(bvs);
  const zT = Math.min(...corners.map((v) => v[2]));
  const zTop = Math.max(...corners.map((v) => v[2]));
  const tang = corners.filter((v) => Math.abs(v[2] - zT) < 0.02);
  const chamfer = bvs.filter((v) => (
    Math.abs(Math.abs(v[1]) - 15) < 0.05 && v[0] > 14 && v[0] < 19.5 && v[2] < zT - 0.5
  ));
  check('chamfer tangency is short of the neutral plane',
    tang.length >= 2 && zT < -5 && zT > -8 && chamfer.length >= 2,
    `zT=${zT} chamfer=${chamfer.length}`);

  const after = await exec(`
    ${BLEND_SETUP}
    part = chamferEdges(part, bottom, 4);
    ${draftWall('[0, 0, -1]', '{ center: [0, 0, -10], normal: [0, 0, -1] }')}
    return part;
  `);
  const avs = verts(after.mesh);
  const shift = TAN * (zTop - zT);
  const tops = avs.filter((v) => Math.abs(v[2] - zTop) < 0.02 && Math.abs(Math.abs(v[1]) - 15) < 0.05 && v[0] > 19);
  check('chamfer tangency stays (no ledge) and the wall tilts from it',
    after.status === 'NoError'
    && tang.every((v) => hasVertex(avs, v[0], v[1], v[2]))
    && !avs.some((v) => Math.abs(v[2] - zT) < 0.1 && v[0] > 20.02)
    && tops.length >= 2 && tops.every((v) => near(v[0], 20 + shift)),
    `zT=${zT.toFixed(4)} top=${tops.map((v) => v[0].toFixed(4)).join(',')}`);
  check('chamfer face was not drafted',
    chamfer.every((v) => hasVertex(avs, v[0], v[1], v[2])));
}

if (failed) {
  console.log(`\n${failed} draft fillet-tangency check(s) failed`);
  process.exit(1);
}
console.log('\nAll draft fillet-tangency checks passed.');
