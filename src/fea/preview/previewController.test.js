import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultStudy } from '../studySchema.js';
import { runSafetyFactor, studyWithLoadVector } from '../studyPanel.js';
import { angleFromVector, sliderFromLoad, studyForPreview, vectorFromAngle } from './loadDrag.js';
import { createPreviewController, uniformLoadScale } from './previewController.js';
import { PREVIEW_WGSL } from './previewShader.js';
import { previewFits } from './resolution.js';

const face = { faceID: 2, at: [40, 5, 5], n: [1, 0, 0], area: 100 };

function study(force = [0, 0, -200]) {
  return {
    material: { id: 'pla-ultimaker' },
    fixtures: [{ kind: 'fixed', faces: [{ faceID: 1, at: [0, 5, 5], n: [-1, 0, 0], area: 100 }] }],
    loads: [{ kind: 'force', vector: force, faces: [face] }],
  };
}

test('direction angle round-trips in the face plane', () => {
  const normal = [1, 0, 0];
  const vector = vectorFromAngle(normal, 200, 35);
  assert.ok(Math.abs(vector[0]) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...vector) - 200) < 1e-9);
  const again = vectorFromAngle(normal, 200, angleFromVector(normal, vector));
  assert.ok(Math.abs(again[1] - vector[1]) < 1e-6);
  assert.ok(Math.abs(again[2] - vector[2]) < 1e-6);
});

test('a load vector edit validates and keeps the other loads', () => {
  const base = defaultStudy(study());
  const next = studyWithLoadVector(base, 0, [0, -40, -190]);
  assert.equal(next.ok, true);
  assert.deepEqual(next.study.loads[0].vector, [0, -40, -190]);
  assert.equal(next.study.fixtures.length, 1);
});

test('preview safety factor is the last TET10 run', () => {
  assert.equal(runSafetyFactor({ source: 'preview', safetyFactor: 3, p95: 10, yield_MPa: 50 }), null);
  assert.equal(runSafetyFactor({ source: 'tet10', safetyFactor: 1.25 }), 1.25);
  assert.equal(runSafetyFactor(null), null);
});

test('uniform load scale rejects a direction change', () => {
  assert.equal(uniformLoadScale(study([0, 0, -200]), study([0, 0, -300])), 1.5);
  assert.equal(uniformLoadScale(study([0, 0, -200]), study([0, -40, -190])), null);
});

test('slider study keeps the selected force in the tangent plane', () => {
  const next = studyForPreview(study(), { loadIndex: 0, magnitude: 100, angle: 90, materialId: 'pla-ultimaker' });
  assert.equal(next.loads[0].vector[0], 0);
  assert.ok(Math.abs(Math.hypot(...next.loads[0].vector) - 100) < 1e-9);
  const slider = sliderFromLoad(next, 0, ['pla-ultimaker']);
  assert.equal(slider.hasForce, true);
  assert.equal(slider.materialIndex, 0);
  assert.ok(Math.abs(slider.angle - 90) < 1e-6);
});

test('drag frames coalesce and a stale solve is dropped', async () => {
  const frames = [];
  const solves = [];
  const results = [];
  const controller = createPreviewController({
    profile: 'phone',
    fits: () => false,
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: (id) => {
      frames[id - 1] = null;
    },
    solve: (job) => new Promise((resolve) => {
      solves.push({ job, resolve });
    }),
    onResult: (result) => results.push(result),
  });
  const box = { dx: 40, dy: 10, dz: 10 };
  controller.push({ ...studyJob(200), bbox: box });
  controller.push({ ...studyJob(240), bbox: box });
  assert.equal(frames.length, 1);
  frames[0]();
  await Promise.resolve();
  assert.equal(solves.length, 1);
  assert.equal(solves[0].job.resolution, 64);
  assert.equal(solves[0].job.study.loads[0].vector[2], -240);
  controller.push({ ...studyJob(260), bbox: box });
  frames[1]();
  await Promise.resolve();
  solves[0].resolve(solved(10));
  await flush();
  assert.equal(solves.length, 2);
  solves[1].resolve(solved(11));
  await flush();
  assert.equal(results.length, 1);
  assert.equal(results[0].nodal[0], 11);
});

test('a magnitude drag scales the last preview without another solve', async () => {
  const frames = [];
  let calls = 0;
  const results = [];
  const controller = createPreviewController({
    profile: 'desktop',
    fits: () => true,
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
    solve: async (job) => {
      calls += 1;
      assert.equal(job.resolution, calls === 1 ? 64 : 128);
      return solved(10);
    },
    onResult: (result) => results.push(result),
  });
  controller.push(studyJob(200));
  frames[0]();
  await flush();
  controller.push(studyJob(300));
  frames[1]();
  await flush();
  assert.equal(calls, 1);
  assert.equal(results.length, 2);
  assert.equal(results[1].fast, true);
  assert.equal(results[1].iterations, 0);
  assert.equal(results[1].nodal[0], 15);
  assert.equal(results[1].p95, 15);
  const release = controller.flush(studyJob(300));
  await release;
  assert.equal(calls, 2);
});

test('WGSL exposes the matrix-free kernels', () => {
  for (const name of ['fn matvec', 'fn jacobi', 'fn restrict', 'fn prolongAdd', 'fn axpy', 'fn dotPartial']) {
    assert.equal(PREVIEW_WGSL.includes(name), true, name);
  }
});

test('128 is rejected when the node vector exceeds the buffer limit', () => {
  assert.equal(previewFits(40, 10, 10, 128, {
    maxStorageBufferBindingSize: 1024,
    maxBufferSize: 1024,
  }), false);
  assert.equal(previewFits(40, 10, 10, 128, {
    maxStorageBufferBindingSize: 256 * 1024 * 1024,
    maxBufferSize: 256 * 1024 * 1024,
  }), true);
});

function studyJob(force) {
  return {
    positions: new Float32Array([0, 0, 0, 40, 10, 10]),
    study: study([0, 0, -force]),
    material: { E_MPa: 3250, nu: 0.36, yield_MPa: 52.5 },
    bbox: { dx: 40, dy: 10, dz: 10 },
  };
}

function solved(value) {
  return {
    source: 'preview',
    nodal: Float32Array.from([value]),
    u: Float64Array.from([value]),
    min: value,
    max: value,
    p95: value,
    safetyFactor: null,
    grid: { tag: 'grid' },
    op: { tag: 'op', ke: new Float64Array(1), diag: new Float64Array(3), fixed: new Uint8Array(1), nodeCount: 1, E: 3250, coarser: null },
    bytes: 128,
    nx: 64,
    ny: 16,
    nz: 16,
    padded: [64, 16, 16],
    iterations: 4,
    ms: 12,
  };
}

function flush() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
