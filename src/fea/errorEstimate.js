/**
 * Zienkiewicz–Zhu recovery estimate for a TET10 mesh, and the sizing
 * field that the next fTetWild pass consumes.
 *
 * Element stress is the mean of the four Gauss-point stresses. Recovered
 * stress is the volume-weighted nodal average of those element stresses,
 * averaged back onto the element. The indicator is the energy norm of the
 * difference. The global relative error is
 * sqrt(Σ ||σ* − σ_h||²) / sqrt(Σ ||σ*||²). A patch test (constant stress)
 * is zero because the recovered field and the element field match.
 *
 * The sizing field is a background tet mesh of the current corners. A
 * high local error shortens the edge; a low one lengthens it. fTetWild
 * reads the vertex values as absolute edge lengths.
 */

import { DOFS_PER_CELL } from './deviceProfile.js';

export const ERROR_TARGET = 0.1;
export const CONVERGENCE_FRACTION = 0.05;

/** Quadratic elements: energy-norm error is O(h²), so the exponent is 1/2. */
export const SIZE_RATE = 2;
export const SIZE_SHRINK = 0.5;
export const SIZE_GROW = 2;

const GAUSS_SQRT5 = Math.sqrt(5);
const GAUSS_ALPHA = (5 + 3 * GAUSS_SQRT5) / 20;
const GAUSS_BETA = (5 - GAUSS_SQRT5) / 20;
const GAUSS_WEIGHT = 1 / 24;
const GAUSS = [
  [GAUSS_BETA, GAUSS_BETA, GAUSS_BETA],
  [GAUSS_ALPHA, GAUSS_BETA, GAUSS_BETA],
  [GAUSS_BETA, GAUSS_ALPHA, GAUSS_BETA],
  [GAUSS_BETA, GAUSS_BETA, GAUSS_ALPHA],
];
const CORNER_EDGES = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];

function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function nodeAt(nodes, index) {
  return [nodes[index * 3], nodes[index * 3 + 1], nodes[index * 3 + 2]];
}

function dshape(l1, l2, l3) {
  const l0 = 1 - l1 - l2 - l3;
  const d0 = -(4 * l0 - 1);
  return [
    [d0, d0, d0],
    [4 * l1 - 1, 0, 0],
    [0, 4 * l2 - 1, 0],
    [0, 0, 4 * l3 - 1],
    [4 * (l0 - l1), -4 * l1, -4 * l1],
    [4 * l2, 4 * l1, 0],
    [-4 * l2, 4 * (l0 - l2), -4 * l2],
    [-4 * l3, -4 * l3, 4 * (l0 - l3)],
    [4 * l3, 0, 4 * l1],
    [0, 4 * l3, 4 * l2],
  ];
}

