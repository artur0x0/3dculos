/**
 * Loft edge pick — circle↔square must not select tessellation spaghetti.
 *
 * Default loft (circle r=5 → rectangle 20×12) used to tangent-walk ~160–230
 * shallow wall seams. Pick candidates are coherent silhouette chains:
 * rectangle sides, corner generators, and the round rim, each a few–dozen
 * segments at most. A chain over the cap is refused.
 */
import { register } from 'node:module';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  toggleEdgeSelectionPropagated,
  COHERENT_EDGE_MAX,
  edgeDihedralDeg,
} from '../../src/utils/selectEdge.js';
import {
  indexBoundaryEdges,
  annotateFeatureEdges,
} from '../../src/utils/boundaryEdgeIds.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('loft edge pick — chain cap');
check('coherent cap is human-scale', COHERENT_EDGE_MAX <= 36 && COHERENT_EDGE_MAX >= 16);

{
  const dup = [];
  for (let i = 0; i < 160; i++) {
    const z0 = (i % 40) * 0.5;
    const z1 = z0 + 0.5;
    dup.push({
      key: `d-${i}`,
      a: i,
      b: i + 1,
      va: [0, 0, z0],
      vb: [0, 0, z1],
      mid: [0, 0, (z0 + z1) / 2],
      length: 0.5,
      tangent: [0, 0, 1],
      n0: [1, 0, 0],
      n1: [0, 1, 0],
    });
  }
  const collapsed = buildCoherentEdges(dup);
  const chains = new Set(collapsed.map((e) => e.chainId));
  check('160 collinear copies collapse to one chain', chains.size === 1, `chains=${chains.size} segs=${collapsed.length}`);
  check('collapsed side is a single segment', collapsed.length === 1, `n=${collapsed.length}`);

  const flood = [];
  for (let i = 0; i < 48; i++) {
    flood.push({
      key: `f-${i}`,
      a: i,
      b: i + 1,
      va: [i * 0.4, 0, 0],
      vb: [(i + 1) * 0.4, 0, 0],
      mid: [(i + 0.5) * 0.4, 0, 0],
      length: 0.4,
      tangent: [1, 0, 0],
      n0: [0, 0, 1],
      n1: [0, 1, 0],
    });
  }
  const refused = toggleEdgeSelectionPropagated([], flood[0], {
    propagate: true,
    featureEdges: flood,
  });
  check('tangent flood over the cap falls back to the seed', refused.length === 1, `n=${refused.length}`);
}

console.log('loft edge pick — circle↔square geometry');

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

function chainsOf(edges) {
  const by = new Map();
  for (const e of edges) {
    if (!by.has(e.chainId)) by.set(e.chainId, []);
    by.get(e.chainId).push(e);
  }
  return [...by.values()];
}

const LOFT = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
return placeInFrame(fr, makeLoft([xs0, xs1]));
`;

{
  const payload = await exec(LOFT);
  const g = geomOf(payload.mesh);
  const raw = buildFeatureEdges(g);
  const topo = indexBoundaryEdges({
    positions: g.attributes.position.array,
    indices: g.index.array,
    faceIDs: payload.mesh.faceID,
  });
  const coherent = buildCoherentEdges(annotateFeatureEdges(raw, topo));
  const chains = chainsOf(coherent);
  const worst = chains.reduce((m, c) => Math.max(m, c.length), 0);
  check('raw loft feature edges are a mesh dump', raw.length > 200, `raw=${raw.length}`);
  check('coherent set is not that dump', coherent.length < 80, `n=${coherent.length}`);
  check('circle↔square chains stay few–dozen', chains.length >= 4 && chains.length <= 16, `chains=${chains.length}`);
  check('no chain exceeds the cap', worst <= COHERENT_EDGE_MAX && worst <= 24, `worst=${worst}`);
  check('shallow seams are not pickable', coherent.every((e) => edgeDihedralDeg(e) >= 14), 'a shallow edge slipped in');

  const side = chains.find((c) => c.every((e) => Math.abs(e.tangent[2]) > 0.8));
  check('a loft side generator is one segment', side && side.length === 1, side ? `n=${side.length}` : 'missing');
  if (side) {
    const picked = toggleEdgeSelectionPropagated([], side[0], {
      propagate: true,
      featureEdges: coherent,
    });
    check('tangent-on side generator does not explode', picked.length === 1, `n=${picked.length}`);
  }
  const rim = chains.find((c) => c.length > 4);
  check('round rim is one chain under two dozen', rim && rim.length <= 24, rim ? `n=${rim.length}` : 'missing');
  if (rim) {
    const picked = toggleEdgeSelectionPropagated([], rim[0], {
      propagate: true,
      featureEdges: coherent,
    });
    check('tangent-on rim stays the rim', picked.length === rim.length && picked.length <= 24, `n=${picked.length}`);
  }
}

{
  const cube = await exec('return Manifold.cube([40, 30, 20], true);');
  const g = geomOf(cube.mesh);
  const raw = buildFeatureEdges(g);
  const topo = indexBoundaryEdges({
    positions: g.attributes.position.array,
    indices: g.index.array,
    faceIDs: cube.mesh.faceID,
  });
  const coherent = buildCoherentEdges(annotateFeatureEdges(raw, topo));
  check('cube still 12 edges', coherent.length === 12, `n=${coherent.length}`);
  check('cube edges keep boundary ids', coherent.every((e) => Number.isFinite(e.boundaryId)));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nloft edge pick golden passed');
