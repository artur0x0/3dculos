#!/usr/bin/env node
/**
 * Face-select boundaries (Artur iPhone playtest #1–#4). App path end to end:
 * sandbox mesh → buildSolidGeometry (fin drop + feature sources) →
 * resolveViewportFaceClick → highlightBoundaryPositions.
 *
 *   #1 box top with the loft "boss" on it → one face, outline has no
 *      interior diagonals (dropped needle left a T-junction the old outline drew).
 *   #2 box-edge fillet → exactly that fillet op (not the tangent fillets it
 *      touches), outline has no strip seams.
 *   #3 fillet on a loft generator → only the fillet, never the G1 loft wall.
 *   #4 loft end cap → one face, no interior diagonal.
 *   Long filleted box edge (fine, tangent chain, coarse strips) → one face.
 *   Planar face with split-vertex seams / a dropped needle → one face.
 */
import { DEFAULT_SCRIPT } from '../../src/utils/defaultScript.js';
import { buildSolidGeometry } from '../../src/utils/partSolidCache.js';
import { resolveViewportFaceClick } from '../../src/utils/selectFace.js';
import { highlightBoundaryPositions } from '../../src/utils/planarSeam.js';
import { readFileSync } from 'node:fs';
import { loadSandbox } from './scs_sandbox.mjs';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function triOf(geometry, t) {
  const p = geometry.attributes.position.array;
  const ix = geometry.index.array;
  const v = [0, 1, 2].map((k) => { const i = ix[t * 3 + k]; return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]; });
  const a = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
  const b = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(...n);
  return { v, n: l ? n.map((x) => x / l) : [0, 0, 0], area: l / 2, c: [0, 1, 2].map((k) => (v[0][k] + v[1][k] + v[2][k]) / 3) };
}
const tris = (s) => Array.from({ length: s.geometry.index.count / 3 }, (_, t) => triOf(s.geometry, t));
const isAxis = (n) => n.some((x) => Math.abs(Math.abs(x) - 1) < 1e-4);
const areaOf = (T, list) => list.reduce((a, t) => a + T[t].area, 0);
function click(s, seed) {
  return resolveViewportFaceClick({
    geometry: s.geometry, seedFaceIndex: seed, faceNormal: triOf(s.geometry, seed).n, clickCount: 1, faceIDs: s.faceIDs,
  });
}
function segLength(seg) {
  let L = 0;
  for (let i = 0; i < seg.length; i += 6) L += Math.hypot(seg[i + 3] - seg[i], seg[i + 4] - seg[i + 1], seg[i + 5] - seg[i + 2]);
  return L;
}
/**
 * Outline segments whose two sides are both picked triangles: the midpoint
 * nudged 0.02 mm either way (in the host triangle's plane) lands on the pick.
 */
