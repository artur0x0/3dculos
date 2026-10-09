/**
 * Sample TET10 nodal fields onto the render mesh.
 *
 * The skin looks up (faceID, vertex index) and reads one value per render
 * vertex. Each render vertex is matched to the boundary triangles of the
 * faces it belongs to, by position, and the value is the quadratic
 * interpolation on the closest 6-node face. Stress samples von Mises.
 * Displacement samples the nodal vector the same way and stores its
 * magnitude in millimetres. The render mesh is not deformed.
 */

import { quadShape } from './traction.js';

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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

function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function closestPointOnTriangle(p, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, scale(ac, w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }
  const denom = va + vb + vc;
  if (denom === 0) return a;
  const inv = 1 / denom;
  return add(a, add(scale(ab, vb * inv), scale(ac, vc * inv)));
}

function barycentric(p, a, b, c) {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denom = d00 * d11 - d01 * d01;
  if (denom === 0) return [1, 0, 0];
  const l1 = (d11 * d20 - d01 * d21) / denom;
  const l2 = (d00 * d21 - d01 * d20) / denom;
  return [1 - l1 - l2, l1, l2];
}

function interpolate(bary, values) {
  const n = quadShape(bary[0], bary[1], bary[2]);
  let stress = 0;
  for (let i = 0; i < 6; i += 1) stress += n[i] * values[i];
  return stress;
}

function facesById(mesh, valuesFor) {
  const byFace = new Map();
  if (!mesh?.faceIds || !mesh.faces || !mesh.nodes) return byFace;
  const faceCount = mesh.faceIds.length;
  for (let f = 0; f < faceCount; f += 1) {
    const id = mesh.faceIds[f];
    let list = byFace.get(id);
    if (!list) {
      list = [];
      byFace.set(id, list);
    }
    const ids = mesh.faces.subarray(f * 6, f * 6 + 6);
    const corners = [0, 1, 2].map((k) => {
      const node = ids[k];
      return [mesh.nodes[node * 3], mesh.nodes[node * 3 + 1], mesh.nodes[node * 3 + 2]];
    });
    list.push({ corners, sample: valuesFor(ids) });
  }
  return byFace;
}

function incidentFaces(indices, faceIDs) {
  const incident = new Map();
  if (!indices || !faceIDs) return incident;
  const triangles = Math.floor(Math.min(indices.length, faceIDs.length * 3) / 3);
  for (let t = 0; t < triangles; t += 1) {
    const face = faceIDs[t];
    for (let k = 0; k < 3; k += 1) {
      const vertex = indices[t * 3 + k];
      let set = incident.get(vertex);
      if (!set) {
        set = new Set();
        incident.set(vertex, set);
      }
      set.add(face);
    }
  }
  return incident;
}

function sampleVertices(positions, indices, faceIDs, mesh, valuesFor, mix) {
  const vertexCount = positions.length / 3;
  const out = new Float32Array(vertexCount);
  out.fill(NaN);
  const byFace = facesById(mesh, valuesFor);
  if (!byFace.size) return out;
  for (const [vertex, faces] of incidentFaces(indices, faceIDs)) {
    const p = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
    let best = Infinity;
    let value = NaN;
    for (const face of faces) {
      const list = byFace.get(face);
      if (!list) continue;
      for (const tri of list) {
        const q = closestPointOnTriangle(p, tri.corners[0], tri.corners[1], tri.corners[2]);
        const dist = length(sub(p, q));
        if (dist < best) {
          best = dist;
          value = mix(tri.sample, barycentric(q, tri.corners[0], tri.corners[1], tri.corners[2]));
        }
      }
    }
    if (Number.isFinite(value)) out[vertex] = value;
  }
  return out;
}

/**
 * `vonMises[node]` is the solver field. The return value is one megapascal
 * per render vertex. Vertices that no boundary face owns stay NaN.
 */
export function sampleSurfaceStress(positions, indices, faceIDs, mesh, vonMises) {
  if (!positions || !vonMises) return new Float32Array();
  return sampleVertices(positions, indices, faceIDs, mesh, (ids) => (
    [0, 1, 2, 3, 4, 5].map((k) => vonMises[ids[k]])
  ), (sample, bary) => interpolate(bary, sample));
}

/**
 * `displacement` is xyzxyz… in millimetres, three components per solver
 * node. The return value is the magnitude in millimetres at each render
 * vertex. The vector is interpolated, then its length is taken, on the
 * same closest face as stress. Vertices that no boundary face owns stay NaN.
 */
export function sampleSurfaceDisplacement(positions, indices, faceIDs, mesh, displacement) {
  if (!positions || !displacement) return new Float32Array();
  return sampleVertices(positions, indices, faceIDs, mesh, (ids) => {
    const ux = new Array(6);
    const uy = new Array(6);
    const uz = new Array(6);
    for (let k = 0; k < 6; k += 1) {
      const base = ids[k] * 3;
      ux[k] = displacement[base];
      uy[k] = displacement[base + 1];
      uz[k] = displacement[base + 2];
    }
    return [ux, uy, uz];
  }, (sample, bary) => {
    const ux = interpolate(bary, sample[0]);
    const uy = interpolate(bary, sample[1]);
    const uz = interpolate(bary, sample[2]);
    if (!Number.isFinite(ux) || !Number.isFinite(uy) || !Number.isFinite(uz)) return NaN;
    return Math.hypot(ux, uy, uz);
  });
}

/** Nearest-rank p95. Same rule as the solver: rank ceil(0.95 * n), 1-based. */
export function nearestRankP95(values) {
  const finite = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (Number.isFinite(value)) finite.push(value);
  }
  if (!finite.length) return 0;
  finite.sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * finite.length);
  const index = Math.min(finite.length - 1, Math.max(0, rank - 1));
  return finite[index];
}

export function fieldRange(values) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!count) return { min: 0, max: 0, p95: 0 };
  return { min, max, p95: nearestRankP95(values) };
}

export function safetyFactor(yieldMPa, p95) {
  if (yieldMPa == null || !Number.isFinite(Number(yieldMPa))) return null;
  const yieldValue = Number(yieldMPa);
  if (!(yieldValue > 0) || !(p95 > 0)) return null;
  return yieldValue / p95;
}