function gradients(xyz, l1, l2, l3) {
  const dn = dshape(l1, l2, l3);
  const jac = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let a = 0; a < 10; a += 1) {
    for (let row = 0; row < 3; row += 1) {
      jac[row][0] += dn[a][0] * xyz[a][row];
      jac[row][1] += dn[a][1] * xyz[a][row];
      jac[row][2] += dn[a][2] * xyz[a][row];
    }
  }
  const det = jac[0][0] * (jac[1][1] * jac[2][2] - jac[1][2] * jac[2][1])
    - jac[0][1] * (jac[1][0] * jac[2][2] - jac[1][2] * jac[2][0])
    + jac[0][2] * (jac[1][0] * jac[2][1] - jac[1][1] * jac[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  const invDet = 1 / det;
  const inv = [
    [
      (jac[1][1] * jac[2][2] - jac[1][2] * jac[2][1]) * invDet,
      (jac[0][2] * jac[2][1] - jac[0][1] * jac[2][2]) * invDet,
      (jac[0][1] * jac[1][2] - jac[0][2] * jac[1][1]) * invDet,
    ],
    [
      (jac[1][2] * jac[2][0] - jac[1][0] * jac[2][2]) * invDet,
      (jac[0][0] * jac[2][2] - jac[0][2] * jac[2][0]) * invDet,
      (jac[0][2] * jac[1][0] - jac[0][0] * jac[1][2]) * invDet,
    ],
    [
      (jac[1][0] * jac[2][1] - jac[1][1] * jac[2][0]) * invDet,
      (jac[0][1] * jac[2][0] - jac[0][0] * jac[2][1]) * invDet,
      (jac[0][0] * jac[1][1] - jac[0][1] * jac[1][0]) * invDet,
    ],
  ];
  const grad = [];
  for (let a = 0; a < 10; a += 1) {
    grad.push([
      inv[0][0] * dn[a][0] + inv[1][0] * dn[a][1] + inv[2][0] * dn[a][2],
      inv[0][1] * dn[a][0] + inv[1][1] * dn[a][1] + inv[2][1] * dn[a][2],
      inv[0][2] * dn[a][0] + inv[1][2] * dn[a][1] + inv[2][2] * dn[a][2],
    ]);
  }
  return { grad, det };
}

function elasticity(E, nu) {
  const lam = E * nu / ((1 + nu) * (1 - 2 * nu));
  const mu = E / (2 * (1 + nu));
  const diag = lam + 2 * mu;
  const c = new Float64Array(36);
  c[0] = diag;
  c[1] = lam;
  c[2] = lam;
  c[6] = lam;
  c[7] = diag;
  c[8] = lam;
  c[12] = lam;
  c[13] = lam;
  c[14] = diag;
  c[21] = mu;
  c[28] = mu;
  c[35] = mu;
  return c;
}

/** σ : C⁻¹ : σ, with engineering shear. */
function energyDensity(stress, E, nu) {
  const invE = 1 / E;
  const mu = E / (2 * (1 + nu));
  const ex = invE * (stress[0] - nu * (stress[1] + stress[2]));
  const ey = invE * (stress[1] - nu * (stress[0] + stress[2]));
  const ez = invE * (stress[2] - nu * (stress[0] + stress[1]));
  return stress[0] * ex + stress[1] * ey + stress[2] * ez
    + (stress[3] * stress[3] + stress[4] * stress[4] + stress[5] * stress[5]) / mu;
}

function gaussStresses(xyz, displacement, elem, c) {
  const ue = new Float64Array(30);
  for (let a = 0; a < 10; a += 1) {
    const base = elem[a] * 3;
    ue[a * 3] = displacement[base];
    ue[a * 3 + 1] = displacement[base + 1];
    ue[a * 3 + 2] = displacement[base + 2];
  }
  const out = [];
  let volume = 0;
  for (let g = 0; g < 4; g += 1) {
    const sample = gradients(xyz, GAUSS[g][0], GAUSS[g][1], GAUSS[g][2]);
    if (!sample || !(sample.det > 0)) return null;
    volume += sample.det * GAUSS_WEIGHT;
    const strain = [0, 0, 0, 0, 0, 0];
    for (let a = 0; a < 10; a += 1) {
      const dx = sample.grad[a][0];
      const dy = sample.grad[a][1];
      const dz = sample.grad[a][2];
      const u = ue[a * 3];
      const v = ue[a * 3 + 1];
      const w = ue[a * 3 + 2];
      strain[0] += dx * u;
      strain[1] += dy * v;
      strain[2] += dz * w;
      strain[3] += dy * u + dx * v;
      strain[4] += dz * v + dy * w;
      strain[5] += dz * u + dx * w;
    }
    const stress = [0, 0, 0, 0, 0, 0];
    for (let s = 0; s < 6; s += 1) {
      let acc = 0;
      for (let t = 0; t < 6; t += 1) acc += c[s * 6 + t] * strain[t];
      stress[s] = acc;
    }
    out.push(stress);
  }
  return { stresses: out, volume };
}

function emptyEstimate(nElem) {
  return {
    errEst: 0,
    elementError: new Float64Array(nElem),
    elementVolume: new Float64Array(nElem),
  };
}

/**
 * Global relative error in the energy norm, plus one relative indicator
 * per element (`||e|| / ||σ*||` on that element, 0 when the element carries
 * no stress).
 */
export function recoveryEstimate({ nodes, elements, displacement, material }) {
  const nElem = elements && elements.length ? Math.floor(elements.length / 10) : 0;
  const nNode = nodes && nodes.length ? Math.floor(nodes.length / 3) : 0;
  if (!nElem || !nNode || !displacement || displacement.length < nNode * 3) return emptyEstimate(nElem);
  const E = Number(material && material.E_MPa);
  const nu = Number(material && material.nu);
  if (!(E > 0) || !Number.isFinite(nu) || nu < 0 || nu >= 0.5) return emptyEstimate(nElem);

  const c = elasticity(E, nu);
  const elementStress = new Float64Array(nElem * 6);
  const elementVolume = new Float64Array(nElem);
  const nodal = new Float64Array(nNode * 6);
  const weight = new Float64Array(nNode);
  const live = new Uint8Array(nElem);

  for (let e = 0; e < nElem; e += 1) {
    const elem = [];
    const xyz = [];
    let inside = true;
    for (let a = 0; a < 10; a += 1) {
      const id = elements[e * 10 + a];
      if (id >= nNode) {
        inside = false;
        break;
      }
      elem.push(id);
      xyz.push(nodeAt(nodes, id));
    }
    if (!inside) continue;
    const gauss = gaussStresses(xyz, displacement, elem, c);
    if (!gauss || !(gauss.volume > 0)) continue;
    live[e] = 1;
    elementVolume[e] = gauss.volume;
    for (let s = 0; s < 6; s += 1) {
      let mean = 0;
      for (let g = 0; g < 4; g += 1) mean += gauss.stresses[g][s];
      mean /= 4;
      elementStress[e * 6 + s] = mean;
    }
    for (let a = 0; a < 10; a += 1) {
      const id = elem[a];
      weight[id] += gauss.volume;
      for (let s = 0; s < 6; s += 1) nodal[id * 6 + s] += elementStress[e * 6 + s] * gauss.volume;
    }
  }

  for (let i = 0; i < nNode; i += 1) {
    if (!(weight[i] > 0)) continue;
    const scale = weight[i];
    for (let s = 0; s < 6; s += 1) nodal[i * 6 + s] /= scale;
  }

  let err2 = 0;
  let rec2 = 0;
  const elementError = new Float64Array(nElem);
  const diff = [0, 0, 0, 0, 0, 0];
  const recovered = [0, 0, 0, 0, 0, 0];
  for (let e = 0; e < nElem; e += 1) {
    if (!live[e]) continue;
    for (let s = 0; s < 6; s += 1) recovered[s] = 0;
    for (let a = 0; a < 10; a += 1) {
      const id = elements[e * 10 + a];
      for (let s = 0; s < 6; s += 1) recovered[s] += nodal[id * 6 + s];
    }
    for (let s = 0; s < 6; s += 1) {
      recovered[s] /= 10;
      diff[s] = recovered[s] - elementStress[e * 6 + s];
    }
    const vol = elementVolume[e];
    const eDens = energyDensity(diff, E, nu);
    const sDens = energyDensity(recovered, E, nu);
    const e2 = Math.max(0, eDens) * vol;
    const s2 = Math.max(0, sDens) * vol;
    err2 += e2;
    rec2 += s2;
    elementError[e] = s2 > 0 ? Math.sqrt(e2 / s2) : 0;
  }
  const errEst = rec2 > 0 ? Math.sqrt(err2 / rec2) : 0;
  return {
    errEst: Number.isFinite(errEst) ? errEst : 0,
    elementError,
    elementVolume,
  };
}

function edgeLengthOf(nodes, a, b) {
  const ax = nodes[a * 3];
  const ay = nodes[a * 3 + 1];
  const az = nodes[a * 3 + 2];
  return Math.hypot(nodes[b * 3] - ax, nodes[b * 3 + 1] - ay, nodes[b * 3 + 2] - az);
}

function meanCornerEdge(nodes, elements, e) {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < CORNER_EDGES.length; k += 1) {
    const a = elements[e * 10 + CORNER_EDGES[k][0]];
    const b = elements[e * 10 + CORNER_EDGES[k][1]];
    const length = edgeLengthOf(nodes, a, b);
    if (length > 0) {
      sum += length;
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

function tetVolume(nodes, a, b, c, d) {
  const abx = nodes[b * 3] - nodes[a * 3];
  const aby = nodes[b * 3 + 1] - nodes[a * 3 + 1];
  const abz = nodes[b * 3 + 2] - nodes[a * 3 + 2];
  const acx = nodes[c * 3] - nodes[a * 3];
  const acy = nodes[c * 3 + 1] - nodes[a * 3 + 1];
  const acz = nodes[c * 3 + 2] - nodes[a * 3 + 2];
  const adx = nodes[d * 3] - nodes[a * 3];
  const ady = nodes[d * 3 + 1] - nodes[a * 3 + 1];
  const adz = nodes[d * 3 + 2] - nodes[a * 3 + 2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return Math.abs(adx * cx + ady * cy + adz * cz) / 6;
}

/**
 * Background sizing mesh. `elementError` is the per-element relative
 * indicator from `recoveryEstimate`. Edges shrink where that indicator is
 * above `target` and grow where it is below. `cap` is a DOF ceiling: the
 * field is scaled up until the estimate fits. `uncappedDofs` is that
 * estimate before the scale, so a caller can refuse the pass instead.
 */
export function sizingFromError({
  nodes,
  elements,
  elementError,
  baseEdge = 1,
  target = ERROR_TARGET,
  cap = Infinity,
  dofsPerCell = DOFS_PER_CELL,
} = {}) {
  const nElem = elements && elements.length ? Math.floor(elements.length / 10) : 0;
  const nNode = nodes && nodes.length ? Math.floor(nodes.length / 3) : 0;
  const fallback = baseEdge > 0 ? baseEdge : 1;
  const elemH = new Float64Array(nElem);
  for (let e = 0; e < nElem; e += 1) {
    const current = meanCornerEdge(nodes, elements, e) || fallback;
    const rel = elementError && e < elementError.length ? Number(elementError[e]) : 0;
    const ratio = target > 0 && rel > 0 ? rel / target : 0;
    let factor = ratio > 0 ? ratio ** (-1 / SIZE_RATE) : SIZE_GROW;
    if (!Number.isFinite(factor) || factor <= 0) factor = SIZE_GROW;
    factor = clamp(factor, SIZE_SHRINK, SIZE_GROW);
    elemH[e] = current * factor;
  }

  const remap = new Int32Array(nNode);
  remap.fill(-1);
  const positions = [];
  const values = [];
  const tets = [];
  let estimatedVolume = 0;
  for (let e = 0; e < nElem; e += 1) {
    const corners = [
      elements[e * 10],
      elements[e * 10 + 1],
      elements[e * 10 + 2],
      elements[e * 10 + 3],
    ];
    if (corners.some((id) => id >= nNode)) continue;
    const local = [];
    for (let k = 0; k < 4; k += 1) {
      const id = corners[k];
      let mapped = remap[id];
      if (mapped < 0) {
        mapped = values.length;
        remap[id] = mapped;
        positions.push(nodes[id * 3], nodes[id * 3 + 1], nodes[id * 3 + 2]);
        values.push(Infinity);
      }
      if (elemH[e] < values[mapped]) values[mapped] = elemH[e];
      local.push(mapped);
    }
    const vol = tetVolume(nodes, corners[0], corners[1], corners[2], corners[3]);
    if (vol > 0 && nodeAt(nodes, corners[1]) && tetVolume(nodes, corners[0], corners[1], corners[2], corners[3]) > 0) {
      const signed = signedVolume(nodes, corners[0], corners[1], corners[2], corners[3]);
      if (signed < 0) {
        const swap = local[0];
        local[0] = local[1];
        local[1] = swap;
      }
    }
    estimatedVolume += vol;
    tets.push(local[0], local[1], local[2], local[3]);
  }
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i]) || !(values[i] > 0)) values[i] = fallback;
  }

  let cells = 0;
  const nBg = tets.length / 4;
  for (let t = 0; t < nBg; t += 1) {
    const ids = [tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]];
    const h = (values[ids[0]] + values[ids[1]] + values[ids[2]] + values[ids[3]]) / 4;
    const vol = Math.abs(signedVolumeFlat(positions, ids[0], ids[1], ids[2], ids[3]));
    if (h > 0 && vol > 0) cells += vol / (h * h * h);
  }
  let estimated = (dofsPerCell > 0 ? dofsPerCell : DOFS_PER_CELL) * cells;
  const uncappedDofs = estimated;
  let edgeScale = 1;
  if (Number.isFinite(cap) && cap > 0 && estimated > cap) {
    edgeScale = Math.cbrt(estimated / cap);
    for (let i = 0; i < values.length; i += 1) values[i] *= edgeScale;
    estimated = cap;
  }
  let edgeLength = 0;
  let shortest = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > edgeLength) edgeLength = values[i];
    if (values[i] < shortest) shortest = values[i];
  }
  if (!(edgeLength > 0)) edgeLength = fallback;
  const shrunk = values.some((value, index) => {
    const id = remap.indexOf(index);
    if (id < 0) return false;
    let current = Infinity;
    for (let e = 0; e < nElem; e += 1) {
      for (let k = 0; k < 4; k += 1) {
        if (elements[e * 10 + k] !== id) continue;
        const edge = meanCornerEdge(nodes, elements, e);
        if (edge > 0 && edge < current) current = edge;
      }
    }
    return Number.isFinite(current) && value < current * 0.98;
  });
  return {
    positions: Float64Array.from(positions),
    tets: Uint32Array.from(tets),
    values: Float64Array.from(values),
    edgeLength,
    shortest: Number.isFinite(shortest) ? shortest : fallback,
    estimatedDofs: estimated,
    uncappedDofs,
    edgeScale,
    canRefine: shrunk && tets.length >= 4,
    volume: estimatedVolume,
  };
}