function interiorSegments(s, indices, seg) {
  const sel = indices.map((t) => triOf(s.geometry, t)).filter((T) => T.area > 1e-9);
  const onTri = (p, T, tol) => {
    const [a, b, c] = T.v;
    const n = T.n;
    const d = (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2];
    if (Math.abs(d) > 0.01) return false;
    const q = [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
    const v0 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const v1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v2 = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
    const dt = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const d00 = dt(v0, v0); const d01 = dt(v0, v1); const d02 = dt(v0, v2); const d11 = dt(v1, v1); const d12 = dt(v1, v2);
    const inv = 1 / (d00 * d11 - d01 * d01 || 1);
    const u = (d11 * d02 - d01 * d12) * inv;
    const w = (d00 * d12 - d01 * d02) * inv;
    return u >= -tol && w >= -tol && u + w <= 1 + tol;
  };
  let interior = 0;
  for (let i = 0; i < seg.length; i += 6) {
    const a = seg.slice(i, i + 3);
    const b = seg.slice(i + 3, i + 6);
    const m = a.map((x, k) => (x + b[k]) / 2);
    const e = b.map((x, k) => x - a[k]);
    const L = Math.hypot(...e);
    if (L < 0.1) continue;
    const host = sel.find((T) => onTri(m, T, 1e-6));
    if (!host) continue;
    const side = [host.n[1] * e[2] - host.n[2] * e[1], host.n[2] * e[0] - host.n[0] * e[2], host.n[0] * e[1] - host.n[1] * e[0]].map((x) => x / L);
    const p1 = m.map((x, k) => x + side[k] * 0.02);
    const p2 = m.map((x, k) => x - side[k] * 0.02);
    if (sel.some((T) => onTri(p1, T, 0)) && sel.some((T) => onTri(p2, T, 0))) interior++;
  }
  return interior;
}

const { exec } = await loadSandbox();
async function build(script) {
  const payload = await exec(script);
  return { payload, ...buildSolidGeometry(payload.mesh) };
}

console.log('Artur Testpart (default script: box, 2 fillets, loft, 2 fillets, hole)');
{
  const s = await build(DEFAULT_SCRIPT);
  const T = tris(s);
  check('worker tags fillet ops on the runs', Array.isArray(s.payload.mesh.runFeature) && s.payload.mesh.runFeature.some((k) => k < 0));
  check('solid carries a feature source per kept triangle', s.geometry.userData.triSource?.length === T.length);

  // #1 — box top z=10 around the loft foot.
  const top = [];
  T.forEach((t, i) => { if (t.area > 1e-9 && t.n[2] > 0.99999 && Math.abs(t.c[2] - 10) < 0.01) top.push(i); });
  const topSet = new Set(top);
  let worst = 1;
  let curvedIn = 0;
  for (const seed of top) {
    const r = click(s, seed);
    const set = new Set(r.indices);
    worst = Math.min(worst, areaOf(T, top.filter((t) => set.has(t))) / areaOf(T, top));
    curvedIn = Math.max(curvedIn, r.indices.filter((t) => !topSet.has(t) && T[t].area > 1e-5).length);
  }
  check('#1 every tap on the box top selects the whole face', worst > 0.9999, `worst=${(worst * 100).toFixed(2)}%`);
  check('#1 nothing off that plane comes along', curvedIn === 0, `extra=${curvedIn}`);
  const r1 = click(s, top[0]);
  const seg1 = highlightBoundaryPositions(s.geometry.attributes.position, s.geometry.index.array, r1.indices);
  check('#1 outline has no interior diagonals', interiorSegments(s, r1.indices, seg1) === 0);
  const want1 = 2 * (2 * 15.17 + 26) + 2 * Math.PI * 5; // trimmed rect (fillets r=4 / 4.83) + loft foot r=5
  check('#1 outline is the real boundary (rect + loft foot)', Math.abs(segLength(seg1) - want1) < 2, `len=${segLength(seg1).toFixed(2)} want≈${want1.toFixed(2)}`);

  // #4 — loft end cap z=30 (20 × 12).
  const cap = [];
  T.forEach((t, i) => { if (t.area > 1e-9 && t.n[2] > 0.99999 && Math.abs(t.c[2] - 30) < 0.01) cap.push(i); });
  let capWorst = 1;
  for (const seed of cap) {
    const set = new Set(click(s, seed).indices);
    capWorst = Math.min(capWorst, areaOf(T, cap.filter((t) => set.has(t))) / areaOf(T, cap));
  }
  check('#4 every tap on the loft cap selects the whole cap', capWorst > 0.9999 && cap.length > 2, `worst=${(capWorst * 100).toFixed(2)}% tris=${cap.length}`);
  const r4 = click(s, cap[0]);
  const seg4 = highlightBoundaryPositions(s.geometry.attributes.position, s.geometry.index.array, r4.indices);
  check('#4 outline has no interior diagonal', interiorSegments(s, r4.indices, seg4) === 0);
  // One corner is the generator fillet. A sliver that welds at only one end
  // can draw beside the real side (about 2 mm of measured length, a few
  // thousandths of a millimetre apart). A doubled side or a stopped side fails.
  check('#4 outline is the 20 × 12 rectangle', segLength(seg4) > 63 && segLength(seg4) < 67.5, `len=${segLength(seg4).toFixed(2)}`);

  // #2 — fillet 2 wraps the x=20 edges (r=4.83); fillet 1 runs y=15 (|x|<15.2),
  // fillet 4 wraps x=−20. All three meet tangentially at the corners.
  const curved = (t) => T[t].area > 1e-9 && !isAxis(T[t].n) && T[t].c[2] > 4 && T[t].c[2] < 10.01;
  const f2 = []; const f1 = []; const f4 = [];
  T.forEach((t, i) => {
    if (!curved(i) && !(T[i].area > 1e-9 && !isAxis(t.n) && t.c[0] > 15.25 && t.c[2] <= 4)) return;
    if (t.c[0] > 15.25) f2.push(i);
    else if (t.c[0] < -15.25) f4.push(i);
    else if (t.c[1] > 10.5 && Math.abs(t.c[0]) < 15.15) f1.push(i);
  });
  const seed2 = f2.reduce((b, t) => (T[t].area > T[b].area ? t : b), f2[0]);
  const r2 = click(s, seed2);
  const set2 = new Set(r2.indices);
  const cover2 = areaOf(T, f2.filter((t) => set2.has(t))) / areaOf(T, f2);
  check('#2 one tap selects the whole box-edge fillet', cover2 > 0.995, `cover=${(cover2 * 100).toFixed(2)}% of ${areaOf(T, f2).toFixed(1)}`);
  check('#2 the tangent fillets on either side stay out', !f1.some((t) => set2.has(t)) && !f4.some((t) => set2.has(t)),
    `f1=${f1.filter((t) => set2.has(t)).length} f4=${f4.filter((t) => set2.has(t)).length}`);
  check('#2 no flat face triangles in the fillet pick', !r2.indices.some((t) => isAxis(T[t].n) && T[t].area > 1e-3));
  const seg2 = highlightBoundaryPositions(s.geometry.attributes.position, s.geometry.index.array, r2.indices);
  check('#2 outline has no strip seams (no stripes)', interiorSegments(s, r2.indices, seg2) === 0, `segs=${seg2.length / 6}`);

  // #3 — fillet r=1.98 on the loft generator (4.63, 2.78, 11.23) → (10, 6, 30).
  const A = [4.634159, 2.780495, 11.230769];
  const B = [10, 6, 30];
  const dLine = (p) => {
    const e = B.map((x, k) => x - A[k]);
    const w = p.map((x, k) => x - A[k]);
    const t = (w[0] * e[0] + w[1] * e[1] + w[2] * e[2]) / (e[0] ** 2 + e[1] ** 2 + e[2] ** 2);
    return Math.hypot(...w.map((x, k) => x - t * e[k]));
  };
  const mid = T.findIndex((t) => t.area > 1e-4 && t.c[2] > 18 && t.c[2] < 22 && dLine(t.c) < 0.7);
  const r3 = click(s, mid);
  const a3 = areaOf(T, r3.indices);
  const far = r3.indices.filter((t) => T[t].area > 1e-6 && dLine(T[t].c) > 2.6);
  check('#3 fillet next to the loft is one face of fillet size', mid >= 0 && a3 > 35 && a3 < 45, `area=${a3.toFixed(1)} (wall+fillet was ≈272)`);
  check('#3 nothing from the loft wall spills in', far.length === 0, `far tris=${far.length}`);
  const seg3 = highlightBoundaryPositions(s.geometry.attributes.position, s.geometry.index.array, r3.indices);
  check('#3 outline has no interior seams', interiorSegments(s, r3.indices, seg3) === 0);
  const wallSeed = T.findIndex((t) => t.area > 1e-3 && t.c[2] > 18 && t.c[2] < 22 && dLine(t.c) > 4 && t.c[0] > 3 && !isAxis(t.n));
  const wall = new Set(click(s, wallSeed).indices);
  check('#3 a loft-wall tap does not take the fillet', !r3.indices.some((t) => wall.has(t)));
}

console.log('Loft rectangle cap (circle 64 → 20×12, the LoftZilla stop)');
{
  // Bare loft, same helpers as a part: the cap face is the whole rectangle, but
  // a 0.006 mm sliver welded into the 0.02 mm outline and the long sides stopped
  // mid-edge (about 38 mm of line instead of the 64 mm loop).
  const script = `
const fr = { center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 64));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
return placeInFrame(fr, makeLoft([xs0, xs1]));
`;
  const s = await build(script);
  const T = tris(s);
  const cap = [];
  T.forEach((t, i) => { if (t.area > 1e-9 && t.n[2] > 0.99999 && Math.abs(t.c[2] - 20) < 0.05) cap.push(i); });
  let worst = 1;
  for (const seed of cap) {
    const set = new Set(click(s, seed).indices);
    worst = Math.min(worst, areaOf(T, cap.filter((t) => set.has(t))) / areaOf(T, cap));
  }
  check('loft cap: every tap selects the whole rectangle', worst > 0.999 && cap.length > 2, `worst=${(worst * 100).toFixed(2)}% tris=${cap.length}`);
  const r = click(s, cap[0]);
  const seg = highlightBoundaryPositions(s.geometry.attributes.position, s.geometry.index.array, r.indices);
  check('loft cap: outline has no interior line', interiorSegments(s, r.indices, seg) === 0);
  check('loft cap: outline is the full 64 mm loop', Math.abs(segLength(seg) - 64) < 1, `len=${segLength(seg).toFixed(2)}`);
  const ends = [];
  for (let i = 0; i < seg.length; i += 6) {
    ends.push([seg[i], seg[i + 1], seg[i + 2]]);
    ends.push([seg[i + 3], seg[i + 4], seg[i + 5]]);
  }
  const used = new Array(ends.length).fill(false);
  let open = 0;
  for (let i = 0; i < ends.length; i++) {
    if (used[i]) continue;
    let n = 0;
    for (let j = i; j < ends.length; j++) {
      const d = Math.hypot(ends[j][0] - ends[i][0], ends[j][1] - ends[i][1], ends[j][2] - ends[i][2]);
      if (d <= 0.05) { used[j] = true; n++; }
    }
    if (n === 1) open++;
  }
  check('loft cap: the outline meets itself', open === 0, `openEnds=${open}`);
  // Both long sides run the full 20 mm, not stopping at the sliver.
  for (const y of [6, -6]) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < seg.length; i += 6) {
      const ay = seg[i + 1];
      const by = seg[i + 4];
      if (Math.abs(ay - y) > 0.05 || Math.abs(by - y) > 0.05) continue;
      lo = Math.min(lo, seg[i], seg[i + 3]);
      hi = Math.max(hi, seg[i], seg[i + 3]);
    }
    check(`loft cap: y=${y} side runs corner to corner`, lo < -9.9 && hi > 9.9, `x ${lo.toFixed(2)}→${hi.toFixed(2)}`);
  }
}

