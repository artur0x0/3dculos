/**
 * Measure picks and the numbers they produce.
 *
 * A tap adds a point, edge, face, or part. The same pick again removes it.
 * Nothing here writes a script. Lengths stay millimetres; the card formats
 * them with the global display unit.
 *
 * Pairwise numbers use the last two picks. Radius and diameter stay on
 * every circular edge and cylindrical face in the set.
 */

export const MEASURE_POINT_SLOP_PX = 12;
export const MEASURE_PARALLEL_DEG = 1;
/** A face hit this close to an edge, in millimetres, is that edge. */
export const MEASURE_EDGE_GAP_MM = 4;
const CIRCLE_CV = 0.02;
const CYLINDER_CV = 0.03;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sub(a, b) {
  return [num(a?.[0]) - num(b?.[0]), num(a?.[1]) - num(b?.[1]), num(a?.[2]) - num(b?.[2])];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function dist(a, b) {
  return len(sub(a, b));
}

function norm(a) {
  const l = len(a);
  if (!(l > 1e-12)) return [0, 0, 1];
  return [a[0] / l, a[1] / l, a[2] / l];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function centroid(points) {
  const c = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = points.length || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

export function uniquePoints(points, eps = 1e-4) {
  const out = [];
  for (const p of points || []) {
    if (!p || p.length < 3) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    const z = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (out.some((q) => Math.hypot(q[0] - x, q[1] - y, q[2] - z) <= eps)) continue;
    out.push([x, y, z]);
  }
  return out;
}

/** Symmetric 3×3 Jacobi. `m` is [a00, a01, a02, a11, a12, a22]. */
function jacobiEigen(m) {
  const A = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 24; iter += 1) {
    let p = 0;
    let q = 1;
    let max = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > max) {
      p = 0;
      q = 2;
      max = Math.abs(A[0][2]);
    }
    if (Math.abs(A[1][2]) > max) {
      p = 1;
      q = 2;
      max = Math.abs(A[1][2]);
    }
    if (max < 1e-12) break;
    const app = A[p][p];
    const aqq = A[q][q];
    const apq = A[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    A[p][q] = 0;
    A[q][p] = 0;
    for (let k = 0; k < 3; k += 1) {
      if (k === p || k === q) continue;
      const aik = A[k][p];
      const akq = A[k][q];
      A[k][p] = c * aik - s * akq;
      A[p][k] = A[k][p];
      A[k][q] = s * aik + c * akq;
      A[q][k] = A[k][q];
    }
    for (let k = 0; k < 3; k += 1) {
      const vip = V[k][p];
      const viq = V[k][q];
      V[k][p] = c * vip - s * viq;
      V[k][q] = s * vip + c * viq;
    }
  }
  return {
    values: [A[0][0], A[1][1], A[2][2]],
    vectors: [
      [V[0][0], V[1][0], V[2][0]],
      [V[0][1], V[1][1], V[2][1]],
      [V[0][2], V[1][2], V[2][2]],
    ],
  };
}

function principalAxes(points) {
  const c = centroid(points);
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let xz = 0;
  let yz = 0;
  for (const p of points) {
    const x = p[0] - c[0];
    const y = p[1] - c[1];
    const z = p[2] - c[2];
    xx += x * x;
    yy += y * y;
    zz += z * z;
    xy += x * y;
    xz += x * z;
    yz += y * z;
  }
  return { center: c, ...jacobiEigen([xx, xy, xz, yy, yz, zz]) };
}

function solve3(a00, a01, a02, b0, a10, a11, a12, b1, a20, a21, a22, b2) {
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (Math.abs(det) < 1e-12) return null;
  const dx = b0 * (a11 * a22 - a12 * a21) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a21 - a11 * b2);
  const dy = a00 * (b1 * a22 - a12 * b2) - b0 * (a10 * a22 - a12 * a20) + a02 * (a10 * b2 - b1 * a20);
  const dz = a00 * (a11 * b2 - b1 * a21) - a01 * (a10 * b2 - b1 * a20) + b0 * (a10 * a21 - a11 * a20);
  return [dx / det, dy / det, dz / det];
}

/**
 * Circle through points that already lie on one. A straight run returns null.
 * Radius is the mean distance to the fitted center.
 */
export function fitCircle(points) {
  const pts = uniquePoints(points);
  if (pts.length < 3) return null;
  const axes = principalAxes(pts);
  const order = [0, 1, 2].sort((i, j) => axes.values[i] - axes.values[j]);
  const primary = axes.values[order[2]];
  const secondary = axes.values[order[1]];
  if (!(primary > 1e-8)) return null;
  if (secondary / primary < 0.015) return null;
  const normal = norm(axes.vectors[order[0]]);
  const b1 = norm(axes.vectors[order[2]]);
  const b2 = norm(cross(normal, b1));
  const c = axes.center;
  const uv = pts.map((p) => {
    const d = sub(p, c);
    return [dot(d, b1), dot(d, b2)];
  });
  let a00 = 0;
  let a01 = 0;
  let a02 = 0;
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let r0 = 0;
  let r1 = 0;
  let r2 = 0;
  for (const [x, y] of uv) {
    const rhs = -(x * x + y * y);
    a00 += x * x;
    a01 += x * y;
    a02 += x;
    a11 += y * y;
    a12 += y;
    a22 += 1;
    r0 += x * rhs;
    r1 += y * rhs;
    r2 += rhs;
  }
  const sol = solve3(a00, a01, a02, r0, a01, a11, a12, r1, a02, a12, a22, r2);
  if (!sol) return null;
  const cx = -sol[0] / 2;
  const cy = -sol[1] / 2;
  let acc = 0;
  let acc2 = 0;
  for (const [x, y] of uv) {
    const r = Math.hypot(x - cx, y - cy);
    acc += r;
    acc2 += r * r;
  }
  const mean = acc / uv.length;
  if (!(mean > 1e-4)) return null;
  const variance = Math.max(0, acc2 / uv.length - mean * mean);
  const cv = Math.sqrt(variance) / mean;
  if (cv > CIRCLE_CV) return null;
  const center = add(c, add(scale(b1, cx), scale(b2, cy)));
  return { radius: mean, center, axis: normal };
}

/**
 * A cylindrical wall: constant radius about an axis, and tall enough that
 * a flat circular cap (height ~ 0) is not reported as a cylinder.
 */
export function fitCylinder(points) {
  const pts = uniquePoints(points);
  if (pts.length < 8) return null;
  const axes = principalAxes(pts);
  let best = null;
  for (let i = 0; i < 3; i += 1) {
    const axis = norm(axes.vectors[i]);
    let hMin = Infinity;
    let hMax = -Infinity;
    const rs = [];
    for (const p of pts) {
      const d = sub(p, axes.center);
      const along = dot(d, axis);
      const radial = len(sub(d, scale(axis, along)));
      rs.push(radial);
      if (along < hMin) hMin = along;
      if (along > hMax) hMax = along;
    }
    const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
    if (!(mean > 0.05)) continue;
    const variance = rs.reduce((s, r) => s + (r - mean) ** 2, 0) / rs.length;
    const cv = Math.sqrt(Math.max(0, variance)) / mean;
    const height = hMax - hMin;
    if (cv > CYLINDER_CV) continue;
    if (height < Math.max(0.5, mean * 0.15)) continue;
    if (!best || cv < best.cv) {
      best = { radius: mean, axis, center: axes.center.slice(), height, cv };
    }
  }
  if (!best) return null;
  return {
    radius: best.radius,
    axis: best.axis,
    center: best.center,
    height: best.height,
  };
}

export function triangleGroupStats(positionArray, indexArray, indices) {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let area = 0;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const points = [];
  const seen = new Set();
  for (const faceIdx of indices || []) {
    const i0 = indexArray[faceIdx * 3];
    const i1 = indexArray[faceIdx * 3 + 1];
    const i2 = indexArray[faceIdx * 3 + 2];
    const ax = positionArray[i0 * 3];
    const ay = positionArray[i0 * 3 + 1];
    const az = positionArray[i0 * 3 + 2];
    const bx = positionArray[i1 * 3];
    const by = positionArray[i1 * 3 + 1];
    const bz = positionArray[i1 * 3 + 2];
    const cxv = positionArray[i2 * 3];
    const cyv = positionArray[i2 * 3 + 1];
    const czv = positionArray[i2 * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cxv - ax;
    const vy = cyv - ay;
    const vz = czv - az;
    const cpx = uy * vz - uz * vy;
    const cpy = uz * vx - ux * vz;
    const cpz = ux * vy - uy * vx;
    const triArea = 0.5 * Math.hypot(cpx, cpy, cpz);
    nx += cpx;
    ny += cpy;
    nz += cpz;
    cx += ((ax + bx + cxv) / 3) * triArea;
    cy += ((ay + by + cyv) / 3) * triArea;
    cz += ((az + bz + czv) / 3) * triArea;
    area += triArea;
    const verts = [[i0, ax, ay, az], [i1, bx, by, bz], [i2, cxv, cyv, czv]];
    for (const [i, x, y, z] of verts) {
      if (seen.has(i)) continue;
      seen.add(i);
      points.push([x, y, z]);
    }
  }
  const nlen = Math.hypot(nx, ny, nz) || 1;
  const center = area > 1e-12 ? [cx / area, cy / area, cz / area] : [0, 0, 0];
  return {
    center,
    normal: [nx / nlen, ny / nlen, nz / nlen],
    points,
    area,
  };
}

export function boundsOfTriangles(positionArray, indexArray, indices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const seen = new Set();
  for (const t of indices || []) {
    for (let k = 0; k < 3; k += 1) {
      const i = indexArray[t * 3 + k];
      if (seen.has(i)) continue;
      seen.add(i);
      const x = positionArray[i * 3];
      const y = positionArray[i * 3 + 1];
      const z = positionArray[i * 3 + 2];
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  }
  if (!Number.isFinite(min[0])) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0] };
  }
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

export function buildPointMeasurePick({ partId = '', position }) {
  const q = position.map((v) => Math.round(num(v) * 100) / 100);
  return {
    kind: 'point',
    id: `point:${partId}:${q.map((v) => v.toFixed(2)).join(',')}`,
    partId,
    position: [num(position[0]), num(position[1]), num(position[2])],
    label: 'Point',
  };
}

export function buildEdgeMeasurePick({ partId = '', edge, chain }) {
  const members = Array.isArray(chain) && chain.length ? chain : [edge];
  const pts = [];
  for (const item of members) {
    if (Array.isArray(item?.pts)) {
      for (const p of item.pts) pts.push(p);
    }
    if (item?.va) pts.push(item.va);
    if (item?.vb) pts.push(item.vb);
  }
  const circle = fitCircle(pts);
  const va = edge.va;
  const vb = edge.vb;
  const mid = Array.isArray(edge.mid) && edge.mid.length >= 3
    ? edge.mid.slice(0, 3)
    : [(num(va[0]) + num(vb[0])) / 2, (num(va[1]) + num(vb[1])) / 2, (num(va[2]) + num(vb[2])) / 2];
  const tangent = Array.isArray(edge.tangent) && edge.tangent.length >= 3
    ? norm(edge.tangent)
    : norm(sub(vb, va));
  return {
    kind: 'edge',
    id: `edge:${partId}:${edge.key}`,
    partId,
    key: edge.key,
    va: va.slice(0, 3),
    vb: vb.slice(0, 3),
    mid,
    tangent,
    length: Number(edge.length) > 0 ? Number(edge.length) : dist(va, vb),
    circle,
    label: circle ? 'Circular edge' : 'Edge',
    draw: members.map((item) => ({
      va: item.va,
      vb: item.vb,
      pts: item.pts,
    })),
  };
}

export function buildFaceMeasurePick({
  partId = '', patchId, center, normal, points, indices,
}) {
  const cylinder = fitCylinder(points);
  const n = norm(normal);
  return {
    kind: 'face',
    id: `face:${partId}:${patchId}`,
    partId,
    patchId,
    center: [num(center[0]), num(center[1]), num(center[2])],
    normal: n,
    indices: Array.isArray(indices) ? indices.slice() : [],
    cylinder,
    label: cylinder ? 'Cylindrical face' : 'Face',
  };
}

export function buildPartMeasurePick({ partId = '', bodyKey, center, size, indices }) {
  return {
    kind: 'part',
    id: `part:${partId}:${bodyKey}`,
    partId,
    bodyKey,
    center: [num(center[0]), num(center[1]), num(center[2])],
    size: [num(size[0]), num(size[1]), num(size[2])],
    indices: Array.isArray(indices) ? indices.slice() : [],
    label: 'Part',
  };
}

export function measureSeedFromSelection(selectedFace, group, partId = '') {
  const picks = group?.picks;
  const face = Array.isArray(picks) && picks.length ? picks[picks.length - 1] : selectedFace;
  if (!face || !Array.isArray(face.center) || !Array.isArray(face.normal)) return [];
  const patchId = face.patchId
    || `seed:${face.center.map((v) => num(v).toFixed(2)).join(',')}:${face.normal.map((v) => num(v).toFixed(2)).join(',')}`;
  return [buildFaceMeasurePick({
    partId,
    patchId,
    center: face.center,
    normal: face.normal,
    points: [],
    indices: face.indices || [],
  })];
}

export function measurePickKey(pick) {
  return pick?.id || '';
}

export function toggleMeasurePick(picks, pick) {
  const list = Array.isArray(picks) ? picks.slice() : [];
  if (!pick?.id) return list;
  const index = list.findIndex((item) => item.id === pick.id);
  if (index >= 0) {
    list.splice(index, 1);
    return list;
  }
  list.push(pick);
  return list;
}

export function measureAnchor(pick) {
  if (!pick) return null;
  if (pick.kind === 'point') return pick.position;
  if (pick.kind === 'edge') return pick.mid;
  if (pick.kind === 'face' || pick.kind === 'part') return pick.center;
  return null;
}

/**
 * Screen-space kind. A click near an edge endpoint is a point. A click
 * along an edge is an edge. Anything else on the solid is a face.
 * A part is a double tap, decided by the caller, not here.
 */
export function classifyMeasurePointer({
  vertexDist = Infinity,
  vertexT = 0.5,
  edgeDist = Infinity,
  edgeSlop = 32,
  hasFace = false,
  pointSlop = MEASURE_POINT_SLOP_PX,
} = {}) {
  const nearEnd = vertexT <= 0.22 || vertexT >= 0.78;
  if (Number.isFinite(vertexDist) && vertexDist <= pointSlop && nearEnd) return 'point';
  if (Number.isFinite(edgeDist) && edgeDist < edgeSlop) return 'edge';
  if (hasFace) return 'face';
  return null;
}

/** Parameter of the closest point on segment AB, clamped to 0..1. */
export function segmentParameter2D(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-12) return 0;
  const t = ((px - ax) * abx + (py - ay) * aby) / ab2;
  return Math.max(0, Math.min(1, t));
}

