// Volume meshing for the FEA solver.
//
// `meshVolume` turns a closed triangle surface (Manifold's positions, indices,
// and a per-triangle face id) into a TET10 mesh. fTetWild, compiled to a
// single-threaded SIMD wasm module, produces the TET4 mesh. This file inserts
// mid-edge nodes, snaps boundary mids back onto the input surface, and copies
// each boundary face's face id from the nearest input triangle.
//
// The module does not use shared memory. Load it from the FEA worker in a
// later change; nothing in the app imports this yet.

import { readFile } from 'node:fs/promises';

const TET_EDGES = [
  [0, 1, 4],
  [1, 2, 5],
  [2, 0, 6],
  [0, 3, 7],
  [1, 3, 8],
  [2, 3, 9],
];

let modulePromise;

function asFloat64(positions) {
  if (positions instanceof Float64Array) return positions;
  return Float64Array.from(positions);
}

function asUint32(indices) {
  if (indices instanceof Uint32Array) return indices;
  return Uint32Array.from(indices);
}

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

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function pointAt(positions, index) {
  return [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
}

export function surfaceVolume(positions, indices) {
  const xyz = asFloat64(positions);
  const tris = asUint32(indices);
  let volume = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const a = pointAt(xyz, tris[i]);
    const b = pointAt(xyz, tris[i + 1]);
    const c = pointAt(xyz, tris[i + 2]);
    volume += dot(a, cross(b, c));
  }
  return volume / 6;
}

export function tetVolume(positions, tet) {
  const a = pointAt(positions, tet[0]);
  const b = pointAt(positions, tet[1]);
  const c = pointAt(positions, tet[2]);
  const d = pointAt(positions, tet[3]);
  return dot(cross(sub(b, a), sub(c, a)), sub(d, a)) / 6;
}

function orientAway(positions, face, opposite) {
  const a = pointAt(positions, face[0]);
  const b = pointAt(positions, face[1]);
  const c = pointAt(positions, face[2]);
  const normal = cross(sub(b, a), sub(c, a));
  if (dot(normal, sub(pointAt(positions, opposite), a)) > 0) {
    return [face[0], face[2], face[1]];
  }
  return face;
}

function outwardFaces(tet) {
  const corners = [
    [tet[1], tet[2], tet[3], tet[0]],
    [tet[0], tet[3], tet[2], tet[1]],
    [tet[0], tet[1], tet[3], tet[2]],
    [tet[0], tet[2], tet[1], tet[3]],
  ];
  return corners;
}

export function tetDihedralDegrees(positions, tet) {
  const oriented = outwardFaces(tet).map(([i, j, k, opposite]) => orientAway(positions, [i, j, k], opposite));
  const normals = oriented.map((face) => {
    const n = cross(
      sub(pointAt(positions, face[1]), pointAt(positions, face[0])),
      sub(pointAt(positions, face[2]), pointAt(positions, face[0])),
    );
    const len = length(n);
    return len === 0 ? [0, 0, 0] : scale(n, 1 / len);
  });
  const angles = [];
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      const cosine = Math.min(1, Math.max(-1, dot(normals[i], normals[j])));
      angles.push(((Math.PI - Math.acos(cosine)) * 180) / Math.PI);
    }
  }
  return angles;
}

function triangleArea(a, b, c) {
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}

export function tetAspectRatio(positions, tet) {
  const volume = Math.abs(tetVolume(positions, tet));
  let longest = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      longest = Math.max(longest, length(sub(pointAt(positions, tet[i]), pointAt(positions, tet[j]))));
    }
  }
  let shortestAltitude = Infinity;
  for (const [i, j, k, opposite] of outwardFaces(tet)) {
    const face = orientAway(positions, [i, j, k], opposite);
    const area = triangleArea(
      pointAt(positions, face[0]),
      pointAt(positions, face[1]),
      pointAt(positions, face[2]),
    );
    if (area > 0) shortestAltitude = Math.min(shortestAltitude, (3 * volume) / area);
  }
  if (!Number.isFinite(shortestAltitude) || shortestAltitude === 0) return Infinity;
  return longest / shortestAltitude;
}

function bboxDiag(positions) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return length(sub(max, min));
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
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