console.log('Rounded box + hole + underside loft (lower front fillet chain)');
for (const segments of [8, 16, 32]) {
  // The gate comes from this segment count (360°/segments × 1.15, clamped).
  // One click is every tangent fillet, including corners, not the flats or the loft.
  const script = `
let part = roundedBox([40, 30, 20], 3, ${segments});
part = part.subtract(Manifold.cylinder(30, 2.5, 2.5, 32, true));
const fr = { center: [0, 7, -10], normal: [0, 0, -1], x: [1, 0, 0], y: [0, 1, 0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 64));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
part = part.add(placeInFrame(fr, makeLoft([xs0, xs1])));
return part;
`;
  const s = await build(script);
  const step = 360 / segments;
  const tagged = (s.payload.mesh.featureTessellation || []).some((row) => Math.abs(row.facetDeg - step) < 1e-6);
  const T = tris(s);
  const seeds = [];
  T.forEach((t, i) => {
    if (t.area < 1e-4) return;
    if (t.c[1] < 10 || t.c[1] > 16 || t.c[2] < -12 || t.c[2] > -6) return;
    if (Math.abs(t.c[0]) > 12) return;
    if (Math.abs(t.n[0]) > 0.45) return;
    if (t.n[1] < 0.15 || t.n[2] > -0.15) return;
    seeds.push(i);
  });
  const seed = seeds[Math.floor(seeds.length / 2)];
  const r = seed == null ? { indices: [] } : click(s, seed);
  const picked = r.indices.map((t) => T[t]);
  const area = picked.reduce((a, t) => a + t.area, 0);
  const flat = picked.filter((t) => t.area > 1 && isAxis(t.n)).length;
  const loft = picked.filter((t) => t.c[2] < -10.5).length;
  const corner = picked.some((t) => Math.abs(t.c[0]) > 18 && t.c[1] > 12 && t.c[2] < -7);
  const sideFillet = picked.some((t) => Math.abs(t.c[0]) > 18 && Math.abs(t.c[1]) < 8 && t.c[2] < -6);
  check(`${segments}-seg rounded box records facet step ${step}°`, tagged);
  check(`${segments}-seg lower front fillet seed exists`, seeds.length > 0, `n=${seeds.length}`);
  check(`${segments}-seg pick is the whole tangent fillet chain`, area > 1100 && area < 1800, `area=${area.toFixed(1)}`);
  check(`${segments}-seg chain wraps the corner onto the side fillet`, corner && sideFillet);
  check(`${segments}-seg flats stay out of the fillet chain`, flat === 0, `flatTris=${flat}`);
  check(`${segments}-seg loft stays out of the fillet chain`, loft === 0, `loftTris=${loft}`);
}

