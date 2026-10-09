/**
 * Matrix-free hex elasticity: geometric multigrid V-cycles precondition CG.
 *
 * The same Ke, Jacobi weight, and even-node restriction run in
 * previewShader.wgsl. Coarse grids are rediscretized, not Galerkin.
 * Displacements on fixed nodes stay zero. Inactive nodes are treated as
 * fixed so the diagonal stays positive.
 */

import { buildHexKe, cellNodeIndex } from './hexElement.js';

export const PRE_SMOOTH = 3;
export const POST_SMOOTH = 6;

function nodeCountOf(nx, ny, nz) {
  return (nx + 1) * (ny + 1) * (nz + 1);
}

function solidList(occupancy) {
  let count = 0;
  for (let i = 0; i < occupancy.length; i += 1) count += occupancy[i] ? 1 : 0;
  const solid = new Uint32Array(count);
  let w = 0;
  for (let i = 0; i < occupancy.length; i += 1) {
    if (occupancy[i]) {
      solid[w] = i;
      w += 1;
    }
  }
  return solid;
}

function connect(nx, ny, nz, solid) {
  const nxp = nx + 1;
  const nyp = ny + 1;
  const nodes = new Uint32Array(solid.length * 8);
  for (let e = 0; e < solid.length; e += 1) {
    const cell = solid[e];
    const i = cell % nx;
    const t = (cell / nx) | 0;
    const j = t % ny;
    const k = (t / ny) | 0;
    const n0 = cellNodeIndex(i, j, k, nxp, nyp);
    const sj = nxp;
    const sk = nxp * nyp;
    const base = e * 8;
    nodes[base] = n0;
    nodes[base + 1] = n0 + 1;
    nodes[base + 2] = n0 + sj;
    nodes[base + 3] = n0 + 1 + sj;
    nodes[base + 4] = n0 + sk;
    nodes[base + 5] = n0 + 1 + sk;
    nodes[base + 6] = n0 + sj + sk;
    nodes[base + 7] = n0 + 1 + sj + sk;
  }
  return nodes;
}

function applyKe(ke, ue, fe) {
  for (let row = 0; row < 24; row += 1) {
    let sum = 0;
    const base = row * 24;
    for (let col = 0; col < 24; col += 1) sum += ke[base + col] * ue[col];
    fe[row] = sum;
  }
}

export function matvec(op, u, out) {
  out.fill(0);
  const ke = op.ke;
  const nodes = op.nodes;
  const fixed = op.fixed;
  const ue = op.ue;
  const fe = op.fe;
  const elements = nodes.length / 8;
  for (let e = 0; e < elements; e += 1) {
    const base = e * 8;
    for (let a = 0; a < 8; a += 1) {
      const node = nodes[base + a];
      const locked = fixed[node];
      const at = node * 3;
      const local = a * 3;
      ue[local] = locked ? 0 : u[at];
      ue[local + 1] = locked ? 0 : u[at + 1];
      ue[local + 2] = locked ? 0 : u[at + 2];
    }
    applyKe(ke, ue, fe);
    for (let a = 0; a < 8; a += 1) {
      const node = nodes[base + a];
      if (fixed[node]) continue;
      const at = node * 3;
      const local = a * 3;
      out[at] += fe[local];
      out[at + 1] += fe[local + 1];
      out[at + 2] += fe[local + 2];
    }
  }
}

function accumulateDiag(op) {
  const diag = new Float64Array(op.nodeCount * 3);
  const ke = op.ke;
  const nodes = op.nodes;
  const elements = nodes.length / 8;
  for (let e = 0; e < elements; e += 1) {
    const base = e * 8;
    for (let a = 0; a < 8; a += 1) {
      const node = nodes[base + a];
      if (op.fixed[node]) continue;
      const local = a * 3;
      const at = node * 3;
      diag[at] += ke[local * 24 + local];
      diag[at + 1] += ke[(local + 1) * 24 + (local + 1)];
      diag[at + 2] += ke[(local + 2) * 24 + (local + 2)];
    }
  }
  for (let n = 0; n < op.nodeCount; n += 1) {
    if (!op.fixed[n]) continue;
    diag[n * 3] = 1;
    diag[n * 3 + 1] = 1;
    diag[n * 3 + 2] = 1;
  }
  return diag;
}

