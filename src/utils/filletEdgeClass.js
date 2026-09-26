/**
 * Slice B — easy vs hard fillet edges.
 *
 * Easy (every clause must hold) on the current edge/chain set:
 *   1. Both adjacent faces planar, or one planar and one cylindrical
 *      with constant radius.
 *   2. Dihedral span along the chain ≤ DIHEDRAL_SPAN_MAX_DEG.
 *   3. Coherent segment count ≤ EASY_SEGMENT_MAX (post-#49 chains).
 *   4. Requested radius ≤ max safe clearance for the local face width.
 *
 * Anything else is hard (loft generators, variable-dihedral walls, long
 * rims, radius past the face). Hard does not block Accept — callers show
 * the stable `reason` string and still run the #45/#46 sweep.
 *
 * Face class is measured on the mesh when `geometry` is passed (the
 * viewport always has it). Without a mesh, a #46 boundary id is treated
 * as planar–planar; an untagged chain is a twisted wall.
 */

export const EASY_SEGMENT_MAX = 12;
export const DIHEDRAL_SPAN_MAX_DEG = 5;
/** Leave a sliver of face past the setback so r === width is not "safe". */
export const CLEARANCE_MARGIN = 0.95;

export const FILLET_REASON_TWISTED_WALL = 'twisted wall';
export const FILLET_REASON_VARIABLE_ANGLE = 'variable angle';
export const FILLET_REASON_LONG_CHAIN = 'long chain';
export const FILLET_REASON_RADIUS_TOO_LARGE = 'radius too large';

const REASON_PRIORITY = [
  FILLET_REASON_TWISTED_WALL,
  FILLET_REASON_VARIABLE_ANGLE,
  FILLET_REASON_LONG_CHAIN,
  FILLET_REASON_RADIUS_TOO_LARGE,
];

const PLANAR_ANGLE_DEG = 2;
const SHALLOW_FLOOD_DEG = 15;
const FEATURE_SAMPLE_DEG = 14;
const ON_EDGE_EPS = 0.18;
const CYL_NORMAL_ALIGN = Math.sin((8 * Math.PI) / 180);
const CYL_RADIUS_CV = 0.08;
const CYL_AXIS_EIGEN = 0.22;

