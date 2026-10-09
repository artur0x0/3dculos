/**
 * Shared boundary between two solids that sit flush.
 *
 * Body edges in the viewport are not a stroke. The solid is flat-shaded
 * off-white, so a silhouette or a body edge is the shade break where two
 * view-space normals meet. A cut that keeps both
 * pieces leaves those pieces flush: the new boundary is a real 90° edge on
 * each piece, but the two side faces have the same normal, so the color
 * never changes and the cut disappears.
 *
 * This lists only that boundary — a feature edge (not a coplanar diagonal)
 * that two different bodies occupy in the same place, with side faces
 * agreeing and cap faces opposing. Which triangle was stored first does not
 * matter: a drafted side is tilted off the cap, and the same edge still
 * counts. One body (uncut, or a cut that keeps one side) has no such pair,
 * so it grows no extra edge. The viewport paints these contours as a 1px
 * black line on the edge itself.
 */

const QUANT = 1e4;
const COPLANAR_DOT = Math.cos((1 * Math.PI) / 180);

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-12)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function geoKey(ax, ay, az, bx, by, bz) {
  const q = (n) => Math.round(n * QUANT);
  const A = `${q(ax)},${q(ay)},${q(az)}`;
  const B = `${q(bx)},${q(by)},${q(bz)}`;
  return A < B ? `${A}|${B}` : `${B}|${A}`;
}

/**
 * @param {ArrayLike<number>} vertProperties
 * @param {ArrayLike<number>} triVerts
 * @param {number} [numProp]
 * @returns {{ a: number[], b: number[], capNormal: number[], sideNormal: number[] }[]}
 */
const EDGE_PACK = 0x4000000;

function packedEdgeKey(lo, hi) {
  if (hi >= EDGE_PACK) return `${lo}-${hi}`;
  return lo * EDGE_PACK + hi;
}

export function contactSeamSegments(vertProperties, triVerts, numProp = 3) {
  const vp = vertProperties;
  const idx = triVerts;
  if (!vp || !idx || idx.length < 3) return [];
  const np = numProp || 3;
  const nTri = Math.floor(idx.length / 3);
  if (!nTri) return [];

  const parent = new Uint32Array(nTri);
  for (let i = 0; i < nTri; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    let x = a;
    while (parent[x] !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const vertToTri = new Map();
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      const prev = vertToTri.get(v);
      if (prev === undefined) vertToTri.set(v, t);
      else unite(prev, t);
    }
  }
  // One vertex-connected body has no flush pair with another body.
  let bodies = 0;
  const seenBody = new Uint8Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const r = find(t);
    if (seenBody[r]) continue;
    seenBody[r] = 1;
    bodies++;
    if (bodies > 1) break;
  }
  if (bodies < 2) return [];

  const at = (v) => [vp[v * np], vp[v * np + 1], vp[v * np + 2]];
  const triN = new Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = at(idx[t * 3]);
    const b = at(idx[t * 3 + 1]);
    const c = at(idx[t * 3 + 2]);
    const n = norm([
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ]);
    triN[t] = n;
  }

  const edgeMap = new Map();
  for (let t = 0; t < nTri; t++) {
    if (!triN[t]) continue;
    const i0 = idx[t * 3];
    const i1 = idx[t * 3 + 1];
    const i2 = idx[t * 3 + 2];
    const pairs = [[i0, i1], [i1, i2], [i2, i0]];
    for (const [u, v] of pairs) {
      const lo = u < v ? u : v;
      const hi = u < v ? v : u;
      const key = packedEdgeKey(lo, hi);
      let e = edgeMap.get(key);
      if (!e) {
        e = { u: lo, v: hi, tris: [] };
        edgeMap.set(key, e);
      }
      if (e.tris.length < 2) e.tris.push(t);
    }
  }

  const byGeo = new Map();
  for (const e of edgeMap.values()) {
    if (e.tris.length !== 2) continue;
    const n0 = triN[e.tris[0]];
    const n1 = triN[e.tris[1]];
    if (!n0 || !n1) continue;
    if (dot(n0, n1) > COPLANAR_DOT) continue;
    const pa = at(e.u);
    const pb = at(e.v);
    if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]) < 1e-8) continue;
    const comp = find(e.tris[0]);
    const gk = geoKey(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
    let list = byGeo.get(gk);
    if (!list) {
      list = [];
      byGeo.set(gk, list);
    }
    if (list.some((r) => r.comp === comp)) continue;
    list.push({ comp, n0, n1, a: pa, b: pb });
  }

  const out = [];
  for (const list of byGeo.values()) {
    if (list.length < 2) continue;
    const paired = pairFaces(list[0], list[1]);
    if (!paired) continue;
    out.push({
      a: list[0].a,
      b: list[0].b,
      capNormal: paired.cap,
      sideNormal: paired.side,
    });
  }
  return out;
}

function pairFaces(a, b) {
  // Either correspondence can be the side pair. Picking the larger dot and
  // calling it the side fails once a draft tilts the side toward the cap:
  // the cross-pair dot becomes positive and beats the cap-vs-cap dot of -1
  // whenever the two bodies stored their triangles in opposite order.
  const pairings = [
    [[a.n0, b.n0], [a.n1, b.n1]],
    [[a.n0, b.n1], [a.n1, b.n0]],
  ];
  let best = null;
  for (const [p, q] of pairings) {
    const d0 = dot(p[0], p[1]);
    const d1 = dot(q[0], q[1]);
    let side = null;
    let cap = null;
    let score = -Infinity;
    if (d0 >= 0.85 && d1 <= -0.85) {
      side = p[0];
      cap = q[0];
      score = d0 - d1;
    } else if (d1 >= 0.85 && d0 <= -0.85) {
      side = q[0];
      cap = p[0];
      score = d1 - d0;
    }
    if (side && (!best || score > best.score)) best = { side, cap, score };
  }
  if (!best) return null;
  const side = norm(best.side);
  const cap = norm(best.cap);
  if (!side || !cap) return null;
  return { side, cap };
}
