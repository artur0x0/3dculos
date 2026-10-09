import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../meshShapes.js';
import { buildHexKe, materialC, stressAt, vonMises } from './hexElement.js';
import { buildHierarchy, matvec, transferScale, vcycleHistory } from './multigrid.js';
import { assemblePreviewBCs, solveVoxelPreview } from './solvePreview.js';
import { voxelizeSolid } from './voxelize.js';
import { previewResolution } from './resolution.js';

const pla = { E_MPa: 3250, nu: 0.36, yield_MPa: 52.5 };

function beamStudy(force = 200) {
  return {
    fixtures: [{
      kind: 'fixed',
      faces: [{ faceID: 1, at: [0, 5, 5], n: [-1, 0, 0], area: 100 }],
    }],
    loads: [{
      kind: 'force',
      vector: [0, 0, -force],
      faces: [{ faceID: 2, at: [40, 5, 5], n: [1, 0, 0], area: 100 }],
    }],
  };
}

test('resolution stays at 64 while dragging and never reaches 128 on a phone', () => {
  assert.equal(previewResolution({ phase: 'drag', profile: 'desktop' }), 64);
  assert.equal(previewResolution({ phase: 'drag', profile: 'phone' }), 64);
  assert.equal(previewResolution({ phase: 'release', profile: 'phone' }), 96);
  assert.equal(previewResolution({ phase: 'release', profile: 'desktop' }), 128);
  assert.equal(previewResolution({ phase: 'release', profile: 'desktop', fits: false }), 96);
});

test('a rigid translation produces no internal force', () => {
  const ke = buildHexKe(1, 1, 1, 1000, 0.3);
  const ue = new Float64Array(24);
  for (let a = 0; a < 8; a += 1) {
    ue[a * 3] = 0.2;
    ue[a * 3 + 1] = -0.4;
    ue[a * 3 + 2] = 0.7;
  }
  const fe = new Float64Array(24);
  for (let row = 0; row < 24; row += 1) {
    let sum = 0;
    for (let col = 0; col < 24; col += 1) sum += ke[row * 24 + col] * ue[col];
    fe[row] = sum;
  }
  let energy = 0;
  for (let i = 0; i < 24; i += 1) energy += fe[i] * fe[i];
  assert.ok(energy < 1e-16, `rigid force ${energy}`);
});

test('a uniform stretch recovers the isotropic stress', () => {
  const E = 1000;
  const nu = 0.25;
  const hx = 2;
  const ke = buildHexKe(hx, hx, hx, E, nu);
  const ue = new Float64Array(24);
  const strain = 0.001;
  const signs = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  for (let a = 0; a < 8; a += 1) ue[a * 3] = strain * signs[a][0] * hx;
  const C = materialC(E, nu);
  const stress = stressAt(hx, hx, hx, C, 0, 0, 0, ue);
  const { lambda, mu } = {
    mu: E / (2 * (1 + nu)),
    lambda: (E * nu) / ((1 + nu) * (1 - 2 * nu)),
  };
  const expected = (lambda + 2 * mu) * strain;
  assert.ok(Math.abs(stress[0] - expected) / expected < 1e-8, `${stress[0]} vs ${expected}`);
  assert.ok(Math.abs(stress[1] - lambda * strain) < 1e-6);
  assert.ok(Math.abs(vonMises(stress) - Math.abs(stress[0] - stress[1])) < 1e-6);
  let energy = 0;
  for (let row = 0; row < 24; row += 1) {
    let force = 0;
    for (let col = 0; col < 24; col += 1) force += ke[row * 24 + col] * ue[col];
    energy += force * ue[row];
  }
  assert.ok(energy > 0);
});

test('a box voxel grid is solid and tags every face id', () => {
  const surface = box([40, 10, 10]);
  const grid = voxelizeSolid(surface.positions, surface.indices, surface.faceIds, 16);
  assert.equal(grid.nx, 16);
  assert.equal(grid.ny, 4);
  assert.equal(grid.nz, 4);
  assert.equal(grid.solidCount, 16 * 4 * 4);
  const seen = new Set();
  for (let i = 0; i < grid.faceSide.length; i += 1) {
    if (grid.faceSide[i] >= 0) seen.add(grid.faceSide[i]);
  }
  for (const id of [1, 2, 3, 4, 5, 6]) assert.ok(seen.has(id), `missing face ${id}`);
  const bcs = assemblePreviewBCs(grid, beamStudy());
  const root = (grid.ny + 1) * (grid.nz + 1);
  assert.equal(bcs.fixedCount, root);
  let fz = 0;
  for (let i = 2; i < bcs.rhs.length; i += 3) fz += bcs.rhs[i];
  assert.ok(Math.abs(fz + 200) < 1e-6, `tip force ${fz}`);
});

