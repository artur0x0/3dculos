/**
 * Map study fixtures and loads onto a TET10 boundary.
 *
 * Faces are picked by Manifold faceID. A face whose id is missing from the
 * volume mesh is matched by its fingerprint (centroid and normal) so a
 * rebuilt id still lands on the same wall. Fixed faces pin every node of
 * the 6-node boundary triangles. A force becomes a uniform traction, then
 * consistent nodal forces. A pressure is passed through in megapascals.
 */

import { faceArea, faceTractionForces } from './traction.js';

function pointAt(nodes, index) {
  return [nodes[index * 3], nodes[index * 3 + 1], nodes[index * 3 + 2]];
}

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

function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function faceGeometry(mesh, faceIndex) {
  const ids = mesh.faces.subarray(faceIndex * 6, faceIndex * 6 + 6);
  const xyz = [];
  for (let k = 0; k < 6; k += 1) xyz.push(pointAt(mesh.nodes, ids[k]));
  const centroid = [
    (xyz[0][0] + xyz[1][0] + xyz[2][0]) / 3,
    (xyz[0][1] + xyz[1][1] + xyz[2][1]) / 3,
    (xyz[0][2] + xyz[1][2] + xyz[2][2]) / 3,
  ];
  const normal = cross(sub(xyz[1], xyz[0]), sub(xyz[2], xyz[0]));
  const norm = length(normal);
  return {
    index: faceIndex,
    ids,
    xyz,
    centroid,
    normal: norm > 0 ? [normal[0] / norm, normal[1] / norm, normal[2] / norm] : [0, 0, 0],
    area: faceArea(xyz),
    faceId: mesh.faceIds[faceIndex],
  };
}

function studyFaces(entries) {
  const faces = [];
  for (const entry of entries || []) {
    for (const face of entry.faces || []) faces.push(face);
  }
  return faces;
}

/**
 * Manifold face ids on this pick. A box wall is often two triangles with
 * two ids; the study stores the majority id plus `triangleFaceIDs` for the
 * whole paint patch. Matching any of them covers the wall.
 */
/**
 * Faces that share a node, or a corner that lands on the same point, are one
 * wall. When the same ids occur on two walls, the wall closest to `at` is
 * the one the study stored.
 */
function nearestPatch(faces, at) {
  if (faces.length < 2) return faces;
  const parent = faces.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const byNode = new Map();
  const byPoint = new Map();
  for (let i = 0; i < faces.length; i += 1) {
    const ids = faces[i].ids;
    const xyz = faces[i].xyz;
    for (let k = 0; k < ids.length; k += 1) {
      const node = ids[k];
      const previous = byNode.get(node);
      if (previous === undefined) byNode.set(node, i);
      else union(previous, i);
      const point = xyz[k];
      const key = `${Math.round(point[0] * 1e4)},${Math.round(point[1] * 1e4)},${Math.round(point[2] * 1e4)}`;
      const seenAt = byPoint.get(key);
      if (seenAt === undefined) byPoint.set(key, i);
      else union(seenAt, i);
    }
  }
  const groups = new Map();
  for (let i = 0; i < faces.length; i += 1) {
    const root = find(i);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(faces[i]);
  }
  if (groups.size < 2) return faces;
  let best = faces;
  let bestDist = Infinity;
  for (const group of groups.values()) {
    let weight = 0;
    const centroid = [0, 0, 0];
    for (let i = 0; i < group.length; i += 1) {
      const face = group[i];
      const area = face.area > 0 ? face.area : 1;
      weight += area;
      centroid[0] += face.centroid[0] * area;
      centroid[1] += face.centroid[1] * area;
      centroid[2] += face.centroid[2] * area;
    }
    if (weight > 0) {
      centroid[0] /= weight;
      centroid[1] /= weight;
      centroid[2] /= weight;
    }
    const dist = Math.hypot(centroid[0] - at[0], centroid[1] - at[1], centroid[2] - at[2]);
    if (dist < bestDist) {
      bestDist = dist;
      best = group;
    }
  }
  return best;
}

