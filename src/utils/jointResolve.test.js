import assert from 'node:assert/strict';
import test from 'node:test';
import { matchJointAxis, matchJointEdge, matchJointFace } from './jointResolve.js';

const FACE = { at: [0, 0, 0.5], n: [0, 0, 1], area: 1 };

test('a face key matches a 0.4 mm shift and a 3 degree tilt', () => {
  const tilt = 3 * Math.PI / 180;
  const moved = {
    at: [0.4, 0, 0.5],
    n: [Math.sin(tilt), 0, Math.cos(tilt)],
    area: 1,
  };
  const before = FACE.at.slice();
  assert.equal(matchJointFace([moved], FACE).status, 'ok');
  assert.deepEqual(FACE.at, before);
});

test('a face 5 mm away is missing and is not the nearest', () => {
  const far = { at: [5, 0, 0.5], n: [0, 0, 1], area: 1 };
  const near = { at: [2, 0, 0.5], n: [0, 0, 1], area: 1 };
  assert.equal(matchJointFace([far, near], FACE).status, 'missing');
});

test('two faces in tolerance are ambiguous and neither is chosen', () => {
  const a = { at: [0.2, 0, 0.5], n: [0, 0, 1], area: 1 };
  const b = { at: [-0.2, 0, 0.5], n: [0, 0, 1], area: 1 };
  const hit = matchJointFace([a, b], FACE);
  assert.equal(hit.status, 'ambiguous');
  assert.equal(hit.face, undefined);
});

test('an axis matches within 8 degrees, 1 mm, and 25 percent radius', () => {
  const tilt = 4 * Math.PI / 180;
  const axis = {
    at: [0.4, 0, 0],
    dir: [Math.sin(tilt), 0, Math.cos(tilt)],
    radius: 1.1,
  };
  const key = { at: [0, 0, 0], dir: [0, 0, 1], radius: 1 };
  assert.equal(matchJointAxis([axis], key).status, 'ok');
  assert.equal(matchJointAxis([
    axis,
    { at: [0.2, 0, 0], dir: [0, 0, 1], radius: 1 },
  ], key).status, 'ambiguous');
  assert.equal(matchJointAxis([
    { at: [0, 0, 0], dir: [0, 0, 1], radius: 2 },
  ], key).status, 'missing');
});

test('an edge matches midpoint, direction, length, and both faces', () => {
  const top = { at: [0, 0, 1], n: [0, 0, 1], area: 1 };
  const side = { at: [0.5, 0, 0.5], n: [1, 0, 0], area: 1 };
  const key = {
    at: [0, 0, 0.5],
    dir: [0, 1, 0],
    length: 2,
    faces: [top, side],
  };
  const edge = {
    at: [0.4, 0, 0.5],
    dir: [0, 1, 0],
    length: 2.1,
    faces: [
      { at: [0.2, 0, 1], n: [0, 0, 1], area: 1 },
      { at: [0.5, 0.2, 0.5], n: [1, 0, 0], area: 1 },
    ],
  };
  assert.equal(matchJointEdge([edge], key).status, 'ok');
  assert.equal(matchJointEdge([{ ...edge, faces: [top] }], key).status, 'missing');
});
