/**
 * Voxel preview against the TET10 solve.
 *
 * p95 is compared on the TET10 nodes: the voxel field is sampled at those
 * coordinates. Max stress is the same sample. A coarse grid overshoots the
 * clamped corners, so the gate is the p95, which is stable. The cantilever
 * gate is 25% at 96 along the beam. The plate with a hole is reported and
 * held to a looser 40% p95 gate at 96.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as fea from '../../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { boundaryConditions } from '../boundaryConditions.js';
import { meshVolume } from '../meshVolume.js';
import { box, plateWithHole } from '../meshShapes.js';
import { fieldRange } from '../stressSample.js';
import { materialC } from './hexElement.js';
import { estimateGpuBytes } from './resolution.js';
import { sampleVonMisesAt, solveVoxelPreview } from './solvePreview.js';

const wasmUrl = new URL('../../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);
await (fea.default ?? fea.init)({ module_or_path: await readFile(wasmUrl) });

const pla = { E_MPa: 3250, nu: 0.36, yield_MPa: 52.5 };

function percent(error) {
  return `${(100 * error).toFixed(1)}%`;
}

async function tetField(surface, study, edgeLength) {
  const diagonal = Math.hypot(
    surface.positions.reduce((m, v, i) => (i % 3 === 0 ? Math.max(m, v) : m), 0),
    10,
    10,
  );
  const volume = await meshVolume(
    { positions: surface.positions, indices: surface.indices, faceIds: surface.faceIds },
    { edgeLength, epsilon: 1e-3 },
  );
  const bcs = boundaryConditions(volume, study, { diagonal: Math.max(diagonal, 1) });
  const solved = fea.solve_tet10(
    { nodes: volume.nodes, elements: volume.elements },
    { E_MPa: pla.E_MPa, nu: pla.nu, yield_MPa: pla.yield_MPa },
    {
      fixedNodes: bcs.fixedNodes,
      forceNodes: bcs.forceNodes,
      forceValues: bcs.forceValues,
    },
    { solver: 'cholesky' },
  );
  return { volume, solved, range: fieldRange(solved.nodal) };
}

function previewAt(surface, study, resolution) {
  const started = Date.now();
  const result = solveVoxelPreview({
    positions: surface.positions,
    indices: surface.indices,
    faceIDs: surface.faceIds,
    study,
    material: pla,
    resolution,
    tol: 1e-4,
    maxIter: 24,
  });
  return { result, ms: Date.now() - started };
}

function compare(label, tet, preview, points) {
  const C = materialC(pla.E_MPa, pla.nu);
  const sampled = sampleVonMisesAt(preview.result.grid, preview.result.u, C, points);
  const range = fieldRange(sampled);
  const p95 = Math.abs(range.p95 - tet.p95) / tet.p95;
  const max = Math.abs(range.max - tet.max) / tet.max;
  const gpu = estimateGpuBytes(preview.result.padded[0], preview.result.padded[1], preview.result.padded[2]);
  console.log(
    `${label} grid ${preview.result.nx}x${preview.result.ny}x${preview.result.nz}`
    + ` max ${range.max.toFixed(2)} (${percent(max)})`
    + ` p95 ${range.p95.toFixed(2)} (${percent(p95)})`
    + ` tet max ${tet.max.toFixed(2)} p95 ${tet.p95.toFixed(2)}`
    + ` iters ${preview.result.iterations} ms ${preview.ms}`
    + ` gpu ${gpu} js ${preview.result.bytes}`,
  );
  return { p95, max, range, gpu, ms: preview.ms };
}

test('cantilever preview tracks TET10 at 64, 96, and 128', { timeout: 300_000 }, async () => {
  const surface = box([40, 10, 10]);
  const study = {
    model: 'solid',
    mesh: { target: 4 },
    fixtures: [{
      kind: 'fixed',
      faces: [{ faceID: 1, at: [0, 5, 5], n: [-1, 0, 0], area: 100 }],
    }],
    loads: [{
      kind: 'force',
      vector: [0, 0, -200],
      faces: [{ faceID: 2, at: [40, 5, 5], n: [1, 0, 0], area: 100 }],
    }],
  };
  const tet = await tetField(surface, study, 4);
  assert.ok(Math.abs(tet.range.max - 48) / 48 <= 0.1, `tet max ${tet.range.max}`);
  const rows = {};
  for (const resolution of [64, 96, 128]) {
    rows[resolution] = compare(`cantilever ${resolution}`, tet.range, previewAt(surface, study, resolution), tet.volume.nodes);
  }
  assert.ok(rows[96].p95 <= 0.25, `96 p95 error ${percent(rows[96].p95)}`);
  assert.ok(rows[64].p95 <= 0.35, `64 p95 error ${percent(rows[64].p95)}`);
  assert.ok(rows[128].p95 <= 0.25, `128 p95 error ${percent(rows[128].p95)}`);
  assert.equal(rows[96].range.safetyFactor, undefined);
});

function relabelPlate(surface) {
  const { positions, indices } = surface;
  const faceIds = new Uint32Array(indices.length / 3);
  const cx0 = 10;
  const cy0 = 10;
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
    const cx = positions[ic * 3];
    const cy = positions[ic * 3 + 1];
    const cz = positions[ic * 3 + 2];
    const x = (ax + bx + cx) / 3;
    const y = (ay + by + cy) / 3;
    const z = (az + bz + cz) / 3;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    if (Math.abs(nz / len) > 0.8) faceIds[t] = z < 2 ? 1 : 2;
    else if (Math.hypot(x - cx0, y - cy0) < 6) faceIds[t] = 7;
    else if (x < 1) faceIds[t] = 3;
    else if (x > 19) faceIds[t] = 4;
    else if (y < 1) faceIds[t] = 5;
    else faceIds[t] = 6;
  }
  return { positions, indices, faceIds };
}

test('plate with a hole preview stays in range of TET10', { timeout: 300_000 }, async () => {
  const surface = relabelPlate(plateWithHole(20, 20, 4, 4, 32));
  const study = {
    model: 'solid',
    fixtures: [{
      kind: 'fixed',
      faces: [{ faceID: 3, at: [0, 10, 2], n: [-1, 0, 0], area: 80 }],
    }],
    loads: [{
      kind: 'force',
      vector: [800, 0, 0],
      faces: [{ faceID: 4, at: [20, 10, 2], n: [1, 0, 0], area: 80 }],
    }],
  };
  const tet = await tetField(surface, study, 1.5);
  const rows = {};
  for (const resolution of [64, 96, 128]) {
    rows[resolution] = compare(`plate ${resolution}`, tet.range, previewAt(surface, study, resolution), tet.volume.nodes);
  }
  assert.ok(rows[96].p95 <= 0.4, `plate 96 p95 error ${percent(rows[96].p95)}`);
  assert.ok(rows[64].p95 < 1, `plate 64 p95 error ${percent(rows[64].p95)}`);
  assert.ok(Number.isFinite(rows[128].range.max) && rows[128].range.max > 0);
});
