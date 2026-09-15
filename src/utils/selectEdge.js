/**
 * Slice 12 — Edge pick helpers for Fillet/Chamfer.
 * Candidate edges = mesh edges shared by two triangles whose normals diverge
 * enough to be a feature edge (not a planar tessellation seam).
 */

import { Vector3 } from 'three';

const DEFAULT_FEATURE_DEG = 2;

/**
 * Build feature edges from a BufferGeometry (indexed).
 * @returns {{ key: string, a: number, b: number, va: number[], vb: number[], mid: number[], length: number, tangent: number[] }[]}
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
