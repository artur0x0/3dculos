#!/usr/bin/env node
/**
 * One click on a coplanar cap covers both former bodies. The curved fillet
 * is not part of that pick.
 *
 * The shelled L is one body and the inner ceiling is one plane. A fillet
 * between the two source bodies leaves the far half of that cap with the
 * other face id. The face graph joins those coplanar triangles. Shell,
 * Draft, Cut, and Move Face one-click read that same planar face. A click
 * on the blend stays the coplanar facet. Move Face double-click is not the
 * body.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { BufferAttribute, BufferGeometry } from 'three';
import { meshBodyComponents } from '../../src/utils/meshBodyComponents.js';
import { buildPartGraphPatches } from '../../src/utils/partGraphPatches.js';
import {
  resolveViewportFaceClick,
  selectFaceByID,
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

function triInfo(pos, index, t) {
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
  const raw = Math.hypot(nx, ny, nz);
  const len = raw || 1;
  const area = 0.5 * raw;
  const cx = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3;
  const cy = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3;
  const cz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;
  return { nx: nx / len, ny: ny / len, nz: nz / len, area, cx, cy, cz };
}

console.log('one click on the coplanar cap covers both former bodies');
{
  const r = await exec(`
let part = Manifold.union([
  Manifold.cube([60, 24, 28], true).translate([-8, 0, 0]),
  Manifold.cube([24, 60, 28], true).translate([0, -8, 0]),
]);
part = hollow(part, 3, [{ center: [0, 0, -14], normal: [0, 0, -1] }]);
const edgeLen = (e) => Math.hypot(e.vb[0] - e.va[0], e.vb[1] - e.va[1], e.vb[2] - e.va[2]);
const edges = concaveEdges(part).filter((e) => edgeLen(e) > 10 && (e.va[2] + e.vb[2]) / 2 > 6);
part = filletAlongPath(part, makeSweepPath(edges), 2, { variableProfile: true });
globalThis.__note = { bodies: part.decompose().length, edges: edges.length };
return part;
`);
  check('shelled L fillet runs', !r.error, r.error || '');
  check('the cap halves are one body', r.note?.bodies === 1, `n=${r.note?.bodies}`);
  check('more than one inner edge was filleted', (r.note?.edges || 0) > 1, `n=${r.note?.edges}`);

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
    check('the cap shares one vertex component', bodies.length === 1, `bodies=${bodies.length}`);

    const numTri = index.length / 3;
    const cosCap = Math.cos((0.5 * Math.PI) / 180);
    const cosFillet = Math.cos((20 * Math.PI) / 180);
    let ceilingArea = 0;
    let seed = -1;
    let filletTri = -1;
    const infos = new Array(numTri);
    for (let t = 0; t < numTri; t++) {
      const info = triInfo(pos, index, t);
      infos[t] = info;
      const onCap = info.nz < -cosCap && Math.abs(info.cz - 11) <= 0.05;
      if (onCap) {
        ceilingArea += info.area;
        if (seed < 0 || info.cx < infos[seed].cx) seed = t;
      }
      const ang = -info.nz;
      if (filletTri < 0 && ang < cosFillet && ang > 0.2 && info.cz > 8 && info.cz < 11.2) filletTri = t;
    }
    check('the inner ceiling is one plane of real area', ceilingArea > 1100 && seed >= 0,
      `area=${ceilingArea.toFixed(1)} seed=${seed}`);
    check('a curved fillet triangle sits beside that cap', filletTri >= 0, `fillet=${filletTri}`);

    if (seed >= 0) {
      const graph = buildPartGraphPatches({
        positions: pos,
        indices: index,
        faceIDs: mesh.faceID,
      });
      const cap = graph.patches[graph.triPatch[seed]];
      const faceIds = new Set();
      let pickedCap = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const t of cap.tris) {
        const info = infos[t];
        if (!(info.nz < -cosCap && Math.abs(info.cz - 11) <= 0.05)) continue;
        pickedCap += info.area;
        faceIds.add(mesh.faceID?.[t]);
        if (info.cx < minX) minX = info.cx;
        if (info.cx > maxX) maxX = info.cx;
        if (info.cy < minY) minY = info.cy;
        if (info.cy > maxY) maxY = info.cy;
      }
      check('the cap patch stays planar', cap?.kind === 'planar', cap?.kind || 'missing');
      check('one patch holds both former bodies of the cap',
        pickedCap > ceilingArea * 0.95 && (maxX - minX) > 20 && (maxY - minY) > 20,
        `area=${pickedCap.toFixed(1)}/${ceilingArea.toFixed(1)} span=${(maxX - minX).toFixed(1)}x${(maxY - minY).toFixed(1)}`);
      check('those halves still carry more than one face id', faceIds.size > 1, `ids=${faceIds.size}`);
      const curvedInCap = cap.tris.some((t) => infos[t].area > 1e-6 && -infos[t].nz < cosFillet);
      check('the curved fillet is not in the cap patch', !curvedInCap);

      const click = (legacy) => resolveViewportFaceClick({
        geometry,
        seedFaceIndex: seed,
        faceNormal: [0, 0, -1],
        clickCount: 1,
        faceIDs: mesh.faceID,
        legacy,
      });
      for (const legacy of [false, true]) {
        const picked = click(legacy);
        const set = new Set(picked.indices);
        const covers = cap.tris.every((t) => set.has(t));
        const filletIn = filletTri >= 0 && set.has(filletTri);
        const curved = picked.indices.some((t) => infos[t].area > 1e-6 && -infos[t].nz < cosFillet);
        check(`${legacy ? 'Shell/Draft/Cut/Move Face' : 'default'} one-click selects the whole cap`,
          picked.kind === 'planar' && covers && !filletIn && !curved,
          `n=${picked.indices.length} filletIn=${filletIn} curved=${curved}`);
      }

      const dbl = resolveViewportFaceClick({
        geometry,
        seedFaceIndex: seed,
        faceNormal: [0, 0, -1],
        clickCount: 2,
        faceIDs: mesh.faceID,
        legacy: true,
      });
      check('Move Face double-click is not the body',
        dbl.selectionMode === 'angular-tolerance' && dbl.indices.length < numTri * 0.5,
        `mode=${dbl.selectionMode} n=${dbl.indices.length}`);

      const arms = graph.patches.filter((p) => {
        if (p.kind !== 'planar' || p.area < 100) return false;
        return Math.abs(p.normal[1] + 1) < 0.01;
      });
      const yOff = (p) => p.center[1] * p.normal[1];
      let split = null;
      for (let i = 0; i < arms.length && !split; i++) {
        for (let j = i + 1; j < arms.length; j++) {
          if (Math.abs(yOff(arms[i]) - yOff(arms[j])) > 0.05) continue;
          const dx = arms[i].center[0] - arms[j].center[0];
          const dy = arms[i].center[1] - arms[j].center[1];
          const dz = arms[i].center[2] - arms[j].center[2];
          if (Math.hypot(dx, dy, dz) > 20) split = [arms[i], arms[j]];
        }
      }
      check('coplanar arms that the fillet does not join stay two faces', !!split,
        `candidates=${arms.length}`);
      if (split) {
        const a = new Set(split[0].tris);
        check('a click on one arm does not select the other',
          split[1].tris.every((t) => !a.has(t)));
      }
    }

    if (filletTri >= 0) {
      const nrm = [infos[filletTri].nx, infos[filletTri].ny, infos[filletTri].nz];
      const facet = selectFaceByID(geometry, filletTri, { normal: nrm });
      const onFillet = resolveViewportFaceClick({
        geometry,
        seedFaceIndex: filletTri,
        faceNormal: nrm,
        clickCount: 1,
        faceIDs: mesh.faceID,
        legacy: true,
      });
      const facetSet = new Set(facet);
      check('a click on the fillet stays the coplanar facet',
        onFillet.selectionMode === 'coplanar'
          && onFillet.indices.length === facet.length
          && onFillet.indices.every((t) => facetSet.has(t)),
        `pick=${onFillet.indices.length} facet=${facet.length}`);
    }
  } else if (!r.error) {
    check('mesh is available for the face pick', false, 'no mesh');
  }
}

{
  const vp = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  check('the new mesh warms the face graph', /warmFaceGraph\(geometry, faceIDsRef\.current\)/.test(vp));
  check('Move Face does not pull a tangent blend into the click',
    !/selectMoveFaceWithTangentFillet\(/.test(vp));
  check('Move Face still forces the legacy walk',
    /legacy: legacyTap \|\| !!moveFaceModeRef\.current/.test(vp));
}

if (failed) {
  console.log(`\n${failed} fillet-face-pick check(s) failed`);
  process.exit(1);
}
console.log('\nfillet-face-pick golden passed');
