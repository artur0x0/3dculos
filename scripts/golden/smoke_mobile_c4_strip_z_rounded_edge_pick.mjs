#!/usr/bin/env node
/**
 * Slice Mobile C.4 — Script strip below ribbon + rounded/post-fillet edge pick.
 *
 * 1) Script stage: feature strip Contour chips start fully below the ribbon
 *    (taller spacer + editor overflow-hidden + strip z-20). C.3's z-30>z-10
 *    alone still let the ribbon paint over Contour#1.
 *
 * 2) Fillet / Edge pick: post-fillet rounded rails were filtered out of the
 *    coherent pick graph. Root cause: BOUNDARY_SMALL_FACE_FRAC drops large↔blend
 *    creases (minFaceArea = blend facet), so rails lack boundaryId; tracing them
 *    with residual sharp edges glued rail+sharp into a wandering chain the spine
 *    test refused. Fix: buildCoherentEdges traces tagged vs untagged pools apart.
 *    #78 roundedBox Tangent golden stays green; this covers the pickability gap.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
  toggleEdgeSelectionPropagated,
  TANGENT_PROP_FLOOD_MAX,
  edgeKey,
} from '../../src/utils/selectEdge.js';
import { annotateFeatureEdges, indexBoundaryEdges } from '../../src/utils/boundaryEdgeIds.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('mobile C.4: strip z + rounded edge pick');

{
  const app = read('../../src/App.jsx');
  const editor = read('../../src/components/CodeEditor.jsx');
  const selectEdge = read('../../src/utils/selectEdge.js');

  check(
    'Script editor stack clips overflow; strip z-20; spacer h-11',
    /data-script-editor-stack/.test(app) &&
      /overflow-hidden/.test(app) &&
      /data-script-feature-strip/.test(app) &&
      /relative z-20 flex flex-col shrink-0/.test(app) &&
      /data-feature-strip-below-ribbon/.test(app) &&
      /data-feature-strip-ribbon-spacer/.test(app) &&
      // Spacer height is measured off the ribbon, so no h-11 literal.
      /data-feature-strip-ribbon-spacer-h="measured"/.test(app) &&
      /style=\{\{ height: ribbonPx \}\}/.test(app) &&
      /ResizeObserver/.test(app) &&
      /data-editor-ribbon/.test(editor),
  );

  check(
    'buildCoherentEdges splits tagged vs untagged sharp pools (C.4)',
    /taggedSharp/.test(selectEdge) &&
      /untaggedSharp/.test(selectEdge) &&
      /Mobile C\.4/.test(selectEdge) &&
      /emitFromPool\(taggedSharp\)/.test(selectEdge) &&
      /emitFromPool\(untaggedSharp\)/.test(selectEdge),
  );
}

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

console.log('\nmobile C.4: post-fillet rounded rail pick + Tangent');

{
  await import('../../src/workers/sandboxWorker.js');
  await send('init');
  async function exec(script) {
    return (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload;
  }

  const filleted = await exec(`
let box1 = Manifold.cube([40, 30, 20], true);
let part = box1;
const selEdges = edgesBetween(part, 3, 5);
const path = makeSweepPath(selEdges);
part = filletAlongPath(part, path, 4);
return part;
`);
  const edges = coherentOf(filleted);
  check('post-fillet yields more than residual sharp 11', edges.length > 11, `n=${edges.length}`);

  const rails = edges.filter((e) => e.length < 8 && !Number.isFinite(e.boundaryId));
  check('post-fillet rounded rails are pickable (untagged short)', rails.length >= 2, `n=${rails.length}`);

  const seed = rails.slice().sort((a, b) => b.length - a.length)[0];
  check('have a rail seed', !!seed, seed ? edgeKey(seed) : 'none');

  if (seed) {
    const alone = toggleEdgeSelectionPropagated([], seed, {
      propagate: false,
      featureEdges: edges,
    });
    check('rail seed pickable with Tangent off', alone.length === 1, `n=${alone.length}`);

    const flooded = toggleEdgeSelectionPropagated([], seed, {
      propagate: true,
      featureEdges: edges,
    });
    const sameChain = flooded.filter((e) => e.chainId === seed.chainId).length;
    check(
      'Tangent-on from rail floods its coherent chain (≥2)',
      sameChain >= 2 && flooded.length <= TANGENT_PROP_FLOOD_MAX,
      `sameChain=${sameChain} total=${flooded.length}`,
    );
  }

  // Regressions
  const cube = await exec('return Manifold.cube([40, 30, 20], true);');
  const cubeEdges = coherentOf(cube);
  const cubeSeed = cubeEdges.slice().sort((a, b) => b.length - a.length)[0];
  const cubeSel = toggleEdgeSelectionPropagated([], cubeSeed, {
    propagate: true,
    featureEdges: cubeEdges,
  });
  check('cube sharp corner stays seed-only with Tangent on', cubeSel.length === 1, `got ${cubeSel.length}`);

  const box = await exec('return roundedBox([50, 30, 20], 4, 16);');
  const rbEdges = coherentOf(box);
  check('roundedBox still yields coherent pick edges', rbEdges.length >= 12, `n=${rbEdges.length}`);
  const zMax = Math.max(...rbEdges.map((e) => (e.va[2] + e.vb[2]) / 2));
  const topOuter = rbEdges.filter((e) => Math.abs((e.va[2] + e.vb[2]) / 2 - zMax) < 0.5);
  const longTop = topOuter.filter((e) => e.length > 15).sort((a, b) => b.length - a.length);
  check('roundedBox top rim has long seeds', longTop.length >= 1, `n=${longTop.length}`);
  if (longTop.length) {
    const sel = toggleEdgeSelectionPropagated([], longTop[0], {
      propagate: true,
      featureEdges: rbEdges,
    });
    const topHit = sel.filter((e) => topOuter.some((t) => edgeKey(t) === edgeKey(e))).length;
    check(
      'roundedBox Tangent-on still floods top rim (≥12)',
      topHit >= 12 && sel.length > 1 && sel.length <= TANGENT_PROP_FLOOD_MAX,
      `selected=${sel.length} topHit=${topHit}`,
    );
  }
}

if (failed) {
  console.error(`\n${failed} mobile C.4 check(s) failed.`);
  process.exit(1);
}
console.log('\nAll mobile C.4 strip z + rounded edge pick checks passed.');
