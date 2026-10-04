#!/usr/bin/env node
/**
 * Move Face on the playtest cap offsets both sides of the duplicate-vertex
 * seam. The drawn mesh drops the needle, so one click is that plane with no
 * edge between the fillet side and the main side. The curved fillet stays
 * its own face.
 *
 * The two regions are already one body and one plane. c4MeshData still sees
 * two faces because the vertices are copies about 0.001mm apart. The second
 * decompose component is the keep-both cut; its contact line is not this cap.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { BufferAttribute, BufferGeometry } from 'three';
import { buildPartGraphPatches } from '../../src/utils/partGraphPatches.js';
import { resolveViewportFaceClick } from '../../src/utils/selectFace.js';
import { dropPlanarFins, isPlanarFin } from '../../src/utils/planarSeam.js';

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
  const z0 = pos[i0 * 3 + 2];
  const z1 = pos[i1 * 3 + 2];
  const z2 = pos[i2 * 3 + 2];
  return {
    nx: nx / len, ny: ny / len, nz: nz / len, area: 0.5 * raw,
    cx: (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3,
    cy: (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3,
    cz: (z0 + z1 + z2) / 3,
    zMin: Math.min(z0, z1, z2),
    zMax: Math.max(z0, z1, z2),
  };
}

console.log('moveFace offsets the whole playtest cap');
{
  const r = await exec(`
let box1 = Manifold.cube([40, 30, 20], true);
let part = box1;
const selEdges = edgesBetween(part, 3, 5);
const path = makeSweepPath(selEdges);
part = filletAlongPath(part, path, 4);
part = hollow(part, 2.5, [{ center: [0, -15, 0], normal: [0, -1, 0] }, { center: [-20, -0.0814, -0.0525], normal: [-1, 0, 0] }, { center: [0, 0, -10], normal: [0, 0, -1] }]);
part = draftFaces(part, [{ center: [0, -1.9752, 10], normal: [0, 0, 1] }, { center: [20, -0.0814, -0.0525], normal: [1, 0, 0] }], 2, { pull: [0, 1, 0], reference: { center: [0, 15, -1.9752], normal: [0, 1, 0] } });
const selEdges2 = [{ a: 75, b: 79, va: [17.500006, -15, 7.500005], vb: [17.500006, 11.048712, 7.500005], length: 26.048712, key: "coh-15-0", n0: [0, 0, -1], n1: [-1, 0, 0], pts: [[17.500006, -15, 7.500005], [17.500006, 11.048712, 7.500005]] }, { a: 79, b: 98, va: [17.500006, 11.048712, 7.500005], vb: [17.500006, 11.548889, 7.396398], length: 0.51254, key: "coh-22-0", n0: [0, -0.062803, -0.998026], n1: [-1, 0, 0], pts: [[17.500006, 11.048712, 7.500005], [17.500006, 11.361927, 7.456096], [17.500006, 11.548889, 7.396398]] }, { a: 98, b: 103, va: [17.500006, 11.548889, 7.396398], vb: [17.500006, 12.060664, 7.060664], length: 0.615859, key: "coh-22-1", n0: [0, -0.528075, -0.849198], n1: [-1, 0, 0], pts: [[17.500006, 11.548889, 7.396398], [17.500006, 11.749999, 7.299045], [17.500006, 11.91315, 7.19003], [17.500006, 12.060664, 7.060664]] }, { a: 103, b: 93, va: [17.500006, 12.060664, 7.060664], vb: [17.500006, 12.345315, 6.663433], length: 0.490383, key: "coh-22-2", n0: [0, -0.729862, -0.683594], n1: [-1, 0, 0], pts: [[17.500006, 12.060664, 7.060664], [17.500006, 12.232179, 6.856119], [17.500006, 12.345315, 6.663433]] }, { a: 93, b: 85, va: [17.500006, 12.345315, 6.663433], vb: [17.500006, 12.500006, 6.048211], length: 0.638427, key: "coh-22-3", n0: [0, -0.975207, -0.221294], n1: [-1, 0, 0], pts: [[17.500006, 12.345315, 6.663433], [17.500006, 12.448895, 6.388229], [17.500006, 12.476648, 6.265923], [17.500006, 12.500006, 6.048211]] }, { a: 77, b: 85, va: [17.500006, 12.500005, -10], vb: [17.500006, 12.500006, 6.048211], length: 16.048211, key: "coh-16-0", n0: [0, -1, 0], n1: [-1, 0, 0], pts: [[17.500006, 12.500005, -10], [17.500006, 12.500006, 6.048211]] }];
const path2 = makeSweepPath(selEdges2);
part = filletAlongPath(part, path2, 4.44, { variableProfile: true });
part = cut(part, { center: [-3.4426, -1.9757, 7.5], normal: [0, 0, -1], offset: 9 });
const selEdges3 = edgesBetween(part, 76, 96);
const path3 = makeSweepPath(selEdges3);
part = filletAlongPath(part, path3, 4.83, { variableProfile: true });
const selEdges4 = [{ a: 467, b: 1207, va: [20, 15, -1.5], vb: [20, 15, 6.049528], length: 7.549528, key: "coh-21-0", n0: [0.999391, 0.034899, 0], n1: [0, 1, 0], pts: [[20, 15, -1.5], [20, 15, 6.049528]] }, { a: 1207, b: 1212, va: [20, 15, 6.049528], vb: [20.007414, 14.787721, 7.285758], length: 1.258735, key: "coh-39-0", n0: [0.999391, 0.034899, -0.000002], n1: [0, 0.995185, 0.098019], pts: [[20, 15, 6.049528], [20.000299, 14.991436, 6.261612], [20.002684, 14.923141, 6.780361], [20.007414, 14.787721, 7.285758]] }, { a: 1212, b: 1226, va: [20.007414, 14.787721, 7.285758], vb: [20.040913, 13.828427, 8.828427], length: 1.830906, key: "coh-39-1", n0: [0.999391, 0.0349, 0.000006], n1: [0, 0.849201, 0.52807], pts: [[20.007414, 14.787721, 7.285758], [20.018715, 14.464102, 8], [20.028866, 14.173413, 8.435045], [20.040913, 13.828427, 8.828427]] }, { a: 1226, b: 1217, va: [20.040913, 13.828427, 8.828427], vb: [20.077904, 12.769155, 9.587491], length: 1.307887, key: "coh-39-2", n0: [0.999391, 0.0349, 0.000006], n1: [0, 0.582477, 0.812847], pts: [[20.040913, 13.828427, 8.828427], [20.062078, 13.222281, 9.325878], [20.077904, 12.769155, 9.587491]] }, { a: 1217, b: 1196, va: [20.077904, 12.769155, 9.587491], vb: [20.137953, 11.049527, 10], length: 1.78219, key: "coh-39-3", n0: [0.999391, 0.0349, 0.000016], n1: [0, 0.162894, 0.986644], pts: [[20.077904, 12.769155, 9.587491], [20.103531, 12.035276, 9.863704], [20.12145, 11.522105, 9.965779], [20.137953, 11.049527, 10]] }, { a: 122, b: 1196, va: [21.047621, -15, 10.909668], vb: [20.137953, 11.049527, 10], length: 26.081274, key: "coh-20-0", n0: [0.999391, 0.034898, -0.000044], n1: [0, 0.034899, 0.999391], pts: [[21.047621, -15, 10.909668], [20.137953, 11.049527, 10]] }];
const path4 = makeSweepPath(selEdges4);
part = filletAlongPath(part, path4, 4.83, { variableProfile: true });
function capCentroid(solid, wantIsland) {
  const mesh = solid.getMesh();
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const np = mesh.numProp || 3;
  let best = null;
  const nTri = tv.length / 3;
  for (let t = 0; t < nTri; t++) {
    const i0 = tv[t * 3], i1 = tv[t * 3 + 1], i2 = tv[t * 3 + 2];
    const x0 = vp[i0 * np], y0 = vp[i0 * np + 1], z0 = vp[i0 * np + 2];
    const x1 = vp[i1 * np], y1 = vp[i1 * np + 1], z1 = vp[i1 * np + 2];
    const x2 = vp[i2 * np], y2 = vp[i2 * np + 1], z2 = vp[i2 * np + 2];
    if (Math.abs(z0 + 10) > 0.15 || Math.abs(z1 + 10) > 0.15 || Math.abs(z2 + 10) > 0.15) continue;
    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
    const nz = ax * by - ay * bx;
    const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, nz);
    if (!(area > 0.2) || !(nz < -0.999 * area * 2)) continue;
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const island = cx > 14 && cy > 8 && cy < 13;
    if (island !== wantIsland) continue;
    if (!best || area > best.area) best = { area, cx, cy };
  }
  if (!best) throw new Error(wantIsland ? 'no fillet-side cap triangle' : 'no main-side cap triangle');
  return [best.cx, best.cy, -10.35];
}
const mainPt = capCentroid(part, false);
const islePt = capCentroid(part, true);
const ballVol = (solid, p) => Manifold.intersection(solid, Manifold.sphere(0.12, 8).translate(p)).volume();
const preN = part.decompose().length;
const preVol = part.volume();
const preLarge = ballVol(part, mainPt);
const preIsland = ballVol(part, islePt);
const shifted = moveFace(part, [{ center: [8.6429, 6.4902, -10.0001], normal: [0, 0, -1] }], 2);
const postLarge = ballVol(shifted, mainPt);
const postIsland = ballVol(shifted, islePt);
globalThis.__note = {
  preN,
  postN: shifted.decompose().length,
  dVol: +(shifted.volume() - preVol).toFixed(3),
  mainPt: mainPt.map((v) => +v.toFixed(3)),
  islePt: islePt.map((v) => +v.toFixed(3)),
  preLarge: +preLarge.toFixed(6),
  postLarge: +postLarge.toFixed(6),
  preIsland: +preIsland.toFixed(6),
  postIsland: +postIsland.toFixed(6),
};
return shifted;
`);
  check('playtest script runs through the cap move', !r.error, r.error || '');
  const n = r.note;
  if (n) console.log('  note', JSON.stringify(n));
  if (!r.error && n) {
    check('the keep-both cut is still two bodies', n.preN === 2 && n.postN === 2, `pre=${n.preN} post=${n.postN}`);
    check('both sides of the cap moved', n.dVol > 360 && n.dVol < 420, `dVol=${n.dVol}`);
    check('the main side was empty just outside and is solid after', n.preLarge < 1e-6 && n.postLarge > 1e-4,
      `pre=${n.preLarge} post=${n.postLarge}`);
    check('the fillet side was empty just outside and is solid after', n.preIsland < 1e-6 && n.postIsland > 1e-4,
      `pre=${n.preIsland} post=${n.postIsland}`);
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
    const rawIndex = Uint32Array.from(mesh.triVerts);
    const fin = dropPlanarFins(pos, rawIndex, mesh.faceID);
    const keptKey = new Set();
    for (let i = 0; i < fin.indices.length; i += 3) {
      keptKey.add(`${fin.indices[i]},${fin.indices[i + 1]},${fin.indices[i + 2]}`);
    }
    let droppedArea = 0;
    for (let t = 0; t < rawIndex.length / 3; t++) {
      const key = `${rawIndex[t * 3]},${rawIndex[t * 3 + 1]},${rawIndex[t * 3 + 2]}`;
      if (keptKey.has(key)) continue;
      const i0 = rawIndex[t * 3];
      const i1 = rawIndex[t * 3 + 1];
      const i2 = rawIndex[t * 3 + 2];
      const ax = pos[i1 * 3] - pos[i0 * 3];
      const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
      const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
      const bx = pos[i2 * 3] - pos[i0 * 3];
      const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
      const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
      droppedArea += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    }
    check('the needle between the cap copies is dropped', fin.dropped > 0 && droppedArea < 1,
      `dropped=${fin.dropped} area=${droppedArea.toFixed(4)}`);
    const index = fin.indices;
    const numTri = index.length / 3;
    const cosCap = Math.cos((0.5 * Math.PI) / 180);
    const cosFillet = Math.cos((20 * Math.PI) / 180);
    let movedArea = 0;
    let stayedArea = 0;
    let largeTri = -1;
    let islandTri = -1;
    let filletTri = -1;
    let finLeft = 0;
    const infos = new Array(numTri);
    for (let t = 0; t < numTri; t++) {
      const info = triInfo(pos, index, t);
      infos[t] = info;
      const onMoved = info.nz < -cosCap && info.zMax < -11.7 && info.zMin > -12.3;
      const onStayed = info.nz < -cosCap && info.zMax < -9.7 && info.zMin > -10.3;
      if (onMoved && info.area > 1e-6) {
        movedArea += info.area;
        if (info.cx < 0 && (largeTri < 0 || info.area > infos[largeTri].area)) largeTri = t;
        if (info.cx > 14 && info.cy > 8 && info.cy < 13 && (islandTri < 0 || info.area > infos[islandTri].area)) islandTri = t;
      }
      if (onStayed && info.area > 1e-4) stayedArea += info.area;
      if (filletTri < 0 && info.area > 0.2 && -info.nz < cosFillet && info.cz < -8 && info.cz > -12.5) filletTri = t;
      if (isPlanarFin(pos, index, t) && info.zMax < -11.5 && info.zMin > -12.4) finLeft++;
    }
    check('the moved cap is the whole plane', movedArea > 160, `area=${movedArea.toFixed(1)}`);
    check('nothing of that plane stayed at the old height', stayedArea < 0.5, `area=${stayedArea.toFixed(3)}`);
    check('the drawn cap has no needle left on it', finLeft === 0, `n=${finLeft}`);
    check('both sides of the cap are in the moved mesh', largeTri >= 0 && islandTri >= 0,
      `large=${largeTri} island=${islandTri}`);

    if (largeTri >= 0 && islandTri >= 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      geometry.setIndex(new BufferAttribute(index, 1));
      const graph = buildPartGraphPatches({
        positions: pos,
        indices: index,
        faceIDs: fin.faceIDs,
      });
      const cap = graph.patches[graph.triPatch[largeTri]];
      const islandPatch = graph.triPatch[islandTri];
      const curvedInCap = cap.tris.some((t) => infos[t].area > 1e-6 && -infos[t].nz < cosFillet);
      check('one planar patch holds both sides',
        cap?.kind === 'planar' && islandPatch === cap.id && !curvedInCap,
        `kind=${cap?.kind} same=${islandPatch === cap?.id} curved=${curvedInCap}`);
      const click = (legacy) => resolveViewportFaceClick({
        geometry,
        seedFaceIndex: largeTri,
        faceNormal: [0, 0, -1],
        clickCount: 1,
        faceIDs: fin.faceIDs,
        legacy,
      });
      for (const legacy of [false, true]) {
        const picked = click(legacy);
        const set = new Set(picked.indices);
        const curved = picked.indices.some((t) => infos[t].area > 1e-6 && -infos[t].nz < cosFillet);
        check(`${legacy ? 'Move Face' : 'default'} one click is the whole cap`,
          picked.kind === 'planar' && set.has(largeTri) && set.has(islandTri) && !curved,
          `n=${picked.indices.length} island=${set.has(islandTri)} curved=${curved}`);
      }
      if (filletTri >= 0) {
        const picked = click(false);
        check('the curved fillet is not in that click', !new Set(picked.indices).has(filletTri));
      } else {
        check('a curved fillet triangle sits beside the cap', false);
      }
    }
  } else if (!r.error) {
    check('mesh is available', false, 'no mesh');
  }
}

{
  const worker = readFileSync(new URL('../../src/workers/sandboxWorker.js', import.meta.url), 'utf8');
  const vp = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const fillet = readFileSync(new URL('../../src/utils/filletAlongPath.js', import.meta.url), 'utf8');
  const scraps = worker.match(/scrapVol > 0\.05 \* bestVol && scrapVol > 1e-2/g) || [];
  check('fillet arc stays 24 segments', /export const FILLET_ARC_SEGMENTS = 24;/.test(fillet));
  check('scrap gate is unchanged', scraps.length === 2, `n=${scraps.length}`);
  check('Move Face still forces the legacy walk',
    /legacy: legacyTap \|\| !!moveFaceModeRef\.current/.test(vp));
  check('moveFace includes the coplanar seam',
    /const sel = _c4ExpandCoplanarSeam\(md, _c4ResolveFaceSelection\(/.test(worker));
  check('the drawn mesh drops the needle before the face graph',
    /dropPlanarFins\(vertProperties, srcIndex, srcFaceID\)/.test(vp)
    && /warmFaceGraph\(geometry, faceIDsRef\.current\)/.test(vp));
}

if (failed) {
  console.log(`\n${failed} fillet-cap-move check(s) failed`);
  process.exit(1);
}
console.log('\nfillet-cap-move golden passed');