function lockInactive(fixed, nodes) {
  const active = new Uint8Array(fixed.length);
  const elements = nodes.length / 8;
  for (let e = 0; e < elements; e += 1) {
    const base = e * 8;
    for (let a = 0; a < 8; a += 1) active[nodes[base + a]] = 1;
  }
  for (let n = 0; n < fixed.length; n += 1) {
    if (!active[n]) fixed[n] = 1;
  }
}

export function buildLevel({
  occupancy,
  nx,
  ny,
  nz,
  hx,
  hy,
  hz,
  fixed,
  E,
  nu,
  shear = 'full',
}) {
  const solid = solidList(occupancy);
  const nxp = nx + 1;
  const nyp = ny + 1;
  const nodeCount = nodeCountOf(nx, ny, nz);
  const locked = fixed ? Uint8Array.from(fixed) : new Uint8Array(nodeCount);
  if (locked.length !== nodeCount) throw new Error('Fixed-node mask does not match the grid.');
  const nodes = connect(nx, ny, nz, solid);
  lockInactive(locked, nodes);
  const level = {
    nx,
    ny,
    nz,
    nxp,
    nyp,
    nzp: nz + 1,
    hx,
    hy,
    hz,
    E,
    nu,
    shear,
    nodeCount,
    occupancy,
    solid,
    nodes,
    fixed: locked,
    ke: buildHexKe(hx, hy, hz, E, nu, shear),
    ue: new Float64Array(24),
    fe: new Float64Array(24),
    z: new Float64Array(nodeCount * 3),
    rhs: new Float64Array(nodeCount * 3),
    az: new Float64Array(nodeCount * 3),
    defect: new Float64Array(nodeCount * 3),
    coarser: null,
  };
  level.diag = accumulateDiag(level);
  level.omega = jacobiOmega(level);
  return level;
}

/** Largest eigenvalue of D⁻¹K, then a weight safely under 2/λ. */
function jacobiOmega(op) {
  const x = new Float64Array(op.nodeCount * 3);
  const y = new Float64Array(op.nodeCount * 3);
  let seed = 17;
  for (let i = 0; i < x.length; i += 1) {
    if (op.fixed[(i / 3) | 0]) continue;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    x[i] = seed / 4294967296 * 2 - 1;
  }
  let lambda = 1;
  for (let iter = 0; iter < 10; iter += 1) {
    matvec(op, x, y);
    for (let n = 0; n < op.nodeCount; n += 1) {
      const at = n * 3;
      if (op.fixed[n]) {
        y[at] = 0;
        y[at + 1] = 0;
        y[at + 2] = 0;
        continue;
      }
      y[at] /= op.diag[at];
      y[at + 1] /= op.diag[at + 1];
      y[at + 2] /= op.diag[at + 2];
    }
    let num = 0;
    let den = 0;
    let norm = 0;
    for (let i = 0; i < x.length; i += 1) {
      num += x[i] * y[i];
      den += x[i] * x[i];
      norm += y[i] * y[i];
    }
    if (den > 0) lambda = num / den;
    norm = Math.sqrt(norm);
    if (!(norm > 0)) break;
    for (let i = 0; i < x.length; i += 1) x[i] = y[i] / norm;
  }
  lambda = Math.max(lambda, 1);
  return Math.min(0.6, 1.1 / lambda);
}

function coarsenOccupancy(fine) {
  const nx = Math.max(1, fine.nx >> 1);
  const ny = Math.max(1, fine.ny >> 1);
  const nz = Math.max(1, fine.nz >> 1);
  const occupancy = new Uint8Array(nx * ny * nz);
  for (let e = 0; e < fine.solid.length; e += 1) {
    const cell = fine.solid[e];
    const i = cell % fine.nx;
    const t = (cell / fine.nx) | 0;
    const j = t % fine.ny;
    const k = (t / fine.ny) | 0;
    const I = i >> 1;
    const J = j >> 1;
    const K = k >> 1;
    if (I < nx && J < ny && K < nz) occupancy[I + nx * (J + ny * K)] = 1;
  }
  return { nx, ny, nz, occupancy };
}