function edgeKey(a, b) {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function decodeTet4(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buffer);
  const status = view.getInt32(0, true);
  const nVertices = view.getUint32(4, true);
  const nTets = view.getUint32(8, true);
  const messageLen = view.getUint32(12, true);
  let offset = 24 + messageLen;
  offset = (offset + 7) & ~7;
  const message = new TextDecoder().decode(new Uint8Array(buffer, 24, messageLen));
  const positions = new Float64Array(nVertices * 3);
  positions.set(new Float64Array(buffer, offset, nVertices * 3));
  offset += nVertices * 3 * 8;
  const tets = new Uint32Array(nTets * 4);
  tets.set(new Uint32Array(buffer, offset, nTets * 4));
  return { status, message, positions, tets };
}

async function loadMeshModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const jsUrl = new URL('../../packages/surfcad-mesh/pkg/surfcad_mesh.js', import.meta.url);
      const wasmUrl = new URL('../../packages/surfcad-mesh/pkg/surfcad_mesh.wasm', import.meta.url);
      const factory = (await import(jsUrl.href)).default;
      const wasmBinary = await readFile(wasmUrl);
      return factory({ wasmBinary });
    })();
  }
  return modulePromise;
}

function meshTet4(module, positions, indices, edgeLength, epsilon, maxTets) {
  const nVertices = positions.length / 3;
  const nTriangles = indices.length / 3;
  const posPtr = module._malloc(nVertices * 3 * 8);
  const indexPtr = module._malloc(nTriangles * 3 * 4);
  const bytesPtr = module._malloc(4);
  if (posPtr === 0 || indexPtr === 0 || bytesPtr === 0) {
    throw new Error('mesh wasm is out of memory');
  }
  try {
    module.HEAPF64.set(positions, posPtr / 8);
    module.HEAPU32.set(indices, indexPtr / 4);
    const blobPtr = module._surfcad_mesh_tet4(
      posPtr,
      nVertices,
      indexPtr,
      nTriangles,
      edgeLength,
      epsilon,
      maxTets,
      bytesPtr,
    );
    if (blobPtr === 0) throw new Error('mesh wasm returned no result');
    const byteLength = module.getValue(bytesPtr, 'i32') >>> 0;
    const copy = new Uint8Array(byteLength);
    copy.set(module.HEAPU8.subarray(blobPtr, blobPtr + byteLength));
    module._surfcad_mesh_free(blobPtr);
    return { decoded: decodeTet4(copy), wasmBytes: module.HEAPU8.byteLength };
  } finally {
    module._free(posPtr);
    module._free(indexPtr);
    module._free(bytesPtr);
  }
}

function withPositiveVolumes(positions, tets) {
  const oriented = new Uint32Array(tets);
  for (let t = 0; t < oriented.length; t += 4) {
    const tet = [oriented[t], oriented[t + 1], oriented[t + 2], oriented[t + 3]];
    if (tetVolume(positions, tet) < 0) {
      const swap = oriented[t];
      oriented[t] = oriented[t + 1];
      oriented[t + 1] = swap;
    }
  }
  return oriented;
}

