#!/usr/bin/env node
/**
 * Move Face on a wall next to an internal fillet carries that fillet, and a
 * drafted face still draws the body-split line.
 *
 * The fillet is already one solid with the owner. Move Face does not read
 * the face graph (that graph stays lazy after fillet). It used to offset
 * only the planar face, so the tangent blend pinned the shared vertices and
 * the fillet stayed put. A point that was empty beside the blend is solid
 * after the wall moves, and decompose is still one body.
 *
 * A keep-both cut draws a 1px seam where two bodies meet. Drafting the wall
 * tilts that side off the cap. The seam is the same line: sides agree, caps
 * oppose, and which triangle was stored first does not matter.
 */
import { register } from 'node:module';
import { contactSeamSegments } from '../../src/utils/contactSeam.js';

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

function ball(solidName, p) {
  return `Manifold.intersection(${solidName}, Manifold.sphere(0.15, 10).translate([${p.join(',')}])).volume()`;
}

console.log('moveFace carries the internal fillet with the wall');
{
  const r = await exec(`
let part = Manifold.cube([40, 30, 20], true);
part = hollow(part, 2.5, [{ center: [0, 0, -10], normal: [0, 0, -1] }]);
const edgeLen = (e) => Math.hypot(e.vb[0] - e.va[0], e.vb[1] - e.va[1], e.vb[2] - e.va[2]);
const inner = concaveEdges(part)
  .filter((e) => edgeLen(e) > 8 && e.va[0] > 10 && e.va[1] > 5)
  .sort((a, b) => edgeLen(b) - edgeLen(a))[0];
if (!inner) throw new Error('no inner concave edge');
const beforeFillet = part.volume();
part = filletAlongPath(part, makeSweepPath([inner]), 2, { variableProfile: true });
const arrived = [16.2, 12, 0];
const oldWedge = [17.2, 12.2, 0];
const otherWall = [10, 12.6, 0];
const otherVoid = [10, 12.3, 0];
const preN = part.decompose().length;
const preArrived = ${ball('part', [16.2, 12, 0])};
const preWedge = ${ball('part', [17.2, 12.2, 0])};
const preOther = ${ball('part', [10, 12.6, 0])};
const preVoid = ${ball('part', [10, 12.3, 0])};
const moved = moveFace(part, [{ center: [17.5, 0, 0], normal: [-1, 0, 0] }], 1);
const postArrived = ${ball('moved', [16.2, 12, 0])};
const postWedge = ${ball('moved', [17.2, 12.2, 0])};
const postOther = ${ball('moved', [10, 12.6, 0])};
const postVoid = ${ball('moved', [10, 12.3, 0])};
globalThis.__note = {
  preN,
  postN: moved.decompose().length,
  filletAdd: +(part.volume() - beforeFillet).toFixed(3),
  dVol: +(moved.volume() - part.volume()).toFixed(2),
  preArrived: +preArrived.toFixed(5),
  postArrived: +postArrived.toFixed(5),
  preWedge: +preWedge.toFixed(5),
  postWedge: +postWedge.toFixed(5),
  preOther: +preOther.toFixed(5),
  postOther: +postOther.toFixed(5),
  preVoid: +preVoid.toFixed(5),
  postVoid: +postVoid.toFixed(5),
};
return moved;
`);
  check('inner fillet move runs', !r.error, r.error || '');
  const n = r.note;
  if (!r.error && n) {
    check('the fillet is one body before the move', n.preN === 1, `n=${n.preN}`);
    check('the fillet added material', n.filletAdd > 5, `add=${n.filletAdd}`);
    check('the old corner wedge was solid', n.preWedge > 1e-4, `vol=${n.preWedge}`);
    check('the arrival point was empty', n.preArrived < 1e-6, `vol=${n.preArrived}`);
    check('moveFace still returns one body', n.postN === 1, `n=${n.postN}`);
    check('the fillet arrived with the wall', n.postArrived > 1e-4, `vol=${n.postArrived}`);
    check('the old wedge is still in the thickened wall', n.postWedge > 1e-4, `vol=${n.postWedge}`);
    check('the other wall did not move', n.preOther > 1e-4 && n.postOther > 1e-4 && n.preVoid < 1e-6 && n.postVoid < 1e-6,
      `other ${n.preOther}->${n.postOther} void ${n.preVoid}->${n.postVoid}`);
  }
}

console.log('drafted face keeps the body-split line');
{
  const cut = await exec(`
let part = Manifold.cube([40, 30, 20], true);
part = cut(part, { normal: [0, 0, 1], originOffset: 0 });
return part;
`);
  const cutSeams = cut.error ? [] : contactSeamSegments(cut.payload.mesh.vertProperties, cut.payload.mesh.triVerts, cut.payload.mesh.numProp);
  check('undrafted cut still draws four seams', !cut.error && cutSeams.length === 4, cut.error || `n=${cutSeams.length}`);

  const drafted = await exec(`
let part = Manifold.cube([40, 30, 20], true);
part = cut(part, { normal: [0, 0, 1], originOffset: 0 });
part = draftFaces(part, [{ center: [20, 0, 5], normal: [1, 0, 0] }, { center: [20, 0, -5], normal: [1, 0, 0] }], 8, { pull: [0, 0, 1], reference: 'min' });
return part;
`);
  check('draft of both +X faces runs', !drafted.error, drafted.error || '');
  if (!drafted.error) {
    const segs = contactSeamSegments(
      drafted.payload.mesh.vertProperties,
      drafted.payload.mesh.triVerts,
      drafted.payload.mesh.numProp,
    );
    const draftedSide = segs.filter((s) => Math.abs(s.a[2]) < 1e-3 && Math.abs(s.b[2]) < 1e-3
      && s.a[0] > 18 && s.a[0] < 19.5 && s.b[0] > 18 && s.b[0] < 19.5
      && Math.abs(s.sideNormal[0]) > 0.9 && Math.abs(s.sideNormal[2]) > 0.05
      && Math.abs(s.capNormal[2]) > 0.9);
    const undrafted = segs.filter((s) => Math.abs(s.a[0] + 20) < 1e-3 && Math.abs(s.b[0] + 20) < 1e-3
      && Math.abs(s.capNormal[2]) > 0.9);
    check('drafted face draws the split', segs.length === 4 && draftedSide.length === 1,
      `n=${segs.length} drafted=${draftedSide.length}`);
    check('the undrafted wall still draws its split', undrafted.length === 1, `n=${undrafted.length}`);
  }

  const one = await exec(`
let part = Manifold.cube([40, 30, 20], true);
part = cut(part, { normal: [0, 0, 1], originOffset: 0 }, { keep: '+' });
part = draftFaces(part, [{ center: [20, 0, 5], normal: [1, 0, 0] }], 8, { pull: [0, 0, 1], reference: 'min' });
return part;
`);
  const oneSeams = one.error ? null : contactSeamSegments(one.payload.mesh.vertProperties, one.payload.mesh.triVerts, one.payload.mesh.numProp);
  check('one body still draws no split', !one.error && oneSeams && oneSeams.length === 0, one.error || `n=${oneSeams && oneSeams.length}`);
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall checks passed');