function coarsenFixed(fine, nx, ny, nz) {
  const fixed = new Uint8Array(nodeCountOf(nx, ny, nz));
  const nxp = nx + 1;
  const nyp = ny + 1;
  for (let K = 0; K <= nz; K += 1) {
    for (let J = 0; J <= ny; J += 1) {
      for (let I = 0; I <= nx; I += 1) {
        const fineNode = cellNodeIndex(I * 2, J * 2, K * 2, fine.nxp, fine.nyp);
        if (fine.fixed[fineNode]) fixed[cellNodeIndex(I, J, K, nxp, nyp)] = 1;
      }
    }
  }
  return fixed;
}

export function buildHierarchy(spec) {
  let current = buildLevel(spec);
  const fine = current;
  let guard = 0;
  while (Math.max(current.nx, current.ny, current.nz) > 4 && guard < 12) {
    guard += 1;
    const coarse = coarsenOccupancy(current);
    if (coarse.nx === current.nx && coarse.ny === current.ny && coarse.nz === current.nz) break;
    const child = buildLevel({
      occupancy: coarse.occupancy,
      nx: coarse.nx,
      ny: coarse.ny,
      nz: coarse.nz,
      hx: current.hx * (current.nx / coarse.nx),
      hy: current.hy * (current.ny / coarse.ny),
      hz: current.hz * (current.nz / coarse.nz),
      fixed: coarsenFixed(current, coarse.nx, coarse.ny, coarse.nz),
      E: spec.E,
      nu: spec.nu,
      shear: spec.shear || 'full',
    });
    current.coarser = child;
    current = child;
  }
  factorDense(current);
  return fine;
}

function factorDense(op) {
  const free = [];
  for (let n = 0; n < op.nodeCount; n += 1) {
    if (op.fixed[n]) continue;
    free.push(n * 3, n * 3 + 1, n * 3 + 2);
  }
  const n = free.length;
  if (!n || n > 900) return;
  const A = new Float64Array(n * n);
  const col = new Float64Array(op.nodeCount * 3);
  const out = new Float64Array(op.nodeCount * 3);
  for (let j = 0; j < n; j += 1) {
    col[free[j]] = 1;
    matvec(op, col, out);
    col[free[j]] = 0;
    for (let i = 0; i < n; i += 1) A[i * n + j] = out[free[i]];
  }
  const piv = new Int32Array(n);
  for (let k = 0; k < n; k += 1) {
    let max = Math.abs(A[k * n + k]);
    let row = k;
    for (let i = k + 1; i < n; i += 1) {
      const value = Math.abs(A[i * n + k]);
      if (value > max) {
        max = value;
        row = i;
      }
    }
    piv[k] = row;
    if (!(max > 0)) continue;
    if (row !== k) {
      for (let j = 0; j < n; j += 1) {
        const tmp = A[k * n + j];
        A[k * n + j] = A[row * n + j];
        A[row * n + j] = tmp;
      }
    }
    const diag = A[k * n + k];
    if (!(Math.abs(diag) > 0)) continue;
    for (let i = k + 1; i < n; i += 1) {
      const factor = A[i * n + k] / diag;
      A[i * n + k] = factor;
      for (let j = k + 1; j < n; j += 1) A[i * n + j] -= factor * A[k * n + j];
    }
  }
  op.dense = { free, A, piv, n };
}

function denseSolve(op, rhs, z) {
  const { free, A, piv, n } = op.dense;
  const b = new Float64Array(n);
  for (let i = 0; i < n; i += 1) b[i] = rhs[free[i]];
  for (let k = 0; k < n; k += 1) {
    const row = piv[k];
    if (row !== k) {
      const tmp = b[k];
      b[k] = b[row];
      b[row] = tmp;
    }
    for (let i = k + 1; i < n; i += 1) b[i] -= A[i * n + k] * b[k];
  }
  for (let k = n - 1; k >= 0; k -= 1) {
    let sum = b[k];
    for (let j = k + 1; j < n; j += 1) sum -= A[k * n + j] * b[j];
    const diag = A[k * n + k];
    b[k] = Math.abs(diag) > 1e-18 ? sum / diag : 0;
  }
  z.fill(0);
  for (let i = 0; i < n; i += 1) z[free[i]] = b[i];
}

