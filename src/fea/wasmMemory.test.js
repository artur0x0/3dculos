import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  capWasmMemory,
  nextPeakBytes,
  performanceMemoryBytes,
  PHONE_WASM_BYTES,
  wasmMemoryLimits,
  workerMemorySample,
} from './wasmMemory.js';

const FILES = [
  new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url),
  new URL('../../packages/surfcad-mesh/pkg/surfcad_mesh.wasm', import.meta.url),
];

test('phone ceiling is 512 MiB, non-shared, and still a valid module', async () => {
  assert.equal(PHONE_WASM_BYTES, 512 * 1024 * 1024);
  for (const url of FILES) {
    const bytes = new Uint8Array(await readFile(url));
    const original = wasmMemoryLimits(bytes);
    assert.equal(original.shared, false);
    const capped = capWasmMemory(bytes, PHONE_WASM_BYTES);
    const limits = wasmMemoryLimits(capped);
    assert.equal(limits.shared, false);
    assert.equal(limits.minPages, original.minPages);
    assert.ok(limits.maxPages != null);
    assert.ok(limits.maxPages * 65536 <= PHONE_WASM_BYTES);
    assert.equal(WebAssembly.validate(capped), true);
  }
});

test('a worker sample is the max wasm buffer plus performance.memory', () => {
  const solver = { buffer: { byteLength: 8 * 1024 * 1024 } };
  const mesh = { buffer: { byteLength: 3 * 1024 * 1024 } };
  assert.equal(workerMemorySample([solver, mesh], null), 8 * 1024 * 1024);
  const withHeap = workerMemorySample([solver, 3 * 1024 * 1024], { usedJSHeapSize: 2 * 1024 * 1024 });
  assert.equal(withHeap, 10 * 1024 * 1024);
  assert.equal(performanceMemoryBytes(null), 0);
  assert.equal(performanceMemoryBytes({}), 0);
  assert.equal(nextPeakBytes(0, withHeap), withHeap);
  assert.equal(nextPeakBytes(withHeap, 1024), withHeap);
  assert.equal(nextPeakBytes(withHeap, withHeap + 10), withHeap + 10);
});

test('a ceiling under the compiled minimum is refused', async () => {
  const bytes = new Uint8Array(await readFile(FILES[1]));
  assert.throws(() => capWasmMemory(bytes, 1024), /minimum/);
});
