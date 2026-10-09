/**
 * Voxel stress preview.
 *
 * The solid is an occupancy grid with faceIDs on boundary sides. A face
 * id reused on a disconnected wall keeps the connected patch nearest the
 * stored point (`nearestPatch`, the same rule as the TET10 match). 8-node
 * hexes are solved by CG, preconditioned with f32-style geometric
 * multigrid (the JS reference uses f64 accumulation; the GPU path stores
 * the same Ke as f32). The returned nodal array is von Mises in MPa on the
 * render vertices, which is what the stress skin already keys by faceID.
 * This result is not a safety factor. `safetyFactor` is always null.
 */

import { nearestPatch } from '../boundaryConditions.js';
import { fieldRange } from '../stressSample.js';
import { SIDE_LOCAL, SIDE_NORMAL, materialC, sideArea, stressAt, vonMises } from './hexElement.js';
import { buildHierarchy, levelBytes, pcg } from './multigrid.js';
import { padGrid, voxelizeSolid } from './voxelize.js';

function idsOf(faces) {
  const ids = new Set();
  for (const face of faces || []) {
    const id = Number(face?.faceID);
    if (Number.isInteger(id) && id >= 0) ids.add(id);
    if (Array.isArray(face?.triangleFaceIDs)) {
      for (const extra of face.triangleFaceIDs) {
        const n = Number(extra);
        if (Number.isInteger(n) && n >= 0) ids.add(n);
      }
    }
  }
  return ids;
}

function cellCoords(cell, nx, ny) {
  const i = cell % nx;
  const t = (cell / nx) | 0;
  const j = t % ny;
  const k = (t / ny) | 0;
  return [i, j, k];
}

function sideNodes(grid, cell, side) {
  const [i, j, k] = cellCoords(cell, grid.nx, grid.ny);
  const nxp = grid.nx + 1;
  const nyp = grid.ny + 1;
  const n0 = i + nxp * (j + nyp * k);
  const sj = nxp;
  const sk = nxp * nyp;
  const all = [
    n0,
    n0 + 1,
    n0 + sj,
    n0 + 1 + sj,
    n0 + sk,
    n0 + 1 + sk,
    n0 + sj + sk,
    n0 + 1 + sj + sk,
  ];
  return SIDE_LOCAL[side].map((local) => all[local]);
}

function nodePoint(grid, node) {
  const nxp = grid.nx + 1;
  const nyp = grid.ny + 1;
  const i = node % nxp;
  const t = (node / nxp) | 0;
  const j = t % nyp;
  const k = (t / nyp) | 0;
  return [
    grid.origin[0] + i * grid.hx,
    grid.origin[1] + j * grid.hy,
    grid.origin[2] + k * grid.hz,
  ];
}

function sideRecord(grid, cell, side) {
  const nodes = sideNodes(grid, cell, side);
  const xyz = new Array(nodes.length);
  const centroid = [0, 0, 0];
  for (let n = 0; n < nodes.length; n += 1) {
    const point = nodePoint(grid, nodes[n]);
    xyz[n] = point;
    centroid[0] += point[0];
    centroid[1] += point[1];
    centroid[2] += point[2];
  }
  const scale = nodes.length || 1;
  centroid[0] /= scale;
  centroid[1] /= scale;
  centroid[2] /= scale;
  return {
    cell,
    side,
    ids: nodes,
    xyz,
    centroid,
    area: sideArea(side, grid.hx, grid.hy, grid.hz),
  };
}

/** Exposed sides grouped by the Manifold face id painted onto them. */
function boundaryByFace(grid) {
  const byId = new Map();
  const { nx, ny, nz, faceSide, occupancy } = grid;
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const cell = i + nx * (j + ny * k);
        if (!occupancy[cell]) continue;
        const base = cell * 6;
        for (let side = 0; side < 6; side += 1) {
          const face = faceSide[base + side];
          if (face < 0) continue;
          let list = byId.get(face);
          if (!list) {
            list = [];
            byId.set(face, list);
          }
          list.push(sideRecord(grid, cell, side));
        }
      }
    }
  }
  return byId;
}

/**
 * Sides for these picks. A face id reused on a disconnected wall is cut
 * down to the connected patch nearest the stored point, the same rule as
 * the TET10 match.
 */