/**
 * Coarsest correction. The dense factor was built with the hierarchy.
 * `rhs` may be f32; the solve accumulates in f64 and returns f64.
 */
export function solveCoarse(op, rhs) {
  const z = new Float64Array(op.nodeCount * 3);
  const b = rhs instanceof Float64Array ? rhs : Float64Array.from(rhs);
  if (op.dense) denseSolve(op, b, z);
  else {
    z.fill(0);
    smooth(op, z, b, 80);
  }
  zeroFixed(op, z);
  return z;
}

/** Multiply every Ke and diagonal by `factor` (an E change at fixed ν). */
export function scaleOperator(op, factor) {
  if (!(factor > 0) || factor === 1) return;
  op.previewStamp = (op.previewStamp || 0) + 1;
  let level = op;
  while (level) {
    const ke = level.ke;
    for (let i = 0; i < ke.length; i += 1) ke[i] *= factor;
    const diag = level.diag;
    for (let n = 0; n < level.nodeCount; n += 1) {
      if (level.fixed[n]) continue;
      diag[n * 3] *= factor;
      diag[n * 3 + 1] *= factor;
      diag[n * 3 + 2] *= factor;
    }
    level.E *= factor;
    level = level.coarser;
  }
}

function zeroFixed(op, field) {
  const fixed = op.fixed;
  for (let n = 0; n < op.nodeCount; n += 1) {
    if (!fixed[n]) continue;
    const at = n * 3;
    field[at] = 0;
    field[at + 1] = 0;
    field[at + 2] = 0;
  }
}

function dotFree(op, a, b) {
  const fixed = op.fixed;
  let sum = 0;
  for (let n = 0; n < op.nodeCount; n += 1) {
    if (fixed[n]) continue;
    const at = n * 3;
    sum += a[at] * b[at] + a[at + 1] * b[at + 1] + a[at + 2] * b[at + 2];
  }
  return sum;
}

function normFree(op, a) {
  return Math.sqrt(Math.max(0, dotFree(op, a, a)));
}

function smooth(op, z, rhs, iters) {
  const omega = op.omega || 0.3;
  const diag = op.diag;
  const fixed = op.fixed;
  const az = op.az;
  for (let s = 0; s < iters; s += 1) {
    matvec(op, z, az);
    for (let n = 0; n < op.nodeCount; n += 1) {
      const at = n * 3;
      if (fixed[n]) {
        z[at] = 0;
        z[at + 1] = 0;
        z[at + 2] = 0;
        continue;
      }
      z[at] += omega * (rhs[at] - az[at]) / diag[at];
      z[at + 1] += omega * (rhs[at + 1] - az[at + 1]) / diag[at + 1];
      z[at + 2] += omega * (rhs[at + 2] - az[at + 2]) / diag[at + 2];
    }
  }
}

