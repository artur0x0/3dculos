#!/usr/bin/env node
/**
 * Slice 12 — Edge select + centered-hole fix.
 * - resolveHoleUV Center → u=0,v=0
 * - workplane snap emission
 * - selected-edge fillet compose
 * - geometric: merged planar face center within epsilon (c4MeshData fix)
 */
import Module from '../../built/manifold.js';
import {
  composeHelperInsert,
  allocateUniqueName,
  HELPER_PALETTE_ITEMS,
} from '../../src/utils/helperPaletteSnippets.js';
import {
  classifySelectedFace,
  resolveHoleUV,
  resolveFaceModal,
  emitFaceWorkplaneLines,
  emitSelectedEdgeLines,
} from '../../src/utils/faceFeaturePlacement.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('slice-12 edge select + centered-hole smoke');

function _n(v) {
  const L = Math.hypot(...v) || 1;
  return v.map((x) => x / L);
}
function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _mul(s, a) {
  return [s * a[0], s * a[1], s * a[2]];
}
function _cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function _len(v) {
  return Math.hypot(...v);
}

function frameToMatrix(frame) {
  const z = frame.normal;
  const x = frame.x;
  const y = frame.y;
  const c = frame.center;
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    c[0], c[1], c[2], 1,
  ];
}

/** Mirror of sandboxWorker c4MeshData planar merge (slice 12). */
function mergedFaces(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const V = [];
  const nVerts = mesh.vertProperties.length / np;
  for (let i = 0; i < nVerts; i++) {
    V.push([mesh.vertProperties[i * np], mesh.vertProperties[i * np + 1], mesh.vertProperties[i * np + 2]]);
  }
  const faceMap = new Map();
  for (let i = 0; i < mesh.numTri; i++) {
    const fid = mesh.faceID[i];
    if (!faceMap.has(fid)) faceMap.set(fid, []);
    faceMap.get(fid).push(i);
  }
  const faces = [];
  for (const [fid, tris] of faceMap) {
    const cn = [0, 0, 0];
    const c = [0, 0, 0];
    let areaSum = 0;
    for (const t of tris) {
      const v0 = V[mesh.triVerts[t * 3]];
      const v1 = V[mesh.triVerts[t * 3 + 1]];
      const v2 = V[mesh.triVerts[t * 3 + 2]];
      const cxv = _cross(_sub(v1, v0), _sub(v2, v0));
      const area = 0.5 * _len(cxv);
      const tn = _n(cxv);
      cn[0] += tn[0];
      cn[1] += tn[1];
      cn[2] += tn[2];
      const tc = [
        (v0[0] + v1[0] + v2[0]) / 3,
        (v0[1] + v1[1] + v2[1]) / 3,
        (v0[2] + v1[2] + v2[2]) / 3,
      ];
      c[0] += tc[0] * area;
      c[1] += tc[1] * area;
      c[2] += tc[2] * area;
      areaSum += area;
    }
    faces.push({
      id: fid,
      tris,
      normal: _n(cn),
      center: areaSum > 0 ? _mul(1 / areaSum, c) : [0, 0, 0],
    });
  }
  const nF = faces.length;
  const parent = Array.from({ length: nF }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  const t2f = new Int32Array(mesh.numTri).fill(-1);
  for (let fi = 0; fi < nF; fi++) for (const t of faces[fi].tris) t2f[t] = fi;
  const cosPlanar = Math.cos(Math.PI / 180);
  const edgeMapM = new Map();
  for (let t = 0; t < mesh.numTri; t++) {
    const vs = [mesh.triVerts[t * 3], mesh.triVerts[t * 3 + 1], mesh.triVerts[t * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const u = vs[k];
      const w = vs[(k + 1) % 3];
      const key = u < w ? u * 1e9 + w : w * 1e9 + u;
      if (!edgeMapM.has(key)) edgeMapM.set(key, []);
      edgeMapM.get(key).push(t);
    }
  }
  for (const trisE of edgeMapM.values()) {
    if (trisE.length !== 2) continue;
    const f0 = t2f[trisE[0]];
    const f1 = t2f[trisE[1]];
    if (f0 < 0 || f1 < 0 || f0 === f1) continue;
    const A = faces[f0];
    const B = faces[f1];
    if (_dot(A.normal, B.normal) < cosPlanar) continue;
    const offA = _dot(A.center, A.normal);
    const offB = _dot(B.center, A.normal);
    if (Math.abs(offA - offB) > 1e-3) continue;
    union(f0, f1);
  }
  const groups = new Map();
  for (let fi = 0; fi < nF; fi++) {
    const r = find(fi);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(fi);
  }
  const merged = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      merged.push(faces[members[0]]);
      continue;
    }
    const cn = [0, 0, 0];
    const c = [0, 0, 0];
    let areaSum = 0;
    const trisSub = [];
    for (const fi of members) {
      for (const t of faces[fi].tris) {
        trisSub.push(t);
        const v0 = V[mesh.triVerts[t * 3]];
        const v1 = V[mesh.triVerts[t * 3 + 1]];
        const v2 = V[mesh.triVerts[t * 3 + 2]];
        const cxv = _cross(_sub(v1, v0), _sub(v2, v0));
        const area = 0.5 * _len(cxv);
        const tn = _n(cxv);
        cn[0] += tn[0];
        cn[1] += tn[1];
        cn[2] += tn[2];
        const tc = [
          (v0[0] + v1[0] + v2[0]) / 3,
          (v0[1] + v1[1] + v2[1]) / 3,
          (v0[2] + v1[2] + v2[2]) / 3,
        ];
        c[0] += tc[0] * area;
        c[1] += tc[1] * area;
        c[2] += tc[2] * area;
        areaSum += area;
      }
    }
    merged.push({
      tris: trisSub,
      normal: _n(cn),
      center: _mul(1 / areaSum, c),
    });
  }
  return merged;
}