const meshCache = new WeakMap();

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function norm(v) {
  const L = len(v) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function degBetween(a, b) {
  const d = dot(a, b) / ((len(a) || 1) * (len(b) || 1));
  return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
}

function edgeDihedral(n0, n1) {
  if (!n0 || !n1) return null;
  return degBetween(n0, n1);
}

function readMeshArrays(geometry) {
  if (!geometry) return null;
  const pos = geometry.attributes?.position?.array || geometry.positions;
  const index = geometry.index?.array || geometry.indices;
  if (!pos || !index || index.length < 3 || pos.length < 9) return null;
  return { pos, index };
}

/**
 * Symmetric 3×3 eigenpairs (Jacobi). `m` is [[a,b,c],[b,d,e],[c,e,f]].
 * @returns {{ values: number[], vectors: number[][] }}
 */
function symEigen3(m) {
  const A = m.map((row) => row.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iter = 0; iter < 12; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > max) {
      max = Math.abs(A[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(A[1][2]) > max) {
      max = Math.abs(A[1][2]);
      p = 1;
      q = 2;
    }
    if (max < 1e-12) break;
    const app = A[p][p];
    const aqq = A[q][q];
    const apq = A[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const next = A.map((row) => row.slice());
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const aik = c * A[p][k] - s * A[q][k];
        const aqk = s * A[p][k] + c * A[q][k];
        next[p][k] = aik;
        next[k][p] = aik;
        next[q][k] = aqk;
        next[k][q] = aqk;
      }
    }
    next[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    next[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    next[p][q] = 0;
    next[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      const vip = V[k][p];
      const viq = V[k][q];
      V[k][p] = c * vip - s * viq;
      V[k][q] = s * vip + c * viq;
    }
    for (let r = 0; r < 3; r++) {
      for (let c2 = 0; c2 < 3; c2++) A[r][c2] = next[r][c2];
    }
  }
  const values = [A[0][0], A[1][1], A[2][2]];
  const vectors = [0, 1, 2].map((col) => norm([V[0][col], V[1][col], V[2][col]]));
  return { values, vectors };
}

function indexMesh(geometry) {
  const cached = meshCache.get(geometry);
  if (cached) return cached;
  const arrays = readMeshArrays(geometry);
  if (!arrays) return null;
  const { pos, index } = arrays;
  const numTri = Math.floor(index.length / 3);
  const at = (i) => {
    const o = i * 3;
    return [pos[o], pos[o + 1], pos[o + 2]];
  };
  const tris = new Array(numTri);
  for (let t = 0; t < numTri; t++) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    const v0 = at(a);
    const v1 = at(b);
    const v2 = at(c);
    const cr = cross(sub(v1, v0), sub(v2, v0));
    const area = 0.5 * len(cr);
    tris[t] = {
      a, b, c, v0, v1, v2,
      area,
      n: area > 1e-18 ? norm(cr) : [0, 0, 1],
    };
  }
  const edgeTris = new Map();
  const addE = (u, w, t) => {
    if (u === w) return;
    const key = u < w ? `${u}-${w}` : `${w}-${u}`;
    let list = edgeTris.get(key);
    if (!list) {
      list = [];
      edgeTris.set(key, list);
    }
    list.push(t);
  };
  for (let t = 0; t < numTri; t++) {
    const tri = tris[t];
    addE(tri.a, tri.b, t);
    addE(tri.b, tri.c, t);
    addE(tri.c, tri.a, t);
  }
  const meshEdges = [];
  for (const [key, list] of edgeTris) {
    if (list.length !== 2) continue;
    const parts = key.split('-');
    const ia = Number(parts[0]);
    const ib = Number(parts[1]);
    const va = at(ia);
    const vb = at(ib);
    const delta = sub(vb, va);
    const L = len(delta);
    if (!(L > 1e-9)) continue;
    const t0 = tris[list[0]];
    const t1 = tris[list[1]];
    meshEdges.push({
      key,
      a: ia,
      b: ib,
      va,
      vb,
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      tangent: [delta[0] / L, delta[1] / L, delta[2] / L],
      length: L,
      tris: list,
      dihedral: degBetween(t0.n, t1.n),
    });
  }
  const byKey = new Map();
  for (const edge of meshEdges) byKey.set(edge.key, edge);
  const built = { tris, meshEdges, byKey };
  if (typeof geometry === 'object' && geometry !== null) {
    try { meshCache.set(geometry, built); } catch { /* plain object */ }
  }
  return built;
}

function pointSegDist(p, a, b) {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  let t = L2 > 1e-18 ? dot(sub(p, a), ab) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  return len(sub(p, q));
}

function onSegment(edge, seg) {
  if (pointSegDist(edge.va, seg.va, seg.vb) > ON_EDGE_EPS) return false;
  if (pointSegDist(edge.vb, seg.va, seg.vb) > ON_EDGE_EPS) return false;
  if (pointSegDist(edge.mid, seg.va, seg.vb) > ON_EDGE_EPS) return false;
  const align = Math.abs(dot(edge.tangent, seg.tangent || [0, 0, 0]));
  return align > 0.85;
}

function groupChains(edges) {
  const groups = new Map();
  edges.forEach((edge, i) => {
    const id = Number.isFinite(edge?.chainId) ? `c:${edge.chainId}` : `e:${edge?.key || i}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(edge);
  });
  return [...groups.values()];
}

function chainTangent(chain) {
  let best = chain[0];
  for (const e of chain) if ((e.length || 0) > (best.length || 0)) best = e;
  if (best?.tangent) return norm(best.tangent);
  if (best?.va && best?.vb) return norm(sub(best.vb, best.va));
  return [0, 0, 1];
}

function interiorThetaRad(n0, n1, T) {
  if (!n0 || !n1 || !T) return null;
  const f0 = cross(n0, T);
  const f1 = cross(n1, T);
  if (len(f0) < 1e-8 || len(f1) < 1e-8) return null;
  let a = norm(f0);
  let b = norm(f1);
  if (dot(a, n1) > 0) a = [-a[0], -a[1], -a[2]];
  if (dot(b, n0) > 0) b = [-b[0], -b[1], -b[2]];
  const th = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
  if (!(th > 0.05) || !(th < Math.PI - 0.05)) return null;
  return th;
}

function edgesOnChain(mesh, chain) {
  const hits = [];
  const seen = new Set();
  for (const seg of chain) {
    if (!seg?.va || !seg?.vb) continue;
    const tangent = seg.tangent || norm(sub(seg.vb, seg.va));
    const withT = { ...seg, tangent };
    for (const edge of mesh.meshEdges) {
      if (seen.has(edge.key)) continue;
      if (!onSegment(edge, withT)) continue;
      seen.add(edge.key);
      hits.push(edge);
    }
  }
  return hits;
}

function floodSide(mesh, seeds, blocked) {
  const seen = new Set();
  const q = [];
  for (const id of seeds) {
    if (seen.has(id)) continue;
    seen.add(id);
    q.push(id);
  }
  const cosShallow = Math.cos((SHALLOW_FLOOD_DEG * Math.PI) / 180);
  while (q.length) {
    const id = q.pop();
    const tri = mesh.tris[id];
    const pairs = [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]];
    for (const [u, w] of pairs) {
      const key = u < w ? `${u}-${w}` : `${w}-${u}`;
      if (blocked.has(key)) continue;
      const edge = mesh.byKey.get(key);
      if (!edge) continue;
      for (const nb of edge.tris) {
        if (seen.has(nb)) continue;
        if (dot(mesh.tris[id].n, mesh.tris[nb].n) < cosShallow) continue;
        seen.add(nb);
        q.push(nb);
      }
    }
  }
  return seen;
}

function sideStats(mesh, ids) {
  let area = 0;
  const nsum = [0, 0, 0];
  const verts = [];
  for (const id of ids) {
    const tri = mesh.tris[id];
    const w = Math.max(tri.area, 0);
    area += w;
    nsum[0] += tri.n[0] * w;
    nsum[1] += tri.n[1] * w;
    nsum[2] += tri.n[2] * w;
    verts.push(tri.v0, tri.v1, tri.v2);
  }
  const mean = norm(nsum);
  let maxAng = 0;
  for (const id of ids) {
    maxAng = Math.max(maxAng, degBetween(mesh.tris[id].n, mean));
  }
  let maxOff = 0;
  const origin = verts[0] || [0, 0, 0];
  for (const v of verts) {
    maxOff = Math.max(maxOff, Math.abs(dot(sub(v, origin), mean)));
  }
  const planar = ids.size > 0 && maxAng <= PLANAR_ANGLE_DEG && maxOff <= Math.max(0.08, 0.002 * Math.sqrt(area));
  return { area, mean, maxAng, maxOff, planar, verts, ids };
}

function classifySupport(mesh, ids) {
  const stats = sideStats(mesh, ids);
  if (!ids.size) return { kind: 'other', stats };
  if (stats.planar) return { kind: 'planar', stats };
  const cyl = fitCylinder(mesh, ids);
  if (cyl) return { kind: 'cylindrical', stats, cylinder: cyl };
  return { kind: 'other', stats };
}

function fitCylinder(mesh, ids) {
  if (ids.size < 4) return null;
  let c00 = 0;
  let c01 = 0;
  let c02 = 0;
  let c11 = 0;
  let c12 = 0;
  let c22 = 0;
  const normals = [];
  for (const id of ids) {
    const tri = mesh.tris[id];
    const w = Math.max(tri.area, 1e-12);
    const n = tri.n;
    c00 += w * n[0] * n[0];
    c01 += w * n[0] * n[1];
    c02 += w * n[0] * n[2];
    c11 += w * n[1] * n[1];
    c12 += w * n[1] * n[2];
    c22 += w * n[2] * n[2];
    normals.push(n);
  }
  const eigen = symEigen3([
    [c00, c01, c02],
    [c01, c11, c12],
    [c02, c12, c22],
  ]);
  const order = [0, 1, 2].sort((i, j) => eigen.values[j] - eigen.values[i]);
  const l1 = Math.max(eigen.values[order[0]], 1e-12);
  const l2 = Math.max(eigen.values[order[1]], 0);
  const l3 = Math.max(eigen.values[order[2]], 0);
  if (l2 / l1 < 0.2) return null;
  if (l3 / Math.max(l2, 1e-12) > CYL_AXIS_EIGEN) return null;
  const axis = eigen.vectors[order[2]];
  let align = 0;
  for (const n of normals) align += Math.abs(dot(n, axis));
  align /= normals.length;
  if (align > CYL_NORMAL_ALIGN) return null;

  const helper = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const b1 = norm(cross(axis, helper));
  const b2 = norm(cross(axis, b1));
  // q - R * nh = center. Solve R, cx, cy in the axis-perpendicular plane.
  const samples = [];
  for (const id of ids) {
    const tri = mesh.tris[id];
    const n = tri.n;
    const nh3 = sub(n, [axis[0] * dot(n, axis), axis[1] * dot(n, axis), axis[2] * dot(n, axis)]);
    if (len(nh3) < 1e-6) continue;
    const nh = norm(nh3);
    const nhx = dot(nh, b1);
    const nhy = dot(nh, b2);
    for (const v of [tri.v0, tri.v1, tri.v2]) {
      samples.push({
        qx: dot(v, b1),
        qy: dot(v, b2),
        h: dot(v, axis),
        nhx,
        nhy,
      });
    }
  }
  if (samples.length < 8) return null;
  // Unknowns [R, cx, cy] from qx = R*nhx + cx and qy = R*nhy + cy.
  let sRR = 0;
  let sRx = 0;
  let sRy = 0;
  let rhsR = 0;
  let rhsX = 0;
  let rhsY = 0;
  for (const s of samples) {
    sRR += s.nhx * s.nhx + s.nhy * s.nhy;
    sRx += s.nhx;
    sRy += s.nhy;
    rhsR += s.qx * s.nhx + s.qy * s.nhy;
    rhsX += s.qx;
    rhsY += s.qy;
  }
  // Matrix:
  // [ sRR  sRx  sRy ] [R ] = [rhsR]
  // [ sRx  N    0   ] [cx]   [rhsX]
  // [ sRy  0    N   ] [cy]   [rhsY]
  const N = samples.length;
  const det = solve3(
    sRR, sRx, sRy, rhsR,
    sRx, N, 0, rhsX,
    sRy, 0, N, rhsY,
  );
  if (!det) return null;
  const radius = Math.abs(det[0]);
  const cx = det[1];
  const cy = det[2];
  if (!(radius > 1e-4)) return null;
  let acc = 0;
  let acc2 = 0;
  let hMin = Infinity;
  let hMax = -Infinity;
  const byH = [];
  for (const s of samples) {
    const r = Math.hypot(s.qx - cx, s.qy - cy);
    acc += r;
    acc2 += r * r;
    byH.push({ h: s.h, r });
    if (s.h < hMin) hMin = s.h;
    if (s.h > hMax) hMax = s.h;
  }
  const mean = acc / samples.length;
  if (!(mean > 1e-4)) return null;
  const variance = Math.max(0, acc2 / samples.length - mean * mean);
  const cv = Math.sqrt(variance) / mean;
  if (cv > CYL_RADIUS_CV) return null;
  byH.sort((a, b) => a.h - b.h);
  const third = Math.max(1, Math.floor(byH.length / 3));
  const meanOf = (slice) => slice.reduce((s, p) => s + p.r, 0) / slice.length;
  const rLo = meanOf(byH.slice(0, third));
  const rHi = meanOf(byH.slice(byH.length - third));
  if (Math.abs(rLo - rHi) / mean > CYL_RADIUS_CV) return null;
  return {
    radius: mean,
    cv,
    axial: hMax - hMin,
  };
}

function solve3(a00, a01, a02, b0, a10, a11, a12, b1, a20, a21, a22, b2) {
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (Math.abs(det) < 1e-10) return null;
  const dx = b0 * (a11 * a22 - a12 * a21) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a21 - a11 * b2);
  const dy = a00 * (b1 * a22 - a12 * b2) - b0 * (a10 * a22 - a12 * a20) + a02 * (a10 * b2 - b1 * a20);
  const dz = a00 * (a11 * b2 - b1 * a21) - a01 * (a10 * b2 - b1 * a20) + b0 * (a10 * a21 - a11 * a20);
  return [dx / det, dy / det, dz / det];
}

function planarClearance(stats, tangent, edgePoint) {
  if (!stats?.planar || !stats.verts?.length) return null;
  let inward = cross(stats.mean, tangent);
  if (len(inward) < 1e-8) return null;
  inward = norm(inward);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of stats.verts) {
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  const n = stats.verts.length;
  const centroid = [cx / n, cy / n, cz / n];
  if (dot(sub(centroid, edgePoint), inward) < 0) inward = [-inward[0], -inward[1], -inward[2]];
  let max = 0;
  for (const v of stats.verts) {
    const d = dot(sub(v, edgePoint), inward);
    if (d > max) max = d;
  }
  return max > 1e-4 ? max : null;
}

function assignSides(mesh, hits, chain) {
  const blocked = new Set(hits.map((e) => e.key));
  const refN0 = chain.find((e) => e.n0)?.n0 || null;
  const seeds = [[], []];
  for (const edge of hits) {
    const tA = edge.tris[0];
    const tB = edge.tris[1];
    const nA = mesh.tris[tA].n;
    const nB = mesh.tris[tB].n;
    let sideA = 0;
    if (refN0) {
      sideA = dot(nA, refN0) >= dot(nB, refN0) ? 0 : 1;
    }
    seeds[sideA].push(sideA === 0 ? tA : tB);
    seeds[1 - sideA].push(sideA === 0 ? tB : tA);
  }
  if (!seeds[0].length && !seeds[1].length) return [null, null];
  const flood0 = floodSide(mesh, seeds[0], blocked);
  const flood1 = floodSide(mesh, seeds[1], blocked);
  return [classifySupport(mesh, flood0), classifySupport(mesh, flood1)];
}

function fallbackSides(chain) {
  const tagged = chain.every((e) => (
    Number.isFinite(e.boundaryId) && Number.isFinite(e.faceA) && Number.isFinite(e.faceB)
  ));
  if (tagged) return [{ kind: 'planar' }, { kind: 'planar' }];
  return [{ kind: 'other' }, { kind: 'other' }];
}

function facesEasy(a, b) {
  const ka = a?.kind;
  const kb = b?.kind;
  if (ka === 'planar' && kb === 'planar') return true;
  if (ka === 'planar' && kb === 'cylindrical') return true;
  if (ka === 'cylindrical' && kb === 'planar') return true;
  return false;
}

function dihedralSpan(chain, hits) {
  const samples = [];
  for (const edge of chain) {
    const d = edgeDihedral(edge.n0, edge.n1);
    if (d != null && d >= FEATURE_SAMPLE_DEG) samples.push(d);
  }
  for (const edge of hits) {
    if (edge.dihedral >= FEATURE_SAMPLE_DEG) samples.push(edge.dihedral);
  }
  if (!samples.length) return 0;
  let min = samples[0];
  let max = samples[0];
  for (const d of samples) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return max - min;
}

function maxSafeRadius(chain, sides, tangent) {
  const edge = chain.find((e) => e.va) || chain[0];
  if (!edge?.va) return null;
  const n0 = edge.n0 || sides[0]?.stats?.mean;
  const n1 = edge.n1 || sides[1]?.stats?.mean;
  const theta = interiorThetaRad(n0, n1, tangent);
  if (theta == null) return null;
  const clearances = [];
  for (const side of sides) {
    if (side?.kind === 'planar' && side.stats) {
      const c = planarClearance(side.stats, tangent, edge.va);
      if (c != null) clearances.push(c);
    } else if (side?.kind === 'cylindrical' && side.cylinder) {
      if (side.cylinder.radius > 1e-4) clearances.push(side.cylinder.radius);
      if (side.cylinder.axial > 1e-4) clearances.push(side.cylinder.axial);
    }
  }
  if (!clearances.length) return null;
  const clearance = Math.min(...clearances);
  return CLEARANCE_MARGIN * clearance * Math.tan(theta / 2);
}

function classifyChain(chain, mesh) {
  const reasons = [];
  const hits = mesh ? edgesOnChain(mesh, chain) : [];
  const sides = mesh && hits.length ? assignSides(mesh, hits, chain) : fallbackSides(chain);
  if (!facesEasy(sides[0], sides[1])) reasons.push(FILLET_REASON_TWISTED_WALL);
  const span = dihedralSpan(chain, hits);
  if (span > DIHEDRAL_SPAN_MAX_DEG + 1e-6) reasons.push(FILLET_REASON_VARIABLE_ANGLE);
  if (chain.length > EASY_SEGMENT_MAX) reasons.push(FILLET_REASON_LONG_CHAIN);
  const safe = maxSafeRadius(chain, sides, chainTangent(chain));
  return {
    reasons,
    segments: chain.length,
    dihedralSpan: span,
    sides: [sides[0]?.kind || 'other', sides[1]?.kind || 'other'],
    sideAreas: [sides[0]?.stats?.area || 0, sides[1]?.stats?.area || 0],
    hitCount: hits.length,
    maxSafeR: safe,
  };
}

const structCache = new WeakMap();

function structuralChains(edges, geometry) {
  const mesh = geometry ? indexMesh(geometry) : null;
  const groups = groupChains(edges);
  return groups.map((group) => classifyChain(group, mesh));
}

function withRadius(chains, radius) {
  const r = Number(radius);
  return chains.map((chain) => {
    const reasons = chain.reasons.filter((reason) => reason !== FILLET_REASON_RADIUS_TOO_LARGE);
    if (chain.maxSafeR != null && Number.isFinite(r) && r > 0 && r > chain.maxSafeR + 1e-6) {
      reasons.push(FILLET_REASON_RADIUS_TOO_LARGE);
    }
    return reasons === chain.reasons ? chain : { ...chain, reasons };
  });
}

/**
 * Classify the current Fillet / Chamfer edge set.
 * @param {object[]} edges coherent pick (#49) or the live preview selection
 * @param {{ radius?: number, geometry?: object }} [opts]
 * @returns {{
 *   klass: 'empty'|'easy'|'hard',
 *   reason: string|null,
 *   reasons: string[],
 *   chains: object[],
 * }}
 */
export function classifyFilletEdges(edges, opts = {}) {
  const list = Array.isArray(edges) ? edges.filter(Boolean) : [];
  if (!list.length) {
    return { klass: 'empty', reason: null, reasons: [], chains: [] };
  }
  let base;
  const geometry = opts.geometry;
  if (geometry && typeof geometry === 'object') {
    let bucket = structCache.get(geometry);
    if (!bucket) {
      bucket = new Map();
      try { structCache.set(geometry, bucket); } catch { bucket = null; }
    }
    const sig = list.map((e) => e.key || `${e.a}:${e.b}`).join('|');
    if (bucket && bucket.has(sig)) base = bucket.get(sig);
    else {
      base = structuralChains(list, geometry);
      if (bucket) bucket.set(sig, base);
    }
  } else {
    base = structuralChains(list, null);
  }
  const chains = withRadius(base, opts.radius);
  const all = new Set();
  for (const chain of chains) {
    for (const reason of chain.reasons) all.add(reason);
  }
  const reasons = REASON_PRIORITY.filter((reason) => all.has(reason));
  return {
    klass: reasons.length ? 'hard' : 'easy',
    reason: reasons[0] || null,
    reasons,
    chains,
  };
}

/**
 * Triangles that read as zero-area in the face chip (numerical zeros and
 * needle slivers). A clean box fillet stays at 0.
 * @param {object} geometry BufferGeometry or { positions, indices }
 * @returns {number}
 */
export function countDegenerateTriangles(geometry) {
  const arrays = readMeshArrays(geometry);
  if (!arrays) return 0;
  const { pos, index } = arrays;
  const numTri = Math.floor(index.length / 3);
  const at = (i) => {
    const o = i * 3;
    return [pos[o], pos[o + 1], pos[o + 2]];
  };
  let n = 0;
  for (let t = 0; t < numTri; t++) {
    const v0 = at(index[t * 3]);
    const v1 = at(index[t * 3 + 1]);
    const v2 = at(index[t * 3 + 2]);
    const area = 0.5 * len(cross(sub(v1, v0), sub(v2, v0)));
    const e0 = len(sub(v1, v0));
    const e1 = len(sub(v2, v1));
    const e2 = len(sub(v0, v2));
    const maxE = Math.max(e0, e1, e2);
    if (area < 1e-6 || maxE < 1e-8) {
      n += 1;
      continue;
    }
    const alt = (2 * area) / maxE;
    if (alt < 1e-3 && area < 0.05) n += 1;
  }
  return n;
}
