#!/usr/bin/env node
/**
 * Slice C3.1 — along-path tangency / smooth frame transport for hard variableProfile.
 *
 * Asserts:
 * - transport helpers exported + wired into buildVariableProfileFrames
 * - noisy / flipped wall normals: with transport max consecutive frame angle is small;
 *   gutting transport (alongPathTransport:false) → large jumps (RED pin)
 * - existing C3 hard loft Accept still emits variableProfile and WASM meta pins
 *   alongPathTransport + modest maxFrameJumpDeg
 * - C3 volume / scrap pins still bite on the loft fixture
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
} from '../../src/utils/selectEdge.js';
import {
  annotateFeatureEdges,
  indexBoundaryEdges,
} from '../../src/utils/boundaryEdgeIds.js';
import {
  buildVariableProfileFrames,
  transportVariableProfileFrames,
  parallelTransportNormal,
  maxConsecutiveFrameAngleDeg,
  FRAME_TRANSPORT_DAMP_DEG,
} from '../../src/utils/edgeTangencyField.js';
import { classifyFilletEdges, countDegenerateTriangles } from '../../src/utils/filletEdgeClass.js';
import { composeFilletCommit } from '../../src/utils/filletMode.js';
import { isFilletSliverDirty } from '../../src/utils/filletSliverGuard.js';

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

console.log('fillet C3.1 along-path tangency / frame transport');

{
  const fieldSrc = readRepo('src/utils/edgeTangencyField.js');
  check(
    'edgeTangencyField exports transportVariableProfileFrames',
    /export function transportVariableProfileFrames\s*\(/.test(fieldSrc),
  );
  check(
    'edgeTangencyField exports parallelTransportNormal',
    /export function parallelTransportNormal\s*\(/.test(fieldSrc),
  );
  check(
    'edgeTangencyField exports maxConsecutiveFrameAngleDeg',
    /export function maxConsecutiveFrameAngleDeg\s*\(/.test(fieldSrc),
  );
  check(
    'buildVariableProfileFrames calls transport by default',
    /alongPathTransport\s*!==\s*false/.test(fieldSrc)
      && /transportVariableProfileFrames\s*\(/.test(fieldSrc),
  );
  const workerSrc = readRepo('src/workers/sandboxWorker.js');
  check(
    'sandboxWorker records alongPathTransport meta',
    /alongPathTransport\s*:/.test(workerSrc) && /maxFrameJumpDeg/.test(workerSrc),
  );
  check(
    // f29fad2 replaced the warp-time N/B lerp between frames with one cutter
    // ring per densified knot, each placed from that knot's own frame. Ridge
    // continuity now comes from the 5° knot density + along-path transport,
    // not from interpolating between knots.
    'sandboxWorker sweep places one ring per knot from its own frame (ridge continuity)',
    /function _s23SweepKnotRings\(points, frames, contour\)/.test(workerSrc)
      && /_s23PlaceContourRing\(contour, points\[i\], fr\.N, fr\.B\)/.test(workerSrc)
      && /frames\.length !== nSeg/.test(workerSrc),
  );
  check('FRAME_TRANSPORT_DAMP_DEG is finite', Number.isFinite(FRAME_TRANSPORT_DAMP_DEG) && FRAME_TRANSPORT_DAMP_DEG > 0);
}

{
  // Unit: double-reflection keeps N ⊥ nextT and continuous for a small turn.
  const prevT = [1, 0, 0];
  const prevN = [0, 1, 0];
  const nextT = [Math.cos(0.2), 0, Math.sin(0.2)];
  const Nt = parallelTransportNormal(prevT, prevN, nextT, [1, 0, 0.2]);
  const dotT = Nt[0] * nextT[0] + Nt[1] * nextT[1] + Nt[2] * nextT[2];
  check('parallelTransportNormal stays ⊥ nextT', Math.abs(dotT) < 1e-9, `dot=${dotT}`);
  check('parallelTransportNormal stays near prevN', Nt[1] > 0.9, `N=${Nt}`);
}

{
  // Curved path + flipped wall normals every 3rd knot (tessellation-style noise).
  // Without transport → ~175° staircase; with transport → smooth.
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * Math.PI;
    pts.push([8 * Math.cos(t), 8 * Math.sin(t), i * 0.8]);
  }
  const segmentNormals = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const t = (i / 24) * Math.PI;
    const radial = [Math.cos(t), Math.sin(t), 0];
    const up = [0, 0, 1];
    const flip = (i % 3 === 2);
    segmentNormals.push({
      n0: flip ? radial.map((x) => -x) : radial,
      n1: flip ? up.map((x) => -x) : up,
    });
  }
  const withT = buildVariableProfileFrames(pts, false, { radius: 1.6, segmentNormals });
  const noT = buildVariableProfileFrames(pts, false, {
    radius: 1.6,
    segmentNormals,
    alongPathTransport: false,
  });
  check('default transport flag true', withT.transported === true);
  check('gutted transport flag false', noT.transported === false);
  check(
    'with transport max frame jump is modest',
    withT.maxFrameJumpDeg < FRAME_TRANSPORT_DAMP_DEG,
    `max=${withT.maxFrameJumpDeg.toFixed(1)} damp=${FRAME_TRANSPORT_DAMP_DEG}`,
  );
  check(
    'gutted transport max frame jump is large (staircase pin)',
    noT.maxFrameJumpDeg > 90,
    `max=${noT.maxFrameJumpDeg.toFixed(1)}`,
  );
  // Mutation pin: dropping transportVariableProfileFrames identity-pass → RED.
  const rawOnly = transportVariableProfileFrames === undefined
    ? noT.frames
    : (() => {
      // Simulate gut: identity "transport" that returns raw frames unchanged.
      const identity = (frames) => frames.map((f) => ({ ...f, transported: false }));
      const gutted = identity(noT.frames);
      return gutted;
    })();
  const guttedMax = maxConsecutiveFrameAngleDeg(rawOnly);
  check(
    'identity/gut transport keeps staircase (mutation RED net)',
    guttedMax > 90,
    `max=${guttedMax.toFixed(1)}`,
  );
  check(
    'helper maxConsecutiveFrameAngleDeg matches build meta (transport on)',
    Math.abs(maxConsecutiveFrameAngleDeg(withT.frames) - withT.maxFrameJumpDeg) < 1e-9,
  );
}

register('./manifold-resolve-hook.mjs', import.meta.url);

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
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}
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

console.log('fillet C3.1 — hard loft variableProfile WASM + transport meta');

{
  const LOFT = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
return placeInFrame(fr, makeLoft([xs0, xs1]));
`;
  const loft = await exec(LOFT);
  const g = geomOf(loft.mesh);
  const preDeg = countDegenerateTriangles(g);
  const raw = buildFeatureEdges(g);
  const topo = indexBoundaryEdges({
    positions: g.attributes.position.array,
    indices: g.index.array,
    faceIDs: loft.mesh.faceID,
  });
  const coherent = buildCoherentEdges(annotateFeatureEdges(raw, topo));
  const generators = coherent.filter((e) => Math.abs(e.tangent[2]) > 0.8 && e.length > 10);
  check('loft has generator', generators.length >= 1);
  const gen = generators.sort((a, b) => b.length - a.length)[0];
  const radius = 1.6;
  const klass = classifyFilletEdges([gen], { radius, geometry: g });
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
    geometry: g,
  });
  check('hard loft emits variableProfile', /variableProfile:\s*true/.test(commit.buffer || ''));

  let hardPayload = null;
  let hardErr = null;
  globalThis.__filletVariableProfileMeta = null;
  try {
    hardPayload = await exec(commit.buffer);
  } catch (e) {
    hardErr = e;
  }
  check('hard variable-profile exec succeeds', !!hardPayload && !hardErr, hardErr?.message || '');
  const vpMeta = globalThis.__filletVariableProfileMeta;
  check(
    'WASM meta alongPathTransport true',
    !!vpMeta && vpMeta.alongPathTransport === true,
    vpMeta ? JSON.stringify(vpMeta) : 'meta missing',
  );
  check(
    'WASM meta maxFrameJumpDeg modest (ridge smooth)',
    !!vpMeta && Number.isFinite(vpMeta.maxFrameJumpDeg) && vpMeta.maxFrameJumpDeg < FRAME_TRANSPORT_DAMP_DEG,
    vpMeta ? `maxJump=${vpMeta.maxFrameJumpDeg}` : 'meta missing',
  );
  check(
    'WASM meta still densified + strong frames',
    !!vpMeta && vpMeta.usedFrames === true && vpMeta.frameCount > vpMeta.rawSegCount && vpMeta.strongFrames >= 1,
    vpMeta ? JSON.stringify(vpMeta) : 'meta missing',
  );
  if (hardPayload?.mesh) {
    const sc = sliverCount(hardPayload.mesh);
    check('hard result not scrap-sheet dirty', sc.dirty === false, `tiny=${sc.tiny}/${sc.nTri}`);
    const postDeg = countDegenerateTriangles(geomOf(hardPayload.mesh));
    const introduced = postDeg - preDeg;
    const wouldBanner = introduced > Math.max(300, 0.1 * Math.max(preDeg, 1));
    check(
      'hard loft R=1.6 would not raise zero-area banner',
      wouldBanner === false,
      `pre=${preDeg} post=${postDeg} introduced=${introduced}`,
    );
    const baseVol = loft.volume;
    const hardVol = hardPayload.volume;
    const removed = (Number.isFinite(baseVol) && Number.isFinite(hardVol))
      ? (baseVol - hardVol)
      : NaN;
    check(
      'hard loft R=1.6 removes ~5 volume (C3 geometry pin stays)',
      Number.isFinite(removed) && removed > 3.5 && removed < 8,
      `base=${baseVol} hard=${hardVol} removed=${removed}`,
    );
  }
}

{
  const payload = await exec(`
    let part = Manifold.cube([40, 30, 20], true);
    const edges = convexEdges(part).filter((e) => Math.hypot(e.vb[0]-e.va[0], e.vb[1]-e.va[1], e.vb[2]-e.va[2]) > 30);
    const path = makeSweepPath([edges[0]]);
    return filletAlongPath(part, path, 3);
  `);
  const sc = sliverCount(payload.mesh);
  check('easy cube sweep stays clean (unchanged)', sc.dirty === false && sc.tiny === 0, `tiny=${sc.tiny}`);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nfillet C3.1 along-path tangency golden passed');
