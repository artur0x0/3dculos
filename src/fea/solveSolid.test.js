import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { box } from './meshShapes.js';
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
    mesh: { target: 4 },
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
  assert.equal(result.shells, false);
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

test('a shell study warns and still solves TET10', { timeout: 180_000 }, async () => {
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
  assert.ok(result.warnings.some((warning) => warning.code === 'shell-unsupported'));
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
});
