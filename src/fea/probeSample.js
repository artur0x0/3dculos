/**
 * Probe a point on the render surface.
 *
 * The ray hits the render mesh. The same face-id map the stress skin uses
 * finds the 6-node FE face under that hit, and the value is the element
 * shape functions at the projected point. A vertex of that face is used
 * only when the hit lands on it.
 *
 * Stress and displacement use the quadratic triangle. Contact pressure
 * uses those shape functions when every node of the face has a sample,
 * and the skin's corner rule when a midside was left unset.
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

function nodeAt(nodes, index) {
  return [nodes[index * 3], nodes[index * 3 + 1], nodes[index * 3 + 2]];
}

function faceCorners(mesh, face) {
  const ids = mesh.faces;
  return [0, 1, 2].map((k) => nodeAt(mesh.nodes, ids[face * 6 + k]));
}

function component(field, index, stride, axis) {
  if (!field) return NaN;
  const value = field[index * stride + axis];
  return Number.isFinite(value) ? value : NaN;
}

/**
 * Closest 6-node boundary face of `faceId`. `faceId` null searches every
 * face. `allowed` limits the search to those face ids.
 */
export function locateProbeFace(point, faceId, mesh, allowed = null) {
  if (!point || !mesh?.nodes || !mesh.faces || !mesh.faceIds) return null;
  const wanted = Number(faceId);
  const restrict = Number.isFinite(wanted);
  let best = null;
  for (let face = 0; face < mesh.faceIds.length; face += 1) {
    const id = Number(mesh.faceIds[face]);
    if (allowed && !allowed.has(id)) continue;
    if (restrict && id !== wanted) continue;
    const corners = faceCorners(mesh, face);
    const q = closestPointOnTriangle(point, corners[0], corners[1], corners[2]);
    const dist = length(sub(point, q));
    if (best && dist >= best.distance) continue;
    const ids = [];
    for (let k = 0; k < 6; k += 1) ids.push(mesh.faces[face * 6 + k]);
    best = {
      face,
      faceId: id,
      distance: dist,
      bary: barycentric(q, corners[0], corners[1], corners[2]),
      ids,
    };
  }
  return best;
}

function weightsOf(bary) {
  return Array.from(quadShape(bary[0], bary[1], bary[2]));
}

function mixScalar(weights, nodal) {
  let value = 0;
  for (let i = 0; i < 6; i += 1) value += weights[i] * nodal[i];
  return value;
}

/**
 * Contact samples are often only on the corners. Quadratic weights need
 * all six. Otherwise the corner barycentric rule from the stress skin.
 */
export function contactProbeMix(sample, bary) {
  if (sample.every((value) => Number.isFinite(value))) {
    const weights = weightsOf(bary);
    return { weights, nodal: sample.slice(), value: mixScalar(weights, sample), mix: 'scalar' };
  }
  const corners = [sample[0], sample[1], sample[2]];
  if (corners.every((value) => Number.isFinite(value))) {
    const weights = [bary[0], bary[1], bary[2], 0, 0, 0];
    const nodal = [sample[0], sample[1], sample[2], 0, 0, 0];
    return { weights, nodal, value: mixScalar(weights, nodal), mix: 'scalar' };
  }
  const finite = [];
  for (let i = 0; i < 6; i += 1) {
    if (Number.isFinite(sample[i])) finite.push(i);
  }
  if (!finite.length) return null;
  const weights = [0, 0, 0, 0, 0, 0];
  const nodal = [0, 0, 0, 0, 0, 0];
  const share = 1 / finite.length;
  for (const index of finite) {
    weights[index] = share;
    nodal[index] = sample[index];
  }
  return { weights, nodal, value: mixScalar(weights, nodal), mix: 'scalar' };
}

function readNodes(hit, stride, read) {
  const nodal = [];
  for (let axis = 0; axis < stride; axis += 1) {
    for (let k = 0; k < 6; k += 1) nodal.push(read(hit.ids[k], axis));
  }
  return nodal;
}

/**
 * Scalar or vector sample at `point` on the FE face of `faceId`.
 * `stride` 1 is a scalar. `stride` 3 interpolates the vector, then takes
 * its length. Returns null when that face has no finite sample.
 */
export function probeMeshPoint(point, faceId, mesh, field, stride, { contact = false, allowed = null } = {}) {
  const hit = locateProbeFace(point, faceId, mesh, allowed);
  if (!hit || !field) return null;
  const sample = [0, 1, 2, 3, 4, 5].map((k) => component(field, hit.ids[k], stride, 0));
  if (contact) {
    if (stride !== 1) return null;
    const mixed = contactProbeMix(sample, hit.bary);
    return mixed;
  }
  const weights = weightsOf(hit.bary);
  if (stride === 1) {
    if (sample.some((value) => !Number.isFinite(value))) return null;
    return { weights, nodal: sample, value: mixScalar(weights, sample), mix: 'scalar' };
  }
  const nodal = readNodes(hit, stride, (index, axis) => component(field, index, stride, axis));
  if (nodal.some((value) => !Number.isFinite(value))) return null;
  const acc = [0, 0, 0];
  for (let axis = 0; axis < stride; axis += 1) {
    for (let k = 0; k < 6; k += 1) acc[axis] += weights[k] * nodal[axis * 6 + k];
  }
  return {
    weights,
    nodal,
    value: Math.hypot(acc[0], acc[1], acc[2] || 0),
    mix: 'magnitude',
  };
}

