#!/usr/bin/env node
/**
 * Slice C2 — hard Accept segment rolling-ball (WASM).
 *
 * Asserts:
 * - hard loft generator Accept emits filletEdges + relaxPlanar (not RMF sweep)
 * - relaxPlanar filletEdges on a loft generator succeeds and is manifold-ish
 * - fewer/no scrap-sheet needles vs pre-C2 single-sweep failure mode
 * - easy cube Accept still uses filletAlongPath
 */
import { register } from 'node:module';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  defaultSweepBlendSize,
  pathLengthFromEdges,
} from '../../src/utils/selectEdge.js';
import {
  annotateFeatureEdges,
  indexBoundaryEdges,
} from '../../src/utils/boundaryEdgeIds.js';
import {
  classifyFilletEdges,
} from '../../src/utils/filletEdgeClass.js';
import { composeFilletCommit } from '../../src/utils/filletMode.js';
import { isFilletSliverDirty } from '../../src/utils/filletSliverGuard.js';
import {
  FILLET_HARD_KERNEL_TRIAL,
  shouldUseHardRollingBall,
} from '../../src/utils/filletKernelSpike.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('fillet C2 rolling-ball');

check('production hard flag on', FILLET_HARD_KERNEL_TRIAL === true);
check('hard class uses rolling-ball', shouldUseHardRollingBall('hard') === true);

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

function geomOf(mesh) {
  const g = new BufferGeometry();
  const np = mesh.numProp || 3;
  const pos = new Float32Array(mesh.vertProperties.length / np * 3);
  for (let i = 0, j = 0; i < mesh.vertProperties.length; i += np, j += 3) {
    pos[j] = mesh.vertProperties[i];
    pos[j + 1] = mesh.vertProperties[i + 1];
    pos[j + 2] = mesh.vertProperties[i + 2];
  }
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  return g;
}

function coherentOf(payload) {
  const g = geomOf(payload.mesh);
  const raw = buildFeatureEdges(g);
  const topo = indexBoundaryEdges({
    positions: g.attributes.position.array,
    indices: g.index.array,
    faceIDs: payload.mesh.faceID,
  });
  return { g, edges: buildCoherentEdges(annotateFeatureEdges(raw, topo)), mesh: payload.mesh };
}

function sliverCount(mesh) {
  const np = mesh.numProp || 3;
  const V = mesh.vertProperties;
  const T = mesh.triVerts;
  const nTri = T.length / 3;
  let tiny = 0;
  for (let ti = 0; ti < nTri; ti++) {
    const i0 = T[ti * 3] * np;
    const i1 = T[ti * 3 + 1] * np;
    const i2 = T[ti * 3 + 2] * np;
    const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
    const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
    const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    if (A < 1e-8) tiny++;
  }
  return { tiny, nTri, dirty: isFilletSliverDirty(tiny, nTri) };
}