function upgradeTet10(tet4Positions, tet4Tets, inputPositions, inputIndices, inputFaceIds, edgeLength, epsilon) {
  tet4Tets = withPositiveVolumes(tet4Positions, tet4Tets);
  const inputTriangles = [];
  for (let i = 0; i < inputIndices.length; i += 3) {
    inputTriangles.push({
      faceId: inputFaceIds[i / 3],
      a: pointAt(inputPositions, inputIndices[i]),
      b: pointAt(inputPositions, inputIndices[i + 1]),
      c: pointAt(inputPositions, inputIndices[i + 2]),
    });
  }
  const boundary = [];
  const counts = new Map();
  const nTets = tet4Tets.length / 4;
  for (let t = 0; t < nTets; t += 1) {
    const tet = [
      tet4Tets[t * 4],
      tet4Tets[t * 4 + 1],
      tet4Tets[t * 4 + 2],
      tet4Tets[t * 4 + 3],
    ];
    for (const [i, j, k, opposite] of outwardFaces(tet)) {
      const oriented = orientAway(tet4Positions, [i, j, k], opposite);
      const key = [...oriented].sort((a, b) => a - b).join(',');
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { face: oriented, count: 1 });
    }
  }
  for (const entry of counts.values()) {
    if (entry.count === 1) boundary.push(entry);
  }

  const boundaryEdgeIds = new Map();
  for (const entry of boundary) {
    const face = entry.face;
    const centroid = scale(
      add(add(pointAt(tet4Positions, face[0]), pointAt(tet4Positions, face[1])), pointAt(tet4Positions, face[2])),
      1 / 3,
    );
    let best = Infinity;
    let faceId = inputTriangles[0] ? inputTriangles[0].faceId : 0;
    for (const triangle of inputTriangles) {
      const q = closestPointOnTriangle(centroid, triangle.a, triangle.b, triangle.c);
      const dist = length(sub(centroid, q));
      if (dist < best) {
        best = dist;
        faceId = triangle.faceId;
      }
    }
    entry.faceId = faceId;
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const key = edgeKey(face[a], face[b]);
      let ids = boundaryEdgeIds.get(key);
      if (!ids) {
        ids = new Set();
        boundaryEdgeIds.set(key, ids);
      }
      ids.add(faceId);
    }
  }

  const diag = bboxDiag(inputPositions);
  const epsAbs = (epsilon > 0 ? epsilon : 1e-3) * diag;
  const targetEdge = edgeLength > 0 ? edgeLength : diag / 20;
  const snapTol = Math.max(epsAbs * 4, targetEdge * 0.25, diag * 1e-8);

  const nodes = [];
  for (let i = 0; i < tet4Positions.length; i += 3) {
    nodes.push([tet4Positions[i], tet4Positions[i + 1], tet4Positions[i + 2]]);
  }
  const mids = new Map();
  const midOf = (a, b) => {
    const key = edgeKey(a, b);
    const existing = mids.get(key);
    if (existing !== undefined) return existing;
    const pa = nodes[a];
    const pb = nodes[b];
    let mid = scale(add(pa, pb), 0.5);
    const allowed = boundaryEdgeIds.get(key);
    if (allowed) {
      let best = Infinity;
      let bestPoint = mid;
      for (const triangle of inputTriangles) {
        if (!allowed.has(triangle.faceId)) continue;
        const q = closestPointOnTriangle(mid, triangle.a, triangle.b, triangle.c);
        const dist = length(sub(mid, q));
        if (dist < best) {
          best = dist;
          bestPoint = q;
        }
      }
      if (best <= snapTol) mid = bestPoint;
    }
    const id = nodes.length;
    nodes.push(mid);
    mids.set(key, id);
    return id;
  };

  const elements = new Uint32Array(nTets * 10);
  for (let t = 0; t < nTets; t += 1) {
    const tet = [
      tet4Tets[t * 4],
      tet4Tets[t * 4 + 1],
      tet4Tets[t * 4 + 2],
      tet4Tets[t * 4 + 3],
    ];
    const elem = elements.subarray(t * 10, t * 10 + 10);
    elem[0] = tet[0];
    elem[1] = tet[1];
    elem[2] = tet[2];
    elem[3] = tet[3];
    for (const [a, b, slot] of TET_EDGES) {
      elem[slot] = midOf(tet[a], tet[b]);
    }
  }

  const faces = new Uint32Array(boundary.length * 6);
  const faceIds = new Uint32Array(boundary.length);
  for (let i = 0; i < boundary.length; i += 1) {
    const face = boundary[i].face;
    faces[i * 6] = face[0];
    faces[i * 6 + 1] = face[1];
    faces[i * 6 + 2] = face[2];
    faces[i * 6 + 3] = midOf(face[0], face[1]);
    faces[i * 6 + 4] = midOf(face[1], face[2]);
    faces[i * 6 + 5] = midOf(face[2], face[0]);
    faceIds[i] = boundary[i].faceId;
  }

  const flat = new Float64Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i += 1) {
    flat[i * 3] = nodes[i][0];
    flat[i * 3 + 1] = nodes[i][1];
    flat[i * 3 + 2] = nodes[i][2];
  }
  return { nodes: flat, elements, faces, faceIds };
}

