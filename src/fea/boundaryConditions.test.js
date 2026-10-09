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

test('a reused face id on a distant coplanar wall stays off this pick', () => {
  const mesh = {
    nodes: new Float64Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0,
      100, 0, 0, 101, 0, 0, 100, 1, 0, 100.5, 0, 0, 100.5, 0.5, 0, 100, 0.5, 0,
    ]),
    faces: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    faceIds: new Uint32Array([1, 1]),
  };
  const near = matchBoundaryFaces(mesh, [{
    faceID: 1,
    triangleFaceIDs: [1],
    at: [0.3, 0.3, 0],
    n: [0, 0, 1],
  }], { diagonal: 120 });
  assert.deepEqual(near.unmatched, []);
  assert.equal(near.faces.length, 1);
  assert.equal(near.faces[0].index, 0);
  const far = matchBoundaryFaces(mesh, [{
    faceID: 1,
    at: [100.3, 0.3, 0],
    n: [0, 0, 1],
  }], { diagonal: 120 });
  assert.equal(far.faces.length, 1);
  assert.equal(far.faces[0].index, 1);
});