function patchSides(byId, faces) {
  const chosen = [];
  const seen = new Set();
  for (const pick of faces || []) {
    const ids = idsOf([pick]);
    let listed = [];
    for (const id of ids) {
      const group = byId.get(id);
      if (group) listed = listed.concat(group);
    }
    const patch = Array.isArray(pick?.at) ? nearestPatch(listed, pick.at) : listed;
    for (let i = 0; i < patch.length; i += 1) {
      const hit = patch[i];
      const key = hit.cell * 6 + hit.side;
      if (seen.has(key)) continue;
      seen.add(key);
      chosen.push(hit);
    }
  }
  return chosen;
}

function addSideForce(rhs, fixed, nodes, fx, fy, fz) {
  for (let n = 0; n < nodes.length; n += 1) {
    if (fixed[nodes[n]]) continue;
    const at = nodes[n] * 3;
    rhs[at] += fx;
    rhs[at + 1] += fy;
    rhs[at + 2] += fz;
  }
}

export function assemblePreviewBCs(grid, study) {
  const nodeCount = (grid.nx + 1) * (grid.ny + 1) * (grid.nz + 1);
  const fixed = new Uint8Array(nodeCount);
  const byId = boundaryByFace(grid);
  const fixtureFaces = [];
  for (const fixture of study?.fixtures || []) {
    for (const face of fixture.faces || []) fixtureFaces.push(face);
  }
  const fixtureSides = patchSides(byId, fixtureFaces);
  for (let s = 0; s < fixtureSides.length; s += 1) {
    const nodes = fixtureSides[s].ids;
    for (let n = 0; n < nodes.length; n += 1) fixed[nodes[n]] = 1;
  }
  let fixedCount = 0;
  for (let i = 0; i < fixed.length; i += 1) fixedCount += fixed[i];
  if (!fixedCount) throw new Error('Fix a face before previewing the study.');

  const rhs = new Float64Array(nodeCount * 3);
  const loads = study?.loads || [];
  for (const load of loads) {
    const sides = patchSides(byId, load.faces);
    if (load.kind === 'pressure') {
      const pressure = Number(load.pressure_MPa);
      if (!Number.isFinite(pressure) || pressure === 0) continue;
      for (let s = 0; s < sides.length; s += 1) {
        const hit = sides[s];
        const share = (-pressure * hit.area) / 4;
        const normal = SIDE_NORMAL[hit.side];
        addSideForce(rhs, fixed, hit.ids, share * normal[0], share * normal[1], share * normal[2]);
      }
      continue;
    }
    const vector = load.vector || [0, 0, 0];
    let area = 0;
    for (let s = 0; s < sides.length; s += 1) area += sides[s].area;
    if (!(area > 0) || !sides.length) {
      throw new Error('A loaded face did not land on the voxel grid.');
    }
    for (let s = 0; s < sides.length; s += 1) {
      const hit = sides[s];
      const share = hit.area / area / 4;
      addSideForce(rhs, fixed, hit.ids, vector[0] * share, vector[1] * share, vector[2] * share);
    }
  }
  return { fixed, rhs, fixedCount };
}

function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function solidCellAt(grid, x, y, z) {
  const { nx, ny, nz, hx, hy, hz, origin, occupancy } = grid;
  const boxNx = grid.boxNx || nx;
  const boxNy = grid.boxNy || ny;
  const boxNz = grid.boxNz || nz;
  const probe = (px, py, pz) => {
    const i = clamp(Math.floor((px - origin[0]) / hx), 0, boxNx - 1);
    const j = clamp(Math.floor((py - origin[1]) / hy), 0, boxNy - 1);
    const k = clamp(Math.floor((pz - origin[2]) / hz), 0, boxNz - 1);
    const cell = i + nx * (j + ny * k);
    return occupancy[cell] ? cell : -1;
  };
  const direct = probe(x, y, z);
  if (direct >= 0) return direct;
  for (let radius = 1; radius <= 3; radius += 1) {
    for (let dk = -radius; dk <= radius; dk += 1) {
      for (let dj = -radius; dj <= radius; dj += 1) {
        for (let di = -radius; di <= radius; di += 1) {
          const hit = probe(x + di * hx, y + dj * hy, z + dk * hz);
          if (hit >= 0) return hit;
        }
      }
    }
  }
  return -1;
}

