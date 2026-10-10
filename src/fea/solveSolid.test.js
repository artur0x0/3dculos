import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { boundaryConditions } from './boundaryConditions.js';
import { ERROR_TARGET, p95Change, recoveryEstimate, sizingFromError } from './errorEstimate.js';
import { box, plateWithHole } from './meshShapes.js';
import { meshVolume } from './meshVolume.js';
import { solveSolid } from './solveSolid.js';
import { formatSolveSummary } from './studyPanel.js';

const wasmUrl = new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);
const initFea = fea.default ?? fea.init;
await initFea({ module_or_path: await readFile(wasmUrl) });

const pla = { E_MPa: 3250, nu: 0.36, yield_MPa: 52.5 };

function beamStudy(force, model = 'solid') {
  return {
    model,
    mesh: { target: 4, refine: 'off' },
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

describe('solveSolid', { concurrency: 1 }, () => {
test('a 40x10x10 cantilever is within 10% of beam theory', { timeout: 180_000 }, async () => {
  const length = 40;
  const width = 10;
  const height = 10;
  const force = 200;
  const surface = box([length, width, height]);
  const theory = (force * length * (height / 2)) / (width * height ** 3 / 12);
  assert.equal(theory, 48);

  const result = await solveSolid({
    study: beamStudy(force),
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: pla,
    profile: 'desktop',
    solveTet10: fea.solve_tet10,
    solveStub: fea.solve,
    meshVolume,
  });

  assert.equal(result.source, 'tet10');
  assert.equal(result.solver, 'cholesky');
  assert.equal(result.shells, true);
  assert.equal(result.nodal instanceof Float32Array, true);
  assert.equal(result.nodal.length, surface.positions.length / 3);
  const error = Math.abs(result.max - theory) / theory;
  assert.ok(error <= 0.1, `max ${result.max} MPa vs beam theory ${theory} MPa (${(100 * error).toFixed(2)}%)`);
  const inertia = width * height ** 3 / 12;
  const tip = (force * length ** 3) / (3 * pla.E_MPa * inertia);
  assert.equal(result.displacement instanceof Float32Array, true);
  assert.equal(result.displacement.length, surface.positions.length / 3);
  const dispError = Math.abs(result.displacementMax - tip) / tip;
  assert.ok(
    dispError <= 0.1,
    `displacement max ${result.displacementMax} mm vs beam theory ${tip} mm (${(100 * dispError).toFixed(2)}%)`,
  );
  assert.ok(result.displacementMin >= 0 && result.displacementMin < result.displacementMax);
  assert.ok(result.p95 > 0 && result.p95 <= result.max);
  assert.ok(Math.abs(result.safetyFactor - (pla.yield_MPa / result.p95)) < 1e-6);
  assert.equal(result.stats.edgeLength, 4);
  assert.ok(result.stats.ms >= 0);
  assert.equal(result.warnings.some((warning) => warning.code === 'stub'), false);
  assert.equal(result.warnings.some((warning) => warning.code === 'mesh-coarse'), false);
  const summary = formatSolveSummary(result);
  assert.equal(summary.stub, false);
  assert.doesNotMatch(summary.warning, /STUB/);
  console.log(`cantilever max ${result.max} p95 ${result.p95} ms ${result.stats.ms} dofs ${result.stats.dofs}`);
});

test('a modal cantilever returns frequencies and ignores the load', { timeout: 180_000 }, async () => {
  const surface = box([40, 10, 10]);
  const result = await solveSolid({
    study: { ...beamStudy(200), type: 'modal' },
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: { ...pla, density_kg_m3: 1240 },
    profile: 'desktop',
    solveTet10: fea.solve_tet10,
    modalTet10: fea.modal_tet10,
    solveStub: fea.solve,
    meshVolume,
  });
  assert.equal(result.source, 'modal');
  assert.equal(result.field, 'mode');
  assert.equal(result.solver, 'lobpcg');
  assert.equal(result.rescaled, false);
  assert.ok(result.frequenciesHz.length >= 1);
  assert.ok(result.frequenciesHz[0] > 1, `first frequency ${result.frequenciesHz[0]}`);
  assert.equal(result.displacement.length, surface.positions.length / 3);
  assert.equal(result.modeMagnitudes.length, result.frequenciesHz.length * result.displacement.length);
  assert.equal(result.modeVectors.length, result.modeMagnitudes.length * 3);
  assert.ok(result.warnings.some((warning) => warning.code === 'modal-loads'));
  assert.ok(result.effectiveMass.length >= 3);
});

test('a shell study on a non-sheet solid falls back to TET10', { timeout: 180_000 }, async () => {
  const surface = box([40, 10, 10]);
  const result = await solveSolid({
    study: beamStudy(200, 'shell'),
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: pla,
    profile: 'desktop',
    solveTet10: fea.solve_tet10,
    solveStub: fea.solve,
    meshVolume,
  });
  assert.equal(result.source, 'tet10');
  assert.ok(result.warnings.some((warning) => warning.code === 'shell-heuristic-deferred'));
});

test('fallback stub keeps the placeholder source', async () => {
  const surface = box([40, 10, 10]);
  const result = await solveSolid({
    study: beamStudy(200),
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: pla,
    profile: 'desktop',
    fallback: 'stub',
    solveTet10: () => { throw new Error('tet10 should not run'); },
    solveStub: fea.solve,
  });
  assert.equal(result.source, 'stub');
  assert.equal(formatSolveSummary(result).stub, true);
});

test('a phone cap coarsens an edge that would exceed it', async () => {
  const surface = box([20, 20, 20]);
  let seen = 0;
  await assert.rejects(() => solveSolid({
    study: {
      model: 'solid',
      mesh: { target: 0.2 },
      fixtures: [{ kind: 'fixed', faces: [{ faceID: 1 }] }],
    },
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: pla,
    profile: 'phone',
    solveTet10: () => { throw new Error('should not solve'); },
    solveStub: fea.solve,
    meshVolume: async (_, options) => {
      seen = options.edgeLength;
      throw new Error('stop after the edge choice');
    },
  }), /stop after the edge choice/);
  assert.ok(seen > 0.2, `edge ${seen}`);
});

function hotSpotMesh(dofs) {
  const tets = [
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]],
  ];
  const map = new Map();
  const coords = [];
  const elements = [];
  const idOf = (point) => {
    const key = point.map((value) => value.toFixed(9)).join(',');
    if (map.has(key)) return map.get(key);
    const id = coords.length / 3;
    map.set(key, id);
    coords.push(point[0], point[1], point[2]);
    return id;
  };
  for (const corners of tets) {
    const ids = corners.map(idOf);
    const pairs = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
    const mids = pairs.map(([a, b]) => idOf([
      (corners[a][0] + corners[b][0]) / 2,
      (corners[a][1] + corners[b][1]) / 2,
      (corners[a][2] + corners[b][2]) / 2,
    ]));
    elements.push(...ids, ...mids);
  }
  const displacement = new Float64Array(coords.length);
  for (let i = 0; i < coords.length / 3; i += 1) {
    const x = coords[i * 3];
    displacement[i * 3] = 0.001 * x * x;
  }
  return {
    nodes: Float64Array.from(coords),
    elements: Uint32Array.from(elements),
    faces: Uint32Array.from([0, 1, 2, 4, 5, 6]),
    faceIds: Uint32Array.from([1]),
    stats: { dofs, elements: 2, ms: 1, wasmBytes: 0 },
    displacement,
  };
}

function hotSpotSolve(mesh) {
  return {
    nodal: new Float64Array(mesh.nodes.length / 3),
    displacement: mesh.displacement,
    min: 0,
    max: 1,
    p95: 1,
    safetyFactor: 1,
    solver: 'cholesky',
    warnings: [],
    stats: { dofs: mesh.stats.dofs, freeDofs: mesh.stats.dofs, iterations: 0, residual: 0, solveMs: 1 },
  };
}

test('a phone remesh over 40k DOF is dropped and the previous result is kept', async () => {
  const seen = [];
  const solves = [];
  const result = await solveSolid({
    study: { ...beamStudy(200), loads: [], mesh: { target: 4, refine: 'auto' } },
    positions: box([40, 10, 10]).positions,
    indices: box([40, 10, 10]).indices,
    faceIDs: box([40, 10, 10]).faceIds,
    material: pla,
    profile: 'phone',
    solveTet10: () => {
      const dofs = seen[seen.length - 1];
      solves.push(dofs);
      return hotSpotSolve(hotSpotMesh(dofs));
    },
    solveStub: fea.solve,
    meshVolume: async () => {
      const dofs = seen.length === 0 ? 1_200 : 80_000;
      seen.push(dofs);
      return hotSpotMesh(dofs);
    },
  });
  assert.deepEqual(seen, [1_200, 80_000]);
  assert.deepEqual(solves, [1_200]);
  assert.equal(result.stats.dofs, 1_200);
  assert.equal(result.refineCount, 0);
  assert.equal(result.convergence.length, 1);
  assert.equal(result.refineNote, 'Refinement stopped at phone limit (40k DOF)');
});

test('a phone remesh under 40k DOF is kept, and desktop keeps a mesh over that cap', async () => {
  async function run(profile, second) {
    const seen = [];
    const solves = [];
    const result = await solveSolid({
      study: { ...beamStudy(200), loads: [], mesh: { target: 4, refine: 'auto' } },
      positions: box([40, 10, 10]).positions,
      indices: box([40, 10, 10]).indices,
      faceIDs: box([40, 10, 10]).faceIds,
      material: pla,
      profile,
      solveTet10: () => {
        const dofs = seen[seen.length - 1];
        solves.push(dofs);
        return hotSpotSolve(hotSpotMesh(dofs));
      },
      solveStub: fea.solve,
      meshVolume: async () => {
        const dofs = seen.length === 0 ? 1_200 : second;
        seen.push(dofs);
        return hotSpotMesh(dofs);
      },
    });
    return { seen, solves, result };
  }

  const phone = await run('phone', 20_000);
  assert.deepEqual(phone.seen, [1_200, 20_000]);
  assert.deepEqual(phone.solves, [1_200, 20_000]);
  assert.equal(phone.result.stats.dofs, 20_000);
  assert.equal(phone.result.refineCount, 1);
  assert.equal(phone.result.refineNote, '');

  const desktop = await run('desktop', 80_000);
  assert.deepEqual(desktop.seen, [1_200, 80_000]);
  assert.deepEqual(desktop.solves, [1_200, 80_000]);
  assert.equal(desktop.result.stats.dofs, 80_000);
  assert.equal(desktop.result.refineNote, '');
});

test('progress walks load, mesh, assemble, solve, and post-processing', async () => {
  const surface = box([40, 10, 10]);
  const stages = [];
  const result = await solveSolid({
    study: beamStudy(200),
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: pla,
    profile: 'desktop',
    onProgress: (event) => stages.push(event.stage),
    solveTet10: () => ({
      nodal: new Float64Array(8),
      min: 0,
      max: 1,
      p95: 1,
      safetyFactor: 1,
      solver: 'cholesky',
      warnings: [],
      stats: { dofs: 36, freeDofs: 30, iterations: 0, residual: 0, solveMs: 4 },
    }),
    solveStub: fea.solve,
    meshVolume: async () => ({
      nodes: new Float64Array([
        0, 0, 0, 0, 10, 0, 0, 0, 10, 0, 5, 5, 0, 5, 0, 0, 0, 5,
        40, 0, 0, 40, 10, 0, 40, 0, 10, 40, 5, 5, 40, 5, 0, 40, 0, 5,
      ]),
      elements: new Uint32Array(10),
      faces: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      faceIds: new Uint32Array([1, 2]),
      stats: { dofs: 36, elements: 1, ms: 12, wasmBytes: 0 },
    }),
  });
  const seen = stages.filter((stage, index) => stage !== stages[index - 1]);
  assert.deepEqual(seen, ['loading-mesher', 'meshing', 'assembling', 'solving', 'post-processing']);
  assert.equal(result.stageTimings.meshing >= 0, true);
  assert.equal(result.stageTimings.solving >= 0, true);
  assert.equal(result.stats.dofs, 36);
});

test('missing yield leaves the safety factor null', async () => {
  const surface = box([40, 10, 10]);
  let yieldSeen = 'unset';
  const result = await solveSolid({
    study: beamStudy(200),
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: { E_MPa: 3250, nu: 0.36, yield_MPa: null },
    profile: 'desktop',
    solveTet10: (_, material) => {
      yieldSeen = material.yield_MPa;
      return {
        source: 'fem',
        nodal: new Float64Array(8),
        min: 0,
        max: 1,
        p95: 1,
        safetyFactor: null,
        solver: 'pcg',
        warnings: [{ code: 'missing-yield', msg: 'No yield strength, so the safety factor is n/a.' }],
        stats: { dofs: 1, freeDofs: 1, solveMs: 1 },
      };
    },
    solveStub: fea.solve,
    meshVolume: async () => ({
      nodes: new Float64Array([
        0, 0, 0, 0, 10, 0, 0, 0, 10, 0, 5, 5, 0, 5, 0, 0, 0, 5,
        40, 0, 0, 40, 10, 0, 40, 0, 10, 40, 5, 5, 40, 5, 0, 40, 0, 5,
      ]),
      elements: new Uint32Array(10),
      faces: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      faceIds: new Uint32Array([1, 2]),
      stats: { dofs: 36, elements: 1, ms: 1, wasmBytes: 0 },
    }),
  });
  assert.equal(yieldSeen, null);
  assert.equal(result.safetyFactor, null);
  assert.ok(result.warnings.some((warning) => warning.code === 'missing-yield'));
});

test('a cantilever root stress converges when refine is auto', { timeout: 300_000 }, async () => {
  const surface = box([40, 10, 10]);
  const result = await solveSolid({
    study: { ...beamStudy(200), mesh: { target: 4, refine: 'auto' } },
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    material: pla,
    profile: 'desktop',
    solveTet10: fea.solve_tet10,
    solveStub: fea.solve,
    meshVolume,
  });
  assert.ok(result.convergence.length >= 2, JSON.stringify(result.convergence));
  for (let i = 0; i < result.convergence.length; i += 1) {
    const row = result.convergence[i];
    const change = i === 0 ? null : p95Change(result.convergence[i - 1].p95, row.p95);
    console.log(
      `cantilever pass ${row.pass} dof ${row.dof} p95 ${Number(row.p95).toFixed(3)} max ${Number(row.max).toFixed(3)} umax ${row.umax == null ? 'n/a' : Number(row.umax).toFixed(4)} err ${Number(row.errEst).toFixed(4)}`
      + (change == null ? '' : ` dp95 ${(change * 100).toFixed(2)}%`),
    );
    assert.equal(row.pass, i + 1);
    assert.ok(row.dof > 0);
    assert.ok(Number.isFinite(row.p95) && Number.isFinite(row.max) && Number.isFinite(row.errEst));
  }
  const lastChange = p95Change(result.convergence.at(-2).p95, result.convergence.at(-1).p95);
  const theory = 48;
  console.log(`cantilever converged ${result.converged} refined ${result.refineCount}x final max ${result.max.toFixed(3)} p95 ${result.p95.toFixed(3)} err ${Number(result.errEst).toFixed(4)} dp95 ${(lastChange * 100).toFixed(2)}% ms ${result.stats.ms}`);
  assert.equal(result.refineCount, result.convergence.length - 1);
  assert.ok(result.refineCount >= 1);
  assert.ok(result.errEst < result.convergence[0].errEst, `err ${result.errEst} vs ${result.convergence[0].errEst}`);
  assert.ok(result.errEst <= 0.1, `errEst ${result.errEst}`);
  assert.ok(result.p95 > 20 && result.p95 < theory * 1.25, `p95 ${result.p95}`);
  assert.equal(result.converged, lastChange < 0.05);
});

test('plate with a hole drops its energy error and stays near Kt = 3', { timeout: 180_000 }, async () => {
  const width = 70;
  const depth = 36;
  const thickness = 4;
  const radius = 4;
  const remote = 100;
  const force = remote * depth * thickness;
  const raw = plateWithHole(width, depth, thickness, radius, 16);
  const surface = splitPlateFaces(raw, width, depth, thickness, radius);
  const study = {
    fixtures: [{
      kind: 'fixed',
      faces: [{ faceID: 3, at: [0, depth / 2, thickness / 2], n: [-1, 0, 0], area: depth * thickness }],
    }],
    loads: [{
      kind: 'force',
      vector: [force, 0, 0],
      faces: [{ faceID: 5, at: [width, depth / 2, thickness / 2], n: [1, 0, 0], area: depth * thickness }],
    }],
  };
  const material = { E_MPa: 210000, nu: 0.3, yield_MPa: 250 };
  const kts = [];
  let edge = 14;
  let sizing = null;
  let mesh = null;
  for (let pass = 1; pass <= 3; pass += 1) {
    mesh = await meshVolume(surface, {
      edgeLength: sizing ? sizing.edgeLength : edge,
      epsilon: 1e-3,
      sizing: sizing || undefined,
    });
    const bcs = boundaryConditions(mesh, study, { diagonal: Math.hypot(width, depth, thickness) });
    const solved = fea.solve_tet10(
      { nodes: mesh.nodes, elements: mesh.elements },
      material,
      { fixedNodes: bcs.fixedNodes, forceNodes: bcs.forceNodes, forceValues: bcs.forceValues },
      { solver: 'cholesky' },
    );
    const estimate = recoveryEstimate({
      nodes: mesh.nodes,
      elements: mesh.elements,
      displacement: solved.displacement,
      material,
    });
    const kt = holeKtVolume(mesh.nodes, solved.nodal, width, depth, radius, remote);
    kts.push({ ...kt, errEst: estimate.errEst, dof: mesh.stats.dofs });
    console.log(`plate pass ${pass} dof ${mesh.stats.dofs} Kt ${kt.kt.toFixed(3)} peak ${kt.peak.toFixed(1)} err ${estimate.errEst.toFixed(4)}`);
    if (pass > 1 && estimate.errEst <= ERROR_TARGET) break;
    sizing = sizingFromError({
      nodes: mesh.nodes,
      elements: mesh.elements,
      elementError: estimate.elementError,
      baseEdge: edge,
      cap: 200000,
    });
    if (!sizing.canRefine) break;
    edge = sizing.edgeLength;
  }
  assert.ok(kts.length >= 2, 'the coarse hole mesh should refine');
  const coarse = kts[0];
  const refined = kts[kts.length - 1];
  const coarseDist = Math.abs(coarse.kt - 3);
  const refinedDist = Math.abs(refined.kt - 3);
  console.log(
    `plate Kt coarse ${coarse.kt.toFixed(3)} (dist ${coarseDist.toFixed(3)}) refined ${refined.kt.toFixed(3)} (dist ${refinedDist.toFixed(3)}) `
    + `err ${coarse.errEst.toFixed(4)} -> ${refined.errEst.toFixed(4)}`,
  );
  assert.ok(coarse.hits > 0 && refined.hits > 0);
  // fTetWild shuffles insertion order with std::random_device (face order,
  // and Geogram's BRIO shuffle). Parameters has no seed. not_sort_input
  // skips only the face shuffle, and the BRIO shuffle still moves the node
  // at the hole equator. Thirty runs of this test spanned refined Kt
  // 2.574..3.255, so "strictly closer to 3 than 2.79" fails when a remesh
  // lands farther out even while the energy-norm estimate falls. Refinement
  // guarantees the estimate drops, and the refined Kt stays near 3.
  assert.ok(refined.errEst < coarse.errEst, `err ${refined.errEst} vs ${coarse.errEst}`);
  assert.ok(refinedDist <= 0.5, `|Kt-3| ${refinedDist} Kt ${refined.kt}`);
  for (const row of kts) {
    assert.ok(row.kt > 2.4 && row.kt < 3.6, `Kt ${row.kt} dof ${row.dof}`);
  }
});
});

