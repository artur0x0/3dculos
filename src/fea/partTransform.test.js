import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { detectContacts } from './contactDetect.js';
import { meshVolume } from './meshVolume.js';
import { box } from './meshShapes.js';
import {
  composePlacement,
  placementMatrix,
  placeStudy,
  transformNormal,
  transformPoint,
  transformPositions,
} from './partTransform.js';
import { solveAssembly } from './solveAssembly.js';
import { worldSurfaces } from './studyPanel.js';

const wasmUrl = new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);
const initFea = fea.default ?? fea.init;
await initFea({ module_or_path: await readFile(wasmUrl) });

const HALF = Math.PI / 4;
const ROT_Z = [0, 0, Math.sin(HALF), Math.cos(HALF)];

function geometryOf(surface) {
  return {
    attributes: { position: { array: surface.positions } },
    index: { array: surface.indices },
  };
}

function rowsFor(placement) {
  const local = box([10, 10, 10]);
  return [
    {
      id: 'a',
      geometry: geometryOf(local),
      faceIDs: local.faceIds,
    },
    {
      id: 'b',
      geometry: geometryOf(local),
      faceIDs: local.faceIds,
      ...placement,
    },
  ];
}

test('a 90° quaternion, a scale, and matrixWorld move the same point', () => {
  const spin = composePlacement([0, 0, 0], ROT_Z, [1, 1, 1]);
  const turned = transformPoint([10, 0, 0], spin);
  assert.ok(Math.abs(turned[0]) < 1e-9, turned.join(','));
  assert.ok(Math.abs(turned[1] - 10) < 1e-9, turned.join(','));
  assert.ok(Math.abs(turned[2]) < 1e-9);
  const normal = transformNormal([1, 0, 0], spin);
  assert.ok(Math.abs(normal[0]) < 1e-9 && Math.abs(normal[1] - 1) < 1e-9, normal.join(','));

  const scaled = composePlacement([0, 0, 0], [0, 0, 0, 1], [2, 2, 2]);
  const grown = transformPoint([4, 0, 0], scaled);
  assert.ok(Math.abs(grown[0] - 8) < 1e-9, grown.join(','));
  const unit = transformNormal([1, 0, 0], scaled);
  assert.ok(Math.abs(unit[0] - 1) < 1e-9 && Math.abs(unit[1]) < 1e-9);

  const translated = placementMatrix({ translation: [3, 0, 0] });
  assert.deepEqual(transformPoint([1, 2, 3], translated), [4, 2, 3]);
  assert.equal(placementMatrix({ position: [0, 0, 0] }), null);
  assert.equal(placementMatrix({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }), null);

  const placed = composePlacement([20, 0, 0], ROT_Z, [1, 1, 1]);
  assert.deepEqual(placementMatrix({ matrix: placed }).map((n) => Math.round(n * 1e9) / 1e9), placed.map((n) => Math.round(n * 1e9) / 1e9));
});

test('a normal load follows the part and a world-axis load does not', () => {
  const matrix = composePlacement([20, 0, 0], ROT_Z, [1, 1, 1]);
  const placed = placeStudy({
    fixtures: [],
    loads: [
      { kind: 'force', vector: [0, 100, 0], faces: [{ faceID: 4, at: [5, 10, 5], n: [0, 1, 0], area: 100 }] },
      { kind: 'force', vector: [100, 0, 0], faces: [{ faceID: 3, at: [5, 0, 5], n: [0, -1, 0], area: 100 }] },
    ],
  }, matrix);
  const followed = placed.loads[0].vector;
  assert.ok(Math.abs(followed[0] + 100) < 1e-6, followed.join(','));
  assert.ok(Math.abs(followed[1]) < 1e-6 && Math.abs(followed[2]) < 1e-6);
  assert.deepEqual(placed.loads[1].vector, [100, 0, 0]);
  const at = placed.loads[1].faces[0].at;
  assert.ok(Math.abs(at[0] - 20) < 1e-6 && Math.abs(at[1] - 5) < 1e-6, at.join(','));
});

