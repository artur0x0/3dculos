/**
 * Slice C3 — shared tangency + face-normal field for Edge pick and Fillet.
 *
 * One substrate for:
 *   - Tangent-on G1 propagation (true design chains, not #49 tessellation spaghetti)
 *   - Variable-profile hard fillet framing (inscribed arc in the local wall square)
 *
 * G1 = tangent alignment AND wall-normal continuity. Tessellation zig-zag often
 * passes a loose tangent check but flips / swaps face normals at every step.
 *
 * Kept free of imports from selectEdge.js to avoid a cycle (selectEdge consumes
 * the G1 helpers below).
 */

/** Default G1 tangent tol — matches selectEdge.TANGENT_PROP_DEG. */
export const TANGENCY_PROP_DEG = 25;
/** Min wall-normal continuity (cos) for true G1. */
export const TANGENCY_NORMAL_ALIGN = Math.cos((28 * Math.PI) / 180);
/** Human-scale chain cap — matches selectEdge.COHERENT_EDGE_MAX. */
export const TANGENCY_CHAIN_MAX = 36;

function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function _norm(v) {
  const L = _len(v) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function _edgeKey(edge) {
  if (!edge) return '';
  if (edge.key) return edge.key;
  const a = Math.min(edge.a, edge.b);
  const b = Math.max(edge.a, edge.b);
  return `${a}-${b}`;
}

function _tangentAlign(t0, t1) {
  if (!t0 || !t1) return 0;
  return Math.abs(t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2]);
}

function _buildAdj(featureEdges) {
  const adj = new Map();
  for (const e of featureEdges || []) {
    for (const v of [e.a, e.b]) {
      if (!adj.has(v)) adj.set(v, []);
      adj.get(v).push(e);
    }
  }
  return adj;
}

/**
 * Unit tangent + adjacent face normals for one edge (or knot sample).
 * @param {object} edge
 * @returns {{ T: number[], n0: number[]|null, n1: number[]|null, dihedralDeg: number }}
 */
export function edgeTangencyFrame(edge) {
  let T = null;
  if (Array.isArray(edge?.tangent) && edge.tangent.length >= 3) {
    T = _norm(edge.tangent);
  } else if (edge?.va && edge?.vb) {
    const d = _sub(edge.vb, edge.va);
    if (_len(d) > 1e-12) T = _norm(d);
  }
  if (!T) T = [0, 0, 1];
  const n0 = Array.isArray(edge?.n0) && edge.n0.length >= 3 ? _norm(edge.n0) : null;
  const n1 = Array.isArray(edge?.n1) && edge.n1.length >= 3 ? _norm(edge.n1) : null;
  let dihedralDeg = 0;
  if (n0 && n1) {
    dihedralDeg = Math.acos(Math.min(1, Math.max(-1, _dot(n0, n1)))) * 180 / Math.PI;
  }
  return { T, n0, n1, dihedralDeg };
}

/**
 * Best pairwise continuity of two normal pairs (order-insensitive).
 * High when the same two walls continue; low on tessellation flip noise.
 */
export function wallNormalContinuity(n0a, n1a, n0b, n1b) {
  if (!n0a || !n1a || !n0b || !n1b) return 1;
  const a = Math.min(_dot(n0a, n0b), _dot(n1a, n1b));
  const b = Math.min(_dot(n0a, n1b), _dot(n1a, n0b));
  return Math.max(a, b);
}

/**
 * True G1 between two feature/coherent edges.
 * @param {object} a
 * @param {object} b
 * @param {{ tolDeg?: number, normalAlign?: number }} [opts]
 */
export function isTrueG1(a, b, opts = {}) {
  const tolDeg = typeof opts.tolDeg === 'number' ? opts.tolDeg : TANGENCY_PROP_DEG;
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const fa = edgeTangencyFrame(a);
  const fb = edgeTangencyFrame(b);
  if (_tangentAlign(fa.T, fb.T) < cosTol) return false;
  const normalAlign = typeof opts.normalAlign === 'number' ? opts.normalAlign : TANGENCY_NORMAL_ALIGN;
  if (fa.n0 && fa.n1 && fb.n0 && fb.n1) {
    if (wallNormalContinuity(fa.n0, fa.n1, fb.n0, fb.n1) < normalAlign) return false;
  }
  return true;
}

/**
 * Propagate a true-G1 chain from seed. Soft-fails to [seed]. Caps at max.
 * @param {object[]} featureEdges
 * @param {object} seedEdge
 * @param {{ tolDeg?: number, adj?: Map, max?: number }} [opts]
 * @returns {object[]}
 */