function qualityStats(nodes, elements) {
  const nTets = elements.length / 10;
  let volume = 0;
  let minDihedral = Infinity;
  let maxDihedral = -Infinity;
  let minAspect = Infinity;
  let maxAspect = 0;
  let aspectSum = 0;
  let positive = true;
  for (let t = 0; t < nTets; t += 1) {
    const tet = [elements[t * 10], elements[t * 10 + 1], elements[t * 10 + 2], elements[t * 10 + 3]];
    const vol = tetVolume(nodes, tet);
    if (!(vol > 0)) positive = false;
    volume += vol;
    for (const angle of tetDihedralDegrees(nodes, tet)) {
      minDihedral = Math.min(minDihedral, angle);
      maxDihedral = Math.max(maxDihedral, angle);
    }
    const aspect = tetAspectRatio(nodes, tet);
    minAspect = Math.min(minAspect, aspect);
    maxAspect = Math.max(maxAspect, aspect);
    aspectSum += aspect;
  }
  return {
    volume,
    minDihedralDeg: nTets === 0 ? 0 : minDihedral,
    maxDihedralDeg: nTets === 0 ? 0 : maxDihedral,
    minAspect: nTets === 0 ? 0 : minAspect,
    maxAspect: nTets === 0 ? 0 : maxAspect,
    meanAspect: nTets === 0 ? 0 : aspectSum / nTets,
    positive,
  };
}

/**
 * Mesh a closed triangle surface.
 *
 * `surface.positions` is xyz, Float32Array or Float64Array, in the caller's
 * length unit (millimetres for a study). `surface.indices` is three indices
 * per triangle. `surface.faceIds` (or `faceIDs`) is one id per triangle.
 *
 * `options.edgeLength` is the target edge length in the same unit. `0` leaves
 * fTetWild's relative default (1/20 of the bbox diagonal). `options.epsilon`
 * is fTetWild's relative envelope, a fraction of that diagonal. `0` leaves
 * the default `1e-3`. `options.maxTets` fails the call when the TET4 mesh
 * would be larger. `0` means no cap.
 *
 * Boundary `faces` are 6-node triangles in the same order `solve_tet10` uses
 * for pressure: corners, then mid-edge nodes 01, 12, 20. The right-hand
 * normal of the corners points out of the solid.
 */
export async function meshVolume(surface, options = {}) {
  const positions = asFloat64(surface.positions);
  const indices = asUint32(surface.indices);
  const faceIds = asUint32(surface.faceIds ?? surface.faceIDs ?? new Uint32Array(indices.length / 3));
  if (positions.length % 3 !== 0) throw new Error('positions length must be a multiple of 3');
  if (indices.length % 3 !== 0) throw new Error('indices length must be a multiple of 3');
  if (faceIds.length !== indices.length / 3) {
    throw new Error('faceIds must contain one id per triangle');
  }
  const edgeLength = options.edgeLength ?? 0;
  const epsilon = options.epsilon ?? 0;
  const maxTets = options.maxTets ?? 0;
  const started = Date.now();
  const module = await loadMeshModule();
  const { decoded, wasmBytes } = meshTet4(module, positions, indices, edgeLength, epsilon, maxTets);
  if (decoded.status !== 0) {
    throw new Error(decoded.message || `volume mesher failed (${decoded.status})`);
  }
  const upgraded = upgradeTet10(
    decoded.positions,
    decoded.tets,
    positions,
    indices,
    faceIds,
    edgeLength,
    epsilon,
  );
  const quality = qualityStats(upgraded.nodes, upgraded.elements);
  const inputVolume = Math.abs(surfaceVolume(positions, indices));
  const volumeError = inputVolume === 0 ? 0 : Math.abs(quality.volume - inputVolume) / inputVolume;
  return {
    nodes: upgraded.nodes,
    elements: upgraded.elements,
    faces: upgraded.faces,
    faceIds: upgraded.faceIds,
    stats: {
      nodes: upgraded.nodes.length / 3,
      elements: upgraded.elements.length / 10,
      boundaryFaces: upgraded.faceIds.length,
      volume: quality.volume,
      inputVolume,
      volumeError,
      minDihedralDeg: quality.minDihedralDeg,
      maxDihedralDeg: quality.maxDihedralDeg,
      minAspect: quality.minAspect,
      meanAspect: quality.meanAspect,
      maxAspect: quality.maxAspect,
      positive: quality.positive,
      ms: Date.now() - started,
      wasmBytes,
      dofs: upgraded.nodes.length,
    },
  };
}
