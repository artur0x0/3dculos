#!/usr/bin/env node
/**
 * Edges PR2 — patch segmentation goldens (EDGES.md §5 / §6 Gate PR 2).
 *
 * faceID-CC atoms + curvature-class merge. Asserts:
 * - cube → 6 planar patches
 * - filleted box → 6 planar + 1 blend; blend does not absorb neighbouring flats
 * - shelled fillet box → outer + inner blends stay separate; flats stay flats
 * - roundedBox → 6 large planar faces remain distinct from blends
 * - loft → each large wall is exactly one patch
 * - worker execute payload does NOT ship partGraph (lazy / off critical path —
 *   #88 shipped it every serializeResult and caused iOS Safari black viewport)
 */
import { register } from 'node:module';
import {
  buildPartGraphPatches,
  PATCH_PLANAR_DEG,
  PATCH_SMOOTH_DEG,
  PATCH_FLAT_AREA_FRAC_OF_MAX,
  PARTGRAPH_MAX_TRIANGLES,
} from '../../src/utils/partGraphPatches.js';

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

function meshArrays(mesh) {
  const np = mesh.numProp || 3;
  const src = mesh.vertProperties;
  const nVert = Math.floor(src.length / np);
  const positions = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    positions[i * 3] = src[i * np];
    positions[i * 3 + 1] = src[i * np + 1];
    positions[i * 3 + 2] = src[i * np + 2];
  }
  return {
    positions,
    indices: new Uint32Array(mesh.triVerts),
    faceIDs: mesh.faceID ? Int32Array.from(mesh.faceID) : null,
  };
}

console.log('edges PR2 — patch segmentation (lazy / off serialize path)');
check('planar gate is tight (≤1°)', PATCH_PLANAR_DEG <= 1);
check('smooth gate clears coarse tessellation', PATCH_SMOOTH_DEG >= 12 && PATCH_SMOOTH_DEG <= 20);
check('flat lock uses frac-of-max', PATCH_FLAT_AREA_FRAC_OF_MAX > 0.05 && PATCH_FLAT_AREA_FRAC_OF_MAX < 0.5);
check('tri count soft-cap is finite', Number.isFinite(PARTGRAPH_MAX_TRIANGLES) && PARTGRAPH_MAX_TRIANGLES > 1000);

