import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adjacentBlendSize, adjacentPerpendicularLength } from './adjacentBlend.js';

function edge(key, a, b, va, vb) {
  const d = [vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return {
    key,
    a,
    b,
    partId: 'box',
    va,
    vb,
    length: len,
    tangent: [d[0] / len, d[1] / len, d[2] / len],
  };
}

// 40 × 30 × 20 box. Every corner is 90°.
const e40 = edge('e40', 0, 1, [0, 0, 0], [40, 0, 0]);
const e30 = edge('e30', 0, 3, [0, 0, 0], [0, 30, 0]);
const e20 = edge('e20', 0, 4, [0, 0, 0], [0, 0, 20]);
const box = [e40, e30, e20];

describe('adjacent blend size', () => {
  it('picks the shorter perpendicular neighbor on a cube', () => {
    assert.equal(adjacentPerpendicularLength([e40], box), 20);
    const long = adjacentBlendSize([e40], box);
    assert.equal(long.defaultMm, 2);
    assert.equal(long.maxMm, 4);

    assert.equal(adjacentPerpendicularLength([e20], box), 30);
    const height = adjacentBlendSize([e20], box);
    assert.equal(height.defaultMm, 3);
    assert.equal(height.maxMm, 6);
  });

  it('a chain uses the shortest neighbor and does not grow with the path', () => {
    const chain = adjacentBlendSize([e40, e20], box);
    assert.equal(chain.basisMm, 20);
    assert.equal(chain.defaultMm, 2);
    assert.equal(chain.maxMm, 4);
  });

  it('no edges falls back to 2 mm', () => {
    const empty = adjacentBlendSize(null, []);
    assert.equal(empty.basisMm, null);
    assert.equal(empty.defaultMm, 2);
    assert.equal(empty.minMm, 0.1);
  });

  it('ignores a collinear continuation', () => {
    const onward = edge('on', 1, 5, [40, 0, 0], [80, 0, 0]);
    assert.equal(adjacentPerpendicularLength([e40], [e40, onward, e20]), 20);
  });
});
