#!/usr/bin/env node
/**
 * An internal fillet is one body with the owner, and a face pick stays there.
 *
 * The inner corner of a shelled box is a concave fillet. The wedge has to be
 * in that solid: decompose is one body, and a point in the added material is
 * solid. A second component is the unjoined wedge.
 *
 * moveFace and a legacy face pick on one body of a compose cannot select a
 * coplanar face of the other body, even when that other face's center is
 * closer to the pick than the hit face's center.
 */
import { register } from 'node:module';
import { BufferAttribute, BufferGeometry } from 'three';
import { resolveViewportFaceClick } from '../../src/utils/selectFace.js';
import { buildPartGraphPatches } from '../../src/utils/partGraphPatches.js';

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
async function exec(script) {
  globalThis.__note = null;
  try {
    const msg = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
    return { payload: msg.payload, note: globalThis.__note };
  } catch (e) {
    return { error: e.message, note: globalThis.__note };
  }
}

console.log('internal fillet is one body with the wedge');
{
  const r = await exec(`
let part = Manifold.cube([40, 30, 20], true);
part = hollow(part, 2.5, [{ center: [0, 0, -10], normal: [0, 0, -1] }]);
const edgeLen = (e) => Math.hypot(e.vb[0] - e.va[0], e.vb[1] - e.va[1], e.vb[2] - e.va[2]);
const inner = concaveEdges(part)
  .filter((e) => edgeLen(e) > 8 && e.va[0] > 10 && e.va[1] > 5)
  .sort((a, b) => edgeLen(b) - edgeLen(a))[0];
if (!inner) throw new Error('no inner concave edge');
const before = part.volume();
const emptyBefore = Manifold.intersection(
  part,
  Manifold.sphere(0.15, 16).translate([17.2, 12.2, 0]),
).volume();
const out = filletAlongPath(part, makeSweepPath([inner]), 2, { variableProfile: true });
const parts = out.decompose();
const filled = Manifold.intersection(
  out,
  Manifold.sphere(0.15, 16).translate([17.2, 12.2, 0]),
).volume();
globalThis.__note = {
  n: parts.length,
  vols: parts.map((p) => +p.volume().toFixed(3)),
  before: +before.toFixed(3),
  after: +out.volume().toFixed(3),
  emptyBefore: +emptyBefore.toFixed(6),
  filled: +filled.toFixed(6),
};
return out;
`);
  check('inner fillet runs', !r.error, r.error || '');
  const note = r.note;
  if (!r.error && note) {
    check('fillet wedge is not its own body', note.n === 1, `n=${note.n} vols=${note.vols}`);
    check('the wedge volume is in that body',
      note.after > note.before + 0.5 && note.vols.length === 1 && note.vols[0] > note.before + 0.5,
      `before=${note.before} after=${note.after} vols=${note.vols}`);
    check('the corner was empty before the fillet', note.emptyBefore < 1e-6, `emptyBefore=${note.emptyBefore}`);
    check('a point in the wedge is solid', note.filled > 1e-4, `filled=${note.filled}`);
  }
}

console.log('face pick and moveFace stay on the seed body');
{
  const r = await exec(`
const left = Manifold.cube([40, 20, 10], true).translate([-10, 0, 0]);
const right = Manifold.cube([4, 4, 10], true).translate([12, 0, 0]);
let part = Manifold.compose([left, right]);
const moved = moveFace(part, [{ center: [9.5, 0, 5], normal: [0, 0, 1] }], 3);
const parts = moved.decompose();
const big = parts.find((p) => p.boundingBox().min[0] < 0);
const small = parts.find((p) => p.boundingBox().min[0] >= 0);
globalThis.__note = {
  n: parts.length,
  bigZ: big ? +big.boundingBox().max[2].toFixed(3) : null,
  smallZ: small ? +small.boundingBox().max[2].toFixed(3) : null,
  bigVol: big ? +big.volume().toFixed(2) : null,
  smallVol: small ? +small.volume().toFixed(2) : null,
};
return part;
`);
  check('composed solid is available for the pick', !r.error, r.error || '');
  const note = r.note;
  if (!r.error && note) {
    check('moveFace does not grow the other body',
      note.n === 2 && Math.abs(note.smallZ - 5) < 1e-2 && Math.abs(note.smallVol - 160) < 1,
      JSON.stringify(note));
    check('moveFace grows the body under the pick',
      Math.abs(note.bigZ - 8) < 1e-2 && note.bigVol > 9000,
      JSON.stringify(note));
  }

  const mesh = r.payload && r.payload.mesh;
  if (mesh && mesh.vertProperties && mesh.triVerts) {
    const np = mesh.numProp || 3;
    const nVert = mesh.vertProperties.length / np;
    const pos = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) {
      pos[i * 3] = mesh.vertProperties[i * np];
      pos[i * 3 + 1] = mesh.vertProperties[i * np + 1];
      pos[i * 3 + 2] = mesh.vertProperties[i * np + 2];
    }
    const index = Uint32Array.from(mesh.triVerts);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(pos, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    let seed = -1;
    for (let t = 0; t < index.length / 3; t++) {
      const i0 = index[t * 3];
      const i1 = index[t * 3 + 1];
      const i2 = index[t * 3 + 2];
      const z0 = pos[i0 * 3 + 2];
      const z1 = pos[i1 * 3 + 2];
      const z2 = pos[i2 * 3 + 2];
      const maxX = Math.max(pos[i0 * 3], pos[i1 * 3], pos[i2 * 3]);
      const minX = Math.min(pos[i0 * 3], pos[i1 * 3], pos[i2 * 3]);
      if (Math.abs(z0 - 5) < 1e-3 && Math.abs(z1 - 5) < 1e-3 && Math.abs(z2 - 5) < 1e-3
        && maxX <= 10.01 && minX < 10) {
        seed = t;
        break;
      }
    }
    check('seed triangle is on the large body', seed >= 0, `seed=${seed}`);
    if (seed >= 0) {
      const picked = resolveViewportFaceClick({
        geometry,
        seedFaceIndex: seed,
        faceNormal: [0, 0, 1],
        clickCount: 1,
        faceIDs: mesh.faceID,
        legacy: true,
      });
      const crossed = picked.indices.some((t) => {
        const i0 = index[t * 3];
        const i1 = index[t * 3 + 1];
        const i2 = index[t * 3 + 2];
        return Math.max(pos[i0 * 3], pos[i1 * 3], pos[i2 * 3]) > 10.01;
      });
      check('legacy face pick stays on the seed body',
        picked.indices.length > 0 && !crossed,
        `n=${picked.indices.length} crossed=${crossed}`);
      const graph = buildPartGraphPatches({
        positions: pos,
        indices: index,
        faceIDs: mesh.faceID,
      });
      const patchCross = (graph.patches || []).some((p) => {
        let lo = false;
        let hi = false;
        for (const t of p.tris) {
          const i0 = index[t * 3];
          const xs = [pos[i0 * 3], pos[index[t * 3 + 1] * 3], pos[index[t * 3 + 2] * 3]];
          if (Math.min(...xs) < 0) lo = true;
          if (Math.max(...xs) > 12) hi = true;
        }
        return lo && hi;
      });
      check('part-graph merge does not cross bodies', !patchCross);
    }
  } else {
    check('mesh is available for the face pick', false, 'no mesh');
  }
}

if (failed) {
  console.log(`\n${failed} fillet-join-body check(s) failed`);
  process.exit(1);
}
console.log('\nfillet-join-body golden passed');