function gatherUe(grid, u, cell) {
  const [i, j, k] = cellCoords(cell, grid.nx, grid.ny);
  const nxp = grid.nx + 1;
  const nyp = grid.ny + 1;
  const n0 = i + nxp * (j + nyp * k);
  const sj = nxp;
  const sk = nxp * nyp;
  const nodes = [
    n0,
    n0 + 1,
    n0 + sj,
    n0 + 1 + sj,
    n0 + sk,
    n0 + 1 + sk,
    n0 + sj + sk,
    n0 + 1 + sj + sk,
  ];
  const ue = new Float64Array(24);
  for (let a = 0; a < 8; a += 1) {
    const at = nodes[a] * 3;
    ue[a * 3] = u[at];
    ue[a * 3 + 1] = u[at + 1];
    ue[a * 3 + 2] = u[at + 2];
  }
  return ue;
}

export function sampleVonMisesAt(grid, u, C, points) {
  const out = new Float64Array(points.length / 3);
  const { hx, hy, hz, origin } = grid;
  for (let p = 0; p < out.length; p += 1) {
    const x = points[p * 3];
    const y = points[p * 3 + 1];
    const z = points[p * 3 + 2];
    const cell = solidCellAt(grid, x, y, z);
    if (cell < 0) {
      out[p] = NaN;
      continue;
    }
    const [i, j, k] = cellCoords(cell, grid.nx, grid.ny);
    const xi = clamp((2 * (x - origin[0] - i * hx)) / hx - 1, -1, 1);
    const eta = clamp((2 * (y - origin[1] - j * hy)) / hy - 1, -1, 1);
    const zeta = clamp((2 * (z - origin[2] - k * hz)) / hz - 1, -1, 1);
    const stress = stressAt(hx, hy, hz, C, xi, eta, zeta, gatherUe(grid, u, cell));
    out[p] = vonMises(stress);
  }
  return out;
}

/**
 * Voxelize, pad, and build the hierarchy unless the caller kept them.
 * `u0` is copied when it matches the dof count. The GPU path uses the
 * same context and only replaces the CG.
 */
export function prepareVoxelPreview({
  positions,
  indices,
  faceIDs,
  study,
  material,
  resolution,
  u0 = null,
  shear = 'full',
  grid = null,
  op = null,
}) {
  const E = Number(material?.E_MPa);
  const nu = Number(material?.nu);
  if (!(E > 0) || !(nu >= 0) || !(nu < 0.5)) throw new Error('Preview needs a modulus and a Poisson ratio.');
  const built = padGrid(grid || voxelizeSolid(positions, indices, faceIDs, resolution));
  const bcs = assemblePreviewBCs(built, study);
  const operator = op || buildHierarchy({
    occupancy: built.occupancy,
    nx: built.nx,
    ny: built.ny,
    nz: built.nz,
    hx: built.hx,
    hy: built.hy,
    hz: built.hz,
    fixed: bcs.fixed,
    E,
    nu,
    shear,
  });
  const u = new Float64Array(operator.nodeCount * 3);
  if (u0 && u0.length === u.length) u.set(u0);
  return { built, operator, rhs: bcs.rhs, u, E, nu, resolution, positions, shear };
}

/** Sample von Mises onto the render vertices. `safetyFactor` stays null. */
export function finishVoxelPreview(ctx, solved, started) {
  const C = materialC(ctx.E, ctx.nu);
  const sampled = sampleVonMisesAt(ctx.built, ctx.u, C, ctx.positions);
  const nodal = Float32Array.from(sampled);
  const range = fieldRange(nodal);
  const built = ctx.built;
  return {
    source: 'preview',
    field: 'von_mises',
    units: 'MPa',
    nodal,
    min: range.min,
    max: range.max,
    p95: range.p95,
    safetyFactor: null,
    u: ctx.u,
    grid: built,
    op: ctx.operator,
    iterations: solved.iterations,
    residual: solved.residual,
    residual0: solved.residual0,
    history: solved.history,
    bytes: solved.gpuBytes || levelBytes(ctx.operator),
    jsBytes: levelBytes(ctx.operator),
    ms: Date.now() - started,
    resolution: ctx.resolution,
    nx: built.boxNx || built.nx,
    ny: built.boxNy || built.ny,
    nz: built.boxNz || built.nz,
    padded: [built.nx, built.ny, built.nz],
    shear: ctx.shear,
    fast: false,
  };
}

/**
 * Solve the preview. `u0`, when the same length as the grid dofs, is the
 * warm start. The displacement is returned on `u` for the next drag.
 */
export function solveVoxelPreview({
  tol = 1e-4,
  maxIter = 40,
  ...args
}) {
  const ctx = prepareVoxelPreview(args);
  const started = Date.now();
  const solved = pcg(ctx.operator, ctx.rhs, ctx.u, { tol, maxIter });
  return finishVoxelPreview(ctx, solved, started);
}
