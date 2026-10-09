import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleSurfaceDisplacement, sampleSurfaceStress } from './stressSample.js';

// One 6-node face. Corners then mid-edge nodes, same order as the solver.
function faceMesh() {
  return {
    nodes: new Float64Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]),
    faces: new Uint32Array([0, 1, 2, 3, 4, 5]),
    faceIds: new Uint32Array([7]),
  };
}

test('displacement magnitude uses the same face map as stress', () => {
  const mesh = faceMesh();
  const positions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 2, 0,
    1, 0, 0,
  ]);
  const indices = new Uint32Array([0, 1, 3, 0, 3, 2]);
  const faceIDs = new Uint32Array([7, 7]);
  // Linear field u = (0, 0, x). Magnitude equals x, and so does a scalar sample of x.
  const scalar = new Float64Array([0, 2, 0, 1, 1, 0]);
  const displacement = new Float64Array(18);
  for (let i = 0; i < 6; i += 1) displacement[i * 3 + 2] = scalar[i];

  const stress = sampleSurfaceStress(positions, indices, faceIDs, mesh, scalar);
  const magnitude = sampleSurfaceDisplacement(positions, indices, faceIDs, mesh, displacement);
  assert.deepEqual([...magnitude], [...stress]);
  assert.ok(Math.abs(magnitude[0] - 0) < 1e-6);
  assert.ok(Math.abs(magnitude[1] - 2) < 1e-6);
  assert.ok(Math.abs(magnitude[2] - 0) < 1e-6);
  assert.ok(Math.abs(magnitude[3] - 1) < 1e-6);
});

test('magnitude is the length of the interpolated vector', () => {
  const mesh = faceMesh();
  // Centroid of the corner triangle. Quadratic interpolation of the vectors
  // is not the interpolation of the nodal magnitudes.
  const positions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    2 / 3, 2 / 3, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2]);
  const faceIDs = new Uint32Array([7]);
  const displacement = new Float64Array([
    1, 0, 0,
    -1, 0, 0,
    0, 1, 0,
    0, 0, 0,
    0, 0, 0,
    0, 0, 0,
  ]);
  const magnitude = sampleSurfaceDisplacement(positions, indices, faceIDs, mesh, displacement);
  assert.ok(Math.abs(magnitude[2] - (1 / 9)) < 1e-5, `got ${magnitude[2]}`);
  assert.ok(Math.abs(magnitude[2] - (1 / 3)) > 1e-3);
});

test('a render vertex with no boundary face stays NaN', () => {
  const mesh = faceMesh();
  const positions = new Float32Array([0, 0, 0, 5, 5, 5]);
  const indices = new Uint32Array([0, 1, 1]);
  const faceIDs = new Uint32Array([9]);
  const displacement = new Float64Array(18);
  const magnitude = sampleSurfaceDisplacement(positions, indices, faceIDs, mesh, displacement);
  assert.ok(Number.isNaN(magnitude[0]));
  assert.ok(Number.isNaN(magnitude[1]));
});