function closestOnSegment(point, a, b) {
  const ab = sub(b, a);
  const ab2 = dot(ab, ab);
  if (ab2 < 1e-18) return a.slice();
  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / ab2));
  return add(a, scale(ab, t));
}

export function pointSegmentDistance(point, a, b) {
  return dist(point, closestOnSegment(point, a, b));
}

/**
 * Screen proximity is not enough. A foreshortened face can put its center
 * within the edge slop. A hit on the solid counts as the edge only when it
 * is actually on that edge. A miss beside the silhouette still does.
 */
export function measurePointerOnEdge({ edgeGap = Infinity, hasFace = false, gapMm = MEASURE_EDGE_GAP_MM } = {}) {
  if (!hasFace) return true;
  return Number.isFinite(edgeGap) && edgeGap <= gapMm;
}

/** A smooth loop is an edge, not a point on every tessellation vertex. */
export function measureChainIsCircular(members) {
  const pts = [];
  for (const item of members || []) {
    if (Array.isArray(item?.pts)) {
      for (const p of item.pts) pts.push(p);
    }
    if (item?.va) pts.push(item.va);
    if (item?.vb) pts.push(item.vb);
  }
  return !!fitCircle(pts);
}

/** Closest points on two segments. Distance is between those points. */
export function segmentSegmentClosest(a0, a1, b0, b1) {
  const u = sub(a1, a0);
  const v = sub(b1, b0);
  const w = sub(a0, b0);
  const a = dot(u, u);
  const b = dot(u, v);
  const c = dot(v, v);
  const d = dot(u, w);
  const e = dot(v, w);
  const denom = a * c - b * b;
  let sN;
  let sD = denom;
  let tN;
  let tD = denom;
  const eps = 1e-10;
  if (denom < eps) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }
  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0;
    else if (-d > a) sN = sD;
    else {
      sN = -d;
      sD = a;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) sN = 0;
    else if (-d + b > a) sN = sD;
    else {
      sN = -d + b;
      sD = a;
    }
  }
  const sc = Math.abs(sN) < eps ? 0 : sN / sD;
  const tc = Math.abs(tN) < eps ? 0 : tN / tD;
  const pointA = add(a0, scale(u, sc));
  const pointB = add(b0, scale(v, tc));
  return { pointA, pointB, distance: dist(pointA, pointB) };
}

