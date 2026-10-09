import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { meshVolume, surfaceVolume } from './meshVolume.js';
import { box, cylinder, lBracket, plateWithHole } from './meshShapes.js';

const wasmUrl = new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);
const feaWasm = await readFile(wasmUrl);
const initFea = fea.default ?? fea.init;
await initFea({ module_or_path: feaWasm });

async function readMeshArtifact() {
  const meshWasmUrl = new URL('../../packages/surfcad-mesh/pkg/surfcad_mesh.wasm', import.meta.url);
  const meshGlueUrl = new URL('../../packages/surfcad-mesh/pkg/surfcad_mesh.js', import.meta.url);
  return {
    wasm: await readFile(meshWasmUrl),
    glue: await readFile(meshGlueUrl, 'utf8'),
  };
}

function assertClosedVolume(surface, expected) {
  const volume = surfaceVolume(surface.positions, surface.indices);
  assert.ok(volume > 0, 'signed volume should point outward');
  assert.ok(Math.abs(volume - expected) / expected < 1e-6, `volume ${volume} vs ${expected}`);
}

function assertMesh(surface, mesh) {
  assert.equal(mesh.stats.positive, true);
  assert.ok(mesh.stats.elements > 0);
  assert.equal(mesh.elements.length, mesh.stats.elements * 10);
  assert.equal(mesh.faces.length, mesh.stats.boundaryFaces * 6);
  assert.ok(mesh.stats.minDihedralDeg > 1, `min dihedral ${mesh.stats.minDihedralDeg}`);
  assert.ok(mesh.stats.maxAspect < 80, `max aspect ${mesh.stats.maxAspect}`);
  assert.ok(Number.isFinite(mesh.stats.meanAspect));
  assert.ok(mesh.stats.volumeError < 0.01, `volume error ${mesh.stats.volumeError}`);
  const present = new Set(mesh.faceIds);
  for (const id of surface.faceIds) {
    assert.ok(present.has(id), `face id ${id} missing from the boundary`);
  }
  for (let i = 0; i < mesh.nodes.length; i += 1) {
    assert.ok(Number.isFinite(mesh.nodes[i]));
  }
}

