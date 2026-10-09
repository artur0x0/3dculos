import assert from 'node:assert/strict';
import test from 'node:test';
import { matchBoundaryFaces } from './boundaryConditions.js';

test('a wall split across two triangle ids matches both boundary faces', () => {
  const mesh = {
    nodes: new Float64Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0,
      1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0.5, 0, 0.5, 1, 0, 0.5, 0.5, 0,
    ]),
    faces: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    faceIds: new Uint32Array([7, 8]),
  };
  const { faces, unmatched } = matchBoundaryFaces(mesh, [{
    faceID: 7,
    triangleFaceIDs: [7, 8],
    at: [0, 0, 0],
    n: [0, 0, 1],
  }], { diagonal: 2 });
  assert.deepEqual(unmatched, []);
  assert.equal(faces.length, 2);
});