function pointPlane(point, center, normal) {
  const n = norm(normal);
  const signed = dot(sub(point, center), n);
  return {
    distance: Math.abs(signed),
    signed,
    foot: sub(point, scale(n, signed)),
  };
}

function planeAngleDeg(n1, n2) {
  const d = Math.abs(dot(norm(n1), norm(n2)));
  return (Math.acos(Math.min(1, Math.max(0, d))) * 180) / Math.PI;
}

function lineAngleDeg(t1, t2) {
  const d = Math.abs(dot(norm(t1), norm(t2)));
  return (Math.acos(Math.min(1, Math.max(0, d))) * 180) / Math.PI;
}

function pushDelta(rows, id, delta) {
  const axes = ['X', 'Y', 'Z'];
  axes.forEach((axis, i) => {
    rows.push({
      id: `${id}:d${axis}`,
      kind: `delta${axis}`,
      label: `Δ${axis}`,
      mm: delta[i],
    });
  });
}

function radiusRows(pick) {
  const shape = pick.kind === 'edge' ? pick.circle : pick.kind === 'face' ? pick.cylinder : null;
  if (!shape || !(shape.radius > 0)) return [];
  return [
    { id: `radius:${pick.id}`, kind: 'radius', label: 'Radius', mm: shape.radius },
    { id: `diameter:${pick.id}`, kind: 'diameter', label: 'Diameter', mm: shape.radius * 2 },
  ];
}