test('one part rotated 90° still bonds on the shared face', () => {
  const straight = detectContacts(worldSurfaces(rowsFor({ position: [10, 0, 0] })));
  assert.equal(straight.pairs.length, 1);
  assert.deepEqual(straight.pairs[0], {
    a: { part: 'a', faceID: 2 },
    b: { part: 'b', faceID: 1 },
    kind: 'bonded',
  });

  const turned = detectContacts(worldSurfaces(rowsFor({
    position: [20, 0, 0],
    quaternion: ROT_Z,
  })));
  assert.equal(turned.pairs.length, 1);
  assert.deepEqual(turned.pairs[0], {
    a: { part: 'a', faceID: 2 },
    b: { part: 'b', faceID: 4 },
    kind: 'bonded',
  });

  const local = box([10, 10, 10]);
  const baked = transformPositions(local.positions, composePlacement([20, 0, 0], ROT_Z, [1, 1, 1]));
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < baked.length; i += 3) {
    minX = Math.min(minX, baked[i]);
    maxX = Math.max(maxX, baked[i]);
  }
  assert.ok(Math.abs(minX - 10) < 1e-6 && Math.abs(maxX - 20) < 1e-6, `${minX} ${maxX}`);
  assert.equal(local.positions[0], 0);
});

describe('rotated bonded solve', { concurrency: 1 }, () => {
  test('a 90° part solves like the same bar without the rotation', { timeout: 180_000 }, async () => {
    const local = box([10, 10, 10]);
    const material = { id: 'al-6061-t6' };
    async function run(placement, loadFace) {
      const detected = detectContacts(worldSurfaces([
        { id: 'a', geometry: geometryOf(local), faceIDs: local.faceIds },
        { id: 'b', geometry: geometryOf(local), faceIDs: local.faceIds, ...placement },
      ]));
      assert.equal(detected.pairs.length, 1);
      const result = await solveAssembly({
        study: {
          material,
          mesh: { target: 5, refine: 'off' },
          contacts: detected.pairs,
          fixtures: [{
            kind: 'fixed',
            faces: [{ faceID: 1, part: 'a', at: [0, 5, 5], n: [-1, 0, 0], area: 100 }],
          }],
          loads: [{
            kind: 'force',
            vector: [100, 0, 0],
            faces: [{
              faceID: loadFace.id,
              part: 'b',
              at: loadFace.at,
              n: loadFace.n,
              area: 100,
            }],
          }],
        },
        parts: [
          {
            id: 'a',
            name: 'A',
            positions: local.positions,
            indices: local.indices,
            faceIDs: local.faceIds,
          },
          {
            id: 'b',
            name: 'B',
            positions: local.positions,
            indices: local.indices,
            faceIDs: local.faceIds,
            ...placement,
          },
        ],
        profile: 'desktop',
        solveBonded: fea.solve_bonded,
        meshVolume,
      });
      assert.equal(result.bonded, true);
      assert.ok(result.displacementMax > 0);
      assert.ok(result.p95 > 0);
      return result;
    }

    const straight = await run({ position: [10, 0, 0] }, { id: 2, at: [10, 5, 5], n: [1, 0, 0] });
    const turned = await run(
      { position: [20, 0, 0], quaternion: ROT_Z },
      { id: 3, at: [5, 0, 5], n: [0, -1, 0] },
    );
    const dispErr = Math.abs(turned.displacementMax - straight.displacementMax) / straight.displacementMax;
    const p95Err = Math.abs(turned.p95 - straight.p95) / straight.p95;
    console.log(
      `straight u=${straight.displacementMax} p95=${straight.p95} missed=${straight.stats.missedSlaves} `
      + `turned u=${turned.displacementMax} p95=${turned.p95} missed=${turned.stats.missedSlaves} `
      + `dispErr=${dispErr} p95Err=${p95Err}`,
    );
    assert.ok(straight.stats.missedSlaves < 8, `straight missed ${straight.stats.missedSlaves}`);
    assert.ok(turned.stats.missedSlaves < 8, `turned missed ${turned.stats.missedSlaves}`);
    assert.ok(
      dispErr < 0.01,
      `displacement ${turned.displacementMax} vs ${straight.displacementMax} (${dispErr})`,
    );
    assert.ok(
      p95Err < 0.03,
      `p95 ${turned.p95} vs ${straight.p95} (${p95Err})`,
    );
  });
});
