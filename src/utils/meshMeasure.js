/**
 * Volume and bounding box of a 3MF mesh, from the model XML.
 * No zip library and no Manifold, so root tests can import it.
 * The signed tetrahedron sum is the enclosed volume; we take the absolute
 * value so winding order does not flip the price.
 */

export const MAX_MESH_VERTICES = 400_000;

export class MeshMeasureError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.name = 'MeshMeasureError';
    this.fatal = fatal;
  }
}

export function meshFrom3mfXml(xml) {
  if (typeof xml !== 'string' || !xml.includes('<')) {
    throw new MeshMeasureError('No geometry found in 3MF');
  }

  const vertices = [];
  const triangles = [];
  const vertexRegex = /<vertex\b[^>]*>/gi;
  let match;

  while ((match = vertexRegex.exec(xml)) !== null) {
    const tag = match[0];
    const x = tag.match(/\bx="([^"]+)"/i);
    const y = tag.match(/\by="([^"]+)"/i);
    const z = tag.match(/\bz="([^"]+)"/i);
    if (!x || !y || !z) continue;
    const point = [parseFloat(x[1]), parseFloat(y[1]), parseFloat(z[1])];
    if (!point.every((n) => Number.isFinite(n))) continue;
    vertices.push(point);
    if (vertices.length > MAX_MESH_VERTICES) {
      throw new MeshMeasureError('Model is too large to price', { fatal: true });
    }
  }

  const triRegex = /<triangle\b[^>]*>/gi;
  while ((match = triRegex.exec(xml)) !== null) {
    const tag = match[0];
    const v1 = tag.match(/\bv1="(\d+)"/i);
    const v2 = tag.match(/\bv2="(\d+)"/i);
    const v3 = tag.match(/\bv3="(\d+)"/i);
    if (!v1 || !v2 || !v3) continue;
    triangles.push([parseInt(v1[1], 10), parseInt(v2[1], 10), parseInt(v3[1], 10)]);
  }

  if (vertices.length === 0 || triangles.length === 0) {
    throw new MeshMeasureError('No geometry found in 3MF');
  }

  return { vertices, triangles };
}

export function geometryFromMesh(mesh) {
  const { vertices, triangles } = mesh;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const [x, y, z] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  let signed = 0;
  for (const [i, j, k] of triangles) {
    const a = vertices[i];
    const b = vertices[j];
    const c = vertices[k];
    if (!a || !b || !c) continue;
    signed += (
      a[0] * (b[1] * c[2] - b[2] * c[1]) +
      a[1] * (b[2] * c[0] - b[0] * c[2]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
  }

  return {
    volume: Math.abs(signed),
    boundingBox: {
      width: maxX - minX,
      height: maxY - minY,
      depth: maxZ - minZ,
    },
  };
}