function signedVolume(nodes, a, b, c, d) {
  const abx = nodes[b * 3] - nodes[a * 3];
  const aby = nodes[b * 3 + 1] - nodes[a * 3 + 1];
  const abz = nodes[b * 3 + 2] - nodes[a * 3 + 2];
  const acx = nodes[c * 3] - nodes[a * 3];
  const acy = nodes[c * 3 + 1] - nodes[a * 3 + 1];
  const acz = nodes[c * 3 + 2] - nodes[a * 3 + 2];
  const adx = nodes[d * 3] - nodes[a * 3];
  const ady = nodes[d * 3 + 1] - nodes[a * 3 + 1];
  const adz = nodes[d * 3 + 2] - nodes[a * 3 + 2];
  return (adx * (aby * acz - abz * acy) + ady * (abz * acx - abx * acz) + adz * (abx * acy - aby * acx)) / 6;
}

function signedVolumeFlat(positions, a, b, c, d) {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3] - ax;
  const by = positions[b * 3 + 1] - ay;
  const bz = positions[b * 3 + 2] - az;
  const cx = positions[c * 3] - ax;
  const cy = positions[c * 3 + 1] - ay;
  const cz = positions[c * 3 + 2] - az;
  const dx = positions[d * 3] - ax;
  const dy = positions[d * 3 + 1] - ay;
  const dz = positions[d * 3 + 2] - az;
  return (dx * (by * cz - bz * cy) + dy * (bz * cx - bx * cz) + dz * (bx * cy - by * cx)) / 6;
}

/** Relative change in p95 between two passes. Infinite when the previous p95 is 0. */
export function p95Change(previous, next) {
  const prev = Number(previous);
  const value = Number(next);
  if (!(Math.abs(prev) > 0) || !Number.isFinite(value)) return Infinity;
  return Math.abs(value - prev) / Math.abs(prev);
}

/** True when the last two passes moved p95 by less than 5%. */
export function convergedOn(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const prev = rows[rows.length - 2];
  const last = rows[rows.length - 1];
  return p95Change(prev && prev.p95, last && last.p95) < CONVERGENCE_FRACTION;
}

export function scaleConvergence(rows, ratio) {
  if (!Array.isArray(rows)) return [];
  const scale = Number(ratio);
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return rows.map((row) => ({
    pass: row.pass,
    dof: row.dof,
    p95: row.p95,
    max: row.max,
    umax: row.umax == null ? null : row.umax * factor,
    errEst: row.errEst,
  }));
}
