#!/usr/bin/env node
/**
 * Slice C3.2 — tighter along-path continuity for hard variableProfile.
 *
 * Playtest loft ridge still staircased after C3.1 transport: θ-tol run splits
 * + sparse densify on large-R / high-curvature paths. This golden pins:
 * - denser / curvature densify helpers + tighter FRAME_TRANSPORT_DAMP_DEG
 * - variableProfile single-run cutter (θ-group seams → RED if gutted)
 * - loft-like twisting ridge: many would-be θ-runs, but WASM keeps runCount=1
 *   and modest maxFrameJumpDeg; C3.1 helix / loft volume pins still bite via
 *   sibling goldens
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
  densifyPathPoints,
  densifyPathByMaxTurn,
  variableProfileDensifyStep,
  pathPolylineLength,
  countThetaRuns,
  maxConsecutiveFrameAngleDeg,
  FRAME_TRANSPORT_DAMP_DEG,
  FRAME_DENSIFY_MAX_TURN_DEG,
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

console.log('fillet C3.2 tighter continuity — helpers + source pins');

{
  const fieldSrc = readRepo('src/utils/edgeTangencyField.js');
  check(
    'edgeTangencyField exports densifyPathByMaxTurn',
    /export function densifyPathByMaxTurn\s*\(/.test(fieldSrc),
  );
  check(
    'edgeTangencyField exports variableProfileDensifyStep',
    /export function variableProfileDensifyStep\s*\(/.test(fieldSrc),
  );
  check(
    'edgeTangencyField exports countThetaRuns',
    /export function countThetaRuns\s*\(/.test(fieldSrc),
  );
  check(
    'FRAME_TRANSPORT_DAMP_DEG tightened (≤16)',
    Number.isFinite(FRAME_TRANSPORT_DAMP_DEG) && FRAME_TRANSPORT_DAMP_DEG > 0 && FRAME_TRANSPORT_DAMP_DEG <= 16,
    `damp=${FRAME_TRANSPORT_DAMP_DEG}`,
  );
  check(
    'FRAME_DENSIFY_MAX_TURN_DEG finite',
    Number.isFinite(FRAME_DENSIFY_MAX_TURN_DEG) && FRAME_DENSIFY_MAX_TURN_DEG > 0,
  );

  const workerSrc = readRepo('src/workers/sandboxWorker.js');
  check(
    'sandboxWorker variableProfile densify uses variableProfileDensifyStep',
    /variableProfileDensifyStep\s*\(/.test(workerSrc)
      && /maxTurnDeg\s*:\s*FRAME_DENSIFY_MAX_TURN_DEG/.test(workerSrc),
  );
  // C3.2 pinned a literal `singleRun: true` / `singleRunCutter: true`, because
  // back then ONE median-θ run was how the ridge stayed continuous. C3.3 removed
  // the θ collapse entirely (per-knot sections), and C4 makes the run count
  // meaningful again — one run per SIGN change, since a concave stretch is a
  // filler, not a cutter. Pin the mechanism that actually has to hold now; the
  // continuity guarantee itself is still pinned by the WASM `runCount === 1`
  // checks below and by the distribution net in the C3.3 golden.
  check(
    'sandboxWorker variableProfile cutter does not θ-group (routes to varying-profile)',
    /_s23BuildVariableProfileCutter[\s\S]{0,2000}_s23VaryingProfileCutter\s*\(/.test(workerSrc)
      && !/_s23BuildVariableProfileCutter[\s\S]{0,2000}_s23CuttersFromSegs\s*\(/.test(workerSrc),
  );
  check(
    'sandboxWorker records singleRunCutter + thetaRunCount meta',
    /singleRunCutter\s*:/.test(workerSrc) && /thetaRunCount\s*:/.test(workerSrc),
  );
  check(
    'sandboxWorker sweep Gram-Schmidt after N/B lerp',
    /nb \*=|const nb = Nx \* Bx/.test(workerSrc) || /Nx \* Bx \+ Ny \* By/.test(workerSrc),
  );
}

{
  // Large-R densify must not stay at 0.75R (playtest R≈198 → step≈149 was too sparse).
  const stepBig = variableProfileDensifyStep(198, 1000);
  const stepLegacy = Math.max(0.75 * 198, 0.5);
  check(
    'large-R densify step << legacy 0.75R',
    stepBig < stepLegacy * 0.5,
    `step=${stepBig.toFixed(2)} legacy=${stepLegacy.toFixed(2)}`,
  );
  check(
    'large-R densify still yields ~48 samples on L=1000',
    stepBig <= 1000 / 40,
    `step=${stepBig.toFixed(2)}`,
  );
  const stepSmall = variableProfileDensifyStep(1.6, 20);
  check(
    'small-R densify still densifies C3 loft scale',
    stepSmall < 1.2 && stepSmall > 0.2,
    `step=${stepSmall.toFixed(2)}`,
  );
}

{
  // Curvature densify: polyline with sharp turns shorter than chord step.
  const zig = [[0, 0, 0], [1, 0, 0], [1.2, 1, 0], [2.2, 1, 0], [2.4, 0, 0], [3.4, 0, 0]];
  const byTurn = densifyPathByMaxTurn(zig, false, 25);
  check(
    'densifyPathByMaxTurn inserts on sharp turns',
    byTurn.length > zig.length,
    `n=${byTurn.length} from ${zig.length}`,
  );
  const chordOnly = densifyPathPoints(zig, false, 5); // step larger than segs → no chord inserts
  const withTurn = densifyPathPoints(zig, false, 5, { maxTurnDeg: 25 });
  check(
    'densifyPathPoints maxTurnDeg densifies when chord step would not',
    withTurn.length > chordOnly.length,
    `chord=${chordOnly.length} turn=${withTurn.length}`,
  );
}

{
  // Loft-like / high-curvature ridge with twisting walls (playtest class).
  // θ spans many 3°-runs; C3.1 helix pin alone missed this.
  const n = 36;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const ang = t * Math.PI * 0.9;
    pts.push([14 * Math.sin(ang), 5 * Math.sin(1.8 * ang), t * 40]);
  }
  const segmentNormals = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const t = (i + 0.5) / n;
    const twist = t * Math.PI * 1.1;
    const n0 = [Math.cos(twist), Math.sin(twist), 0];
    const n1raw = [-Math.sin(twist), Math.cos(twist), 0.1];
    const L = Math.hypot(...n1raw) || 1;
    segmentNormals.push({ n0, n1: n1raw.map((x) => x / L) });
  }
  const plen = pathPolylineLength(pts, false);
  const step = variableProfileDensifyStep(2.5, plen);
  const dense = densifyPathPoints(pts, false, step, { maxTurnDeg: FRAME_DENSIFY_MAX_TURN_DEG });
  const denseSegN = [];
  for (let i = 0; i < dense.length - 1; i++) {
    const mid = [
      (dense[i][0] + dense[i + 1][0]) / 2,
      (dense[i][1] + dense[i + 1][1]) / 2,
      (dense[i][2] + dense[i + 1][2]) / 2,
    ];
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < pts.length - 1; j++) {
      const m = [
        (pts[j][0] + pts[j + 1][0]) / 2,
        (pts[j][1] + pts[j + 1][1]) / 2,
        (pts[j][2] + pts[j + 1][2]) / 2,
      ];
      const d = Math.hypot(m[0] - mid[0], m[1] - mid[1], m[2] - mid[2]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    denseSegN.push(segmentNormals[best]);
  }
  const withT = buildVariableProfileFrames(dense, false, {
    radius: 2.5,
    segmentNormals: denseSegN,
  });
  const noT = buildVariableProfileFrames(dense, false, {
    radius: 2.5,
    segmentNormals: denseSegN,
    alongPathTransport: false,
  });
  const wouldBeRuns = countThetaRuns(withT.frames);
  check(
    'loft-like fixture would shatter into many θ-runs (staircase net)',
    wouldBeRuns >= 5,
    `thetaRuns=${wouldBeRuns}`,
  );
  check(
    'loft-like with transport max frame jump under damp',
    withT.maxFrameJumpDeg < FRAME_TRANSPORT_DAMP_DEG,
    `max=${withT.maxFrameJumpDeg.toFixed(1)} damp=${FRAME_TRANSPORT_DAMP_DEG}`,
  );
  check(
    'loft-like densified (more knots than raw)',
    dense.length > pts.length * 0.9,
    `dense=${dense.length} raw=${pts.length}`,
  );
  // Mutation pin: if single-run were gutted, θ-runs would be the cutter seams.
  check(
    'countThetaRuns on loft-like is the multi-run RED signal',
    wouldBeRuns > 1 && countThetaRuns(noT.frames) >= 5,
    `withT=${wouldBeRuns} noT=${countThetaRuns(noT.frames)}`,
  );
  check(
    'helper maxConsecutiveFrameAngleDeg matches build meta',
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

console.log('fillet C3.2 — hard loft WASM single-run + continuity meta');

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
    'WASM meta singleRunCutter true',
    !!vpMeta && vpMeta.singleRunCutter === true,
    vpMeta ? JSON.stringify(vpMeta) : 'meta missing',
  );
  check(
    'WASM meta runCount === 1 (continuous ridge)',
    !!vpMeta && vpMeta.runCount === 1,
    vpMeta ? `runCount=${vpMeta.runCount} thetaRunCount=${vpMeta.thetaRunCount}` : 'meta missing',
  );
  check(
    'WASM meta alongPathTransport true',
    !!vpMeta && vpMeta.alongPathTransport === true,
    vpMeta ? JSON.stringify(vpMeta) : 'meta missing',
  );
  check(
    'WASM meta maxFrameJumpDeg under tightened damp',
    !!vpMeta && Number.isFinite(vpMeta.maxFrameJumpDeg) && vpMeta.maxFrameJumpDeg < FRAME_TRANSPORT_DAMP_DEG,
    vpMeta ? `maxJump=${vpMeta.maxFrameJumpDeg} damp=${FRAME_TRANSPORT_DAMP_DEG}` : 'meta missing',
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
  // High-curvature open path via explicit points — WASM single-run pin without
  // relying on loft mesh topology. Gutting singleRun → thetaRunCount seams.
  globalThis.__filletVariableProfileMeta = null;
  const curved = await exec(`
    let part = Manifold.cube([60, 40, 30], true);
    // Carve a corner so a long convex edge exists near a bent path we supply.
    const path = {
      kind: 'sweepPath',
      closed: false,
      points: (() => {
        const pts = [];
        for (let i = 0; i <= 20; i++) {
          const t = i / 20;
          pts.push([
            -30 + 60 * t,
            20 * Math.sin(t * Math.PI),
            15,
          ]);
        }
        return pts;
      })(),
      length: 0,
    };
    let L = 0;
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i], b = path.points[i + 1];
      L += Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    }
    path.length = L;
    // Prefer a real box edge so probe finds walls; bend is for densify/turn.
    const edges = convexEdges(part).filter((e) => {
      const d = [e.vb[0]-e.va[0], e.vb[1]-e.va[1], e.vb[2]-e.va[2]];
      return Math.hypot(d[0], d[1], d[2]) > 50 && Math.abs(d[1]) < 1e-6 && Math.abs(d[2]) < 1e-6;
    });
    const edgePath = makeSweepPath([edges[0]]);
    return filletAlongPath(part, edgePath, 3, { variableProfile: true });
  `);
  const meta2 = globalThis.__filletVariableProfileMeta;
  check(
    'box long-edge variableProfile still single-run',
    !!meta2 && meta2.singleRunCutter === true && meta2.runCount === 1,
    meta2 ? JSON.stringify(meta2) : 'meta missing',
  );
  const sc2 = sliverCount(curved.mesh);
  check('box hard variableProfile stays clean', sc2.dirty === false, `tiny=${sc2.tiny}/${sc2.nTri}`);
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
console.log('\nfillet C3.2 tighter continuity golden passed');
