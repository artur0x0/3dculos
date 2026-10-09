/**
 * Mesh a box large enough for about 100k degrees of freedom and print
 * wasm size, time, and peak memory. Not part of `node --test`.
 *
 *   node scripts/fea/mesh-bench.mjs
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meshVolume } from '../../src/fea/meshVolume.js';
import { box } from '../../src/fea/meshShapes.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wasmPath = resolve(repoRoot, 'packages/surfcad-mesh/pkg/surfcad_mesh.wasm');
const wasm = readFileSync(wasmPath);
const gzip = gzipSync(wasm, { level: 9 }).length;
const side = Number(process.env.MESH_BENCH_SIDE || 40);
const edge = Number(process.env.MESH_BENCH_EDGE || 1.6);

const surface = box([side, side, side]);
const before = process.memoryUsage();
const mesh = await meshVolume(surface, { edgeLength: edge, epsilon: 1e-3, maxTets: 0 });
const after = process.memoryUsage();
const limit = 512 * 1024 * 1024;
const report = {
  side,
  edge,
  wasmBytes: wasm.length,
  wasmGzipBytes: gzip,
  dofs: mesh.stats.dofs,
  nodes: mesh.stats.nodes,
  elements: mesh.stats.elements,
  ms: mesh.stats.ms,
  wasmHeapBytes: mesh.stats.wasmBytes,
  rssBytes: after.rss,
  rssDeltaBytes: after.rss - before.rss,
  within512MiB: mesh.stats.wasmBytes <= limit && after.rss <= limit,
};
console.log(JSON.stringify(report, null, 2));
