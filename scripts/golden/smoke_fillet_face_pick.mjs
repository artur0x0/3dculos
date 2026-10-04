#!/usr/bin/env node
/**
 * A face pick on the wall next to an internal fillet includes that fillet,
 * and Move Face then carries it.
 *
 * The fillet and the wall are one body (one decompose component, one vertex
 * component). The blend stays its own patch. Move Face one-click reads the
 * tangent link, so the pick includes the fillet triangles. The named center
 * stays on the wall, and moveFace carries the blend into the cavity.
 * Default one-click stays the planar face. A click on the fillet stays the
 * coplanar facet.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { BufferAttribute, BufferGeometry } from 'three';
import { meshBodyComponents } from '../../src/utils/meshBodyComponents.js';
import { buildPartGraphPatches } from '../../src/utils/partGraphPatches.js';
import {
  resolveViewportFaceClick,
  selectFaceByID,
  selectMoveFaceWithTangentFillet,
} from '../../src/utils/selectFace.js';

register('./manifold-resolve-hook.mjs', import.meta.url);

const pending = new Map();
let msgId = 0;
globalThis.self = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const w = pending.get(msg.id);
    if (!w) return;
    pending.delete(msg.id);
    if (msg.type === 'error') w.reject(new Error(msg.payload?.message || 'worker error'));
    else w.resolve(msg);
  },
};
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => globalThis.self.onmessage({ data: { type, payload, id } }));
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
  globalThis.__note = null;
  try {
    const msg = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
    return { payload: msg.payload, note: globalThis.__note };
  } catch (e) {
    return { error: e.message, note: globalThis.__note };
  }
}

function ball(solidName, p) {
  return `Manifold.intersection(${solidName}, Manifold.sphere(0.2, 12).translate([${p.join(',')}])).volume()`;
}

function triNormal(pos, index, t) {
  const i0 = index[t * 3];
  const i1 = index[t * 3 + 1];
  const i2 = index[t * 3 + 2];
  const ax = pos[i1 * 3] - pos[i0 * 3];
  const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
  const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
  const bx = pos[i2 * 3] - pos[i0 * 3];
  const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
  const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function triOnPlane(pos, index, t, axis, value, eps = 0.05) {
  for (let k = 0; k < 3; k++) {
    const v = index[t * 3 + k];
    if (Math.abs(pos[v * 3 + axis] - value) > eps) return false;
  }
  return true;
}

console.log('face pick on the wall includes the internal fillet');
{
  const arrived = [0, -32.8, 10.8];
  const cavity = [0, -32.8, 9.2];
  const r = await exec(`
let part = Manifold.union([
  Manifold.cube([60, 24, 28], true).translate([-8, 0, 0]),
  Manifold.cube([24, 60, 28], true).translate([0, -8, 0]),
]);
part = hollow(part, 3, [{ center: [0, 0, -14], normal: [0, 0, -1] }]);
const edgeLen = (e) => Math.hypot(e.vb[0] - e.va[0], e.vb[1] - e.va[1], e.vb[2] - e.va[2]);
const horizontal = concaveEdges(part).filter((e) => {
  const midY = (e.va[1] + e.vb[1]) / 2;
  const midZ = (e.va[2] + e.vb[2]) / 2;
  return Math.abs(e.vb[2] - e.va[2]) < 0.5 && midZ > 8 && edgeLen(e) > 8 && Math.abs(midY + 35) < 1;
});
if (!horizontal.length) throw new Error('no inner-wall top edge');
const before = part.volume();
part = filletAlongPath(part, makeSweepPath([horizontal[0]]), 2.5, { variableProfile: true });
const preN = part.decompose().length;
const preArrived = ${ball('part', arrived)};
const preCavity = ${ball('part', cavity)};
const moved = moveFace(part, [{ center: [0, -35, 0], normal: [0, 1, 0] }], 1.5);
const postArrived = ${ball('moved', arrived)};
const postCavity = ${ball('moved', cavity)};
globalThis.__note = {
  preN,
  postN: moved.decompose().length,
  filletAdd: +(part.volume() - before).toFixed(3),
  preArrived: +preArrived.toFixed(5),
  postArrived: +postArrived.toFixed(5),
  preCavity: +preCavity.toFixed(5),
  postCavity: +postCavity.toFixed(5),
};
return part;
`);
  check('shelled L fillet runs', !r.error, r.error || '');
  const n = r.note;
  if (!r.error && n) {
    check('the fillet and the wall are one body', n.preN === 1, `n=${n.preN}`);
    check('the fillet added material', n.filletAdd > 1, `add=${n.filletAdd}`);
    check('moveFace still returns one body', n.postN === 1, `n=${n.postN}`);
    check('the cavity point beside the fillet was empty', n.preArrived < 1e-4, `vol=${n.preArrived}`);
    check('Move Face carried the fillet into that point', n.postArrived > 1e-3, `vol=${n.postArrived}`);
    check('a deeper cavity point stayed empty', n.preCavity < 1e-4 && n.postCavity < 1e-4,
      `vol ${n.preCavity}->${n.postCavity}`);
  }

  const mesh = r.payload?.mesh;
  if (!r.error && mesh?.vertProperties && mesh?.triVerts) {
    const np = mesh.numProp || 3;
    const nVert = mesh.vertProperties.length / np;
    const pos = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) {
      pos[i * 3] = mesh.vertProperties[i * np];
      pos[i * 3 + 1] = mesh.vertProperties[i * np + 1];
      pos[i * 3 + 2] = mesh.vertProperties[i * np + 2];
    }
    const index = Uint32Array.from(mesh.triVerts);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(pos, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    const bodies = meshBodyComponents(geometry.attributes.position, geometry.index);
    check('the fillet shares the wall vertex component', bodies.length === 1, `bodies=${bodies.length}`);

    const numTri = index.length / 3;
    let wall = -1;
    let filletTri = -1;
    for (let t = 0; t < numTri; t++) {
      const normal = triNormal(pos, index, t);
      if (wall < 0 && normal[1] > 0.99 && triOnPlane(pos, index, t, 1, -35)) wall = t;
      if (filletTri < 0 && normal[1] < Math.cos((20 * Math.PI) / 180) && normal[1] > 0.2) {
        let cy = 0;
        let cz = 0;
        for (let k = 0; k < 3; k++) {
          const v = index[t * 3 + k];
          cy += pos[v * 3 + 1];
          cz += pos[v * 3 + 2];
        }
        cy /= 3;
        cz /= 3;
        if (cy > -35.2 && cy < -30 && cz > 8) filletTri = t;
      }
    }
    check('the inner wall triangle is on y = -35', wall >= 0, `wall=${wall}`);
    check('a fillet triangle sits on that corner', filletTri >= 0, `fillet=${filletTri}`);

    if (wall >= 0) {
      const graph = buildPartGraphPatches({
        positions: pos,
        indices: index,
        faceIDs: mesh.faceID,
      });
      const wallPatch = graph.patches[graph.triPatch[wall]];
      const blend = graph.patches.find((p) => p.kind === 'blend');
      check('the wall patch stays planar', wallPatch?.kind === 'planar', wallPatch?.kind || 'missing');
      check('the fillet stays its own blend patch', !!blend && blend.id !== wallPatch?.id);
      check('the wall patch tris do not swallow the blend',
        !!blend && blend.tris.every((t) => !wallPatch.tris.includes(t)));
      check('the wall records the tangent fillet',
        !!blend && blend.tris.some((t) => wallPatch.tangentTris.includes(t)),
        `tangent=${wallPatch?.tangentTris?.length || 0}`);
      const side = graph.patches.find((p) => p.kind === 'planar' && Math.abs(p.normal[0]) > 0.9 && p.area > 50);
      check('a 90° side wall does not record the fillet',
        !!side && (!blend || blend.tris.every((t) => !side.tangentTris.includes(t))),
        side ? `tangent=${side.tangentTris.length}` : 'no side');

      const picked = selectMoveFaceWithTangentFillet(geometry, wall, [0, 1, 0], mesh.faceID);
      const pickedSet = new Set(picked);
      const includesWall = wallPatch.tris.every((t) => pickedSet.has(t));
      const includesFillet = !!blend && blend.tris.some((t) => pickedSet.has(t));
      check('Move Face pick on the wall includes the wall', includesWall, `n=${picked.length}`);
      check('Move Face pick on the wall includes the fillet', includesFillet, `n=${picked.length}`);
      let cy = 0;
      let cArea = 0;
      const cos1 = Math.cos(Math.PI / 180);
      for (const t of picked) {
        const normal = triNormal(pos, index, t);
        if (normal[1] <= cos1) continue;
        let y = 0;
        for (let k = 0; k < 3; k++) y += pos[index[t * 3 + k] * 3 + 1];
        const i0 = index[t * 3];
        const i1 = index[t * 3 + 1];
        const i2 = index[t * 3 + 2];
        const ax = pos[i1 * 3] - pos[i0 * 3];
        const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
        const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
        const bx = pos[i2 * 3] - pos[i0 * 3];
        const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
        const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
        const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
        cy += (y / 3) * area;
        cArea += area;
      }
      const centerY = cArea > 0 ? cy / cArea : 0;
      check('the named center stays on the wall', cArea > 0 && Math.abs(centerY + 35) < 0.05,
        `y=${centerY.toFixed(3)} area=${cArea.toFixed(2)}`);

      const graphClick = resolveViewportFaceClick({
        geometry,
        seedFaceIndex: wall,
        faceNormal: [0, 1, 0],
        clickCount: 1,
        faceIDs: mesh.faceID,
        legacy: false,
      });
      const graphSet = new Set(graphClick.indices);
      check('default one-click on the wall stays the planar face',
        graphClick.kind === 'planar'
          && wallPatch.tris.every((t) => graphSet.has(t))
          && (!blend || blend.tris.every((t) => !graphSet.has(t))));
    }

    if (filletTri >= 0) {
      const nrm = triNormal(pos, index, filletTri);
      const facet = selectFaceByID(geometry, filletTri, { normal: nrm });
      const onFillet = selectMoveFaceWithTangentFillet(geometry, filletTri, nrm, mesh.faceID);
      const facetSet = new Set(facet);
      check('a click on the fillet stays the coplanar facet',
        onFillet.length === facet.length && onFillet.every((t) => facetSet.has(t)),
        `pick=${onFillet.length} facet=${facet.length}`);
    }
  } else if (!r.error) {
    check('mesh is available for the face pick', false, 'no mesh');
  }
}

{
  const vp = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  check('the new mesh warms the face graph', /warmFaceGraph\(geometry, faceIDsRef\.current\)/.test(vp));
  check('Move Face one-click reads the tangent fillet', /selectMoveFaceWithTangentFillet\(/.test(vp));
  check('Move Face still forces the legacy walk',
    /legacy: legacyTap \|\| !!moveFaceModeRef\.current/.test(vp));
}

if (failed) {
  console.log(`\n${failed} fillet-face-pick check(s) failed`);
  process.exit(1);
}
console.log('\nfillet-face-pick golden passed');
