/**
 * Fix / Force / Pressure face highlights.
 *
 * One overlay per (fixture or load, face), keyed in a map. Reconcile diffs
 * that map against the study: a key that is still selected keeps its mesh,
 * and a key that left is removed. Geometry and materials (the fill and the
 * outline) are disposed on the way out. Painting is therefore a pure
 * function of the selection. Appending a transparent mesh on every tap is
 * what stacked the highlight and left a cleared face lit.
 *
 * Contact skins are a different child (`fea-contact`). This module only
 * disposes meshes it put in the map.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { FACE_HIGHLIGHT_RENDER_ORDER } from '../utils/faceColorSkin.js';
import { fingerprintsFromGeometry } from '../utils/facePaint.js';
import { matchFaceKeys } from '../utils/faceColorMatch.js';
import { highlightBoundaryPositions } from '../utils/planarSeam.js';
import { faceKeyOf } from './studyPanel.js';

export const FEA_FACE_HIGHLIGHT_NAME = 'fea-face-highlight';
export const FEA_FACE_HIGHLIGHT_COLOR = 0x22d3ee;

export function faceHighlightKey(role, entryIndex, faceIndex) {
  return `${role}:${entryIndex}:${faceIndex}`;
}

/** Stable selection entries. `partId` is empty on a single-part study. */
export function faceHighlightTargets(study) {
  const targets = [];
  const push = (role, list) => {
    (list || []).forEach((entry, entryIndex) => {
      (entry?.faces || []).forEach((face, faceIndex) => {
        if (!face) return;
        const part = face.part;
        targets.push({
          key: faceHighlightKey(role, entryIndex, faceIndex),
          role,
          entryIndex,
          faceIndex,
          partId: part != null && part !== '' ? String(part) : '',
          face,
        });
      });
    });
  };
  push('fixture', study?.fixtures);
  push('load', study?.loads);
  return targets;
}

/**
 * The part mesh that owns this face. A stamped part id wins. A part-scope
 * face (no id) uses the active solid, or the only solid on screen.
 */
export function hostForHighlight(hosts, target) {
  const list = Array.isArray(hosts) ? hosts : [];
  if (target?.partId) {
    return list.find((host) => String(host?.id) === String(target.partId)) || null;
  }
  const active = list.find((host) => host?.active);
  if (active) return active;
  return list.length === 1 ? list[0] : null;
}