function pairRows(a, b) {
  const rows = [];
  if (a.kind === 'point' && b.kind === 'point') {
    const delta = sub(b.position, a.position);
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: len(delta) });
    pushDelta(rows, 'pair', delta);
    return rows;
  }
  if ((a.kind === 'point' && b.kind === 'face') || (b.kind === 'point' && a.kind === 'face')) {
    const point = a.kind === 'point' ? a : b;
    const face = a.kind === 'face' ? a : b;
    if (face.cylinder) {
      const axis = norm(face.cylinder.axis);
      const rel = sub(point.position, face.cylinder.center);
      const along = dot(rel, axis);
      const radialVec = sub(rel, scale(axis, along));
      const radial = len(radialVec);
      const signed = radial - face.cylinder.radius;
      const delta = radial > 1e-9 ? scale(norm(radialVec), signed) : [0, 0, 0];
      rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: Math.abs(signed) });
      pushDelta(rows, 'pair', delta);
      return rows;
    }
    const hit = pointPlane(point.position, face.center, face.normal);
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: hit.distance });
    pushDelta(rows, 'pair', sub(hit.foot, point.position));
    return rows;
  }
  if ((a.kind === 'point' && b.kind === 'edge') || (b.kind === 'point' && a.kind === 'edge')) {
    const point = a.kind === 'point' ? a : b;
    const edge = a.kind === 'edge' ? a : b;
    const closest = closestOnSegment(point.position, edge.va, edge.vb);
    const delta = sub(closest, point.position);
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: len(delta) });
    pushDelta(rows, 'pair', delta);
    return rows;
  }
  if (a.kind === 'edge' && b.kind === 'edge') {
    const seg = segmentSegmentClosest(a.va, a.vb, b.va, b.vb);
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: seg.distance });
    rows.push({ id: 'angle', kind: 'angle', label: 'Angle', deg: lineAngleDeg(a.tangent, b.tangent) });
    pushDelta(rows, 'pair', sub(seg.pointB, seg.pointA));
    return rows;
  }
  if (a.kind === 'face' && b.kind === 'face') {
    const angle = planeAngleDeg(a.normal, b.normal);
    const centerDelta = sub(b.center, a.center);
    const parallel = angle <= MEASURE_PARALLEL_DEG;
    const distance = parallel ? Math.abs(dot(centerDelta, norm(a.normal))) : len(centerDelta);
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: distance });
    rows.push({ id: 'angle', kind: 'angle', label: 'Angle', deg: angle });
    pushDelta(rows, 'pair', centerDelta);
    return rows;
  }
  if ((a.kind === 'edge' && b.kind === 'face') || (b.kind === 'edge' && a.kind === 'face')) {
    const edge = a.kind === 'edge' ? a : b;
    const face = a.kind === 'face' ? a : b;
    const n = norm(face.normal);
    const angle = (Math.asin(Math.min(1, Math.abs(dot(norm(edge.tangent), n)))) * 180) / Math.PI;
    if (angle <= MEASURE_PARALLEL_DEG && edge.mid) {
      const hit = pointPlane(edge.mid, face.center, n);
      rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: hit.distance });
      pushDelta(rows, 'pair', sub(hit.foot, edge.mid));
    }
    rows.push({ id: 'angle', kind: 'angle', label: 'Angle', deg: angle });
    return rows;
  }
  if (a.kind === 'part' && b.kind === 'part') {
    const delta = sub(b.center, a.center);
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: len(delta) });
    pushDelta(rows, 'pair', delta);
    return rows;
  }
  const pa = measureAnchor(a);
  const pb = measureAnchor(b);
  if (pa && pb) {
    const delta = sub(pb, pa);
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: len(delta) });
    pushDelta(rows, 'pair', delta);
  }
  return rows;
}