describe('volume mesh', { concurrency: 1 }, () => {
  test('the mesh wasm is single-threaded simd and has no shared memory', async () => {
    const { wasm, glue } = await readMeshArtifact();
    let simd = false;
    for (let i = 0; i < wasm.length - 1; i += 1) {
      if (wasm[i] === 0xfd) {
        simd = true;
        break;
      }
    }
    assert.equal(simd, true);
    assert.equal(glue.includes('SharedArrayBuffer'), false);
    assert.equal(glue.includes('pthread'), false);
  });

  test('analytic volumes of the four surfaces', () => {
    assertClosedVolume(box([10, 20, 30]), 10 * 20 * 30);
    const segments = 16;
    const radius = 5;
    const height = 10;
    const prism = segments * radius * radius * Math.sin((2 * Math.PI) / segments) * 0.5 * height;
    assertClosedVolume(cylinder(radius, height, segments), prism);
    const plate = plateWithHole(20, 20, 4, 4, 16);
    const hole = 16 * 4 * 4 * Math.sin((2 * Math.PI) / 16) * 0.5;
    assertClosedVolume(plate, (20 * 20 - hole) * 4);
    const length = 30;
    const thickness = 10;
    const depth = 8;
    const area = 2 * length * thickness - thickness * thickness;
    assertClosedVolume(lBracket(length, thickness, depth), area * depth);
  });

  test('a box becomes a quality TET10 mesh', { timeout: 180_000 }, async () => {
    const surface = box([10, 10, 10]);
    const mesh = await meshVolume(surface, { edgeLength: 5, epsilon: 1e-3, maxTets: 20000 });
    assertMesh(surface, mesh);
  });

  test('a cylinder becomes a quality TET10 mesh', { timeout: 180_000 }, async () => {
    const surface = cylinder(5, 10, 16);
    const mesh = await meshVolume(surface, { edgeLength: 3, epsilon: 1e-3, maxTets: 20000 });
    assertMesh(surface, mesh);
  });

  test('a plate with a hole keeps every face id', { timeout: 180_000 }, async () => {
    const surface = plateWithHole(20, 20, 4, 4, 16);
    const mesh = await meshVolume(surface, { edgeLength: 2, epsilon: 1e-3, maxTets: 40000 });
    assertMesh(surface, mesh);
  });

  test('an L-bracket keeps every face id', { timeout: 180_000 }, async () => {
    const surface = lBracket(30, 10, 8);
    const mesh = await meshVolume(surface, { edgeLength: 4, epsilon: 1e-3, maxTets: 40000 });
    assertMesh(surface, mesh);
  });

  test('a meshed cantilever matches Euler-Bernoulli within 5%', { timeout: 300_000 }, async () => {
    const length = 100;
    const height = 10;
    const width = 10;
    const load = 100;
    const young = 210_000;
    const surface = box([length, height, width]);
    const mesh = await meshVolume(surface, { edgeLength: 5, epsilon: 1e-3, maxTets: 100000 });
    assertMesh(surface, mesh);

    // fTetWild may leave the fixed face a fraction of the envelope off x = 0.
    const tol = 0.25;
    const fixed = [];
    for (let i = 0; i < mesh.stats.nodes; i += 1) {
      if (mesh.nodes[i * 3] <= tol) fixed.push(i);
    }
    assert.ok(fixed.length >= 3);

    const forceAt = new Map();
    let area = 0;
    const tipFaces = [];
    for (let f = 0; f < mesh.faceIds.length; f += 1) {
      if (mesh.faceIds[f] !== 2) continue;
      const ids = mesh.faces.subarray(f * 6, f * 6 + 6);
      const ax = mesh.nodes[ids[0] * 3];
      const ay = mesh.nodes[ids[0] * 3 + 1];
      const az = mesh.nodes[ids[0] * 3 + 2];
      const ux = mesh.nodes[ids[1] * 3] - ax;
      const uy = mesh.nodes[ids[1] * 3 + 1] - ay;
      const uz = mesh.nodes[ids[1] * 3 + 2] - az;
      const vx = mesh.nodes[ids[2] * 3] - ax;
      const vy = mesh.nodes[ids[2] * 3 + 1] - ay;
      const vz = mesh.nodes[ids[2] * 3 + 2] - az;
      const faceArea = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      area += faceArea;
      tipFaces.push({ ids: Array.from(ids), faceArea });
    }
    assert.ok(area > 0);
    for (const face of tipFaces) {
      const share = (-load * face.faceArea) / (3 * area);
      for (const node of [face.ids[3], face.ids[4], face.ids[5]]) {
        forceAt.set(node, (forceAt.get(node) || 0) + share);
      }
    }
    const forceNodes = Uint32Array.from(forceAt.keys());
    const forceValues = new Float64Array(forceNodes.length * 3);
    let total = 0;
    for (let i = 0; i < forceNodes.length; i += 1) {
      const fy = forceAt.get(forceNodes[i]);
      forceValues[i * 3 + 1] = fy;
      total += fy;
    }
    assert.ok(Math.abs(total + load) / load < 1e-8);

    const result = fea.solve_tet10(
      { nodes: mesh.nodes, elements: mesh.elements },
      { E_MPa: young, nu: 0.3, yield_MPa: 250 },
      { fixedNodes: Uint32Array.from(fixed), forceNodes, forceValues },
      { solver: 'auto' },
    );
    const inertia = width * height ** 3 / 12;
    const bending = (load * length ** 3) / (3 * young * inertia);
    let tip = 0;
    let tipDist = Infinity;
    const target = [length, height / 2, width / 2];
    for (let i = 0; i < mesh.stats.nodes; i += 1) {
      const dx = mesh.nodes[i * 3] - target[0];
      const dy = mesh.nodes[i * 3 + 1] - target[1];
      const dz = mesh.nodes[i * 3 + 2] - target[2];
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < tipDist) {
        tipDist = dist;
        tip = i;
      }
    }
    const uy = Math.abs(result.displacement[tip * 3 + 1]);
    const error = Math.abs(uy - bending) / bending;
    assert.ok(error < 0.05, `tip ${uy} mm vs Euler-Bernoulli ${bending} mm (${(100 * error).toFixed(2)}%)`);
  });
});