/** Changes when the part mesh, its geometry, or the covered triangles change. */
export function highlightSignature(mesh, triangles) {
  const geometry = mesh?.geometry;
  let hash = 2166136261;
  const list = triangles || [];
  for (let i = 0; i < list.length; i += 1) {
    hash ^= list[i] >>> 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${mesh?.uuid || ''}:${geometry?.uuid || ''}:${list.length}:${hash >>> 0}`;
}

export function disposeHighlightObject(object) {
  if (!object) return;
  const parent = object.parent;
  if (parent && typeof parent.remove === 'function') parent.remove(object);
  const stack = [object];
  while (stack.length) {
    const node = stack.pop();
    const children = node.children;
    if (children) {
      for (let i = 0; i < children.length; i += 1) stack.push(children[i]);
    }
    node.geometry?.dispose?.();
    const material = node.material;
    if (Array.isArray(material)) {
      for (let i = 0; i < material.length; i += 1) material[i]?.dispose?.();
    } else {
      material?.dispose?.();
    }
  }
}

function defaultResolveTriangles(host, face) {
  const geometry = host?.mesh?.geometry;
  const fingerprints = fingerprintsFromGeometry(geometry, host?.faceIDs);
  if (!fingerprints.length || !face) return [];
  const key = faceKeyOf(face);
  if (!key) return [];
  const { matched } = matchFaceKeys(fingerprints, [{ key }]);
  const indices = [];
  for (const row of matched) {
    const tris = row.face?.tris || [];
    for (let i = 0; i < tris.length; i += 1) indices.push(tris[i]);
  }
  return indices;
}

/**
 * Local-space fill plus the face outline. The caller parents it to the
 * part mesh. It does not raycast, so the solid still receives the tap.
 */
export function createFaceHighlightMesh(geometry, triangleIndices) {
  const index = geometry?.index?.array;
  const positionAttr = geometry?.attributes?.position;
  const positions = positionAttr?.array;
  if (!index?.length || !positions?.length || !triangleIndices?.length) return null;
  const local = new Float32Array(triangleIndices.length * 9);
  let write = 0;
  for (let t = 0; t < triangleIndices.length; t += 1) {
    const base = triangleIndices[t] * 3;
    if (base < 0 || base + 2 >= index.length) continue;
    for (let k = 0; k < 3; k += 1) {
      const vertex = index[base + k] * 3;
      if (vertex < 0 || vertex + 2 >= positions.length) continue;
      local[write] = positions[vertex];
      local[write + 1] = positions[vertex + 1];
      local[write + 2] = positions[vertex + 2];
      write += 3;
    }
  }
  if (!write) return null;
  const fill = new BufferGeometry();
  fill.setAttribute('position', new BufferAttribute(local.subarray(0, write), 3));
  const mesh = new Mesh(fill, new MeshBasicMaterial({
    color: FEA_FACE_HIGHLIGHT_COLOR,
    transparent: true,
    opacity: 0.3,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  }));
  mesh.name = FEA_FACE_HIGHLIGHT_NAME;
  mesh.renderOrder = FACE_HIGHLIGHT_RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.raycast = () => {};
  try {
    const boundary = highlightBoundaryPositions(positionAttr, index, triangleIndices);
    if (boundary?.length) {
      const edgeGeometry = new BufferGeometry();
      edgeGeometry.setAttribute('position', new BufferAttribute(new Float32Array(boundary), 3));
      const edges = new LineSegments(edgeGeometry, new LineBasicMaterial({
        color: FEA_FACE_HIGHLIGHT_COLOR,
        linewidth: 3,
        depthTest: true,
        depthWrite: false,
      }));
      edges.name = `${FEA_FACE_HIGHLIGHT_NAME}-edge`;
      edges.renderOrder = FACE_HIGHLIGHT_RENDER_ORDER + 1;
      edges.frustumCulled = false;
      edges.raycast = () => {};
      mesh.add(edges);
    }
  } catch {
    // The fill still marks the face when the outline cannot be built.
  }
  return mesh;
}

/**
 * Diff `overlays` (Map key -> { signature, hostMesh, mesh }) against
 * `desired` ({ key, signature, hostMesh, create }). Returns a new map.
 * `create` runs only for a key that is missing or whose signature changed.
 */
export function reconcileFaceHighlights(overlays, desired, { dispose, attach }) {
  const prev = overlays instanceof Map ? overlays : new Map();
  const wanted = new Map();
  for (const spec of desired || []) {
    if (!spec || typeof spec.key !== 'string' || !spec.key || wanted.has(spec.key)) continue;
    wanted.set(spec.key, spec);
  }
  const next = new Map();
  const removed = [];
  for (const [key, record] of prev) {
    const spec = wanted.get(key);
    if (
      spec
      && record
      && spec.signature === record.signature
      && spec.hostMesh === record.hostMesh
    ) {
      next.set(key, record);
      continue;
    }
    dispose(record?.mesh);
    removed.push(key);
  }
  const created = [];
  const kept = [];
  for (const [key, spec] of wanted) {
    if (next.has(key)) {
      kept.push(key);
      continue;
    }
    const mesh = typeof spec.create === 'function' ? spec.create() : null;
    if (!mesh) continue;
    mesh.name = FEA_FACE_HIGHLIGHT_NAME;
    if (!mesh.userData) mesh.userData = {};
    mesh.userData.feaHighlightKey = key;
    mesh.raycast = () => {};
    mesh.frustumCulled = false;
    attach(mesh, spec);
    next.set(key, {
      key,
      signature: spec.signature,
      hostMesh: spec.hostMesh,
      mesh,
    });
    created.push(key);
  }
  return { overlays: next, created, removed, kept };
}

/**
 * Install the study's overlays on `hosts` (`{ id, mesh, faceIDs, active }`).
 * An empty study or a null study removes every overlay this map owns.
 */
export function syncFeaFaceHighlights(overlays, study, hosts, options = {}) {
  const resolveTriangles = options.resolveTriangles || defaultResolveTriangles;
  const createMesh = options.createMesh
    || ((host, triangles) => createFaceHighlightMesh(host?.mesh?.geometry, triangles));
  const dispose = options.dispose || disposeHighlightObject;
  const attach = options.attach || ((mesh, spec) => {
    if (typeof spec.hostMesh?.add === 'function') spec.hostMesh.add(mesh);
  });
  const list = Array.isArray(hosts) ? hosts : [];
  const desired = [];
  for (const target of faceHighlightTargets(study)) {
    const host = hostForHighlight(list, target);
    if (!host?.mesh) continue;
    const triangles = resolveTriangles(host, target.face) || [];
    if (!triangles.length) continue;
    const frozen = Array.from(triangles);
    desired.push({
      key: target.key,
      signature: highlightSignature(host.mesh, frozen),
      hostMesh: host.mesh,
      create: () => createMesh(host, frozen, target),
    });
  }
  return reconcileFaceHighlights(overlays, desired, { dispose, attach });
}