function triangleIdsOf(pick) {
  const ids = [];
  const seen = new Set();
  const push = (value) => {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 0 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (Array.isArray(pick.triangleFaceIDs)) {
    for (const id of pick.triangleFaceIDs) push(id);
  }
  push(pick.faceID);
  return ids;
}

/**
 * Boundary-face records for the study faces. Matching is by faceID first.
 * Returns `{ faces, unmatched }`.
 */
export function matchBoundaryFaces(mesh, picked, { diagonal = 1 } = {}) {
  const boundary = [];
  for (let f = 0; f < mesh.faceIds.length; f += 1) boundary.push(faceGeometry(mesh, f));
  const byId = new Map();
  for (const face of boundary) {
    let list = byId.get(face.faceId);
    if (!list) {
      list = [];
      byId.set(face.faceId, list);
    }
    list.push(face);
  }
  const chosen = [];
  const seen = new Set();
  const unmatched = [];
  const tol = Math.max(diagonal * 0.02, 1e-6);
  for (const pick of picked) {
    const ids = triangleIdsOf(pick);
    let listed = [];
    for (const id of ids) {
      const group = byId.get(id);
      if (group) listed = listed.concat(group);
    }
    if (listed.length) {
      // A Manifold face id is reused on disconnected coplanar walls. The two
      // outer flanges of a hat share ids, so an id match covers both and the
      // load lands on fixed nodes. Keep the connected patch nearest the
      // stored point.
      const patch = Array.isArray(pick.at) ? nearestPatch(listed, pick.at) : listed;
      for (const face of patch) {
        if (seen.has(face.index)) continue;
        seen.add(face.index);
        chosen.push(face);
      }
      continue;
    }
    const at = pick.at;
    const n = pick.n;
    let hit = false;
    if (Array.isArray(at) && Array.isArray(n)) {
      for (const face of boundary) {
        const dist = Math.hypot(face.centroid[0] - at[0], face.centroid[1] - at[1], face.centroid[2] - at[2]);
        if (dist > tol) continue;
        if (dot(face.normal, n) < 0.9) continue;
        hit = true;
        if (seen.has(face.index)) continue;
        seen.add(face.index);
        chosen.push(face);
      }
    }
    if (!hit) unmatched.push(pick);
  }
  return { faces: chosen, unmatched };
}

function addForce(into, node, force) {
  const prev = into.get(node) || [0, 0, 0];
  prev[0] += force[0];
  prev[1] += force[1];
  prev[2] += force[2];
  into.set(node, prev);
}

/**
 * `{ fixedNodes, forceNodes, forceValues, pressureFaces, pressures, warnings }`
 * for solve_tet10. Empty loads are omitted by the caller.
 */
export function boundaryConditions(mesh, study, { diagonal = 1 } = {}) {
  const warnings = [];
  const fixtures = matchBoundaryFaces(mesh, studyFaces(study && study.fixtures), { diagonal });
  if (fixtures.unmatched.length) {
    throw new Error('A fixed face is not on this solid. Pick the face again.');
  }
  const fixed = new Set();
  for (const face of fixtures.faces) {
    for (let k = 0; k < 6; k += 1) fixed.add(face.ids[k]);
  }

  const forces = new Map();
  const pressureFaces = [];
  const pressures = [];
  const loads = (study && study.loads) || [];
  for (const load of loads) {
    const matched = matchBoundaryFaces(mesh, load.faces || [], { diagonal });
    if (!matched.faces.length || matched.unmatched.length) {
      throw new Error('A loaded face is not on this solid. Pick the face again.');
    }
    if (load.kind === 'pressure') {
      const pressure = Number(load.pressure_MPa);
      for (const face of matched.faces) {
        for (let k = 0; k < 6; k += 1) pressureFaces.push(face.ids[k]);
        pressures.push(pressure);
      }
      continue;
    }
    const vector = load.vector || [0, 0, 0];
    let area = 0;
    for (const face of matched.faces) area += face.area;
    if (!(area > 0)) throw new Error('A loaded face has no area.');
    const traction = [vector[0] / area, vector[1] / area, vector[2] / area];
    for (const face of matched.faces) {
      const nodal = faceTractionForces(face.xyz, traction);
      for (let k = 0; k < 6; k += 1) addForce(forces, face.ids[k], nodal[k]);
    }
  }

  if ((study && study.fixtures && study.fixtures.length) && fixed.size === 0) {
    warnings.push({
      code: 'no-fixture',
      msg: 'No boundary node matched the fixed face.',
    });
  }

  const forceNodes = [];
  const forceValues = [];
  for (const [node, force] of forces) {
    if (force[0] === 0 && force[1] === 0 && force[2] === 0) continue;
    forceNodes.push(node);
    forceValues.push(force[0], force[1], force[2]);
  }

  return {
    fixedNodes: Uint32Array.from(fixed),
    forceNodes: Uint32Array.from(forceNodes),
    forceValues: Float64Array.from(forceValues),
    pressureFaces: Uint32Array.from(pressureFaces),
    pressures: Float64Array.from(pressures),
    warnings,
  };
}
