/**
 * Bind solve()'s per-vertex von Mises onto one buildSolidGeometry result.
 *
 * The stub field is one megapascal per render vertex of the geometry that
 * was solved. The binding is that geometry object plus faceID. A corner is
 * looked up as (faceID, vertex index). Triangle index is not a key: the
 * same geometry can be walked in another triangle order and the stresses
 * stay on the faces and vertices. A different geometry object does not
 * match, even when its index buffer is identical. Phase 1 can fill the
 * same face buckets from solver nodes (the kept render vertices) without
 * the skin learning a new key.
 */

const listeners = new Set();
let source = null;

function indexArray(geometry) {
  const index = geometry?.index;
  if (!index) return null;
  if (index.array) return index.array;
  return index;
}

function faceArray(geometry, faceIDs) {
  const attr = geometry?.getAttribute?.('faceID')?.array || geometry?.attributes?.faceID?.array;
  return attr || faceIDs || null;
}

function faceKey(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * `nodal[vertex]` is von Mises in MPa for this geometry. `faceIDs` is the
 * per-triangle ids from buildSolidGeometry when the geometry has no faceID
 * attribute. Returns null when the mesh cannot be keyed.
 */
export function bindStressField(geometry, nodal, faceIDs) {
  if (!geometry || !(nodal instanceof Float32Array)) return null;
  const index = indexArray(geometry);
  const faces = faceArray(geometry, faceIDs);
  if (!index?.length || !faces?.length) return null;
  const byFace = new Map();
  const triangles = Math.floor(Math.min(index.length, faces.length * 3) / 3);
  for (let t = 0; t < triangles; t++) {
    const face = faceKey(faces[t]);
    if (face == null) continue;
    let bucket = byFace.get(face);
    if (!bucket) {
      bucket = new Map();
      byFace.set(face, bucket);
    }
    for (let k = 0; k < 3; k++) {
      const vertex = index[t * 3 + k];
      const stress = nodal[vertex];
      bucket.set(vertex, Number.isFinite(stress) ? stress : NaN);
    }
  }
  if (!byFace.size) return null;
  return { geometry, byFace };
}

/** Von Mises in MPa for one corner, or NaN when that face does not own the vertex. */
export function stressAt(field, faceID, vertexIndex) {
  if (!field?.byFace) return NaN;
  const face = faceKey(faceID);
  if (face == null) return NaN;
  const bucket = field.byFace.get(face);
  if (!bucket || !bucket.has(vertexIndex)) return NaN;
  return bucket.get(vertexIndex);
}

/**
 * Per-corner stresses for a walk of `index` / `faceIDs`. Null when `field`
 * was bound to a different geometry. The output follows the walk, so a
 * reordered index does not reuse the old triangle slots.
 */
export function cornerStresses(field, geometry, index, faceIDs) {
  if (!field || field.geometry !== geometry || !index?.length || !faceIDs?.length) return null;
  const out = new Float32Array(index.length);
  out.fill(NaN);
  const triangles = Math.floor(Math.min(index.length, faceIDs.length * 3) / 3);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const vertex = index[t * 3 + k];
      const stress = stressAt(field, faceIDs[t], vertex);
      out[t * 3 + k] = Number.isFinite(stress) ? stress : NaN;
    }
  }
  return out;
}

/**
 * What the skin draws. `null` clears it. The object is the geometry from
 * buildSolidGeometry, the bound field, and `onStale` for a later mesh.
 * Listeners run on the change so the viewport can repaint without a rebuild.
 */
export function setStressSkinSource(next) {
  const value = next || null;
  if (value === source) return;
  source = value;
  for (const listener of listeners) listener();
}

export function getStressSkinSource() {
  return source;
}

export function subscribeStressSkin(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
