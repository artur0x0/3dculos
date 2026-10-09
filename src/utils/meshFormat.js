/**
 * SurfCAD `.mesh` — the manifold mesh beside a part script.
 *
 * Little-endian. Header is 20 bytes, then the arrays with no padding:
 *
 *   offset  size    field
 *   0       4       magic ASCII "MESH"
 *   4       4       version uint32 = 1
 *   8       4       numProp uint32 (floats per vertex; 3 is xyz)
 *   12      4       vertCount uint32 (float32 values in vertProperties)
 *   16      4       triCount uint32 (uint32 values in triVerts)
 *   20      4*vertCount   vertProperties float32
 *           4*triCount    triVerts uint32
 *
 * The bytes are what `putAsset` hashes. A script names the file
 * (`importMesh('Bracket.mesh')`); the part record maps that name to the sha.
 */

export const MESH_MAGIC = 'MESH';
export const MESH_VERSION = 1;
export const MESH_HEADER_BYTES = 20;

const MAGIC_BYTES = [0x4d, 0x45, 0x53, 0x48];

function asFloat32(value) {
  if (value instanceof Float32Array) return value;
  if (!value || typeof value.length !== 'number') {
    throw new Error('Mesh is missing vertProperties');
  }
  return Float32Array.from(value);
}

function asUint32(value) {
  if (value instanceof Uint32Array) return value;
  if (!value || typeof value.length !== 'number') {
    throw new Error('Mesh is missing triVerts');
  }
  return Uint32Array.from(value);
}

/** Encode `{ vertProperties, triVerts, numProp }` to `.mesh` bytes. */
export function encodeMesh(mesh) {
  const numProp = Number(mesh?.numProp) || 3;
  if (!Number.isInteger(numProp) || numProp < 1 || numProp > 16) {
    throw new Error('Mesh numProp must be an integer from 1 to 16');
  }
  const vertProperties = asFloat32(mesh?.vertProperties);
  const triVerts = asUint32(mesh?.triVerts);
  if (vertProperties.length % numProp !== 0) {
    throw new Error('vertProperties length is not a multiple of numProp');
  }
  if (triVerts.length % 3 !== 0) {
    throw new Error('triVerts length is not a multiple of 3');
  }
  const bytes = new Uint8Array(MESH_HEADER_BYTES + vertProperties.byteLength + triVerts.byteLength);
  bytes.set(MAGIC_BYTES, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, MESH_VERSION, true);
  view.setUint32(8, numProp, true);
  view.setUint32(12, vertProperties.length, true);
  view.setUint32(16, triVerts.length, true);
  bytes.set(new Uint8Array(vertProperties.buffer, vertProperties.byteOffset, vertProperties.byteLength), MESH_HEADER_BYTES);
  bytes.set(
    new Uint8Array(triVerts.buffer, triVerts.byteOffset, triVerts.byteLength),
    MESH_HEADER_BYTES + vertProperties.byteLength,
  );
  return bytes;
}

/** Decode `.mesh` bytes to `{ numProp, vertProperties, triVerts }`. */
export function decodeMesh(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.byteLength < MESH_HEADER_BYTES) throw new Error('Mesh file is too small');
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new Error('Not a SurfCAD mesh');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== MESH_VERSION) throw new Error(`Unsupported mesh version ${version}`);
  const numProp = view.getUint32(8, true);
  const vertCount = view.getUint32(12, true);
  const triCount = view.getUint32(16, true);
  if (!numProp || vertCount % numProp !== 0 || triCount % 3 !== 0) {
    throw new Error('Mesh header counts are invalid');
  }
  const need = MESH_HEADER_BYTES + vertCount * 4 + triCount * 4;
  if (bytes.byteLength < need) throw new Error('Mesh file is truncated');
  const vertProperties = new Float32Array(vertCount);
  const triVerts = new Uint32Array(triCount);
  new Uint8Array(vertProperties.buffer).set(bytes.subarray(MESH_HEADER_BYTES, MESH_HEADER_BYTES + vertCount * 4));
  new Uint8Array(triVerts.buffer).set(bytes.subarray(
    MESH_HEADER_BYTES + vertCount * 4,
    MESH_HEADER_BYTES + vertCount * 4 + triCount * 4,
  ));
  return { numProp, vertProperties, triVerts };
}