console.log('Separate fillet calls stay separate; one call with two radii splits');
{
  const separate = await build(`
let part = Manifold.cube([40, 30, 20], true);
part = filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 3);
part = filletAlongPath(part, makeSweepPath(edgesBetween(part, 2, 3)), 3);
return part;
`);
  const Ts = tris(separate);
  const curved = [];
  Ts.forEach((t, i) => { if (t.area > 1 && !isAxis(t.n)) curved.push(i); });
  const a = curved[0];
  const pickA = new Set(click(separate, a).indices);
  const b = curved.find((t) => !pickA.has(t));
  check('two fillet calls leave a second fillet unselected', b != null && !pickA.has(b));
  const radii = await build(`
let part = Manifold.cube([40, 30, 20], true);
const e1 = edgesBetween(part, 0, 1);
const e2 = edgesBetween(part, 1, 2);
const edges = e1.concat(e2);
part = filletEdges(part, edges, edges.map((_, i) => i < e1.length ? 3 : 8), { sphericalCorners: true });
return part;
`);
  const Tr = tris(radii);
  const curvedR = [];
  Tr.forEach((t, i) => { if (t.area > 0.2 && !isAxis(t.n)) curvedR.push(i); });
  const seedR = curvedR[0];
  const pickR = new Set(click(radii, seedR).indices);
  const other = curvedR.find((t) => !pickR.has(t));
  const areaR = [...pickR].reduce((acc, t) => acc + Tr[t].area, 0);
  const otherArea = other == null ? 0 : click(radii, other).indices.reduce((acc, t) => acc + Tr[t].area, 0);
  check('one filletEdges call with two radii stays two faces',
    other != null && otherArea > 20 && areaR > 20 && Math.abs(areaR - otherArea) > 20,
    `a=${areaR.toFixed(1)} b=${otherArea.toFixed(1)}`);
}

