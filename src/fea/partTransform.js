/**
 * Assembly placement for a FEA part.
 *
 * The viewport stores a three.js matrixWorld (column-major, the same order
 * as Matrix4.elements): translation, rotation, and scale, including a parent.
 * A row may instead carry position, quaternion (x, y, z, w), and scale.
 * `translation` is the older position-only field.
 *
 * Contact detection and meshing both see the surface after this matrix.
 * Face fingerprints (`at`, `n`) are in the part's local frame and are mapped
 * with the same matrix. A force that follows the local face normal is mapped
 * too, and keeps its magnitude in newtons. A world-axis force is left alone.
 */

const IDENTITY = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isIdentity(matrix) {
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(matrix[i] - IDENTITY[i]) > 1e-9) return false;
  }
  return true;
}

/** Column-major 4x4 from a three.js matrix, or null when it is the identity. */
export function matrixFromElements(elements) {
  if (!elements || elements.length < 16) return null;
  const matrix = new Array(16);
  for (let i = 0; i < 16; i += 1) matrix[i] = num(elements[i]);
  return isIdentity(matrix) ? null : matrix;
}

/**
 * Column-major T * R * S, matching three.js Matrix4.compose.
 * Quaternion is x, y, z, w.
 */
export function composePlacement(position, quaternion, scale) {
  const px = num(position?.[0]);
  const py = num(position?.[1]);
  const pz = num(position?.[2]);
  let x = num(quaternion?.[0]);
  let y = num(quaternion?.[1]);
  let z = num(quaternion?.[2]);
  let w = quaternion && quaternion.length >= 4 ? num(quaternion[3], 1) : 1;
  const qlen = Math.hypot(x, y, z, w);
  if (qlen > 0) {
    x /= qlen;
    y /= qlen;
    z /= qlen;
    w /= qlen;
  } else {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  }
  const sx = scale && scale.length >= 3 ? num(scale[0], 1) : 1;
  const sy = scale && scale.length >= 3 ? num(scale[1], 1) : 1;
  const sz = scale && scale.length >= 3 ? num(scale[2], 1) : 1;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const matrix = [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    px, py, pz, 1,
  ];
  return isIdentity(matrix) ? null : matrix;
}

/** The matrix to bake into a part surface, or null when the part stays put. */
export function placementMatrix(part) {
  if (!part) return null;
  const fromElements = matrixFromElements(part.matrix);
  if (fromElements) return fromElements;
  if (Array.isArray(part.matrix) && part.matrix.length >= 16) return null;
  const position = Array.isArray(part.position) ? part.position : part.translation;
  const hasQuaternion = Array.isArray(part.quaternion) && part.quaternion.length >= 4;
  const hasScale = Array.isArray(part.scale) && part.scale.length >= 3;
  if (!position && !hasQuaternion && !hasScale) return null;
  return composePlacement(
    position || [0, 0, 0],
    hasQuaternion ? part.quaternion : [0, 0, 0, 1],
    hasScale ? part.scale : [1, 1, 1],
  );
}

export function transformPoint(point, matrix) {
  const x = num(point?.[0]);
  const y = num(point?.[1]);
  const z = num(point?.[2]);
  if (!matrix) return [x, y, z];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/** Inverse-transpose of the linear part, then normalized. Translation is ignored. */
export function transformNormal(normal, matrix) {
  const x = num(normal?.[0]);
  const y = num(normal?.[1]);
  const z = num(normal?.[2]);
  if (!matrix) return [x, y, z];
  const a = matrix[0];
  const d = matrix[1];
  const g = matrix[2];
  const b = matrix[4];
  const e = matrix[5];
  const h = matrix[6];
  const c = matrix[8];
  const f = matrix[9];
  const i = matrix[10];
  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;
  const c10 = -(b * i - c * h);
  const c11 = a * i - c * g;
  const c12 = -(a * h - b * g);
  const c20 = b * f - c * e;
  const c21 = -(a * f - c * d);
  const c22 = a * e - b * d;
  const nx = c00 * x + c01 * y + c02 * z;
  const ny = c10 * x + c11 * y + c12 * z;
  const nz = c20 * x + c21 * y + c22 * z;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) return [x, y, z];
  return [nx / len, ny / len, nz / len];
}

/**
 * Rotate a vector by the linear part and keep its length, so a force in
 * newtons does not grow when the part is scaled.
 */
export function transformDirection(vector, matrix) {
  const x = num(vector?.[0]);
  const y = num(vector?.[1]);
  const z = num(vector?.[2]);
  if (!matrix) return [x, y, z];
  const ox = matrix[0] * x + matrix[4] * y + matrix[8] * z;
  const oy = matrix[1] * x + matrix[5] * y + matrix[9] * z;
  const oz = matrix[2] * x + matrix[6] * y + matrix[10] * z;
  const inLen = Math.hypot(x, y, z);
  const outLen = Math.hypot(ox, oy, oz);
  if (!(inLen > 0) || !(outLen > 0)) return [ox, oy, oz];
  const scale = inLen / outLen;
  return [ox * scale, oy * scale, oz * scale];
}

export function transformPositions(positions, matrix) {
  if (!matrix || !positions) return positions;
  const out = new positions.constructor(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    out[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    out[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    out[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  return out;
}

function parallel(a, b) {
  const al = Math.hypot(a[0], a[1], a[2]);
  const bl = Math.hypot(b[0], b[1], b[2]);
  if (!(al > 0) || !(bl > 0)) return false;
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * bl);
  return Math.abs(Math.abs(dot) - 1) <= 1e-3;
}

function placeFace(face, matrix) {
  if (!face || !matrix) return face;
  const next = { ...face };
  if (Array.isArray(face.at)) next.at = transformPoint(face.at, matrix);
  if (Array.isArray(face.n)) next.n = transformNormal(face.n, matrix);
  return next;
}

/** Study fixtures and loads for a mesh that was baked into world space. */
export function placeStudy(study, matrix) {
  if (!study || !matrix) return study;
  const mapEntry = (entry) => {
    if (!entry) return entry;
    const faces = (entry.faces || []).map((face) => placeFace(face, matrix));
    const next = { ...entry, faces };
    if (!Array.isArray(entry.vector)) return next;
    const locals = (entry.faces || []).map((face) => face?.n).filter((n) => Array.isArray(n));
    if (locals.length && locals.every((n) => parallel(entry.vector, n))) {
      next.vector = transformDirection(entry.vector, matrix);
    }
    return next;
  };
  return {
    ...study,
    fixtures: (study.fixtures || []).map(mapEntry),
    loads: (study.loads || []).map(mapEntry),
  };
}