function singleRows(pick) {
  const rows = [];
  if (pick.kind === 'point') {
    ['X', 'Y', 'Z'].forEach((axis, i) => {
      rows.push({
        id: `pos:d${axis}`,
        kind: `delta${axis}`,
        label: `Δ${axis}`,
        mm: pick.position[i],
      });
    });
  } else if (pick.kind === 'edge' && !pick.circle) {
    rows.push({ id: 'distance', kind: 'distance', label: 'Distance', mm: pick.length });
    pushDelta(rows, 'pair', sub(pick.vb, pick.va));
  } else if (pick.kind === 'part') {
    pushDelta(rows, 'pair', pick.size);
  }
  return rows;
}

/**
 * @returns {{ rows: { id: string, kind: string, label: string, mm?: number, deg?: number }[], pairIds: string[]|null }}
 */
export function measureReadout(picks) {
  const list = (Array.isArray(picks) ? picks : []).filter((pick) => pick && pick.id);
  const rows = [];
  if (list.length === 1) rows.push(...singleRows(list[0]));
  else if (list.length >= 2) rows.push(...pairRows(list[list.length - 2], list[list.length - 1]));
  for (const pick of list) rows.push(...radiusRows(pick));
  return {
    rows,
    pairIds: list.length >= 2 ? [list[list.length - 2].id, list[list.length - 1].id] : null,
  };
}
