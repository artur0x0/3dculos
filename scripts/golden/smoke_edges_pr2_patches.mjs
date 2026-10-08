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
  PATCH_SMOOTH_CAP_DEG,
  sourceSmoothDeg,
  PATCH_FLAT_AREA_FRAC_OF_MAX,
  PARTGRAPH_MAX_TRIANGLES,
} from '../../src/utils/partGraphPatches.js';
import { triangleSources } from '../../src/utils/partSolidCache.js';

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
check('untagged sources fall back to 15°', PATCH_SMOOTH_DEG === 15);
check('derived gate caps at 50°', PATCH_SMOOTH_CAP_DEG === 50);
check('8-segment step (45°) clamps to 50°', sourceSmoothDeg(45, 24.4) === 50);
check('16-segment step (22.5°) scales to 25.875°', Math.abs(sourceSmoothDeg(22.5, 18.5) - 25.875) < 1e-9);
check('32-segment step (11.25°) stays on the 15° floor', sourceSmoothDeg(11.25, 9) === 15);
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
  const arrays = meshArrays(payload.mesh);
  arrays.triSource = triangleSources(payload.mesh, null, arrays.indices.length / 3);
  arrays.featureTessellation = payload.mesh.featureTessellation;
  const g = buildPartGraphPatches(arrays);
  check('roundedBox records its 22.5° facet step',
    Array.isArray(payload.mesh.featureTessellation)
    && payload.mesh.featureTessellation.some((row) => Math.abs(row.facetDeg - 22.5) < 1e-6),
    JSON.stringify(payload.mesh.featureTessellation));
  const planar = g.patches.filter((p) => p.kind === 'planar');
  const blend = g.patches.filter((p) => p.kind === 'blend');
  check('roundedBox has 6 planar faces', planar.length === 6, `n=${planar.length}`);
  check('roundedBox flats stay large (not shreds)', planar.every((p) => p.area > 200));
  check('roundedBox fillet chain is one blend, corners included', blend.length === 1 && blend[0].area > 1500,
    `n=${blend.length} area=${blend[0] ? blend[0].area.toFixed(0) : 'none'}`);
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

{
  // Same positive source, join under the 15° fallback, κ rate over 0.55.
  // A coarser bend (14°) against a finer one (1°) is the radius-change split.
  const positions = [];
  const indices = [];
  const faceIDs = [];
  const sources = [];
  const add = (x, y, z) => { const i = positions.length / 3; positions.push(x, y, z); return i; };
  // Large flat so the small bend facets do not earn the flat lock.
  {
    const a = add(-20, -20, -40);
    const b = add(20, -20, -40);
    const c = add(20, 20, -40);
    const d = add(-20, 20, -40);
    indices.push(a, b, c, a, c, d);
    faceIDs.push(1, 1);
    sources.push(1, 1);
  }
  let y = 0;
  let z = 0;
  let ang = 0;
  let prev = [add(0, y, z), add(2, y, z)];
  let fid = 10;
  const segment = (deg) => {
    ang += deg * Math.PI / 180;
    y += Math.sin(ang);
    z += Math.cos(ang);
    const next = [add(0, y, z), add(2, y, z)];
    indices.push(prev[0], next[0], next[1], prev[0], next[1], prev[1]);
    faceIDs.push(fid, fid);
    sources.push(1, 1);
    fid += 1;
    prev = next;
  };
  segment(14); segment(14); segment(14);
  segment(6); // join, still under the 15° fallback
  segment(1); segment(1); segment(1);
  const g = buildPartGraphPatches({
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    faceIDs: Int32Array.from(faceIDs),
    triSource: Int32Array.from(sources),
  });
  const bend = g.patches.filter((p) => p.kind === 'blend').sort((a, b) => b.area - a.area);
  const regions = bend.filter((p) => p.area > 4);
  check('a radius change (κ rate over 0.55) stays split',
    regions.length === 2 && bend[0].area < 10,
    `n=${bend.length} areas=${bend.map((p) => p.area.toFixed(1)).join(',')}`);
}

// Source-level: the rail patch-colour overlay and its material swap are gone.
// Face graphs still come from warmFaceGraph. Worker serialize stays lean.
{
  const fs = await import('node:fs');
  const vp = fs.readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../../src/workers/sandboxWorker.js', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../../src/lib/surfcad/runtime.js', import.meta.url), 'utf8');
  check(
    'worker serializeResult does not call buildPartGraphPatches',
    !/buildPartGraphPatches/.test(worker),
  );
  check(
    'the rail patch-colour overlay is gone',
    !/buildPartGraphPatches\(/.test(vp)
      && !/buildPatchOverlayArrays/.test(vp)
      && !/showPatchOverlay/.test(vp)
      && !/patchOverlayActiveRef/.test(vp)
      && !/forceBaseRestore/.test(vp),
  );
  check(
    'face graphs still come from warmFaceGraph',
    /warmFaceGraph\(/.test(vp),
  );
}

if (failed) {
  console.error(`\n${failed} edges PR2 patch check(s) failed.`);
  process.exit(1);
}
console.log('\nAll edges PR2 patch checks passed.');
