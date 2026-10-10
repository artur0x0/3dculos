/**
 * Bonded pair highlight. One child mesh per part, in that part's local
 * coordinates, named `fea-contact`. It does not raycast. Closing Analyze
 * passes an empty pair list and the children come off.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
} from 'three';

const NAME = 'fea-contact';

function clearHost(mesh) {
  if (!mesh?.children) return;
  const children = mesh.children.filter((child) => child?.name === NAME);
  for (const child of children) {
    mesh.remove(child);
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
}

function trianglesFor(geometry, faceIDs, faceSet) {
  const index = geometry?.index?.array;
  const positions = geometry?.attributes?.position?.array;
  if (!index?.length || !positions?.length || !faceIDs?.length || !faceSet?.size) return null;
  const kept = [];
  const triangles = Math.floor(index.length / 3);
  for (let t = 0; t < triangles && t < faceIDs.length; t += 1) {
    if (!faceSet.has(Number(faceIDs[t]))) continue;
    kept.push(index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
  }
  if (!kept.length) return null;
  const local = new Float32Array(kept.length * 3);
  for (let i = 0; i < kept.length; i += 1) {
    const vertex = kept[i] * 3;
    local[i * 3] = positions[vertex] || 0;
    local[i * 3 + 1] = positions[vertex + 1] || 0;
    local[i * 3 + 2] = positions[vertex + 2] || 0;
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(local, 3));
  geom.computeVertexNormals();
  return geom;
}

/**
 * `hosts` are `{ id, mesh, faceIDs }`. `pairs` are study contacts.
 * An empty list clears every host.
 */
export function paintFeaContactHighlights(hosts, pairs) {
  const list = Array.isArray(hosts) ? hosts : [];
  const wanted = new Map();
  for (const pair of pairs || []) {
    if (!pair || pair.enabled === false) continue;
    for (const end of [pair.a, pair.b]) {
      if (!end || end.part == null || !Number.isInteger(Number(end.faceID))) continue;
      const id = String(end.part);
      let set = wanted.get(id);
      if (!set) {
        set = new Set();
        wanted.set(id, set);
      }
      set.add(Number(end.faceID));
    }
  }
  for (const host of list) {
    const mesh = host?.mesh;
    if (!mesh) continue;
    clearHost(mesh);
    const faces = wanted.get(String(host.id));
    if (!faces) continue;
    const geometry = trianglesFor(mesh.geometry, host.faceIDs, faces);
    if (!geometry) continue;
    const material = new MeshBasicMaterial({
      color: 0xf472b6,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const skin = new Mesh(geometry, material);
    skin.name = NAME;
    skin.renderOrder = 4;
    skin.frustumCulled = false;
    skin.raycast = () => {};
    mesh.add(skin);
  }
}