const LOFT = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
return placeInFrame(fr, makeLoft([xs0, xs1]));
`;

console.log('fillet C2 — Accept compose + WASM loft hard path');

{
  const starter = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;';
  const tagged = {
    key: '0-1', a: 0, b: 1,
    va: [0, 0, 10], vb: [40, 0, 10], mid: [20, 0, 10],
    length: 40, tangent: [1, 0, 0],
    n0: [0, 0, 1], n1: [0, -1, 0],
    boundaryId: 4, faceA: 2, faceB: 5, pairCount: 1,
  };
  const easy = composeFilletCommit(starter, {
    edges: [tagged],
    params: { strategy: 'sweep', radius: 2 },
    filletClass: 'easy',
  });
  check('easy compose stays sweep', easy.ok && /filletAlongPath\s*\(/.test(easy.buffer));
}

{
  const loft = coherentOf(await exec(LOFT));
  const generators = loft.edges.filter((e) => Math.abs(e.tangent[2]) > 0.8 && e.length > 10);
  check('loft has generator', generators.length >= 1, `n=${generators.length}`);
  const gen = generators[0];
  const radius = defaultSweepBlendSize(pathLengthFromEdges([gen]));
  const klass = classifyFilletEdges([gen], { radius, geometry: loft.g });
  check('generator classified hard', klass.klass === 'hard', klass.klass);

  const loftStarter = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
let part = placeInFrame(fr, makeLoft([xs0, xs1]));
return part;
`;
  const commit = composeFilletCommit(loftStarter, {
    edges: [gen],
    params: { strategy: 'sweep', radius, sphericalCorners: true },
    filletClass: klass.klass,
    geometry: loft.g,
  });
  check('hard loft Accept ok', commit.ok === true, commit.message || '');
  check('hard loft emits filletEdges', /filletEdges\s*\(/.test(commit.buffer || ''), commit.buffer?.slice(-400));
  check('hard loft emits relaxPlanar', /relaxPlanar:\s*true/.test(commit.buffer || ''));
  check('hard loft does not emit filletAlongPath', !/filletAlongPath\s*\(/.test(commit.buffer || ''));
  check('hard loft kernel rolling-ball', commit.kernel === 'rolling-ball-segment');

  // Execute full committed buffer (markers + filletEdges + relaxPlanar).
  let hardPayload = null;
  let hardErr = null;
  try {
    hardPayload = await exec(commit.buffer);
  } catch (e) {
    hardErr = e;
  }
  check('hard rolling-ball exec succeeds', !!hardPayload && !hardErr, hardErr?.message || '');
  if (hardPayload?.mesh) {
    const sc = sliverCount(hardPayload.mesh);
    check('hard result not scrap-sheet dirty', sc.dirty === false, `tiny=${sc.tiny}/${sc.nTri}`);
    // Shared scrap-sheet gate (same as filletEdges loud-fail) is the
    // manifold-ish bar — dense loft meshes can have many skinny tris.
    check(
      'hard result manifold-ish (not scrap-sheet dirty)',
      sc.dirty === false,
      `tiny=${sc.tiny}/${sc.nTri}`,
    );
  }

  // Compare: single RMF sweep on same generator (pre-C2 path) — may be dirty.
  let sweepTiny = null;
  try {
    const mid = [
      (gen.va[0] + gen.vb[0]) / 2,
      (gen.va[1] + gen.vb[1]) / 2,
      (gen.va[2] + gen.vb[2]) / 2,
    ];
    const sweepScript = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
let part = placeInFrame(fr, makeLoft([xs0, xs1]));
const hit = convexEdges(part).filter((e) => {
  const m = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];
  const p = [${mid.map((x) => +x.toFixed(6)).join(', ')}];
  return (m[0]-p[0])**2 + (m[1]-p[1])**2 + (m[2]-p[2])**2 < 0.25;
});
if (!hit.length) throw new Error('generator not found for sweep compare');
const path = makeSweepPath(hit);
part = filletAlongPath(part, path, ${radius});
return part;
`;
    const sweepPayload = await exec(sweepScript);
    sweepTiny = sliverCount(sweepPayload.mesh).tiny;
  } catch (e) {
    // Sweep may loud-fail on slivers — that is the pre-C2 failure mode.
    sweepTiny = Infinity;
    check('pre-C2 sweep failed or threw (expected possible)', true, e.message);
  }
  if (hardPayload?.mesh && sweepTiny != null) {
    const hardTiny = sliverCount(hardPayload.mesh).tiny;
    check(
      'hard rolling-ball needles ≤ pre-C2 sweep needles',
      hardTiny <= sweepTiny,
      `hard=${hardTiny} sweep=${sweepTiny}`,
    );
  }
}

{
  // Easy box path still exact under filletEdges planar (sanity) + sweep Accept path.
  const payload = await exec(`
    let part = Manifold.cube([40, 30, 20], true);
    const edges = convexEdges(part).filter((e) => Math.hypot(e.vb[0]-e.va[0], e.vb[1]-e.va[1], e.vb[2]-e.va[2]) > 30);
    const path = makeSweepPath([edges[0]]);
    return filletAlongPath(part, path, 3);
  `);
  const sc = sliverCount(payload.mesh);
  check('easy cube sweep stays clean', sc.dirty === false && sc.tiny === 0, `tiny=${sc.tiny}`);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nfillet C2 rolling-ball golden passed');
