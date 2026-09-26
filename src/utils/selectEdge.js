/**
 * Slice 12 — Edge pick helpers for Fillet/Chamfer.
 * Candidate edges = mesh edges shared by two triangles whose normals diverge
 * enough to be a feature edge (not a planar tessellation seam).
 */

import { Vector3 } from 'three';
import { propagateTrueTangentEdges } from './edgeTangencyField.js';

const DEFAULT_FEATURE_DEG = 2;

/**
 * Build feature edges from a BufferGeometry (indexed).
 * @returns {{ key: string, a: number, b: number, va: number[], vb: number[], mid: number[], length: number, tangent: number[], n0: number[], n1: number[] }[]}
 */
export function buildFeatureEdges(geometry, minAngleDeg = DEFAULT_FEATURE_DEG) {
  if (!geometry?.index || !geometry.attributes?.position) return [];
  const positions = geometry.attributes.position;
  const index = geometry.index.array;
  const numTri = index.length / 3;
  const edgeMap = new Map();

  const getN = (t) => {
    const i0 = index[t * 3], i1 = index[t * 3 + 1], i2 = index[t * 3 + 2];
    const v0 = new Vector3().fromBufferAttribute(positions, i0);
    const v1 = new Vector3().fromBufferAttribute(positions, i1);
    const v2 = new Vector3().fromBufferAttribute(positions, i2);
    return new Vector3().subVectors(v1, v0).cross(new Vector3().subVectors(v2, v0)).normalize();
  };

  for (let t = 0; t < numTri; t++) {
    const i0 = index[t * 3], i1 = index[t * 3 + 1], i2 = index[t * 3 + 2];
    const edges = [
      [Math.min(i0, i1), Math.max(i0, i1)],
      [Math.min(i1, i2), Math.max(i1, i2)],
      [Math.min(i2, i0), Math.max(i2, i0)],
    ];
    for (const [a, b] of edges) {
      const key = `${a}-${b}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { a, b, tris: [] });
      edgeMap.get(key).tris.push(t);
    }
  }

  const cosMin = Math.cos((minAngleDeg * Math.PI) / 180);
  const out = [];
  for (const e of edgeMap.values()) {
    if (e.tris.length !== 2) continue;
    const n0 = getN(e.tris[0]);
    const n1 = getN(e.tris[1]);
    if (n0.dot(n1) > cosMin) continue; // coplanar / seam
    const va = new Vector3().fromBufferAttribute(positions, e.a);
    const vb = new Vector3().fromBufferAttribute(positions, e.b);
    const mid = va.clone().add(vb).multiplyScalar(0.5);
    const tangent = vb.clone().sub(va);
    const length = tangent.length();
    if (length < 1e-9) continue;
    tangent.normalize();
    out.push({
      key: `${e.a}-${e.b}`,
      a: e.a,
      b: e.b,
      va: [va.x, va.y, va.z],
      vb: [vb.x, vb.y, vb.z],
      mid: [mid.x, mid.y, mid.z],
      length,
      tangent: [tangent.x, tangent.y, tangent.z],
      n0: [n0.x, n0.y, n0.z],
      n1: [n1.x, n1.y, n1.z],
    });
  }
  return out;
}

/** Distance from point to segment (va–vb). */
export function distPointToSegment(p, va, vb) {
  const ax = va[0], ay = va[1], az = va[2];
  const bx = vb[0], by = vb[1], bz = vb[2];
  const px = p[0], py = p[1], pz = p[2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const abLen2 = abx * abx + aby * aby + abz * abz;
  let t = abLen2 > 1e-18 ? (apx * abx + apy * aby + apz * abz) / abLen2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * abx, qy = ay + t * aby, qz = az + t * abz;
  return Math.hypot(px - qx, py - qy, pz - qz);
}

/**
 * Pick nearest feature edge to a world hit point.
 * @deprecated-in-app Prefer pickNearestEdgeScreen for Viewport edge mode (screen-space slop).
 * Kept for golden coverage and any world-space call sites.
 * @returns {object|null}
 */
export function pickNearestEdge(featureEdges, hitPoint, maxDist) {
  if (!featureEdges?.length || !hitPoint) return null;
  let best = null;
  let bestD = maxDist;
  for (const e of featureEdges) {
    const d = distPointToSegment(hitPoint, e.va, e.vb);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/** Stable edge id for multi-select toggle. */
export function edgeKey(edge) {
  if (!edge) return '';
  if (edge.key) return edge.key;
  const a = Math.min(edge.a, edge.b);
  const b = Math.max(edge.a, edge.b);
  return `${a}-${b}`;
}

/**
 * Toggle edge in selection list (by key). Returns new array.
 */
export function toggleEdgeSelection(selected, edge) {
  const key = edgeKey(edge);
  const list = Array.isArray(selected) ? [...selected] : [];
  const idx = list.findIndex((e) => edgeKey(e) === key);
  if (idx >= 0) list.splice(idx, 1);
  else {
    list.push(copyPickEdge(edge, key));
  }
  return list;
}

/** Fields the viewport pick must keep so Fillet Accept can emit face/edge ids. */
function copyPickEdge(edge, key) {
  return {
    key,
    a: edge.a,
    b: edge.b,
    va: edge.va.slice(),
    vb: edge.vb.slice(),
    mid: edge.mid.slice(),
    length: edge.length,
    tangent: edge.tangent ? edge.tangent.slice() : undefined,
    n0: edge.n0 ? edge.n0.slice() : undefined,
    n1: edge.n1 ? edge.n1.slice() : undefined,
    faceA: Number.isFinite(edge.faceA) ? edge.faceA : undefined,
    faceB: Number.isFinite(edge.faceB) ? edge.faceB : undefined,
    boundaryId: Number.isFinite(edge.boundaryId) ? edge.boundaryId : undefined,
    pairCount: Number.isFinite(edge.pairCount) ? edge.pairCount : undefined,
    chainId: Number.isFinite(edge.chainId) ? edge.chainId : undefined,
  };
}

/**
 * Kernel size-guard fraction for **planar** filletEdges / chamferEdges (t < 0.45·L).
 * Planar-only: Strategy=sweep / filletAlongPath must NOT use this clamp — short
 * tessellation edges on a prior fillet rim would pin the slider near ~0.04 while
 * r=6 is fine in script. See defaultSweepBlendSize / sweepBlendHardMax.
 */
export const EDGE_BLEND_SIZE_GUARD = 0.45;

/**
 * Minimum length among selected edges (uses .length or |vb-va|).
 * @param {object[]|null|undefined} edges
 * @returns {number|null}
 */
export function minSelectedEdgeLength(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  let min = Infinity;
  for (const e of edges) {
    let L = Number(e?.length);
    if (!(Number.isFinite(L) && L > 0) && e?.va && e?.vb) {
      L = Math.hypot(
        e.vb[0] - e.va[0],
        e.vb[1] - e.va[1],
        e.vb[2] - e.va[2],
      );
    }
    if (Number.isFinite(L) && L > 0) min = Math.min(min, L);
  }
  return min === Infinity ? null : min;
}

/**
 * Length used for Fillet/Chamfer slider defaults on multi-edge picks.
 * Raw min() collapses to ~0.03 when a tangent/compound set includes short
 * tessellation scraps; drop outliers below 25% of the median, then take min
 * of the kept pool (single-edge unchanged).
 * @param {object[]|null|undefined} edges
 * @returns {number|null}
 */
export function effectiveBlendEdgeLength(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const lengths = [];
  for (const e of edges) {
    let L = Number(e?.length);
    if (!(Number.isFinite(L) && L > 0) && e?.va && e?.vb) {
      L = Math.hypot(
        e.vb[0] - e.va[0],
        e.vb[1] - e.va[1],
        e.vb[2] - e.va[2],
      );
    }
    if (Number.isFinite(L) && L > 0) lengths.push(L);
  }
  if (!lengths.length) return null;
  if (lengths.length === 1) return lengths[0];
  lengths.sort((a, b) => a - b);
  const med = lengths[Math.floor(lengths.length / 2)];
  const kept = lengths.filter((L) => L >= 0.25 * med);
  const pool = kept.length ? kept : [med];
  return Math.min(...pool);
}

/**
 * Range-input step scaled to hard-max so short-edge sliders are not stuck
 * (step 0.5 with max≈0.03 leaves the thumb immovable).
 * @param {number|null|undefined} hardMax
 * @returns {number}
 */
export function blendSliderStep(hardMax) {
  const m = Number(hardMax);
  if (!(m > 0) || m >= 5) return 0.5;
  return Math.max(0.01, Math.round((m / 20) * 100) / 100);
}

/**
 * Safe default fillet/chamfer size from min edge length.
 * Formula: clamp(0.15·minL, min(0.5, 0.35·minL), 0.35·minL) — always ≤ 0.35·L < 0.45·L.
 * @param {number} minEdgeLength
 * @returns {number}
 */
export function defaultEdgeBlendSize(minEdgeLength) {
  const minL = Number(minEdgeLength);
  if (!(minL > 0)) return 3;
  const softMax = 0.35 * minL;
  const floor = Math.min(0.5, softMax);
  const r = Math.min(softMax, Math.max(floor, 0.15 * minL));
  // Param min for radius/chamfer is 0.01 — never round a tiny softMax down to 0.
  return Math.max(0.01, Math.round(r * 100) / 100);
}

/**
 * Slider / type hard max under the kernel size guard (0.44·minL).
 * @param {number} minEdgeLength
 * @returns {number}
 */
export function edgeBlendHardMax(minEdgeLength) {
  const minL = Number(minEdgeLength);
  if (!(minL > 0)) return 100;
  return Math.round(0.44 * minL * 100) / 100;
}

/**
 * True if blend size would fail the **planar** kernel size guard (t ≥ 0.45·L).
 * Do not call for Strategy=sweep / filletAlongPath — see sweepBlendHardMax.
 */
export function edgeBlendFailsSizeGuard(size, minEdgeLength) {
  const t = Number(size);
  const minL = Number(minEdgeLength);
  if (!(t > 0) || !(minL > 0)) return false;
  return t >= EDGE_BLEND_SIZE_GUARD * minL;
}

/**
 * Total path length of selected edges (sum of .length / |vb−va|).
 * Used for Strategy=sweep radius defaults when per-edge min L is tessellation-scale.
 * @param {object[]|null|undefined} edges
 * @returns {number|null}
 */
export function pathLengthFromEdges(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const e of edges) {
    let L = Number(e?.length);
    if (!(Number.isFinite(L) && L > 0) && e?.va && e?.vb) {
      L = Math.hypot(
        e.vb[0] - e.va[0],
        e.vb[1] - e.va[1],
        e.vb[2] - e.va[2],
      );
    }
    if (Number.isFinite(L) && L > 0) {
      sum += L;
      n++;
    }
  }
  return n ? sum : null;
}

/**
 * Absolute model-unit floor/cap for defaultSweepBlendSize (box-scale UX).
 * 0.1·L is scale-relative; these bound the thumb on ~10–60 unit perimeters.
 */
export const SWEEP_BLEND_DEFAULT_MIN = 1;
export const SWEEP_BLEND_DEFAULT_MAX = 6;

/**
 * Sweep fillet default radius from path length (not 0.45·minL).
 * Caps at SWEEP_BLEND_DEFAULT_MAX so box-scale perimeter picks get a usable
 * thumb without the planar 0.45·L clamp. Empty L → 3 (planar fillet seed);
 * call sites pass null through rather than inventing L=30.
 * @param {number} pathLength
 * @returns {number}
 */
export function defaultSweepBlendSize(pathLength) {
  const L = Number(pathLength);
  if (!(L > 0)) return 3;
  const r = Math.min(
    SWEEP_BLEND_DEFAULT_MAX,
    Math.max(SWEEP_BLEND_DEFAULT_MIN, 0.1 * L),
  );
  return Math.max(0.01, Math.round(r * 100) / 100);
}

/**
 * Sweep slider / typed hard max — scale-relative (½·L), floored at 6 (not 50).
 * Floor 6 (vs review's suggested 5) keeps typed-6 + max≥6 golden on short rims;
 * absolute 50 was oversized (~13× segment on box-scale paths).
 * Empty / non-positive L → 100 (no invented L=30).
 * @param {number} [pathLength]
 * @returns {number}
 */
export function sweepBlendHardMax(pathLength) {
  const L = Number(pathLength);
  if (L > 0) return Math.max(6, Math.round(0.5 * L * 100) / 100);
  return 100;
}

/** Pop the last selected edge (Back affordance). Returns new array. */
export function popLastEdgeSelection(selected) {
  const list = Array.isArray(selected) ? [...selected] : [];
  if (list.length === 0) return list;
  list.pop();
  return list;
}

/** 2D distance from point (px,py) to segment (ax,ay)–(bx,by). */
export function distPointToSegment2D(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLen2 = abx * abx + aby * aby;
  let t = abLen2 > 1e-18 ? (apx * abx + apy * aby) / abLen2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * abx;
  const qy = ay + t * aby;
  return Math.hypot(px - qx, py - qy);
}

/** Default finger slop in CSS pixels for edge pick (mobile-friendly). */
export const EDGE_PICK_SLOP_PX = 32;
export const EDGE_PICK_SLOP_COARSE_PX = 40;

/**
 * Resolve pixel slop for the current pointer type.
 * Coarse (touch) gets a larger target; fine pointers stay at EDGE_PICK_SLOP_PX.
 */
export function resolveEdgePickSlopPx(opts = {}) {
  if (typeof opts.slopPx === 'number' && opts.slopPx > 0) return opts.slopPx;
  if (opts.coarse === true) return EDGE_PICK_SLOP_COARSE_PX;
  if (opts.coarse === false) return EDGE_PICK_SLOP_PX;
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
    return EDGE_PICK_SLOP_COARSE_PX;
  }
  return EDGE_PICK_SLOP_PX;
}

/**
 * Project a world point through a Three.js camera into canvas pixel coords.
 * Returns null if the point is outside useful NDC depth (behind / clipped).
 *
 * @param {object} camera Three.js Camera
 * @param {number[]} world [x,y,z]
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {{x:number,y:number,z:number,project?:Function}|null} [tmp]
 */
export function projectWorldToCanvas(camera, world, canvasW, canvasH, tmp = null) {
  if (!camera || !world || !(canvasW > 0) || !(canvasH > 0)) return null;
  const v = tmp || { x: 0, y: 0, z: 0 };
  v.x = world[0];
  v.y = world[1];
  v.z = world[2];
  if (typeof v.project === 'function') {
    v.project(camera);
  } else {
    const m = camera.matrixWorldInverse;
    const p = camera.projectionMatrix;
    if (!m || !p) return null;
    const e = m.elements;
    const x = v.x;
    const y = v.y;
    const z = v.z;
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const ww = e[3] * x + e[7] * y + e[11] * z + e[15];
    const pe = p.elements;
    const cx = pe[0] * wx + pe[4] * wy + pe[8] * wz + pe[12] * ww;
    const cy = pe[1] * wx + pe[5] * wy + pe[9] * wz + pe[13] * ww;
    const cz = pe[2] * wx + pe[6] * wy + pe[10] * wz + pe[14] * ww;
    const cw = pe[3] * wx + pe[7] * wy + pe[11] * wz + pe[15] * ww;
    if (Math.abs(cw) < 1e-12) return null;
    v.x = cx / cw;
    v.y = cy / cw;
    v.z = cz / cw;
  }
  if (v.z < -1 || v.z > 1) return null;
  return {
    x: (v.x * 0.5 + 0.5) * canvasW,
    y: (-v.y * 0.5 + 0.5) * canvasH,
    ndcZ: v.z,
  };
}


/**
 * True when no adjacent face normal points toward the camera (back / through
 * solid). Silhouette edges typically have one camera-facing normal — false.
 * Missing normals: treat as facing away so distance-only rejection still works.
 */
export function edgeFacesAwayFromCamera(e, camPos) {
  if (!e?.mid || !camPos) return true;
  const mid = e.mid;
  const vx = camPos[0] - mid[0];
  const vy = camPos[1] - mid[1];
  const vz = camPos[2] - mid[2];
  const toward = (n) => n && (n[0] * vx + n[1] * vy + n[2] * vz) > 0;
  if (!e.n0 && !e.n1) return true;
  return !(toward(e.n0) || toward(e.n1));
}

/**
 * Screen-space edge pick: nearest feature edge by 2D pixel distance to the
 * projected segment. Does NOT require a mesh face hit — silhouette / near-miss
 * taps work. Prefer closer-to-camera edge on near ties.
 *
 * Occlusion (opts.meshHitPoint + opts.cameraPosition): when the tap hits the
 * mesh, reject edges whose midpoint is further from the camera than the hit
 * (plus a small epsilon) AND whose adjacent face normals both face away from
 * the camera. Pure distance rejection false-rejects silhouette / boundary
 * edges beside the solid (lateral offset makes mid farther even when the edge
 * is the intended pick). Edges with any camera-facing normal (silhouette band)
 * are kept. Taps with no mesh hit skip this filter.
 *
 * @returns {object|null}
 */
export function pickNearestEdgeScreen(
  featureEdges,
  camera,
  canvasW,
  canvasH,
  px,
  py,
  maxPx,
  opts = {},
) {
  if (!featureEdges?.length || !camera || !(maxPx > 0)) return null;
  const scratchA = opts.projectScratchA || null;
  const scratchB = opts.projectScratchB || null;
  const hit = opts.meshHitPoint;
  const camPos = opts.cameraPosition;
  const occludeEps = typeof opts.occlusionEps === 'number' ? opts.occlusionEps : 0.75;
  let hitDist = null;
  if (hit && camPos && Array.isArray(hit) && Array.isArray(camPos)) {
    hitDist = Math.hypot(hit[0] - camPos[0], hit[1] - camPos[1], hit[2] - camPos[2]);
  }
  let best = null;
  let bestD = Infinity;
  let bestDepth = Infinity;
  for (const e of featureEdges) {
    const sa = projectWorldToCanvas(camera, e.va, canvasW, canvasH, scratchA);
    const sb = projectWorldToCanvas(camera, e.vb, canvasW, canvasH, scratchB);
    if (!sa && !sb) continue;
    let d;
    let depth;
    if (sa && sb) {
      d = distPointToSegment2D(px, py, sa.x, sa.y, sb.x, sb.y);
      depth = Math.min(sa.ndcZ, sb.ndcZ);
    } else {
      const s = sa || sb;
      d = Math.hypot(px - s.x, py - s.y);
      depth = s.ndcZ;
    }
    // Strict < maxPx (matches pickNearestEdge); depth tie-break when equal px.
    if (!(d < maxPx)) continue;
    // Mesh occlusion: drop edges behind the front-face hit, but only when the
    // edge faces away from the camera. Silhouette edges beside the solid have
    // a lateral mid offset that exceeds hitDist+eps even though one face
    // normal still faces the camera — keep those.
    if (hitDist != null && camPos && e.mid) {
      const mid = e.mid;
      const edgeDist = Math.hypot(mid[0] - camPos[0], mid[1] - camPos[1], mid[2] - camPos[2]);
      if (edgeDist > hitDist + occludeEps && edgeFacesAwayFromCamera(e, camPos)) continue;
    }
    if (d < bestD || (d === bestD && depth < bestDepth)) {
      bestD = d;
      bestDepth = depth;
      best = e;
    }
  }
  return best;
}

/** Default G1 (tangent) propagation threshold in degrees.
 * 25° covers production 16-seg circles (22.5° turn, cos=0.9239 < cos(22°))
 * while still breaking genuine hard corners (≥45°). N=12 (30°) stays seed-only. */
export const TANGENT_PROP_DEG = 25;

/**
 * Build adjacency: vertex index → feature edges touching it.
 * @param {object[]} featureEdges
 * @returns {Map<number, object[]>}
 */
export function buildEdgeVertexAdj(featureEdges) {
  const adj = new Map();
  if (!featureEdges?.length) return adj;
  for (const e of featureEdges) {
    for (const v of [e.a, e.b]) {
      if (!adj.has(v)) adj.set(v, []);
      adj.get(v).push(e);
    }
  }
  return adj;
}

/**
 * Absolute tangent alignment |t0·t1| for G1 test (direction-insensitive).
 */
export function tangentAlign(t0, t1) {
  if (!t0 || !t1) return 0;
  return Math.abs(t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2]);
}

/**
 * Propagate G1-connected (tangent) edges from a seed through the feature-edge
 * graph. Soft-fails to [seed] when no tangent neighbors exist.
 *
 * Walk rule: at a shared vertex, accept a neighbor when |t_seed·t_nbr| >= cos(tolDeg)
 * (tessellated circular / fillet loops stay linked; sharp corners break the chain).
 *
 * @param {object[]} featureEdges
 * @param {object} seedEdge
 * @param {{ tolDeg?: number, adj?: Map<number, object[]> }} [opts]
 * @returns {object[]} seed + G1 chain (deduped by edgeKey)
 */
export function propagateTangentEdges(featureEdges, seedEdge, opts = {}) {
  // C3: true G1 (tangent + wall-normal continuity) via shared tangency field.
  // Soft-fails to the seed; caps at COHERENT_EDGE_MAX (no #49 spaghetti).
  if (!seedEdge) return [];
  const chain = propagateTrueTangentEdges(featureEdges || [], seedEdge, {
    tolDeg: opts.tolDeg,
    adj: opts.adj || buildEdgeVertexAdj(featureEdges || []),
    max: COHERENT_EDGE_MAX,
  });
  return chain.map((e) => copyPickEdge(e, edgeKey(e)));
}

export function edgeDihedralDeg(edge) {
  const n0 = edge?.n0;
  const n1 = edge?.n1;
  if (!n0 || !n1) return 0;
  const d = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
  return Math.acos(Math.min(1, Math.max(-1, d))) * 180 / Math.PI;
}

/**
 * Hard cap on a single pick / tangent chain.
 * A simple loft silhouette (rim, corner generator, rectangle side) fits;
 * a tessellation flood (~160 zig-zag segments) does not — refuse it.
 */
export const COHERENT_EDGE_MAX = 36;

const COLLINEAR_DEG = 6;
const LINE_OFFSET_EPS = 0.45;
const LINE_GAP_EPS = 0.75;
/** RDP tolerance. Keeps a mild loft generator; collapses a straight side to one segment. */
const CHAIN_SIMPLIFY_EPS = 0.35;
/** Closed loops kept only when they are circular rims, not a face outline. */
const RIM_RADIAL_CV = 0.12;

function _sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _len3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function _dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function _otherVert(edge, v) {
  return edge.a === v ? edge.b : edge.a;
}
function _posAt(edge, v) {
  return v === edge.a ? edge.va : edge.vb;
}

function _pointLineDist(p, origin, tangent) {
  const vx = p[0] - origin[0];
  const vy = p[1] - origin[1];
  const vz = p[2] - origin[2];
  const proj = vx * tangent[0] + vy * tangent[1] + vz * tangent[2];
  return Math.hypot(p[0] - (origin[0] + proj * tangent[0]), p[1] - (origin[1] + proj * tangent[1]), p[2] - (origin[2] + proj * tangent[2]));
}

function _pointSegDist(p, a, b) {
  const ab = _sub3(b, a);
  const L2 = _dot3(ab, ab);
  let t = L2 > 1e-18 ? _dot3(_sub3(p, a), ab) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return _dist3(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
}

function _sameLine(a, b) {
  if (tangentAlign(a.tangent, b.tangent) < Math.cos((COLLINEAR_DEG * Math.PI) / 180)) return false;
  if (_pointLineDist(b.va, a.va, a.tangent) > LINE_OFFSET_EPS) return false;
  if (_pointLineDist(b.vb, a.va, a.tangent) > LINE_OFFSET_EPS) return false;
  return true;
}

function _uniqueFinite(edges, field) {
  let value;
  let seen = false;
  for (const e of edges) {
    if (!Number.isFinite(e?.[field])) continue;
    if (!seen) {
      value = e[field];
      seen = true;
    } else if (e[field] !== value) {
      return undefined;
    }
  }
  return seen ? value : undefined;
}

/**
 * Collapse overlapping collinear copies of one design edge (loft rims are
 * often dozens of coincident triangle edges on the same line) into one segment.
 * @param {object[]} edges
 */
function mergeCollinearEdges(edges) {
  // Group against the seed line only. Union-find would walk a curve
  // (each 6° step collinear with the last) and erase a loft generator.
  const used = new Array(edges.length).fill(false);
  const groups = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const group = [edges[i]];
    used[i] = true;
    for (let j = i + 1; j < edges.length; j++) {
      if (used[j]) continue;
      if (!_sameLine(edges[i], edges[j])) continue;
      used[j] = true;
      group.push(edges[j]);
    }
    groups.push(group);
  }
  const out = [];
  for (const group of groups) {
    const t = group[0].tangent;
    const origin = group[0].va;
    const spans = group.map((e) => {
      const pa = _dot3(_sub3(e.va, origin), t);
      const pb = _dot3(_sub3(e.vb, origin), t);
      const lo = Math.min(pa, pb);
      const hi = Math.max(pa, pb);
      const loP = pa <= pb ? e.va : e.vb;
      const hiP = pa <= pb ? e.vb : e.va;
      const loI = pa <= pb ? e.a : e.b;
      const hiI = pa <= pb ? e.b : e.a;
      return { lo, hi, loP, hiP, loI, hiI, src: e };
    });
    spans.sort((a, b) => a.lo - b.lo);
    const flush = (span) => {
      const va = span.loP.slice();
      const vb = span.hiP.slice();
      const delta = _sub3(vb, va);
      const L = _len3(delta);
      if (!(L > 1e-8)) return;
      const tangent = [delta[0] / L, delta[1] / L, delta[2] / L];
      out.push({
        key: `m-${span.loI}-${span.hiI}-${out.length}`,
        a: span.loI,
        b: span.hiI,
        va,
        vb,
        mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
        length: L,
        tangent,
        n0: span.src.n0 ? span.src.n0.slice() : undefined,
        n1: span.src.n1 ? span.src.n1.slice() : undefined,
        boundaryId: span.boundaryId,
        faceA: span.faceA,
        faceB: span.faceB,
        pairCount: span.pairCount,
        _sources: span.sources,
      });
    };
    const first = spans[0];
    let acc = {
      lo: first.lo,
      hi: first.hi,
      loP: first.loP,
      hiP: first.hiP,
      loI: first.loI,
      hiI: first.hiI,
      src: first.src,
      boundaryId: _uniqueFinite([first.src], 'boundaryId'),
      faceA: _uniqueFinite([first.src], 'faceA'),
      faceB: _uniqueFinite([first.src], 'faceB'),
      pairCount: _uniqueFinite([first.src], 'pairCount'),
      sources: [first.src],
    };
    for (let k = 1; k < spans.length; k++) {
      const s = spans[k];
      if (s.lo <= acc.hi + LINE_GAP_EPS) {
        acc.sources.push(s.src);
        if (s.hi > acc.hi) {
          acc.hi = s.hi;
          acc.hiP = s.hiP;
          acc.hiI = s.hiI;
        }
        acc.boundaryId = _uniqueFinite(acc.sources, 'boundaryId');
        acc.faceA = _uniqueFinite(acc.sources, 'faceA');
        acc.faceB = _uniqueFinite(acc.sources, 'faceB');
        acc.pairCount = _uniqueFinite(acc.sources, 'pairCount');
      } else {
        flush(acc);
        acc = {
          lo: s.lo,
          hi: s.hi,
          loP: s.loP,
          hiP: s.hiP,
          loI: s.loI,
          hiI: s.hiI,
          src: s.src,
          boundaryId: _uniqueFinite([s.src], 'boundaryId'),
          faceA: _uniqueFinite([s.src], 'faceA'),
          faceB: _uniqueFinite([s.src], 'faceB'),
          pairCount: _uniqueFinite([s.src], 'pairCount'),
          sources: [s.src],
        };
      }
    }
    flush(acc);
  }
  return out;
}

function _walkDir(prev, v, adj, used) {
  const cosTol = Math.cos((TANGENT_PROP_DEG * Math.PI) / 180);
  const seq = [];
  while (seq.length < 8000) {
    const nbrs = adj.get(v) || [];
    let best = null;
    let bestAl = cosTol;
    for (const n of nbrs) {
      const nk = edgeKey(n);
      if (used.has(nk)) continue;
      const al = tangentAlign(prev.tangent, n.tangent);
      if (al + 1e-12 < cosTol) continue;
      if (!best || al > bestAl + 1e-12 || (Math.abs(al - bestAl) <= 1e-12 && n.length > best.length)) {
        bestAl = al;
        best = n;
      }
    }
    if (!best) break;
    seq.push(best);
    used.add(edgeKey(best));
    v = _otherVert(best, v);
    prev = best;
  }
  return seq;
}

function _traceChains(edges) {
  const adj = buildEdgeVertexAdj(edges);
  const used = new Set();
  const chains = [];
  for (const edge of edges) {
    const sk = edgeKey(edge);
    if (used.has(sk)) continue;
    used.add(sk);
    const forward = _walkDir(edge, edge.b, adj, used);
    const backward = _walkDir(edge, edge.a, adj, used);
    chains.push([...backward.reverse(), edge, ...forward]);
  }
  return chains;
}

function _orderChain(chain) {
  if (!chain.length) return null;
  let v = chain[0].a;
  if (chain.length > 1) {
    const n = chain[1];
    const sharesA = n.a === chain[0].a || n.b === chain[0].a;
    v = sharesA ? chain[0].b : chain[0].a;
  }
  const pts = [];
  const idxs = [];
  pts.push(_posAt(chain[0], v).slice());
  idxs.push(v);
  for (const e of chain) {
    const next = e.a === v ? e.b : (e.b === v ? e.a : null);
    if (next == null) return null;
    pts.push(_posAt(e, next).slice());
    idxs.push(next);
    v = next;
  }
  const closed = idxs.length > 2 && idxs[0] === idxs[idxs.length - 1];
  if (closed) {
    pts.pop();
    idxs.pop();
  }
  return { pts, idxs, closed };
}

function _rdpKeep(pts, eps) {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Array(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const pair = stack.pop();
    const i = pair[0];
    const j = pair[1];
    let maxD = 0;
    let maxK = -1;
    for (let k = i + 1; k < j; k++) {
      const d = _pointSegDist(pts[k], pts[i], pts[j]);
      if (d > maxD) {
        maxD = d;
        maxK = k;
      }
    }
    if (maxK >= 0 && maxD > eps) {
      keep[maxK] = true;
      stack.push([i, maxK], [maxK, j]);
    }
  }
  const idx = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

function _simplifyPolyline(pts, closed) {
  if (!pts || pts.length < 2) return null;
  if (!closed) {
    const idx = _rdpKeep(pts, CHAIN_SIMPLIFY_EPS);
    return idx.length >= 2 ? idx : null;
  }
  if (pts.length < 3) return null;
  let far = 1;
  let best = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = _dist3(pts[0], pts[i]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const left = _rdpKeep(pts.slice(0, far + 1), CHAIN_SIMPLIFY_EPS);
  const rightPts = pts.slice(far).concat([pts[0]]);
  const right = _rdpKeep(rightPts, CHAIN_SIMPLIFY_EPS).map((i) => (i === rightPts.length - 1 ? 0 : far + i));
  const merged = left.concat(right.slice(1, -1));
  return merged.length >= 3 ? merged : null;
}

function _radialCv(pts) {
  if (!pts.length) return Infinity;
  const c = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  c[0] /= pts.length;
  c[1] /= pts.length;
  c[2] /= pts.length;
  const rs = pts.map((p) => _dist3(p, c));
  const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
  if (!(mean > 1e-8)) return Infinity;
  const dev = rs.reduce((s, r) => s + Math.abs(r - mean), 0) / rs.length;
  return dev / mean;
}

function _segmentsFromKeep(ordered, keep) {
  const { pts, idxs, closed } = ordered;
  const segs = [];
  const n = keep.length;
  const steps = closed ? n : n - 1;
  for (let s = 0; s < steps; s++) {
    const i0 = keep[s];
    const i1 = keep[(s + 1) % n];
    const va = pts[i0];
    const vb = pts[i1];
    const delta = _sub3(vb, va);
    const L = _len3(delta);
    if (!(L > 1e-8)) continue;
    segs.push({
      a: idxs[i0],
      b: idxs[i1],
      va: va.slice(),
      vb: vb.slice(),
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      length: L,
      tangent: [delta[0] / L, delta[1] / L, delta[2] / L],
    });
  }
  return segs;
}

/**
 * Pick candidates for Edge / Fillet: sharp creases collapsed to a short
 * silhouette polyline. Shallow loft-wall seams (dihedral under the #46
 * gate) never enter the graph, so tangent-on cannot flood the tessellation.
 * A chain that will not simplify under {@link COHERENT_EDGE_MAX} is dropped
 * (empty is better than a zig-zag mesh dump).
 *
 * Closed loops are kept only when they are circular rims. Untagged chains
 * (no #46 boundary id — loft generators the small-face test dropped) are
 * kept when the simplified polyline is a simple open curve or a round rim.
 *
 * @param {object[]} featureEdges
 * @param {{ minDeg?: number }} [opts]
 * @returns {object[]}
 */
export function buildCoherentEdges(featureEdges, opts = {}) {
  const minDeg = typeof opts.minDeg === 'number' ? opts.minDeg : 15;
  const sharp = [];
  for (const e of featureEdges || []) {
    if (!e?.va || !e?.vb || !e?.tangent) continue;
    if (edgeDihedralDeg(e) + 1e-9 < minDeg) continue;
    sharp.push(e);
  }
  if (!sharp.length) return [];
  const merged = mergeCollinearEdges(sharp);
  const chains = _traceChains(merged);
  const out = [];
  let chainSeq = 0;
  const consumedIds = new Set();
  const noteIds = (chain) => {
    for (const e of chain) {
      if (Number.isFinite(e.boundaryId)) consumedIds.add(e.boundaryId);
      const sources = e._sources;
      if (!sources) continue;
      for (const src of sources) {
        if (Number.isFinite(src.boundaryId)) consumedIds.add(src.boundaryId);
      }
    }
  };
  for (const chain of chains) {
    const ordered = _orderChain(chain);
    if (!ordered || ordered.pts.length < 2) continue;
    const keep = _simplifyPolyline(ordered.pts, ordered.closed);
    if (!keep) continue;
    const segs = _segmentsFromKeep(ordered, keep);
    if (!segs.length || segs.length > COHERENT_EDGE_MAX) continue;
    const boundaryId = _uniqueFinite(chain, 'boundaryId');
    const tagged = Number.isFinite(boundaryId);
    if (!tagged) {
      if (ordered.closed) {
        // Round rims only. A filleted face outline is closed-ish but not circular.
        if (_radialCv(ordered.pts) > RIM_RADIAL_CV) continue;
      } else {
        // Open recovery (loft generator the small-face test dropped) must be a
        // spine. Blend outlines wander across a whole face and are refused.
        const a = ordered.pts[0];
        const b = ordered.pts[ordered.pts.length - 1];
        const chord = _dist3(a, b);
        let dev = 0;
        for (let i = 1; i < ordered.pts.length - 1; i++) {
          dev = Math.max(dev, _pointSegDist(ordered.pts[i], a, b));
        }
        if (dev > Math.max(1.25, 0.3 * chord)) continue;
      }
    }
    noteIds(chain);
    const id = chainSeq;
    chainSeq += 1;
    const faceA = _uniqueFinite(chain, 'faceA');
    const faceB = _uniqueFinite(chain, 'faceB');
    const pairCount = _uniqueFinite(chain, 'pairCount');
    segs.forEach((seg, i) => {
      // C3: nearest-source normals (not a single first-hit stamp).
      let best = null;
      let bestD = Infinity;
      for (const src of chain) {
        if (!src?.n0 || !src?.n1 || !src.mid) continue;
        const d = _dist3(seg.mid, src.mid);
        if (d < bestD) {
          bestD = d;
          best = src;
        }
      }
      const n0 = best?.n0 || chain.find((e) => e.n0)?.n0;
      const n1 = best?.n1 || chain.find((e) => e.n1)?.n1;
      out.push({
        ...seg,
        key: `coh-${id}-${i}`,
        chainId: id,
        boundaryId,
        faceA,
        faceB,
        pairCount,
        n0: n0 ? n0.slice() : undefined,
        n1: n1 ? n1.slice() : undefined,
      });
    });
  }
  // #46 edges must survive even when a tangent walk dragged them into a
  // chain that was refused as a blend outline.
  const leftover = new Map();
  for (const e of sharp) {
    if (!Number.isFinite(e.boundaryId) || consumedIds.has(e.boundaryId)) continue;
    if (!leftover.has(e.boundaryId)) leftover.set(e.boundaryId, []);
    leftover.get(e.boundaryId).push(e);
  }
  for (const group of leftover.values()) {
    const merged = mergeCollinearEdges(group);
    const pieces = _traceChains(merged);
    for (const chain of pieces) {
      const ordered = _orderChain(chain);
      if (!ordered) continue;
      const keep = _simplifyPolyline(ordered.pts, ordered.closed);
      if (!keep) continue;
      const segs = _segmentsFromKeep(ordered, keep);
      if (!segs.length || segs.length > COHERENT_EDGE_MAX) continue;
      const id = chainSeq;
      chainSeq += 1;
      const boundaryId = _uniqueFinite(chain, 'boundaryId');
      const faceA = _uniqueFinite(chain, 'faceA');
      const faceB = _uniqueFinite(chain, 'faceB');
      const pairCount = _uniqueFinite(chain, 'pairCount');
      segs.forEach((seg, i) => {
        let best = null;
        let bestD = Infinity;
        for (const src of chain) {
          if (!src?.n0 || !src?.n1 || !src.mid) continue;
          const d = _dist3(seg.mid, src.mid);
          if (d < bestD) {
            bestD = d;
            best = src;
          }
        }
        const n0 = best?.n0 || chain.find((e) => e.n0)?.n0;
        const n1 = best?.n1 || chain.find((e) => e.n1)?.n1;
        out.push({
          ...seg,
          key: `coh-${id}-${i}`,
          chainId: id,
          boundaryId,
          faceA,
          faceB,
          pairCount,
          n0: n0 ? n0.slice() : undefined,
          n1: n1 ? n1.slice() : undefined,
        });
      });
    }
  }
  return out;
}

/**
 * Add seed (+ optional G1 chain) to selection, or remove seed if already selected.
 * When removing, only the tapped edge is removed (chain stays unless toggled off).
 *
 * @param {object[]} selected
 * @param {object} edge
 * @param {{ propagate?: boolean, featureEdges?: object[], tolDeg?: number }} [opts]
 */
export function toggleEdgeSelectionPropagated(selected, edge, opts = {}) {
  const key = edgeKey(edge);
  const list = Array.isArray(selected) ? [...selected] : [];
  const idx = list.findIndex((e) => edgeKey(e) === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    return list;
  }
  const propagate = opts.propagate !== false;
  let toAdd = null;
  let refuseFlood = false;
  if (propagate && Number.isFinite(edge?.chainId) && opts.featureEdges?.length) {
    const chain = opts.featureEdges.filter((e) => e.chainId === edge.chainId);
    // Cap → keep seed (never return empty; never re-flood the same spaghetti).
    if (chain.length > COHERENT_EDGE_MAX) {
      refuseFlood = true;
    } else if (chain.length > 1) {
      toAdd = chain;
    }
  }
  if (!toAdd && !refuseFlood && propagate && opts.featureEdges?.length) {
    toAdd = propagateTangentEdges(opts.featureEdges, edge, { tolDeg: opts.tolDeg });
    // Hitting the cap means tessellation flood — keep the seed only.
    if (toAdd.length >= COHERENT_EDGE_MAX) {
      toAdd = null;
    }
  }
  if (!toAdd || toAdd.length <= 1) {
    // Soft-fail: no tangents — just the seed (same as toggleEdgeSelection add).
    return toggleEdgeSelection(list, edge);
  }
  const have = new Set(list.map((e) => edgeKey(e)));
  for (const e of toAdd) {
    const k = edgeKey(e);
    if (have.has(k)) continue;
    list.push(copyPickEdge(e, k));
    have.add(k);
  }
  return list;
}
