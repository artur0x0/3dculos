/**
 * Slice 12 — Edge pick helpers for Fillet/Chamfer.
 * Candidate edges = mesh edges shared by two triangles whose normals diverge
 * enough to be a feature edge (not a planar tessellation seam).
 */

import { Vector3 } from 'three';

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
    list.push({
      key,
      a: edge.a,
      b: edge.b,
      va: edge.va.slice(),
      vb: edge.vb.slice(),
      mid: edge.mid.slice(),
      length: edge.length,
      tangent: edge.tangent ? edge.tangent.slice() : undefined,
    });
  }
  return list;
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
 * Sweep fillet default radius from path length (not 0.45·minL).
 * Caps at 6 so box-scale perimeter picks get a usable thumb without planar clamp.
 * @param {number} pathLength
 * @returns {number}
 */
export function defaultSweepBlendSize(pathLength) {
  const L = Number(pathLength);
  if (!(L > 0)) return 3;
  const r = Math.min(6, Math.max(1, 0.1 * L));
  return Math.max(0.01, Math.round(r * 100) / 100);
}

/**
 * Sweep slider / typed hard max — generous; planar 0.45·L must not apply.
 * @param {number} [pathLength]
 * @returns {number}
 */
export function sweepBlendHardMax(pathLength) {
  const L = Number(pathLength);
  if (L > 0) return Math.max(50, Math.round(0.5 * L * 100) / 100);
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
  if (!seedEdge) return [];
  const tolDeg = typeof opts.tolDeg === 'number' ? opts.tolDeg : TANGENT_PROP_DEG;
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const adj = opts.adj || buildEdgeVertexAdj(featureEdges || []);
  const seedKey = edgeKey(seedEdge);
  const out = new Map();
  out.set(seedKey, {
    key: seedKey,
    a: seedEdge.a,
    b: seedEdge.b,
    va: seedEdge.va?.slice?.() ?? seedEdge.va,
    vb: seedEdge.vb?.slice?.() ?? seedEdge.vb,
    mid: seedEdge.mid?.slice?.() ?? seedEdge.mid,
    length: seedEdge.length,
    tangent: seedEdge.tangent ? seedEdge.tangent.slice() : undefined,
  });

  const queue = [out.get(seedKey)];
  while (queue.length) {
    const cur = queue.shift();
    const t0 = cur.tangent;
    if (!t0) continue;
    for (const v of [cur.a, cur.b]) {
      const nbrs = adj.get(v) || [];
      for (const nbr of nbrs) {
        const nk = edgeKey(nbr);
        if (out.has(nk)) continue;
        if (tangentAlign(t0, nbr.tangent) < cosTol) continue;
        const copy = {
          key: nk,
          a: nbr.a,
          b: nbr.b,
          va: nbr.va.slice(),
          vb: nbr.vb.slice(),
          mid: nbr.mid.slice(),
          length: nbr.length,
          tangent: nbr.tangent ? nbr.tangent.slice() : undefined,
        };
        out.set(nk, copy);
        queue.push(copy);
      }
    }
  }
  return [...out.values()];
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
  const toAdd = propagate && opts.featureEdges?.length
    ? propagateTangentEdges(opts.featureEdges, edge, { tolDeg: opts.tolDeg })
    : null;
  if (!toAdd || toAdd.length <= 1) {
    // Soft-fail: no tangents — just the seed (same as toggleEdgeSelection add).
    return toggleEdgeSelection(list, edge);
  }
  const have = new Set(list.map((e) => edgeKey(e)));
  for (const e of toAdd) {
    const k = edgeKey(e);
    if (have.has(k)) continue;
    list.push(e);
    have.add(k);
  }
  return list;
}