export function probeQuantityName(kind, plot) {
  if (kind === 'modal') return 'mode';
  if (plot === 'contact') return 'contact';
  if (plot === 'displacement') return 'displacement';
  return 'stress';
}

export function probeUnit(quantity) {
  if (quantity === 'stress' || quantity === 'contact') return 'MPa';
  if (quantity === 'displacement') return 'mm';
  return '';
}

function allowedSet(ids) {
  if (!ids || !ids.length) return null;
  const set = new Set();
  for (let i = 0; i < ids.length; i += 1) set.add(Number(ids[i]));
  return set;
}

/** Reading for one stored probe against a packed tet record. */
export function readTetProbe(point, faceId, record, quantity, modeIndex = 0) {
  if (!record || record.kind === 'shell' || !point) return null;
  if (quantity === 'stress') {
    return probeMeshPoint(point, faceId, record, record.stress, 1);
  }
  if (quantity === 'displacement') {
    return probeMeshPoint(point, faceId, record, record.displacement, 3);
  }
  if (quantity === 'contact') {
    return probeMeshPoint(point, faceId, record, record.contact, 1, {
      contact: true,
      allowed: allowedSet(record.contactFaces),
    });
  }
  if (quantity === 'mode') {
    const count = record.nodes.length / 3;
    const mode = Math.max(0, modeIndex | 0);
    if (!record.modes || !(count > 0) || mode >= (record.modeCount || 0)) return null;
    const slice = record.modes.subarray(mode * count * 3, (mode + 1) * count * 3);
    return probeMeshPoint(point, faceId, record, slice, 3);
  }
  return null;
}

function remapField(used, field, stride) {
  if (!field) return null;
  const out = new Float32Array(used.size * stride);
  for (const [prev, next] of used) {
    for (let axis = 0; axis < stride; axis += 1) {
      const value = field[prev * stride + axis];
      out[next * stride + axis] = Number.isFinite(value) ? value : NaN;
    }
  }
  return out;
}

/**
 * Boundary faces only, nodes compacted. Copies every array so the worker
 * cache can keep the mesh. `fields.modes` is mode-major xyz on the
 * original node numbering.
 */
export function packProbeSurface(mesh, fields = {}, frame = 'local') {
  const facesIn = mesh?.faces;
  const faceIdsIn = mesh?.faceIds;
  const src = mesh?.nodes;
  if (!facesIn || !faceIdsIn || !src || !faceIdsIn.length) return null;
  const faceCount = faceIdsIn.length;
  const used = new Map();
  const nodes = [];
  const faces = new Uint32Array(faceCount * 6);
  for (let face = 0; face < faceCount; face += 1) {
    for (let k = 0; k < 6; k += 1) {
      const prev = facesIn[face * 6 + k];
      let next = used.get(prev);
      if (next == null) {
        next = used.size;
        used.set(prev, next);
        nodes.push(src[prev * 3] || 0, src[prev * 3 + 1] || 0, src[prev * 3 + 2] || 0);
      }
      faces[face * 6 + k] = next;
    }
  }
  const srcCount = src.length / 3;
  let modes = null;
  const modeCount = fields.modeCount || 0;
  if (fields.modes && modeCount > 0) {
    modes = new Float32Array(modeCount * used.size * 3);
    for (let mode = 0; mode < modeCount; mode += 1) {
      const srcBase = mode * srcCount * 3;
      const dstBase = mode * used.size * 3;
      for (const [prev, next] of used) {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = fields.modes[srcBase + prev * 3 + axis];
          modes[dstBase + next * 3 + axis] = Number.isFinite(value) ? value : 0;
        }
      }
    }
  }
  const contactFaces = fields.contactFaces && fields.contactFaces.length
    ? Uint32Array.from(fields.contactFaces)
    : null;
  return {
    kind: 'tet',
    frame,
    nodes: Float32Array.from(nodes),
    faces,
    faceIds: Uint32Array.from(faceIdsIn),
    stress: remapField(used, fields.stress, 1),
    displacement: remapField(used, fields.displacement, 3),
    contact: remapField(used, fields.contact, 1),
    contactFaces,
    modes,
    modeCount,
  };
}

/** Shell mid-surface plus the nodal fields a probe evaluates on the client. */
export function packShellProbe(shellMesh, fields = {}, frame = 'local') {
  if (!shellMesh?.nodes || !shellMesh.elements || !shellMesh.regions) return null;
  return {
    kind: 'shell',
    frame,
    nodes: Float32Array.from(shellMesh.nodes),
    elements: Uint32Array.from(shellMesh.elements),
    regions: shellMesh.regions,
    thickness: shellMesh.thickness,
    top: fields.top ? Float32Array.from(fields.top) : null,
    mid: fields.mid ? Float32Array.from(fields.mid) : null,
    bottom: fields.bottom ? Float32Array.from(fields.bottom) : null,
    displacement: fields.displacement ? Float32Array.from(fields.displacement) : null,
    modes: fields.modes ? Float32Array.from(fields.modes) : null,
    modeCount: fields.modeCount || 0,
  };
}