console.log('Long filleted box edge');
for (const [label, script, analytic, n] of [
  ['200 mm edge r=6', 'let part = Manifold.cube([200, 30, 30], true);\npart = filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 6);\nreturn part;', (Math.PI / 2) * 6 * 200, 1],
  ['tangent chain (second fillet on the next edge)', 'let part = Manifold.cube([200, 30, 30], true);\npart = filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 6);\npart = filletAlongPath(part, makeSweepPath(edgesBetween(part, 2, 3)), 6);\nreturn part;', (Math.PI / 2) * 6 * 200, 2],
  ['coarse strips (segments: 4) clear the flat-lock gate', 'let part = Manifold.cube([120, 30, 30], true);\npart = filletAlongPath(part, makeSweepPath(edgesBetween(part, 3, 5)), 10, { segments: 4 });\nreturn part;', (Math.PI / 2) * 10 * 120, 1],
]) {
  const s = await build(script);
  const T = tris(s);
  const curved = [];
  T.forEach((t, i) => { if (t.area > 1e-9 && !isAxis(t.n)) curved.push(i); });
  // Seed on the longest-run fillet: the strip with the largest area.
  const seed = curved.reduce((b, t) => (T[t].area > T[b].area ? t : b), curved[0]);
  const r = click(s, seed);
  const a = areaOf(T, r.indices);
  // Faceted area sits a little under the arc.
  check(`${label}: one tap = the whole fillet`, Math.abs(a - analytic * 0.99) / analytic < 0.015, `area=${a.toFixed(1)} arc=${analytic.toFixed(1)} n=${r.indices.length}`);
  check(`${label}: only curved triangles`, !r.indices.some((t) => isAxis(T[t].n) && T[t].area > 1e-3));
  if (n === 2) check(`${label}: the second fillet is its own face`, areaOf(T, curved) - a > 100, `rest=${(areaOf(T, curved) - a).toFixed(1)}`);
  const seg = highlightBoundaryPositions(s.geometry.attributes.position, s.geometry.index.array, r.indices);
  check(`${label}: outline has no strip seams`, interiorSegments(s, r.indices, seg) === 0);
}

