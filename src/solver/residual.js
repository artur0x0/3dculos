/**
 * Dense nonlinear least squares.
 *
 * Powell dogleg on the Gauss–Newton step and the steepest-descent step,
 * inside a trust region. The normal matrix is JᵀJ, factored with a small
 * Cholesky. A missing Jacobian is finite-differenced.
 *
 * The unknown is a plain number vector. Callers own the geometry: a joint
 * adapter and, later, a 2D sketcher. This file does not know about either.
 *
 * Gauge freedom is left to the trust region and to the minimum-norm step
 * (a null direction of JᵀJ is not moved). There is no hidden anchor.
 */

const RIDGE0 = 1e-12;

function zeros(n) {
  return new Array(n).fill(0);
}

function clone(x) {
  return x.slice();
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.hypot(...a);
}

function maxAbs(a) {
  let m = 0;
  for (const v of a) {
    const x = Math.abs(v);
    if (x > m) m = x;
  }
  return m;
}

function scale(a, s) {
  return a.map((v) => v * s);
}

function add(a, b) {
  return a.map((v, i) => v + b[i]);
}

function matVec(A, x) {
  return A.map((row) => dot(row, x));
}

function jtr(J, r) {
  const n = J[0]?.length || 0;
  const g = zeros(n);
  for (let i = 0; i < J.length; i++) {
    const ri = r[i];
    if (ri === 0) continue;
    const row = J[i];
    for (let j = 0; j < n; j++) g[j] += row[j] * ri;
  }
  return g;
}

function normal(J, r) {
  const n = J[0]?.length || 0;
  const A = Array.from({ length: n }, () => zeros(n));
  for (const row of J) {
    for (let i = 0; i < n; i++) {
      const ri = row[i];
      if (ri === 0) continue;
      for (let j = i; j < n; j++) A[i][j] += ri * row[j];
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  }
  return { A, g: jtr(J, r) };
}

function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => zeros(n));
  let scale = 1;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(A[i][i]));
  const floor = 1e-14 * scale;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(sum > floor)) return null;
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