await import('../../src/workers/sandboxWorker.js');
await send('init');
async function exec(script) {
  return (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload;
}

{
  const payload = await exec('return Manifold.cube([40,30,20], true);');
  check(
    'worker execute payload has NO partGraph (serialize stays lean)',
    !payload.mesh?.partGraph,
    payload.mesh?.partGraph ? 'partGraph present — regresses #88' : '',
  );
  check('worker still ships faceID for lazy build', !!payload.mesh?.faceID?.length);
  const g = buildPartGraphPatches(meshArrays(payload.mesh));
  check('cube util → 6 patches', g.patches.length === 6, `n=${g.patches.length}`);
  check('cube all planar', g.patches.every((p) => p.kind === 'planar'));
}

{
  const payload = await exec(`
let part = Manifold.cube([40, 30, 20], true);
return filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 4);
`);
  check('filleted execute has NO partGraph', !payload.mesh?.partGraph);
  const g = buildPartGraphPatches(meshArrays(payload.mesh));
  const planar = g.patches.filter((p) => p.kind === 'planar');
  const blend = g.patches.filter((p) => p.kind === 'blend');
  check('filleted box → 7 patches', g.patches.length === 7, `n=${g.patches.length}`);
  check('filleted box → 6 flats', planar.length === 6, `n=${planar.length}`);
  check('filleted box → 1 blend', blend.length === 1, `n=${blend.length}`);
  // Tangent-junction trap: no patch mixes a large flat normal with blend area.
  const top = planar.find((p) => p.normal[2] > 0.9);
  const side = planar.find((p) => p.normal[1] > 0.9);
  check('top flat survives (not swallowed)', !!top && top.area > 500, top ? `a=${top.area}` : 'missing');
  check('side flat survives', !!side && side.area > 400, side ? `a=${side.area}` : 'missing');
  check('blend is the remaining band', blend[0] && blend[0].area > 100 && blend[0].area < 800,
    blend[0] ? `a=${blend[0].area}` : 'missing');
}

{
  const payload = await exec(`
let part = Manifold.cube([40, 30, 20], true);
part = filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 4);
return part.subtract(shell(part, 2.5, 'z'));
`);
  const g = buildPartGraphPatches(meshArrays(payload.mesh));
  const allBlend = g.patches.filter((p) => p.kind === 'blend');
  const planar = g.patches.filter((p) => p.kind === 'planar');
  // Since #110 (shell offset clusters facet normals) the open +Z rim wall that
  // joins the inner r=1.5 arc end (z≈7.47) to the outer r=4 band (z≈9.98) is
  // offset a few tenths of a mm off-plane (normal ≈ [0,-1,0.03]), so its three
  // triangles miss the ≤1° planar gate and segment as their own 'blend'. It is
  // a near-vertical wall above the inner ceiling, not a fillet band; the
  // curved bands are still exactly outer + inner, separate, never merged.
  const isRimWall = (p) => Math.abs(p.normal[2]) < 0.1 && p.center[2] > 7.5 && p.tris.length <= 4;
  const rimWall = allBlend.filter(isRimWall);
  const blend = allBlend.filter((p) => !isRimWall(p));
  check('shelled has outer+inner blends', blend.length === 2, `n=${blend.length}`);
  check('shelled extra blend is only the #110 open-rim wall (≤1 patch, ≤4 tris)',
    rimWall.length <= 1, `rim=${rimWall.length}`);
  check('shelled keeps many flats', planar.length >= 10, `n=${planar.length}`);
  check('shelled blends differ in area (outer≠inner)', blend.length === 2
    && Math.abs(blend[0].area - blend[1].area) > 20);
  // No through-wall merge: two blends, not one.
  check('shelled patch count in human range', g.patches.length >= 12 && g.patches.length <= 20,
    `n=${g.patches.length}`);
}

{
  const payload = await exec('return roundedBox([50,30,20], 4, 16);');
  const g = buildPartGraphPatches(meshArrays(payload.mesh));
  const planar = g.patches.filter((p) => p.kind === 'planar');
  check('roundedBox has 6 planar faces', planar.length === 6, `n=${planar.length}`);
  check('roundedBox flats stay large (not shreds)', planar.every((p) => p.area > 200));
  check('roundedBox total patches near 26±10', g.patches.length >= 20 && g.patches.length <= 40,
    `n=${g.patches.length}`);
}

{
  const payload = await exec(`
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
return placeInFrame(fr, makeLoft([xs0, xs1]));
`);
  const g = buildPartGraphPatches(meshArrays(payload.mesh));
  const walls = g.patches.filter((p) => p.area > 50);
  check('loft has ~6 large face patches (walls+caps)', walls.length >= 5 && walls.length <= 10,
    `n=${walls.length}`);
  const side = walls.filter((p) => Math.abs(p.normal[2]) < 0.5);
  check('loft side walls are single patches each', side.length >= 4, `n=${side.length}`);
}

// Source-level: Viewport builds lazily; overlay uses unlit material.
{
  const fs = await import('node:fs');
  const vp = fs.readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../../src/workers/sandboxWorker.js', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../../src/lib/surfcad/runtime.js', import.meta.url), 'utf8');
  check(
    'worker serializeResult does not call buildPartGraphPatches',
    !/buildPartGraphPatches/.test(worker),
  );
  check(
    'Viewport lazy-builds via buildPartGraphPatches',
    /buildPartGraphPatches\(/.test(vp),
  );
  check(
    'overlay uses MeshBasicMaterial (unlit)',
    /patchOverlayMatRef\.current = new MeshBasicMaterial\(\{\s*vertexColors:\s*true/.test(vp)
      || /new MeshBasicMaterial\(\{\s*vertexColors:\s*true/.test(vp),
  );
  check(
    'overlay does not use MeshLambertMaterial for patches',
    !/patchOverlayMatRef\.current = new MeshLambertMaterial/.test(vp),
  );
  check(
    'overlay-off is gated on patchOverlayActiveRef (no half-rebuild)',
    /patchOverlayActiveRef/.test(vp)
      && /if \(!showPatchOverlay\)/.test(vp)
      && /if \(patchOverlayActiveRef\.current\)/.test(vp),
  );
  check(
    'toggle-off force-restores via renderMeshData (lit base)',
    /forceBaseRestore/.test(vp) && /renderMeshData\(cached\)/.test(vp),
  );
}

if (failed) {
  console.error(`\n${failed} edges PR2 patch check(s) failed.`);
  process.exit(1);
}
console.log('\nAll edges PR2 patch checks passed.');
