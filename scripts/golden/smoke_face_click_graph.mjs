#!/usr/bin/env node
/**
 * Default viewport face pick.
 *
 * One click selects the face-graph component (a flat face or a whole curved
 * face — fillet band, cylinder wall), not the hit triangle and not one
 * coplanar mesh facet. Two clicks select the body that owns that face.
 *
 * Shell / Draft / Cut stay on the legacy tap (coplanar, then 3° walk, then
 * the connected region) so a double click does not become the body.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import {
  resolveViewportFaceClick,
  selectFaceByID,
} from '../../src/utils/selectFace.js';
import { buildPartGraphPatches } from '../../src/utils/partGraphPatches.js';

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

function meshOf(mesh) {
  const np = mesh.numProp || 3;
  const src = mesh.vertProperties;
  const nVert = Math.floor(src.length / np);
  const positions = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    positions[i * 3] = src[i * np];
    positions[i * 3 + 1] = src[i * np + 1];
    positions[i * 3 + 2] = src[i * np + 2];
  }
  const indices = new Uint32Array(mesh.triVerts);
  const faceIDs = mesh.faceID ? Int32Array.from(mesh.faceID) : null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  const graph = buildPartGraphPatches({ positions, indices, faceIDs });
  return { geometry, positions, indices, faceIDs, graph };
}

function triNormal(geometry, t) {
  const index = geometry.index.array;
  const pos = geometry.attributes.position;
  const v0 = new Vector3().fromBufferAttribute(pos, index[t * 3]);
  const v1 = new Vector3().fromBufferAttribute(pos, index[t * 3 + 1]);
  const v2 = new Vector3().fromBufferAttribute(pos, index[t * 3 + 2]);
  return new Vector3().subVectors(v1, v0).cross(new Vector3().subVectors(v2, v0)).normalize();
}

function click(mesh, seed, clickCount, legacy = false) {
  const n = triNormal(mesh.geometry, seed);
  return resolveViewportFaceClick({
    geometry: mesh.geometry,
    seedFaceIndex: seed,
    faceNormal: [n.x, n.y, n.z],
    clickCount,
    faceIDs: mesh.faceIDs,
    legacy,
  });
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((t) => s.has(t));
}

await import('../../src/workers/sandboxWorker.js');
await send('init');
async function exec(script) {
  return (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload;
}

console.log('face click — graph face, then owning body');

{
  const payload = await exec('return Manifold.cube([40, 30, 20], true);');
  const mesh = meshOf(payload.mesh);
  const seed = 0;
  const face = click(mesh, seed, 1);
  const patch = mesh.graph.patches[mesh.graph.triPatch[seed]];
  const n = triNormal(mesh.geometry, seed);
  const coplanar = selectFaceByID(mesh.geometry, seed, { normal: [n.x, n.y, n.z] });
  check('flat face is one graph component', face.selectionMode === 'coplanar' && face.kind === 'planar');
  check('flat face is the whole patch, not one triangle',
    face.indices.length === patch.tris.length && face.indices.length > 1,
    `n=${face.indices.length}`);
  check('flat face matches the coplanar flood', sameSet(face.indices, coplanar));
  const body = click(mesh, seed, 2);
  check('double click selects the cube body',
    body.selectionMode === 'all-connected' && body.indices.length === mesh.faceIDs.length,
    `n=${body.indices.length}`);
  check('the flat face sits inside that body', face.indices.every((t) => body.indices.includes(t)));
}

{
  const payload = await exec('return Manifold.cylinder(20, 10, 10, 32);');
  const mesh = meshOf(payload.mesh);
  const wall = mesh.graph.patches.find((p) => p.kind === 'blend');
  const cap = mesh.graph.patches.find((p) => p.kind === 'planar');
  check('cylinder has a curved wall and a flat cap', !!wall && !!cap && wall.tris.length > 8);
  const curved = click(mesh, wall.tris[0], 1);
  const n = triNormal(mesh.geometry, wall.tris[0]);
  const facet = selectFaceByID(mesh.geometry, wall.tris[0], { normal: [n.x, n.y, n.z] });
  check('one click selects the whole cylinder wall',
    sameSet(curved.indices, wall.tris) && curved.selectionMode === 'angular-tolerance',
    `n=${curved.indices.length} facet=${facet.length}`);
  check('that wall is not one triangle and not one mesh facet',
    curved.indices.length > facet.length && facet.length <= 2);
  const flat = click(mesh, cap.tris[0], 1);
  check('one click selects the whole flat cap',
    sameSet(flat.indices, cap.tris) && flat.selectionMode === 'coplanar',
    `n=${flat.indices.length}`);
  const body = click(mesh, wall.tris[0], 2);
  check('double click on the wall selects the cylinder body',
    body.indices.length === mesh.faceIDs.length && body.indices.length > curved.indices.length);
}

{
  const payload = await exec(`
let part = Manifold.cube([40, 30, 20], true);
return filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 4);
`);
  const mesh = meshOf(payload.mesh);
  const blend = mesh.graph.patches.find((p) => p.kind === 'blend');
  const flat = mesh.graph.patches.find((p) => p.kind === 'planar' && Math.abs(p.normal[2]) > 0.9);
  check('fillet blend is one curved face', !!blend && blend.tris.length > 8, blend ? `n=${blend.tris.length}` : 'missing');
  const curved = click(mesh, blend.tris[0], 1);
  const n = triNormal(mesh.geometry, blend.tris[0]);
  const facet = selectFaceByID(mesh.geometry, blend.tris[0], { normal: [n.x, n.y, n.z] });
  check('one click on the fillet selects the whole blend',
    sameSet(curved.indices, blend.tris),
    `n=${curved.indices.length} facet=${facet.length}`);
  check('fillet click is larger than one facet', curved.indices.length > facet.length);
  const flatClick = click(mesh, flat.tris[0], 1);
  check('one click on a filleted flat face stays that face',
    sameSet(flatClick.indices, flat.tris) && flatClick.selectionMode === 'coplanar');
  check('curved face and flat face do not share triangles',
    curved.indices.every((t) => !flatClick.indices.includes(t)));
  const body = click(mesh, blend.tris[0], 2);
  check('double click on the fillet selects the whole body',
    body.indices.length === mesh.faceIDs.length
      && curved.indices.every((t) => body.indices.includes(t))
      && flatClick.indices.every((t) => body.indices.includes(t)),
    `body=${body.indices.length}`);
  const legacy = click(mesh, blend.tris[0], 2, true);
  check('legacy double click does not select the body',
    legacy.selectionMode === 'angular-tolerance' && legacy.indices.length < body.indices.length,
    `n=${legacy.indices.length}`);
  const legacySingle = click(mesh, blend.tris[0], 1, true);
  check('legacy single click stays the coplanar facet',
    legacySingle.selectionMode === 'coplanar' && sameSet(legacySingle.indices, facet));
}

{
  const payload = await exec(`
let a = Manifold.cube([10, 10, 10], true);
let b = Manifold.cube([10, 10, 10], true).translate([40, 0, 0]);
return a.add(b);
`);
  const mesh = meshOf(payload.mesh);
  const body = click(mesh, 0, 2);
  check('double click selects one body, not both cubes',
    body.indices.length > 0 && body.indices.length < mesh.faceIDs.length,
    `body=${body.indices.length} all=${mesh.faceIDs.length}`);
  check('the other cube is a different body', !body.indices.includes(mesh.faceIDs.length - 1));
}

{
  const vp = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const hi = vp.indexOf('const highlightFace = useCallback');
  const draft = vp.indexOf('const paintDraftPicks = useCallback');
  check('paintDraftPicks stays below highlightFace', hi > 0 && draft > hi);
  check('draft order comment is intact', vp.includes('Below highlightFace on purpose'));
  check(
    'shell, draft, and cut keep the legacy tap',
    /const legacyTap = !!\(shellModeRef\.current \|\| draftModeRef\.current \|\| cutModeRef\.current\)/.test(vp)
      && /legacy: legacyTap/.test(vp),
  );
  check('default pick goes through resolveViewportFaceClick', /resolveViewportFaceClick\(/.test(vp));
}

if (failed) {
  console.error(`\n${failed} face-click check(s) failed.`);
  process.exit(1);
}
console.log('\nAll face-click checks passed.');
