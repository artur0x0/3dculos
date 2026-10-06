#!/usr/bin/env node
/**
 * Slice Mobile C.3 — HARD CR: Fillet Tangent-on on real roundedBox rim.
 *
 * #77 (skipNormals + TANGENT_PROP_FLOOD_MAX) fixed synthetic 64-gons but not the
 * mobile CAD path Artur hit: Edge pick · Tangent on · roundedBox top rim only
 * highlighted 1 segment. Root cause: coherent graph splits the rim into short
 * chainIds (RDP sides + leftover parallel creases); G1 walk stopped at ~74°
 * collapsed fillet corners, or over-flooded into verticals without a seed-plane
 * lock.
 *
 * This golden exercises the ACTUAL call site used by Viewport edge-pick:
 *   toggleEdgeSelectionPropagated(prev, edge, { propagate: true, featureEdges })
 * on coherent edges from a live roundedBox mesh (not a synthetic ring).
 */
import { register } from 'node:module';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  edgeKey,
  toggleEdgeSelectionPropagated,
  TANGENT_PROP_FLOOD_MAX,
} from '../../src/utils/selectEdge.js';
import { annotateFeatureEdges, indexBoundaryEdges } from '../../src/utils/boundaryEdgeIds.js';
import { preferredPlaneNormal, isTrueG1 } from '../../src/utils/edgeTangencyField.js';

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

function mid(e) {
  return [
    (e.va[0] + e.vb[0]) / 2,
    (e.va[1] + e.vb[1]) / 2,
    (e.va[2] + e.vb[2]) / 2,
  ];
}

function coherentOf(payload) {
  const g = geomOf(payload.mesh);
  const raw = annotateFeatureEdges(
    buildFeatureEdges(g),
    indexBoundaryEdges({
      positions: g.attributes.position.array,
      indices: g.index.array,
      faceIDs: payload.mesh.faceID,
    }),
  );
  return buildCoherentEdges(raw);
}

console.log('mobile C.3: roundedBox fillet Tangent-on (real CAD path)');

check(
  'preferredPlaneNormal exported for seed-plane lock',
  typeof preferredPlaneNormal === 'function',
);

{
  await import('../../src/workers/sandboxWorker.js');
  await send('init');
  const exec = async (script) => {
    return (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload;
  };

  const box = await exec('return roundedBox([50, 30, 20], 4, 16);');
  const edges = coherentOf(box);
  check('roundedBox yields coherent pick edges', edges.length >= 12, `n=${edges.length}`);

  const zMax = Math.max(...edges.map((e) => mid(e)[2]));
  const topOuter = edges.filter((e) => Math.abs(mid(e)[2] - zMax) < 0.5);
  check('top outer rim has ≥12 coherent segs', topOuter.length >= 12, `n=${topOuter.length}`);

  // Artur playtest seeds: long top-front crease AND the parallel lower leftover
  // (faces 4/9) that previously soft-failed to 1 selected with Tangent on.
  const longTop = topOuter.filter((e) => e.length > 15).sort((a, b) => b.length - a.length);
  check('found long top-rim seeds', longTop.length >= 2, `n=${longTop.length}`);

  // Immediate parallel crease under the top outer rim (fillet top/bottom pair),
  // not the next-lower blend ring (~zMax-2) which walks the front face instead.
  const lowerParallel = edges
    .filter((e) => {
      const z = mid(e)[2];
      return z < zMax - 0.5 && z > zMax - 1.5 && e.length > 15;
    })
    .sort((a, b) => b.length - a.length);

  for (const seed of longTop.slice(0, 4)) {
    const sel = toggleEdgeSelectionPropagated([], seed, {
      propagate: true,
      featureEdges: edges,
    });
    const topHit = sel.filter((e) => topOuter.some((t) => edgeKey(t) === edgeKey(e))).length;
    check(
      `Tangent-on top seed ${edgeKey(seed)} floods rim (≥12 top, <floodMax)`,
      topHit >= 12 && sel.length > 1 && sel.length <= TANGENT_PROP_FLOOD_MAX,
      `selected=${sel.length} topHit=${topHit}`,
    );
  }

  if (lowerParallel.length) {
    const seed = lowerParallel[0];
    const sel = toggleEdgeSelectionPropagated([], seed, {
      propagate: true,
      featureEdges: edges,
    });
    const topHit = sel.filter((e) => topOuter.some((t) => edgeKey(t) === edgeKey(e))).length;
    check(
      `Tangent-on parallel crease ${edgeKey(seed)} bridges to top rim`,
      topHit >= 12 && sel.length > 1 && sel.length <= TANGENT_PROP_FLOOD_MAX,
      `selected=${sel.length} topHit=${topHit}`,
    );
  } else {
    check('parallel lower crease present (skip if mesh differs)', false, 'none found');
  }

  // Sharp cube: Tangent-on must NOT flood the face outline.
  const cube = await exec('return Manifold.cube([40, 30, 20], true);');
  const cubeEdges = coherentOf(cube);
  const cubeSeed = cubeEdges.slice().sort((a, b) => b.length - a.length)[0];
  const cubeSel = toggleEdgeSelectionPropagated([], cubeSeed, {
    propagate: true,
    featureEdges: cubeEdges,
  });
  check(
    'cube sharp corner stays seed-only with Tangent on',
    cubeSel.length === 1,
    `got ${cubeSel.length}`,
  );

  // Corner continue rejects exact 90° (cube-like) even with seed plane.
  const e0 = {
    va: [0, 0, 0],
    vb: [1, 0, 0],
    tangent: [1, 0, 0],
    n0: [0, 0, 1],
    n1: [0, 1, 0],
  };
  const e90 = {
    va: [1, 0, 0],
    vb: [1, 1, 0],
    tangent: [0, 1, 0],
    n0: [0, 0, 1],
    n1: [1, 0, 0],
  };
  check(
    'isTrueG1 skipNormals rejects sharp 90° corner',
    !isTrueG1(e0, e90, { skipNormals: true, seedPlaneNormal: [0, 0, 1] }),
  );
  const e70 = {
    va: [1, 0, 0],
    vb: [1 + Math.cos((70 * Math.PI) / 180), Math.sin((70 * Math.PI) / 180), 0],
    tangent: [Math.cos((70 * Math.PI) / 180), Math.sin((70 * Math.PI) / 180), 0],
    n0: [0, 0, 1],
    n1: [0, 1, 0],
  };
  check(
    'isTrueG1 skipNormals accepts ~70° corner in seed plane',
    isTrueG1(e0, e70, { skipNormals: true, seedPlaneNormal: [0, 0, 1] }),
  );
}

if (failed) {
  console.error(`\n${failed} mobile C.3 roundedBox tangent check(s) failed.`);
  process.exit(1);
}
console.log('\nAll mobile C.3 roundedBox fillet tangent checks passed.');