function restrictResidual(fine, defect, coarseRhs) {
  coarseRhs.fill(0);
  const coarse = fine.coarser;
  const { nx, ny, nz, nxp, nyp } = fine;
  const cnx = coarse.nx;
  const cny = coarse.ny;
  const cnz = coarse.nz;
  const cnpx = coarse.nxp;
  const cnpy = coarse.nyp;
  const fixed = fine.fixed;
  for (let k = 0; k <= nz; k += 1) {
    const K0 = k >> 1;
    const wz = (k & 1) ? 0.5 : 1;
    const K1 = (k & 1) ? Math.min(K0 + 1, cnz) : K0;
    const wk = (k & 1) ? 0.5 : 0;
    for (let j = 0; j <= ny; j += 1) {
      const J0 = j >> 1;
      const wy = (j & 1) ? 0.5 : 1;
      const J1 = (j & 1) ? Math.min(J0 + 1, cny) : J0;
      const wj = (j & 1) ? 0.5 : 0;
      for (let i = 0; i <= nx; i += 1) {
        const node = i + nxp * (j + nyp * k);
        if (fixed[node]) continue;
        const at = node * 3;
        const rx = defect[at];
        const ry = defect[at + 1];
        const rz = defect[at + 2];
        const I0 = i >> 1;
        const wx = (i & 1) ? 0.5 : 1;
        const I1 = (i & 1) ? Math.min(I0 + 1, cnx) : I0;
        const wi = (i & 1) ? 0.5 : 0;
        const corners = [
          [I0, J0, K0, wx * wy * wz],
          [I1, J0, K0, wi * wy * wz],
          [I0, J1, K0, wx * wj * wz],
          [I1, J1, K0, wi * wj * wz],
          [I0, J0, K1, wx * wy * wk],
          [I1, J0, K1, wi * wy * wk],
          [I0, J1, K1, wx * wj * wk],
          [I1, J1, K1, wi * wj * wk],
        ];
        for (let c = 0; c < 8; c += 1) {
          const weight = corners[c][3];
          if (weight === 0) continue;
          const cn = corners[c][0] + cnpx * (corners[c][1] + cnpy * corners[c][2]);
          if (coarse.fixed[cn]) continue;
          const to = cn * 3;
          coarseRhs[to] += weight * rx;
          coarseRhs[to + 1] += weight * ry;
          coarseRhs[to + 2] += weight * rz;
        }
      }
    }
  }
}

function prolongAdd(fine, coarseZ, z) {
  const coarse = fine.coarser;
  const { nx, ny, nz, nxp, nyp } = fine;
  const cnx = coarse.nx;
  const cny = coarse.ny;
  const cnz = coarse.nz;
  const cnpx = coarse.nxp;
  const cnpy = coarse.nyp;
  const fixed = fine.fixed;
  for (let k = 0; k <= nz; k += 1) {
    const K0 = k >> 1;
    const wz = (k & 1) ? 0.5 : 1;
    const K1 = (k & 1) ? Math.min(K0 + 1, cnz) : K0;
    const wk = (k & 1) ? 0.5 : 0;
    for (let j = 0; j <= ny; j += 1) {
      const J0 = j >> 1;
      const wy = (j & 1) ? 0.5 : 1;
      const J1 = (j & 1) ? Math.min(J0 + 1, cny) : J0;
      const wj = (j & 1) ? 0.5 : 0;
      for (let i = 0; i <= nx; i += 1) {
        const node = i + nxp * (j + nyp * k);
        if (fixed[node]) continue;
        const I0 = i >> 1;
        const wx = (i & 1) ? 0.5 : 1;
        const I1 = (i & 1) ? Math.min(I0 + 1, cnx) : I0;
        const wi = (i & 1) ? 0.5 : 0;
        let x = 0;
        let y = 0;
        let zed = 0;
        const corners = [
          [I0, J0, K0, wx * wy * wz],
          [I1, J0, K0, wi * wy * wz],
          [I0, J1, K0, wx * wj * wz],
          [I1, J1, K0, wi * wj * wz],
          [I0, J0, K1, wx * wy * wk],
          [I1, J0, K1, wi * wy * wk],
          [I0, J1, K1, wx * wj * wk],
          [I1, J1, K1, wi * wj * wk],
        ];
        for (let c = 0; c < 8; c += 1) {
          const weight = corners[c][3];
          if (weight === 0) continue;
          const cn = corners[c][0] + cnpx * (corners[c][1] + cnpy * corners[c][2]);
          const at = cn * 3;
          x += weight * coarseZ[at];
          y += weight * coarseZ[at + 1];
          zed += weight * coarseZ[at + 2];
        }
        const to = node * 3;
        z[to] += x;
        z[to + 1] += y;
        z[to + 2] += zed;
      }
    }
  }
}

