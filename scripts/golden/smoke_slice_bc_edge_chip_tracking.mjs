#!/usr/bin/env node
/**
 * Slice B+C — edge chip tracking + fillet path fidelity.
 *
 * Artur shot (fillet-unsmooth-edge-chips.png): after Tangent edge pick + fillet,
 * (1) selection chips floated mid-air (RDP chord midpoints inside the curve),
 * (2) fillet corner was faceted/wedge-y (makeSweepPath used those same chords).
 *
 * Fix:
 *  - coherent edges keep pre-RDP `pts`; `mid` is arc-length track on that polyline
 *  - copyPickEdge / _copyEdge preserve pts through Tangent-on
 *  - assembleSweepPath expands pts + smoothPathCorners rounds RDP-scale joints
 */
import { register } from 'node:module';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  edgeTrackPoint,
  edgePolyline,
  edgeChordFloatError,
  toggleEdgeSelectionPropagated,
} from '../../src/utils/selectEdge.js';
import { annotateFeatureEdges, indexBoundaryEdges } from '../../src/utils/boundaryEdgeIds.js';
import { assembleSweepPath } from '../../src/utils/edgeSweepPath.js';

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

async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}

function geomOf(mesh) {
  const np = mesh.numProp || 3;
  const src = mesh.vertProperties;
  const nVert = Math.floor(src.length / np);
  const positions = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    positions[i * 3] = src[i * np];
    positions[i * 3 + 1] = src[i * np + 1];
    positions[i * 3 + 2] = src[i * np + 2];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  return g;
}

function coherentOf(payload) {
  const g = geomOf(payload.mesh);
  const topo = indexBoundaryEdges({
    positions: g.attributes.position.array,
    indices: g.index.array,
    faceIDs: payload.mesh.faceID,
  });
  return buildCoherentEdges(annotateFeatureEdges(buildFeatureEdges(g), topo));
}

function worstPathTurn(pts, closed) {
  const n = pts.length;
  if (n < 3) return 0;
  let worst = 0;
  const count = closed ? n : n - 2;
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const c = pts[(i + 2) % n];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const lab = Math.hypot(...ab) || 1;
    const lbc = Math.hypot(...bc) || 1;
    const dot = (ab[0] * bc[0] + ab[1] * bc[1] + ab[2] * bc[2]) / (lab * lbc);
    const turn = Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
    if (turn > worst) worst = turn;
  }
  return worst;
}

function distPointToSeg(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 1e-18 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby), p[2] - (a[2] + t * abz));
}

function distPointToPoly(p, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    best = Math.min(best, distPointToSeg(p, poly[i - 1], poly[i]));
  }
  return best;
}

console.log('Slice B+C — edge chip tracking + path fidelity');

// --- A. Post-fillet cube: RDP chords skip arc verts → pts denser than 2 ---
const filleted = await exec(`
let part = Manifold.cube([40, 30, 20], true);
part = filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 4);
return part;
`);
const cohFillet = coherentOf(filleted);
const withPts = cohFillet.filter((e) => Array.isArray(e.pts) && e.pts.length >= 3);
check(
  'post-fillet arcs keep pre-RDP pts (≥3)',
  withPts.length >= 4,
  `dense=${withPts.length} / ${cohFillet.length}`,
);

let maxFloat = 0;
let maxTrackToPoly = 0;
for (const e of withPts) {
  maxFloat = Math.max(maxFloat, edgeChordFloatError(e));
  const track = edgeTrackPoint(e);
  const poly = edgePolyline(e);
  if (track && poly) maxTrackToPoly = Math.max(maxTrackToPoly, distPointToPoly(track, poly));
}
check(
  'RDP chord mid floats inside arcs (chip float root cause)',
  maxFloat > 0.03,
  `maxChordFloat=${maxFloat.toFixed(3)}`,
);
check(
  'chip track point sits on the dense edge polyline',
  maxTrackToPoly < 1e-6,
  `maxTrackErr=${maxTrackToPoly.toExponential(2)}`,
);

// Picked edges must still carry pts after Tangent-on (copyPickEdge).
const arcSeed = withPts.sort((a, b) => b.length - a.length)[0];
const pickedArc = toggleEdgeSelectionPropagated([], arcSeed, {
  propagate: true,
  featureEdges: cohFillet,
});
const pickedDense = pickedArc.filter((e) => Array.isArray(e.pts) && e.pts.length >= 3);
check(
  'Tangent-on copyPickEdge preserves dense pts',
  pickedDense.length >= 1,
  `pickedDense=${pickedDense.length} / ${pickedArc.length}`,
);

// --- B. roundedBox Tangent wrap: path must not keep 100°+ RDP corners ---
const rbox = await exec('return roundedBox([50, 30, 20], 4, 16);');
const cohBox = coherentOf(rbox);
check('roundedBox yields a coherent pick graph', cohBox.length >= 8, `n=${cohBox.length}`);

const topZ = Math.max(...cohBox.map((e) => e.mid[2]));
const seed = cohBox
  .filter((e) => Math.abs(e.mid[2] - topZ) < 0.5)
  .sort((a, b) => b.length - a.length)[0];
check('found a top-rim seed', !!seed);

let picked = [];
if (seed) {
  picked = toggleEdgeSelectionPropagated([], seed, {
    propagate: true,
    featureEdges: cohBox,
  });
  check('Tangent-on wraps a multi-edge chain', picked.length >= 4, `n=${picked.length}`);
}

const raw = assembleSweepPath(picked, { smoothCorners: false });
const smoothed = assembleSweepPath(picked);
check('assembleSweepPath succeeds on the wrap', smoothed.ok === true, smoothed.message || '');

if (raw.ok && smoothed.ok) {
  const rawWorst = worstPathTurn(raw.value.points, raw.value.closed);
  const smWorst = worstPathTurn(smoothed.value.points, smoothed.value.closed);
  check(
    'raw RDP path still has sharp corner spikes (baseline)',
    rawWorst > 40,
    `rawWorst=${rawWorst.toFixed(1)}°`,
  );
  check(
    'smoothPathCorners removes RDP-scale spikes (≤35°)',
    smWorst <= 35,
    `smoothedWorst=${smWorst.toFixed(1)}° pts=${smoothed.value.points.length}`,
  );
  check(
    'smoothed path is denser than raw chords',
    smoothed.value.points.length > raw.value.points.length,
    `smooth=${smoothed.value.points.length} raw=${raw.value.points.length}`,
  );
}

// --- C. Regression: plain cube ---
const cubePay = await exec('return Manifold.cube([40, 30, 20], true);');
const cubeCoh = buildCoherentEdges(buildFeatureEdges(geomOf(cubePay.mesh)));
check('plain cube still 12 coherent edges', cubeCoh.length === 12, `n=${cubeCoh.length}`);
const cubeDense = cubeCoh.filter((e) => Array.isArray(e.pts) && e.pts.length > 2);
check('straight cube sides do not invent fake arc pts', cubeDense.length === 0, `n=${cubeDense.length}`);

const cubePath = assembleSweepPath(cubeCoh.slice(0, 1));
check('single cube edge path still ok', cubePath.ok === true);

if (failed) {
  console.error(`\n${failed} Slice B+C check(s) failed.`);
  process.exit(1);
}
console.log('\nAll Slice B+C edge-chip / path-fidelity checks passed.');