const planarFace = {
  center: [0, 0, 10],
  normal: [0, 0, 1],
  area: 1200,
  triangleCount: 2,
  selectionMode: 'coplanar',
};

// ── resolveHoleUV ──────────────────────────────────────────────
{
  const face = classifySelectedFace(planarFace);
  const c = resolveHoleUV({ placement: 'center', u: 9, v: 9 }, face);
  check('Center mode forces u=0,v=0', c.mode === 'center' && c.u === 0 && c.v === 0);
  const custom = resolveHoleUV({ placement: 'custom', u: 3, v: -2 }, face);
  check('custom UV respected', custom.mode === 'custom' && custom.u === 3 && custom.v === -2);
  const def = resolveHoleUV({ placement: 'center' }, face);
  check('explicit center placement', def.mode === 'center' && def.u === 0 && def.v === 0);
  const legacy = resolveHoleUV({ u: 4, v: 5 }, face);
  check('legacy u/v without placement', legacy.mode === 'literal' && legacy.u === 4 && legacy.v === 5);
}

// ── Workplane snap emission ────────────────────────────────────
{
  const face = classifySelectedFace(planarFace);
  const names = new Set();
  const { lines } = emitFaceWorkplaneLines('part', face, names, allocateUniqueName);
  const joined = lines.join('\n');
  check('snap uses _pc pick center', /_pc/.test(joined));
  check('snap uses _off (not _d clash)', /_off/.test(joined) && !/const _d = \(_pc/.test(joined));
  check('snap mutates fr.center', /fr\.center\s*=/.test(joined) || /\w+\.center\s*=/.test(joined));
}

// ── Compose Center hole ────────────────────────────────────────
{
  const face = classifySelectedFace(planarFace);
  const buf = composeHelperInsert(
    '',
    'hole',
    null,
    { dia: 6, placement: 'center', through: true },
    face,
  );
  check('center hole u,v 0,0', /hole\([^)]*,\s*0,\s*0,\s*6/.test(buf));
  check('center hole has snap _off', /_off/.test(buf));
  check('center hole no illegal top', !/\btop\b/.test(buf));
  check('center hole facesByNormal', /facesByNormal/.test(buf));
}

// ── Edge multi-select fillet ───────────────────────────────────
{
  const edges = [
    { mid: [20, -15, 0], va: [20, -15, -10], vb: [20, -15, 10] },
    { mid: [-20, 15, 0], va: [-20, 15, -10], vb: [-20, 15, 10] },
  ];
  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === 'filletEdges');
  const resolved = resolveFaceModal(item, null, edges);
  check('fillet with edges → params', resolved.mode === 'params');
  check('fillet title mentions edges', /2 edges/.test(resolved.item?.title || ''));

  const refuse = resolveFaceModal(item, null, []);
  check('fillet no edges → refuse', refuse.mode === 'refuse');
  check('refuse mentions Edge pick', /Edge pick/i.test(refuse.message || ''));

  const names = new Set();
  const emitted = emitSelectedEdgeLines('part', edges, names, allocateUniqueName);
  check('emitSelectedEdgeLines ok', emitted.ok);
  check('emit filters convexEdges by mids', /convexEdges/.test(emitted.lines.join('\n')) && /_mids/.test(emitted.lines.join('\n')));

  const buf = composeHelperInsert(
    '',
    'filletEdges',
    null,
    { radius: 2.5, sphericalCorners: true, edgeScope: 'selected' },
    null,
    edges,
  );
  check('fillet snippet uses selEdges', /selEdges/.test(buf));
  check('fillet snippet filletEdges call', /filletEdges\(/.test(buf));
  check('fillet snippet mid literals', /\[20,\s*-15,\s*0\]/.test(buf));
  console.log('\n--- example selected-edge fillet ---\n' + buf + '\n---');
}


// ── Geometric: planar face center after coplanar merge ─────────
{
  console.log('\ngeometric face-center (c4MeshData merge contract)');
  const wasm = await Module();
  wasm.setup();
  const { Manifold } = wasm;

  const cube = Manifold.cube([40, 30, 20], true);
  const faces = mergedFaces(cube);
  check('cube merges to 6 faces', faces.length === 6, `got ${faces.length}`);
  const top = faces.find((f) => f.normal[2] > 0.9);
  check('top face exists', !!top);
  const eps = 1e-6;
  check(
    'top center at [0,0,10] within eps',
    top && Math.hypot(top.center[0], top.center[1]) < eps && Math.abs(top.center[2] - 10) < eps,
    top ? `center=${top.center}` : '',
  );

  const frCenter = top.center;
  const probeR = 1;
  const holeR = 3;
  const frame = { center: frCenter, normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
  const span = 30;
  const w0 = 1 - span / 2;
  const n = frame.normal;
  const c = frame.center;
  const tm = frameToMatrix({
    center: [c[0] + n[0] * w0, c[1] + n[1] * w0, c[2] + n[2] * w0],
    x: frame.x,
    y: frame.y,
    normal: n,
  });
  const cut = Manifold.cylinder(span, holeR, holeR, 32, true).transform(tm);
  const holed = Manifold.difference(cube, cut);
  const probe = Manifold.cylinder(25, probeR, probeR, 16, true);
  const interVol = Manifold.intersection(holed, probe).volume();
  check('hole at face center: probe along axis nearly empty', interVol < 0.5, `vol=${interVol}`);

  const badCut = Manifold.cylinder(span, holeR, holeR, 32, true).transform(
    frameToMatrix({
      center: [-6.6667, -5, 10 + w0],
      x: [1, 0, 0],
      y: [0, 1, 0],
      normal: [0, 0, 1],
    }),
  );
  const badHoled = Manifold.difference(Manifold.cube([40, 30, 20], true), badCut);
  const badInter = Manifold.intersection(badHoled, Manifold.cylinder(25, probeR, probeR, 16, true)).volume();
  check('pre-fix triangle-centroid miss leaves probe solid', badInter > 10, `vol=${badInter}`);
}

if (failed) {
  console.log(`\nFAILED: ${failed}`);
  process.exit(1);
}
console.log('\nAll slice-12 edge + center-hole checks passed.');