export function transferScale(op) {
  const coarse = op.coarser;
  if (!coarse) return null;
  const probe = new Float64Array(coarse.nodeCount * 3);
  for (let n = 0; n < coarse.nodeCount; n += 1) {
    if (coarse.fixed[n]) continue;
    probe[n * 3 + 2] = 1;
    break;
  }
  const fine = new Float64Array(op.nodeCount * 3);
  prolongAdd(op, probe, fine);
  matvec(op, fine, op.az);
  restrictResidual(op, op.az, coarse.rhs);
  matvec(coarse, probe, coarse.az);
  let num = 0;
  let den = 0;
  let diff = 0;
  for (let n = 0; n < coarse.nodeCount; n += 1) {
    if (coarse.fixed[n]) continue;
    const at = n * 3;
    num += coarse.rhs[at] * coarse.az[at] + coarse.rhs[at + 1] * coarse.az[at + 1] + coarse.rhs[at + 2] * coarse.az[at + 2];
    den += coarse.az[at] ** 2 + coarse.az[at + 1] ** 2 + coarse.az[at + 2] ** 2;
    const dx = coarse.rhs[at] - coarse.az[at];
    const dy = coarse.rhs[at + 1] - coarse.az[at + 1];
    const dz = coarse.rhs[at + 2] - coarse.az[at + 2];
    diff += dx * dx + dy * dy + dz * dz;
  }
  return {
    scale: den > 0 ? num / den : null,
    rel: den > 0 ? Math.sqrt(diff / den) : null,
  };
}

export function vcycle(op, rhs, z) {
  if (!op.coarser) {
    if (op.dense) denseSolve(op, rhs, z);
    else {
      z.fill(0);
      smooth(op, z, rhs, 80);
    }
    zeroFixed(op, z);
    return;
  }
  z.fill(0);
  smooth(op, z, rhs, PRE_SMOOTH);
  matvec(op, z, op.az);
  const defect = op.defect;
  const fixed = op.fixed;
  for (let n = 0; n < op.nodeCount; n += 1) {
    const at = n * 3;
    if (fixed[n]) {
      defect[at] = 0;
      defect[at + 1] = 0;
      defect[at + 2] = 0;
      continue;
    }
    defect[at] = rhs[at] - op.az[at];
    defect[at + 1] = rhs[at + 1] - op.az[at + 1];
    defect[at + 2] = rhs[at + 2] - op.az[at + 2];
  }
  restrictResidual(op, defect, op.coarser.rhs);
  vcycle(op.coarser, op.coarser.rhs, op.coarser.z);
  prolongAdd(op, op.coarser.z, z);
  zeroFixed(op, z);
  smooth(op, z, rhs, POST_SMOOTH);
  zeroFixed(op, z);
}

/**
 * Stationary V-cycles in correction form. The first cycle can raise the
 * Euclidean residual (the prolonged correction carries stiff modes). Later
 * cycles are the reduction rate. Each entry is ||r|| / ||r0||.
 */
export function vcycleHistory(op, rhs, cycles = 4) {
  const z = new Float64Array(op.nodeCount * 3);
  const residual = new Float64Array(op.nodeCount * 3);
  const corr = new Float64Array(op.nodeCount * 3);
  zeroFixed(op, rhs);
  const origin = normFree(op, rhs);
  const history = [];
  if (!(origin > 0)) return history;
  const fixed = op.fixed;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    matvec(op, z, op.az);
    for (let n = 0; n < op.nodeCount; n += 1) {
      const at = n * 3;
      if (fixed[n]) {
        residual[at] = 0;
        residual[at + 1] = 0;
        residual[at + 2] = 0;
        continue;
      }
      residual[at] = rhs[at] - op.az[at];
      residual[at + 1] = rhs[at + 1] - op.az[at + 1];
      residual[at + 2] = rhs[at + 2] - op.az[at + 2];
    }
    vcycle(op, residual, corr);
    for (let i = 0; i < z.length; i += 1) z[i] += corr[i];
    matvec(op, z, op.az);
    let sum = 0;
    for (let n = 0; n < op.nodeCount; n += 1) {
      if (fixed[n]) continue;
      const at = n * 3;
      const dx = rhs[at] - op.az[at];
      const dy = rhs[at + 1] - op.az[at + 1];
      const dz = rhs[at + 2] - op.az[at + 2];
      sum += dx * dx + dy * dy + dz * dz;
    }
    history.push(Math.sqrt(sum) / origin);
  }
  return history;
}

/**
 * One V-cycle on a residual. Returns ||r - A z|| / ||r||. The first cycle
 * is not always a reduction; use `vcycleHistory` for the rate.
 */