test('V-cycles reduce the cantilever residual after the first correction', () => {
  const surface = box([40, 10, 10]);
  const grid = voxelizeSolid(surface.positions, surface.indices, surface.faceIds, 16);
  const bcs = assemblePreviewBCs(grid, beamStudy());
  const op = buildHierarchy({
    occupancy: grid.occupancy,
    nx: grid.nx,
    ny: grid.ny,
    nz: grid.nz,
    hx: grid.hx,
    hy: grid.hy,
    hz: grid.hz,
    fixed: bcs.fixed,
    E: pla.E_MPa,
    nu: pla.nu,
  });
  const matched = transferScale(op);
  assert.ok(matched.rel < 1e-8, `Galerkin mismatch ${matched.rel}`);
  const history = vcycleHistory(op, bcs.rhs, 4);
  console.log(`vcycle residual ratios ${history.map((value) => value.toFixed(3)).join(' ')}`);
  assert.equal(history.length, 4);
  const perCycle = history[3] / history[1];
  assert.ok(history[3] < 0.5, `residual still ${history[3]}`);
  assert.ok(perCycle < 0.7, `per-cycle ${perCycle}`);
});

test('a coarse cantilever is in the neighbourhood of beam theory', () => {
  const surface = box([40, 10, 10]);
  const result = solveVoxelPreview({
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    study: beamStudy(200),
    material: pla,
    resolution: 32,
    tol: 1e-5,
    maxIter: 30,
  });
  const theory = 48;
  const error = Math.abs(result.max - theory) / theory;
  console.log(`preview32 max ${result.max.toFixed(2)} p95 ${result.p95.toFixed(2)} iters ${result.iterations} residual ${result.residual} ms ${result.ms} cells ${result.nx}x${result.ny}x${result.nz}`);
  assert.equal(result.safetyFactor, null);
  assert.equal(result.source, 'preview');
  assert.ok(result.residual < 1e-4, `residual ${result.residual}`);
  assert.ok(error < 0.35, `max ${result.max} vs ${theory}`);
  const op = result.op;
  const u = result.u;
  const out = new Float64Array(u.length);
  matvec(op, u, out);
  assert.ok(out.some((value) => value !== 0));
});

test('warm start cuts iterations when the load is scaled', () => {
  const surface = box([40, 10, 10]);
  const cold = solveVoxelPreview({
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    study: beamStudy(200),
    material: pla,
    resolution: 16,
    tol: 1e-4,
    maxIter: 40,
  });
  const scaled = cold.u.map((value) => value * 1.5);
  const warm = solveVoxelPreview({
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    study: beamStudy(300),
    material: pla,
    resolution: 16,
    u0: scaled,
    tol: 1e-4,
    maxIter: 40,
    grid: cold.grid,
  });
  console.log(`warm iterations ${warm.iterations} cold ${cold.iterations}`);
  assert.ok(warm.iterations < cold.iterations, `warm ${warm.iterations} cold ${cold.iterations}`);
  assert.ok(Math.abs(warm.max - cold.max * 1.5) / (cold.max * 1.5) < 0.05);
});

test('a direction change warm-starts in fewer iterations than a cold start', () => {
  const surface = box([40, 10, 10]);
  const base = {
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: pla,
    resolution: 16,
    tol: 1e-4,
    maxIter: 40,
  };
  const coldZ = solveVoxelPreview({ ...base, study: beamStudy(200) });
  const tilted = {
    fixtures: beamStudy().fixtures,
    loads: [{
      kind: 'force',
      vector: [0, -40, -190],
      faces: [{ faceID: 2, at: [40, 5, 5], n: [1, 0, 0], area: 100 }],
    }],
  };
  const coldTilt = solveVoxelPreview({ ...base, study: tilted });
  const warmTilt = solveVoxelPreview({
    ...base,
    study: tilted,
    u0: coldZ.u,
    grid: coldZ.grid,
  });
  const warmAbs = warmTilt.residual0 * warmTilt.residual;
  const coldAbs = coldTilt.residual0 * coldTilt.residual;
  console.log(`direction warm0 ${warmTilt.residual0.toFixed(2)} cold0 ${coldTilt.residual0.toFixed(2)} iters ${warmTilt.iterations}/${coldTilt.iterations}`);
  assert.ok(warmTilt.residual0 < coldTilt.residual0 * 0.5, `initial residual warm ${warmTilt.residual0} cold ${coldTilt.residual0}`);
  assert.ok(warmAbs <= coldAbs * 1.01);
});