export function propagateTrueTangentEdges(featureEdges, seedEdge, opts = {}) {
  if (!seedEdge) return [];
  const max = typeof opts.max === 'number' ? opts.max : TANGENCY_CHAIN_MAX;
  const adj = opts.adj || _buildAdj(featureEdges || []);
  const seedKey = _edgeKey(seedEdge);
  const out = new Map();
  const seedCopy = {
    ...seedEdge,
    key: seedKey,
    va: seedEdge.va ? seedEdge.va.slice() : undefined,
    vb: seedEdge.vb ? seedEdge.vb.slice() : undefined,
    mid: seedEdge.mid ? seedEdge.mid.slice() : undefined,
    tangent: seedEdge.tangent ? seedEdge.tangent.slice() : undefined,
    n0: seedEdge.n0 ? seedEdge.n0.slice() : undefined,
    n1: seedEdge.n1 ? seedEdge.n1.slice() : undefined,
  };
  out.set(seedKey, seedCopy);
  const queue = [seedCopy];
  while (queue.length) {
    const cur = queue.shift();
    for (const v of [cur.a, cur.b]) {
      for (const nbr of adj.get(v) || []) {
        const nk = _edgeKey(nbr);
        if (out.has(nk)) continue;
        if (!isTrueG1(cur, nbr, opts)) continue;
        if (out.size >= max) return [...out.values()];
        const copy = {
          ...nbr,
          key: nk,
          va: nbr.va ? nbr.va.slice() : undefined,
          vb: nbr.vb ? nbr.vb.slice() : undefined,
          mid: nbr.mid ? nbr.mid.slice() : undefined,
          tangent: nbr.tangent ? nbr.tangent.slice() : undefined,
          n0: nbr.n0 ? nbr.n0.slice() : undefined,
          n1: nbr.n1 ? nbr.n1.slice() : undefined,
        };
        out.set(nk, copy);
        queue.push(copy);
      }
    }
  }
  return [...out.values()];
}

/**
 * Densify a polyline so no segment exceeds `step`.
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {number} step
 * @returns {number[][]}
 */
export function densifyPathPoints(points, closed, step) {
  if (!Array.isArray(points) || points.length < 2) return points ? points.map((p) => p.slice()) : [];
  const s = Math.max(1e-3, Number(step) || 1);
  const out = [];
  const n = points.length;
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out.push(a.slice());
    if (!(L > 1e-9)) continue;
    const nInsert = Math.max(0, Math.ceil(L / s) - 1);
    for (let k = 1; k <= nInsert; k++) {
      const t = k / (nInsert + 1);
      out.push([
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
      ]);
    }
  }
  if (!closed) out.push(points[n - 1].slice());
  return out;
}

/**
 * In-face directions from wall normals + path tangent.
 * @param {number[]} T
 * @param {number[]|null} n0
 * @param {number[]|null} n1
 */
export function inFaceDirsFromNormals(T, n0, n1) {
  if (!T || !n0 || !n1) return null;
  const Tn = _norm(T);
  let f0 = _cross(n0, Tn);
  let f1 = _cross(n1, Tn);
  if (_len(f0) < 1e-8 || _len(f1) < 1e-8) return null;
  f0 = _norm(f0);
  f1 = _norm(f1);
  if (_dot(f0, n1) > 0) f0 = [-f0[0], -f0[1], -f0[2]];
  if (_dot(f1, n0) > 0) f1 = [-f1[0], -f1[1], -f1[2]];
  return { f0, f1 };
}

/**
 * Local wall-square frame at a knot: path-normal orientation.
 * Square side ≈ 2R (ball diameter); setback = R / tan(θ/2).
 *
 * @param {number[]} origin
 * @param {number[]} T
 * @param {number[]} n0
 * @param {number[]} n1
 * @param {number} radius
 * @param {number[]|null} [prevN]
 */
export function buildInscribedArcFrame(origin, T, n0, n1, radius, prevN = null) {
  const dirs = inFaceDirsFromNormals(T, n0, n1);
  if (!dirs) return null;
  let A = dirs.f0;
  let C = dirs.f1;
  if (prevN && _dot(C, prevN) > _dot(A, prevN)) {
    const tmp = A;
    A = C;
    C = tmp;
  }
  const Tn = _norm(T);
  let N = A;
  let B = _norm(_cross(Tn, N));
  if (_dot(B, C) < 0) {
    N = C;
    B = _norm(_cross(Tn, N));
    if (_dot(B, A) < 0) B = [-B[0], -B[1], -B[2]];
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, _dot(_norm(dirs.f0), _norm(dirs.f1)))));
  if (!(theta > 0.05) || !(theta < Math.PI - 0.05)) return null;
  const r = Number(radius);
  if (!(r > 0)) return null;
  return {
    origin: origin.slice(),
    T: Tn,
    N,
    B,
    theta,
    setback: r / Math.tan(theta / 2),
    squareSide: 2 * r,
    f0: dirs.f0,
    f1: dirs.f1,
  };
}

/**
 * Path-normal frames for a (possibly densified) path.
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {{ radius: number, segmentNormals?: object[], seedNormals?: {n0,n1} }} opts
 */
export function buildVariableProfileFrames(points, closed, opts = {}) {
  const pts = Array.isArray(points) ? points : [];
  const n = pts.length;
  if (n < 2) return { frames: [], points: pts };
  const segCount = closed ? n : n - 1;
  const radius = Number(opts.radius) || 1;
  const seed = opts.seedNormals || null;
  const perSeg = opts.segmentNormals || null;
  const frames = [];
  let prevN = null;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const T = _norm(_sub(b, a));
    const nr = perSeg && perSeg[i] ? perSeg[i] : seed;
    const fr = (nr?.n0 && nr?.n1)
      ? buildInscribedArcFrame(a, T, nr.n0, nr.n1, radius, prevN)
      : null;
    if (fr) {
      frames.push(fr);
      prevN = fr.N;
    } else {
      const up = Math.abs(T[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const N = _norm(_cross(T, up));
      const B = _norm(_cross(T, N));
      frames.push({
        origin: a.slice(),
        T,
        N,
        B,
        theta: Math.PI / 2,
        setback: radius,
        squareSide: 2 * radius,
        f0: N,
        f1: B,
        weak: true,
      });
      prevN = N;
    }
  }
  return { frames, points: pts.map((p) => p.slice()) };
}
