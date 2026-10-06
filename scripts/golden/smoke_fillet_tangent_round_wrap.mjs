#!/usr/bin/env node
/**
 * Fillet Tangent-on must wrap the round — Artur's mobile CAD report.
 *
 *   let box1 = Manifold.cube([40, 30, 20], true);
 *   const selEdges = edgesBetween(part, 3, 5);
 *   part = filletAlongPath(part, makeSweepPath(selEdges), 4);
 *
 * Tapping the vertical end-face edge with Tangent on selected 2 edges: it ran
 * up the straight edge, entered the blend, and died one chord into the round.
 *
 * Root cause was NOT the G1 walk — it was the coherent-chain simplifier
 * upstream of it. RDP is a distance test, so it is scale-blind on a tight arc:
 * an r=4 quarter-round sits only ~0.30 mm off its own 45° chord, inside
 * CHAIN_SIMPLIFY_EPS (0.35), so a 24-segment blend end-cap collapsed to TWO
 * chords turning 45° each. That broke Tangent-on twice over — the highlight
 * was a 2-chord polyline rather than a curve, and 45° blows past
 * TANGENT_PROP_DEG (25°), so the walk could not continue around the arc.
 *
 * CHAIN_MAX_TURN_DEG caps the angular span of a kept chord, so arcs stay
 * G1-walkable by construction while straight runs still collapse to one
 * segment. This golden pins the behaviour the user asked for: contour the
 * edge all the way around the tangency, and stop at the sharp corner.
 */
import { register } from 'node:module';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  toggleEdgeSelectionPropagated,
  TANGENT_PROP_DEG,
} from '../../src/utils/selectEdge.js';
import { annotateFeatureEdges, indexBoundaryEdges } from '../../src/utils/boundaryEdgeIds.js';

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

async function coherentOf(script) {
  const p = await exec(script);
  const g = geomOf(p.mesh);
  const topo = indexBoundaryEdges({
    positions: g.attributes.position.array,
    indices: g.index.array,
    faceIDs: p.mesh.faceID,
  });
  return buildCoherentEdges(annotateFeatureEdges(buildFeatureEdges(g), topo));
}

console.log('fillet Tangent-on wraps the round (Artur mobile CAD)');

// cube 40×30×20 centred, fillet r=4 on the y=+15 / z=+10 edge.
// End cap x=+20 carries a quarter arc centred (y=11, z=6).
const SCRIPT = `
let box1 = Manifold.cube([40, 30, 20], true);
let part = box1;
const selEdges = edgesBetween(part, 3, 5);
const path = makeSweepPath(selEdges);
part = filletAlongPath(part, path, 4);
return part;
`;

const coherent = await coherentOf(SCRIPT);
const onCap = (e) => Math.abs(e.va[0] - 20) < 0.02 && Math.abs(e.vb[0] - 20) < 0.02;
const isArc = (e) => onCap(e) && Math.abs(e.tangent[1]) > 0.05 && Math.abs(e.tangent[2]) > 0.05;

const arc = coherent.filter(isArc);
check('blend end-cap arc survives into the pick graph', arc.length >= 3, `n=${arc.length}`);

// The curve must be tracked, not chorded flat: every kept chord stays under the
// walk tolerance, so a G1 walk can cross it. 45° chords were the bug.
const _cosTol = Math.cos((TANGENT_PROP_DEG * Math.PI) / 180);
const turns = [];
for (const a of arc) {
  for (const b of arc) {
    if (a.key === b.key) continue;
    // consecutive iff they share an endpoint position
    const share = [[a.va, b.va], [a.va, b.vb], [a.vb, b.va], [a.vb, b.vb]]
      .some(([p, q]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6);
    if (!share) continue;
    const d = Math.abs(
      a.tangent[0] * b.tangent[0] + a.tangent[1] * b.tangent[1] + a.tangent[2] * b.tangent[2],
    );
    turns.push(Math.acos(Math.min(1, d)) * 180 / Math.PI);
  }
}
const worstTurn = turns.length ? Math.max(...turns) : 0;
check(
  'no arc chord turns past the G1 walk tolerance',
  turns.length > 0 && Math.max(...turns) <= TANGENT_PROP_DEG,
  `worst=${worstTurn.toFixed(1)}° tol=${TANGENT_PROP_DEG}°`,
);

// Seed: the straight vertical edge on the end cap at y=+15 that Artur tapped.
const seed = coherent
  .filter((e) => onCap(e) && Math.abs(e.tangent[2]) > 0.9 && Math.abs(e.mid[1] - 15) < 0.5)
  .sort((a, b) => b.length - a.length)[0];
check('found the tapped vertical edge', !!seed, 'missing');

if (seed) {
  const picked = toggleEdgeSelectionPropagated([], seed, {
    propagate: true,
    featureEdges: coherent,
  });
  const keys = new Set(picked.map((e) => e.key));

  check(
    'Tangent-on no longer stops one chord into the round',
    picked.length > 2,
    `n=${picked.length}`,
  );
  check(
    'the whole arc is selected, not half of it',
    arc.every((e) => keys.has(e.key)),
    `${arc.filter((e) => keys.has(e.key)).length}/${arc.length} arc chords`,
  );

  // Past the round the blend runs tangent into the top face, so the chain
  // continues onto that straight edge — then must stop at the sharp corner.
  const topEdge = coherent.find((e) => onCap(e)
    && Math.abs(e.tangent[1]) > 0.9 && Math.abs(e.mid[2] - 10) < 0.02);
  check('chain continues onto the tangent top edge', topEdge && keys.has(topEdge.key),
    topEdge ? 'top edge not selected' : 'top edge missing');

  // The far vertical edge (y=-15) meets the top edge at a 90° sharp corner.
  const farVert = coherent.find((e) => onCap(e)
    && Math.abs(e.tangent[2]) > 0.9 && Math.abs(e.mid[1] + 15) < 0.5);
  check('chain stops at the sharp corner', farVert && !keys.has(farVert.key),
    farVert ? 'walked through a 90° corner' : 'far vertical missing');

  // Bottom face outline is across another sharp corner too.
  const bottom = coherent.filter((e) => Math.abs(e.mid[2] + 10) < 0.02);
  check('chain does not leak onto the bottom outline',
    bottom.every((e) => !keys.has(e.key)), `${bottom.filter((e) => keys.has(e.key)).length} leaked`);
}

// The turn cap must not stop straight runs collapsing: a plain cube is 12 edges.
const cube = await coherentOf('return Manifold.cube([40, 30, 20], true);');
check('plain cube still collapses to 12 single-segment edges', cube.length === 12, `n=${cube.length}`);

if (failed) {
  console.error(`\n${failed} fillet tangent round-wrap check(s) failed.`);
  process.exit(1);
}
console.log('\nAll fillet Tangent-on round-wrap checks passed.');
