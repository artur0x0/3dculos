/**
 * 8-node trilinear hex for a rectangular voxel.
 *
 * One element stiffness is shared by every solid cell of a uniform grid.
 * The matrix-free matvec and the WGSL kernel both multiply by this Ke.
 * Node order is i + 2j + 4k with i, j, k in {0, 1}, x then y then z.
 * Stress is N/mm² (MPa) when E is MPa and lengths are mm.
 */

const GAUSS = 1 / Math.sqrt(3);

const SIGNS = [
  [-1, -1, -1],
  [1, -1, -1],
  [-1, 1, -1],
  [1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [-1, 1, 1],
  [1, 1, 1],
];

/** Local nodes on each cell side: −x +x −y +y −z +z. */
export const SIDE_LOCAL = [
  [0, 2, 4, 6],
  [1, 3, 5, 7],
  [0, 1, 4, 5],
  [2, 3, 6, 7],
  [0, 1, 2, 3],
  [4, 5, 6, 7],
];

export const SIDE_NORMAL = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

export function lame(E, nu) {
  const mu = E / (2 * (1 + nu));
  const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  return { lambda, mu };
}

/** Row-major 6×6 isotropic elasticity, engineering shear. */
export function materialC(E, nu) {
  const { lambda, mu } = lame(E, nu);
  const diag = lambda + 2 * mu;
  const C = new Float64Array(36);
  C[0] = diag;
  C[1] = lambda;
  C[2] = lambda;
  C[6] = lambda;
  C[7] = diag;
  C[8] = lambda;
  C[12] = lambda;
  C[13] = lambda;
  C[14] = diag;
  C[21] = mu;
  C[28] = mu;
  C[35] = mu;
  return C;
}

export function vonMises(stress) {
  const xx = stress[0];
  const yy = stress[1];
  const zz = stress[2];
  const xy = stress[3];
  const yz = stress[4];
  const zx = stress[5];
  const a = xx - yy;
  const b = yy - zz;
  const c = zz - xx;
  return Math.sqrt(0.5 * (a * a + b * b + c * c) + 3 * (xy * xy + yz * yz + zx * zx));
}

function shapeDerivs(xi, eta, zeta, hx, hy, hz, out) {
  const invX = 2 / hx;
  const invY = 2 / hy;
  const invZ = 2 / hz;
  for (let a = 0; a < 8; a += 1) {
    const sx = SIGNS[a][0];
    const sy = SIGNS[a][1];
    const sz = SIGNS[a][2];
    const dxi = 0.125 * sx * (1 + eta * sy) * (1 + zeta * sz);
    const deta = 0.125 * sy * (1 + xi * sx) * (1 + zeta * sz);
    const dzeta = 0.125 * sz * (1 + xi * sx) * (1 + eta * sy);
    out[a] = dxi * invX;
    out[8 + a] = deta * invY;
    out[16 + a] = dzeta * invZ;
  }
  return out;
}

function accumulateKe(Ke, dN, C, weight) {
  const CB = new Float64Array(144);
  for (let a = 0; a < 8; a += 1) {
    const dx = dN[a];
    const dy = dN[8 + a];
    const dz = dN[16 + a];
    const columns = [
      [dx, 0, 0, dy, 0, dz],
      [0, dy, 0, dx, dz, 0],
      [0, 0, dz, 0, dy, dx],
    ];
    for (let col = 0; col < 3; col += 1) {
      const Bc = columns[col];
      const dof = a * 3 + col;
      for (let row = 0; row < 6; row += 1) {
        let sum = 0;
        const crow = row * 6;
        for (let k = 0; k < 6; k += 1) sum += C[crow + k] * Bc[k];
        CB[row * 24 + dof] = sum;
      }
    }
  }
  for (let a = 0; a < 8; a += 1) {
    const dx = dN[a];
    const dy = dN[8 + a];
    const dz = dN[16 + a];
    const rows = [
      [dx, 0, 0, dy, 0, dz],
      [0, dy, 0, dx, dz, 0],
      [0, 0, dz, 0, dy, dx],
    ];
    for (let iLocal = 0; iLocal < 3; iLocal += 1) {
      const Bi = rows[iLocal];
      const row = a * 3 + iLocal;
      const krow = row * 24;
      for (let col = 0; col < 24; col += 1) {
        let sum = 0;
        for (let k = 0; k < 6; k += 1) sum += Bi[k] * CB[k * 24 + col];
        Ke[krow + col] += weight * sum;
      }
    }
  }
}

/**
 * 24×24 element stiffness, row-major. `shear` is `full` (2×2×2) or
 * `reduced` (shear strains at the element centre, the locking fix).
 */
export function buildHexKe(hx, hy, hz, E, nu, shear = 'full') {
  const C = materialC(E, nu);
  const Ke = new Float64Array(576);
  const dN = new Float64Array(24);
  const weight = (hx * hy * hz) / 8;
  const points = [-GAUSS, GAUSS];
  for (const xi of points) {
    for (const eta of points) {
      for (const zeta of points) {
        shapeDerivs(xi, eta, zeta, hx, hy, hz, dN);
        if (shear === 'full') {
          accumulateKe(Ke, dN, C, weight);
        } else {
          accumulateSplit(Ke, dN, C, weight, xi, eta, zeta, hx, hy, hz);
        }
      }
    }
  }
  return Ke;
}

/**
 * Normal strains stay at the 2×2×2 points. Shear uses the centre value,
 * added once, so the caller must invoke this only from the full loop and
 * we gate the shear add on the first Gauss point.
 */
function accumulateSplit(Ke, dN, C, weight, xi, eta, zeta, hx, hy, hz) {
  const normal = materialCFrom(C, false);
  accumulateKe(Ke, dN, normal, weight);
  const first = xi < 0 && eta < 0 && zeta < 0;
  if (!first) return;
  const shear = materialCFrom(C, true);
  const centre = new Float64Array(24);
  shapeDerivs(0, 0, 0, hx, hy, hz, centre);
  accumulateKe(Ke, centre, shear, hx * hy * hz);
}

function materialCFrom(C, shearOnly) {
  const out = new Float64Array(36);
  if (shearOnly) {
    out[21] = C[21];
    out[28] = C[28];
    out[35] = C[35];
  } else {
    out.set(C.subarray(0, 15));
  }
  return out;
}

/** Engineering stress at a parametric point. `ue` is 24 displacements. */
export function stressAt(hx, hy, hz, C, xi, eta, zeta, ue) {
  const dN = new Float64Array(24);
  shapeDerivs(xi, eta, zeta, hx, hy, hz, dN);
  const strain = new Float64Array(6);
  for (let a = 0; a < 8; a += 1) {
    const dx = dN[a];
    const dy = dN[8 + a];
    const dz = dN[16 + a];
    const ux = ue[a * 3];
    const uy = ue[a * 3 + 1];
    const uz = ue[a * 3 + 2];
    strain[0] += dx * ux;
    strain[1] += dy * uy;
    strain[2] += dz * uz;
    strain[3] += dy * ux + dx * uy;
    strain[4] += dz * uy + dy * uz;
    strain[5] += dz * ux + dx * uz;
  }
  const stress = new Float64Array(6);
  for (let row = 0; row < 6; row += 1) {
    let sum = 0;
    const crow = row * 6;
    for (let k = 0; k < 6; k += 1) sum += C[crow + k] * strain[k];
    stress[row] = sum;
  }
  return stress;
}

export function cellNodeIndex(i, j, k, nxp, nyp) {
  return i + nxp * (j + nyp * k);
}

export function sideArea(side, hx, hy, hz) {
  if (side <= 1) return hy * hz;
  if (side <= 3) return hx * hz;
  return hx * hy;
}