console.log('Planar face with split-vertex seams (through buildSolidGeometry)');
{
  // Top 40 × 30 at z=20. Diagonal a→b with a needle (a, b, c) where c is a
  // copy of b 0.004 mm back along it — what a fillet boolean leaves; the fin
  // drop removes it and the two halves share only `a`. A second seam at
  // x=10 splits the right part with copies 0.001 mm apart plus a T-junction.
  const P = [];
  const v = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
  const I = [];
  const tri = (a, b, c) => I.push(a, b, c);
  const a = v(-20, -15, 20); const e = v(-20, 15, 20);
  const b = v(10, 15, 20); const d = v(10, -15, 20);
  const dir = [30, 30].map((x) => x / Math.hypot(30, 30));
  const c = v(10 - 0.004 * dir[0], 15 - 0.004 * dir[1], 20);
  const d2 = v(10.001, -15, 20); const b2 = v(10.001, 15, 20); const m2 = v(10.001, 0, 20);
  const f = v(20, -15, 20); const g = v(20, 15, 20);
  tri(a, d, b); tri(a, b, c); tri(a, c, e); // needle in the middle
  tri(d2, f, m2); tri(m2, f, g); tri(m2, g, b2); // right strip: T-junction at m2
  const ba = v(-20, -15, 0); const bf = v(20, -15, 0); const bg = v(20, 15, 0); const be = v(-20, 15, 0);
  tri(ba, be, bg); tri(ba, bg, bf);
  tri(ba, bf, f); tri(ba, f, d2); tri(ba, d2, d); tri(ba, d, a);
  tri(bf, bg, g); tri(bf, g, f);
  tri(bg, be, e); tri(bg, e, b); tri(bg, b, b2); tri(bg, b2, g);
  tri(be, ba, a); tri(be, a, e);
  const mesh = { numProp: 3, vertProperties: P, triVerts: I, faceID: I.map((_, i) => i).filter((i) => i % 3 === 0).map((i) => i / 3) };
  const s = buildSolidGeometry(mesh);
  const T = tris(s);
  const zeroTop = T.filter((t) => Math.abs(t.c[2] - 20) < 1e-6 && t.area < 1e-6).length;
  check('the top needle is dropped from the drawn mesh (T-junction left behind)', T.length < I.length / 3 && zeroTop === 0, `tris=${T.length} zeroTop=${zeroTop}`);
  const top = [];
  T.forEach((t, i) => { if (t.area > 1e-6 && t.n[2] > 0.9999 && Math.abs(t.c[2] - 20) < 1e-6) top.push(i); });
  let worst = 1;
  for (const seed of top) {
    const set = new Set(click(s, seed).indices);
    worst = Math.min(worst, areaOf(T, top.filter((t) => set.has(t))) / 1200);
  }
  check('every tap selects the whole 40 × 30 face', worst > 0.999, `worst=${(worst * 100).toFixed(2)}%`);
  const r = click(s, top[0]);
  const seg = highlightBoundaryPositions(s.geometry.attributes.position, s.geometry.index.array, r.indices);
  check('outline has no interior diagonal or seam', interiorSegments(s, r.indices, seg) === 0, `segs=${seg.length / 6}`);
  check('outline is the 140 mm perimeter', Math.abs(segLength(seg) - 140) < 0.05, `len=${segLength(seg).toFixed(3)}`);
}

console.log('Render + docs');
{
  const view = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const at = view.indexOf('const highlightMesh = new ThreeMesh(highlightGeometry');
  const hl = at >= 0 ? view.slice(at, at + 400) : '';
  check('highlight fill is offset toward the camera and writes no depth (no z-fight stripes)',
    /polygonOffset: true/.test(hl) && /polygonOffsetFactor: -1/.test(hl) && /depthWrite: false/.test(hl));
  const arch = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');
  check('architecture.md documents the face-graph walls', /feature source/i.test(arch) && /graph rebuilds/i.test(arch));
  check('architecture.md documents the loft outline stop and the 1.1 mm crease gap', /0\.006 mm/.test(arch) && /1\.1 mm/.test(arch));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll face-select boundary checks passed');
process.exit(0);