export function vcycleReduction(op, rhs) {
  const scale = normFree(op, rhs);
  if (!(scale > 0)) return 1;
  vcycle(op, rhs, op.z);
  matvec(op, op.z, op.az);
  let sum = 0;
  const fixed = op.fixed;
  for (let n = 0; n < op.nodeCount; n += 1) {
    if (fixed[n]) continue;
    const at = n * 3;
    const dx = rhs[at] - op.az[at];
    const dy = rhs[at + 1] - op.az[at + 1];
    const dz = rhs[at + 2] - op.az[at + 2];
    sum += dx * dx + dy * dy + dz * dz;
  }
  return Math.sqrt(sum) / scale;
}

/**
 * CG preconditioned by one V-cycle. `u` is the initial guess and is
 * updated in place. Fixed dofs stay zero.
 */
export function pcg(op, rhs, u, { tol = 1e-4, maxIter = 40 } = {}) {
  zeroFixed(op, u);
  zeroFixed(op, rhs);
  const r = op.r || new Float64Array(op.nodeCount * 3);
  const p = op.p || new Float64Array(op.nodeCount * 3);
  op.r = r;
  op.p = p;
  matvec(op, u, op.az);
  const fixed = op.fixed;
  for (let n = 0; n < op.nodeCount; n += 1) {
    const at = n * 3;
    if (fixed[n]) {
      r[at] = 0;
      r[at + 1] = 0;
      r[at + 2] = 0;
      continue;
    }
    r[at] = rhs[at] - op.az[at];
    r[at + 1] = rhs[at + 1] - op.az[at + 1];
    r[at + 2] = rhs[at + 2] - op.az[at + 2];
  }
  const residual0 = normFree(op, r);
  const history = [1];
  if (!(residual0 > 0) || residual0 < tol * Math.max(1, normFree(op, rhs))) {
    return { iterations: 0, residual: 0, residual0, history };
  }
  vcycle(op, r, op.z);
  p.set(op.z);
  let rz = dotFree(op, r, op.z);
  let iterations = 0;
  let residual = residual0;
  for (let iter = 0; iter < maxIter; iter += 1) {
    iterations = iter + 1;
    matvec(op, p, op.az);
    const pAp = dotFree(op, p, op.az);
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    for (let n = 0; n < op.nodeCount; n += 1) {
      if (fixed[n]) continue;
      const at = n * 3;
      u[at] += alpha * p[at];
      u[at + 1] += alpha * p[at + 1];
      u[at + 2] += alpha * p[at + 2];
      r[at] -= alpha * op.az[at];
      r[at + 1] -= alpha * op.az[at + 1];
      r[at + 2] -= alpha * op.az[at + 2];
    }
    residual = normFree(op, r);
    history.push(residual / residual0);
    if (residual / residual0 <= tol) {
      return { iterations, residual: residual / residual0, residual0, history };
    }
    vcycle(op, r, op.z);
    const next = dotFree(op, r, op.z);
    const beta = rz !== 0 ? next / rz : 0;
    for (let n = 0; n < op.nodeCount; n += 1) {
      if (fixed[n]) {
        p[n * 3] = 0;
        p[n * 3 + 1] = 0;
        p[n * 3 + 2] = 0;
        continue;
      }
      const at = n * 3;
      p[at] = op.z[at] + beta * p[at];
      p[at + 1] = op.z[at + 1] + beta * p[at + 1];
      p[at + 2] = op.z[at + 2] + beta * p[at + 2];
    }
    rz = next;
  }
  return { iterations, residual: residual / residual0, residual0, history };
}

export function levelBytes(op) {
  let bytes = 0;
  let level = op;
  while (level) {
    bytes += level.ke.byteLength;
    bytes += level.nodes.byteLength;
    bytes += level.solid.byteLength;
    bytes += level.fixed.byteLength;
    bytes += level.diag.byteLength;
    bytes += level.z.byteLength + level.rhs.byteLength + level.az.byteLength + level.defect.byteLength;
    bytes += level.occupancy.byteLength;
    level = level.coarser;
  }
  return bytes;
}