function cholSolve(L, b) {
  const n = L.length;
  const y = zeros(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  const x = zeros(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

function addDiag(A, lam) {
  return A.map((row, i) => {
    const next = row.slice();
    next[i] += lam;
    return next;
  });
}

/** Minimum-norm solution of JᵀJ δ = -g. A ridge is added only when JᵀJ is singular. */
function gaussNewton(A, g) {
  const rhs = scale(g, -1);
  const pure = cholesky(A);
  if (pure) return cholSolve(pure, rhs);
  let scaleA = 1;
  for (let i = 0; i < A.length; i++) scaleA = Math.max(scaleA, Math.abs(A[i][i]));
  let lam = RIDGE0 * scaleA;
  for (let k = 0; k < 16; k++) {
    const L = cholesky(addDiag(A, lam));
    if (L) return cholSolve(L, rhs);
    lam *= 10;
  }
  return null;
}

function cauchy(g, A, delta) {
  const gNorm = norm(g);
  if (!(gNorm > 0)) return zeros(g.length);
  const Ag = matVec(A, g);
  const gAg = dot(g, Ag);
  let step;
  if (!(gAg > 0)) {
    step = scale(g, -delta / gNorm);
  } else {
    const alpha = dot(g, g) / gAg;
    step = scale(g, -alpha);
    const len = norm(step);
    if (len > delta) step = scale(step, delta / len);
  }
  return step;
}

function dogleg(gn, cp, delta) {
  const gnNorm = norm(gn);
  if (gnNorm <= delta) return gn;
  const cpNorm = norm(cp);
  if (!(cpNorm > 0) || cpNorm >= delta) {
    return cpNorm > 0 ? scale(cp, delta / cpNorm) : zeros(gn.length);
  }
  const diff = add(gn, scale(cp, -1));
  const a = dot(diff, diff);
  const b = 2 * dot(cp, diff);
  const c = dot(cp, cp) - delta * delta;
  const disc = Math.max(0, b * b - 4 * a * c);
  const tau = a > 0 ? (-b + Math.sqrt(disc)) / (2 * a) : 0;
  return add(cp, scale(diff, Math.min(1, Math.max(0, tau))));
}

/** Rank of a symmetric matrix by elimination. */
export function symmetricRank(A, tol = 1e-8) {
  const n = A.length;
  const M = A.map((row) => row.slice());
  let scale = 1;
  for (const row of M) for (const v of row) scale = Math.max(scale, Math.abs(v));
  const floor = tol * scale;
  let rank = 0;
  let row = 0;
  for (let col = 0; col < n && row < n; col++) {
    let piv = row;
    for (let i = row + 1; i < n; i++) {
      if (Math.abs(M[i][col]) > Math.abs(M[piv][col])) piv = i;
    }
    if (Math.abs(M[piv][col]) <= floor) continue;
    const tmp = M[row];
    M[row] = M[piv];
    M[piv] = tmp;
    const div = M[row][col];
    for (let i = row + 1; i < n; i++) {
      const f = M[i][col] / div;
      for (let j = col; j < n; j++) M[i][j] -= f * M[row][j];
    }
    rank += 1;
    row += 1;
  }
  return rank;
}

function finiteJacobian(residual, x) {
  const r0 = residual(x);
  const m = r0.length;
  const n = x.length;
  const J = Array.from({ length: m }, () => zeros(n));
  for (let j = 0; j < n; j++) {
    const step = 1e-7 * Math.max(1, Math.abs(x[j]));
    const xp = clone(x);
    xp[j] += step;
    const rp = residual(xp);
    for (let i = 0; i < m; i++) J[i][j] = (rp[i] - r0[i]) / step;
  }
  return J;
}

/**
 * @param {object} args
 * @param {number} args.n
 * @param {(x: number[]) => number[]} args.residual
 * @param {((x: number[]) => number[][]) | null} [args.jacobian]
 * @param {number[]} args.x0
 * @param {number} [args.tol]
 * @param {number} [args.maxIter]
 * @returns {{ x: number[], ok: boolean, residual: number[], rank: number }}
 */
export function solveResiduals({
  n,
  residual,
  jacobian = null,
  x0,
  tol = 1e-3,
  maxIter = 60,
}) {
  if (!Number.isInteger(n) || n < 0) throw new Error('solveResiduals: n must be a non-negative integer');
  let x = x0 ? clone(x0) : zeros(n);
  if (x.length !== n) throw new Error('solveResiduals: x0 length must be n');
  let r = residual(x);
  if (n === 0 || r.length === 0) {
    return { x, ok: maxAbs(r) < tol, residual: r, rank: 0 };
  }
  let delta = 10;
  const deltaMax = 1e3;
  let rank = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    if (maxAbs(r) < tol) return { x, ok: true, residual: r, rank };
    const J = jacobian ? jacobian(x) : finiteJacobian(residual, x);
    const { A, g } = normal(J, r);
    rank = symmetricRank(A);
    const gNorm = norm(g);
    if (!(gNorm > 1e-14)) break;
    const cp = cauchy(g, A, delta);
    const gn = gaussNewton(A, g);
    const step = gn ? dogleg(gn, cp, delta) : cp;
    const stepNorm = norm(step);
    if (!(stepNorm > 1e-14)) break;
    const pred = -(dot(g, step) + 0.5 * dot(step, matVec(A, step)));
    const xNext = add(x, step);
    const rNext = residual(xNext);
    const actual = 0.5 * (dot(r, r) - dot(rNext, rNext));
    const rho = pred > 1e-16 ? actual / pred : (actual > 0 ? 1 : -1);
    if (rho > 0.1) {
      x = xNext;
      r = rNext;
    }
    if (rho < 0.25) delta = Math.max(delta * 0.25, 1e-8);
    else if (rho > 0.75 && stepNorm > 0.9 * delta) delta = Math.min(delta * 2, deltaMax);
    if (maxAbs(r) < tol) return { x, ok: true, residual: r, rank };
  }
  return { x, ok: maxAbs(r) < tol, residual: r, rank };
}
