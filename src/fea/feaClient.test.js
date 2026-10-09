import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { effectiveMaterial } from './materials.js';
import { packMesh } from './meshTransfer.js';

const wasmUrl = new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);
const wasmBytes = await readFile(wasmUrl);
const init = fea.default ?? fea.init;
await init({ module_or_path: wasmBytes });

const aluminum = { E_MPa: 68900, nu: 0.33, yield_MPa: 276 };

function mesh({ positions, indices = new Uint32Array(), faceIDs = new Uint32Array() }) {
  return { positions, indices, faceIDs };
}

describe('surfcad-fea wasm', { concurrency: 1 }, () => {
test('capabilities describes the single-threaded simd stub', () => {
  const caps = fea.capabilities();
  assert.equal(caps.version, '0.1.0');
  assert.deepEqual(caps.solvers, ['stub']);
  assert.equal(caps.simd, true);
  assert.equal(caps.threads, false);
  assert.deepEqual(caps.maxDofs, { phone: 48000, desktop: 300000 });
});

test('the committed wasm contains simd128 operations', () => {
  // Prefix 0xFD. wasm-opt rewrites the explicit f32x4.add; v128.load (FD 00)
  // and v128.store (FD 0B) stay, and a scalar build of this crate does not emit them.
  let found = false;
  for (let i = 0; i < wasmBytes.length - 1; i++) {
    if (wasmBytes[i] === 0xfd && (wasmBytes[i + 1] === 0x00 || wasmBytes[i + 1] === 0x0b)) {
      found = true;
      break;
    }
  }
  assert.equal(found, true);
});

test('solve returns a stub von Mises field with p95 and safetyFactor', () => {
  const positions = new Float32Array([
    0, 0, 0,
    0, 0, 10,
    0, 0, 20,
    0, 0, 30,
  ]);
  const indices = new Uint32Array([0, 1, 2]);
  const faceIDs = new Uint32Array([4]);
  const study = {
    loads: [{ kind: 'force', vector: [0, 0, -200], faces: [{ at: [0, 0, 30], area: 100 }] }],
  };
  const result = fea.solve(study, positions, indices, faceIDs, aluminum, 'desktop');
  assert.equal(result.source, 'stub');
  assert.equal(result.field, 'von_mises');
  assert.equal(result.units, 'MPa');
  assert.ok(result.nodal instanceof Float32Array);
  assert.equal(result.nodal.length, 4);
  assert.deepEqual(Array.from(result.nodal), [0, 20, 40, 60]);
  assert.equal(result.min, 0);
  assert.equal(result.max, 60);
  assert.equal(result.p95, nearestRankP95(result.nodal));
  assert.equal(result.p95, 60);
  assert.equal(result.safetyFactor, aluminum.yield_MPa / result.p95);
  assert.equal(result.fos, result.safetyFactor);
  assert.equal(result.stats.vertices, 4);
  assert.equal(result.stats.triangles, 1);
  assert.equal(result.stats.dofs, 12);
  assert.equal(typeof result.stats.ms, 'number');
  assert.ok(result.warnings.some((warning) => warning.code === 'stub' && /STUB, not a real result/.test(warning.msg)));

  const again = fea.solve(study, positions, indices, faceIDs, aluminum, 'phone');
  assert.deepEqual(Array.from(again.nodal), Array.from(result.nodal));
});

test('fixture distance and material aliases stay deterministic', () => {
  const positions = new Float32Array([0, 0, 0, 3, 4, 0]);
  const study = { fixtures: [{ kind: 'fixed', faces: [{ at: [0, 0, 0], n: [0, 0, -1], area: 400 }] }] };
  const canonical = fea.solve(study, positions, new Uint32Array(), new Uint32Array(), aluminum, 'desktop');
  const alias = fea.solve(
    study,
    positions,
    new Uint32Array(),
    new Uint32Array(),
    { E: 68900, nu: 0.33, yield: 276 },
    'desktop',
  );
  assert.deepEqual(Array.from(canonical.nodal), [0, 5]);
  assert.deepEqual(Array.from(alias.nodal), [0, 5]);
  assert.equal(canonical.p95, 5);
  assert.equal(canonical.safetyFactor, 276 / 5);
  assert.equal(alias.safetyFactor, canonical.safetyFactor);
});

test('a null yield leaves the safety factor null and does not throw', () => {
  const pa12 = effectiveMaterial('pa12-hp-mjf');
  assert.equal(pa12.yield_MPa, null);
  assert.equal(pa12.nu, 0.39);
  const positions = new Float32Array([0, 0, 0, 0, 0, 10]);
  const result = fea.solve(
    null,
    positions,
    new Uint32Array(),
    new Uint32Array(),
    { E_MPa: pa12.E_MPa, nu: pa12.nu, yield_MPa: pa12.yield_MPa },
    'desktop',
  );
  assert.ok(result.p95 > 0);
  assert.equal(result.safetyFactor, null);
  assert.equal(result.fos, null);
  assert.ok(result.warnings.some((warning) => warning.code === 'missing-yield'));

  const omitted = fea.solve(
    null,
    positions,
    new Uint32Array(),
    new Uint32Array(),
    { E_MPa: pa12.E_MPa, nu: pa12.nu },
    'desktop',
  );
  assert.equal(omitted.safetyFactor, null);
  assert.ok(omitted.warnings.some((warning) => warning.code === 'missing-yield'));
});

test('an empty mesh is still labeled as a stub', () => {
  const result = fea.solve(
    null,
    new Float32Array(),
    new Uint32Array(),
    new Uint32Array(),
    aluminum,
    'phone',
  );
  assert.equal(result.source, 'stub');
  assert.equal(result.nodal.length, 0);
  assert.equal(result.p95, 0);
  assert.equal(result.safetyFactor, null);
  assert.equal(result.min, 0);
  assert.equal(result.max, 0);
  assert.ok(result.warnings.some((warning) => warning.code === 'empty-mesh'));
});

test('bad profile and a pending cancel reject', async () => {
  await assert.rejects(
    async () => {
      fea.solve(null, new Float32Array(3), new Uint32Array(), new Uint32Array(), aluminum, 'tablet');
    },
    /profile/,
  );
  fea.cancel();
  await assert.rejects(
    async () => {
      fea.solve(null, new Float32Array(), new Uint32Array(), new Uint32Array(), aluminum, 'desktop');
    },
    /cancelled/,
  );
  fea.dispose();
  const after = fea.solve(null, new Float32Array(), new Uint32Array(), new Uint32Array(), aluminum, 'desktop');
  assert.equal(after.source, 'stub');
});

test('packMesh transfers owned buffers and copies shared ones', () => {
  const positions = new Float32Array([0, 0, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const faceIDs = new Uint32Array([9]);
  const packed = packMesh(mesh({ positions, indices, faceIDs }));
  assert.equal(packed.positions, positions);
  assert.deepEqual(packed.transfer, [positions.buffer, indices.buffer, faceIDs.buffer]);

  const shared = new ArrayBuffer(32);
  const viewPositions = new Float32Array(shared, 0, 3);
  const viewIndices = new Uint32Array(shared, 16, 3);
  const copied = packMesh({
    positions: viewPositions,
    indices: viewIndices,
    faceID: new Uint32Array([1]),
  });
  assert.notEqual(copied.positions.buffer, shared);
  assert.notEqual(copied.indices.buffer, shared);
  assert.notEqual(copied.positions.buffer, copied.indices.buffer);
  assert.equal(shared.byteLength, 32);
  assert.deepEqual(Array.from(copied.positions), Array.from(viewPositions));
});
});

function nearestRankP95(values) {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}