function splitPlateFaces(surface, width, depth, thickness, radius) {
  const { positions, indices } = surface;
  const faceIds = new Uint32Array(indices.length / 3);
  const cx = width / 2;
  const cy = depth / 2;
  for (let t = 0; t < faceIds.length; t += 1) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const bx = positions[ib * 3];
    const by = positions[ib * 3 + 1];
    const bz = positions[ib * 3 + 2];
    const cpx = positions[ic * 3];
    const cpy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];
    const x = (ax + bx + cpx) / 3;
    const y = (ay + by + cpy) / 3;
    const z = (az + bz + cz) / 3;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cpy - ay);
    const ny = (bz - az) * (cpx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cpy - ay) - (by - ay) * (cpx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    if (Math.abs(nz / len) > 0.7) faceIds[t] = z < thickness * 0.5 ? 1 : 2;
    else if (Math.hypot(x - cx, y - cy) < radius * 1.5) faceIds[t] = 4;
    else if (x < width * 0.08) faceIds[t] = 3;
    else if (x > width * 0.92) faceIds[t] = 5;
    else if (y < depth * 0.08) faceIds[t] = 6;
    else faceIds[t] = 7;
  }
  return { positions, indices, faceIds };
}

function holeKtVolume(nodes, nodal, width, depth, radius, remote) {
  const cx = width / 2;
  const cy = depth / 2;
  const targets = [[cx, cy + radius], [cx, cy - radius]];
  let peak = 0;
  let hits = 0;
  for (let t = 0; t < targets.length; t += 1) {
    let best = Infinity;
    let stress = 0;
    for (let i = 0; i < nodal.length; i += 1) {
      const dist = Math.hypot(nodes[i * 3] - targets[t][0], nodes[i * 3 + 1] - targets[t][1]);
      if (dist < best) {
        best = dist;
        stress = nodal[i];
      }
    }
    if (best < radius) {
      hits += 1;
      if (stress > peak) peak = stress;
    }
  }
  return { kt: peak / remote, peak, hits };
}
