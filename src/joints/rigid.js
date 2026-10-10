/**
 * Rigid poses for joint residuals.
 *
 * A free part carries six numbers: a rotation increment ω and a translation
 * increment. They apply on the left of the seed pose.
 *
 *   R ← exp([ω]×) R
 *   t ← t + Δt
 *
 * The stored pose is t plus a quaternion, vector part first.
 */

export const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1]);

export function vec(x, y, z) {
  return [x, y, z];
}

export function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function unit3(a) {
  const len = length3(a);
  if (!(len > 1e-12)) return [0, 0, 0];
  return scale3(a, 1 / len);
}

export function mulQuat(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatFromOmega(omega) {
  const theta = length3(omega);
  if (theta < 1e-12) {
    return [omega[0] / 2, omega[1] / 2, omega[2] / 2, 1];
  }
  const s = Math.sin(theta / 2) / theta;
  return [omega[0] * s, omega[1] * s, omega[2] * s, Math.cos(theta / 2)];
}

export function rotateByQuat(q, v) {
  const qv = mulQuat(q, [v[0], v[1], v[2], 0]);
  const r = mulQuat(qv, [-q[0], -q[1], -q[2], q[3]]);
  return [r[0], r[1], r[2]];
}

/** Left Jacobian of SO(3). Jl(0) = I. */
export function leftJacobian(omega) {
  const theta = length3(omega);
  const K = skew(omega);
  if (theta < 1e-8) return addMat(eye(), scaleMat(K, 0.5));
  const a = (1 - Math.cos(theta)) / (theta * theta);
  const b = (theta - Math.sin(theta)) / (theta ** 3);
  return addMat(eye(), addMat(scaleMat(K, a), scaleMat(mulMat(K, K), b)));
}

export function skew(w) {
  return [
    [0, -w[2], w[1]],
    [w[2], 0, -w[0]],
    [-w[1], w[0], 0],
  ];
}

export function eye() {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

export function scaleMat(M, s) {
  return M.map((row) => row.map((v) => v * s));
}

export function addMat(A, B) {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

export function mulMat(A, B) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return out;
}

export function mulMatVec(M, v) {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

/** vᵀ M, a row of three. */
export function vecTMat(v, M) {
  return [
    v[0] * M[0][0] + v[1] * M[1][0] + v[2] * M[2][0],
    v[0] * M[0][1] + v[1] * M[1][1] + v[2] * M[2][1],
    v[0] * M[0][2] + v[1] * M[1][2] + v[2] * M[2][2],
  ];
}

/**
 * World frame of a local point and direction, plus ∂/∂ω and ∂/∂t.
 * `pose` is { t, q, omega } with q = exp(ω) ⊗ qSeed and t = tSeed + Δt.
 */
export function worldGeom(pose, local) {
  const dir = rotateByQuat(pose.q, local.dir);
  const rotatedAt = rotateByQuat(pose.q, local.at);
  const at = add3(rotatedAt, pose.t);
  const Jl = leftJacobian(pose.omega);
  const dDir = mulMat(scaleMat(skew(dir), -1), Jl);
  const dAt = mulMat(scaleMat(skew(rotatedAt), -1), Jl);
  return { at, dir, dDir, dAt };
}

/** Index of the largest component. Frozen by the caller so a residual row stays fixed. */
export function dropIndex(v) {
  let k = 0;
  if (Math.abs(v[1]) > Math.abs(v[k])) k = 1;
  if (Math.abs(v[2]) > Math.abs(v[k])) k = 2;
  return k;
}

export function normalizeQuat(q) {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(len > 1e-12)) return [0, 0, 0, 1];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}
