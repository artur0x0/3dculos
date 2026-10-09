import assert from 'node:assert/strict';
import test from 'node:test';
import { bindStressField, cornerStresses, stressAt } from './stressMap.js';

function geometry({ index, faceIDs }) {
  return {
    index: { array: index },
    attributes: { faceID: { array: faceIDs } },
    getAttribute(name) {
      return this.attributes[name] || null;
    },
  };
}

test('corners are keyed by faceID and vertex, not by triangle index', () => {
  const index = new Uint32Array([0, 1, 2, 2, 3, 0]);
  const faceIDs = new Uint32Array([7, 7]);
  const mesh = geometry({ index, faceIDs });
  const nodal = new Float32Array([1, 2, 3, 4]);
  const field = bindStressField(mesh, nodal);

  assert.equal(stressAt(field, 7, 0), 1);
  assert.equal(stressAt(field, 7, 3), 4);
  assert.ok(Number.isNaN(stressAt(field, 9, 0)));

  const reordered = new Uint32Array([2, 3, 0, 0, 1, 2]);
  const corners = cornerStresses(field, mesh, reordered, faceIDs);
  assert.deepEqual([...corners], [3, 4, 1, 1, 2, 3]);
});

test('a different geometry object does not reuse the field', () => {
  const index = new Uint32Array([0, 1, 2]);
  const faceIDs = new Uint32Array([4]);
  const solved = geometry({ index, faceIDs });
  const rebuilt = geometry({ index, faceIDs });
  const field = bindStressField(solved, new Float32Array([8, 9, 10]));
  assert.equal(cornerStresses(field, rebuilt, index, faceIDs), null);
  assert.deepEqual([...cornerStresses(field, solved, index, faceIDs)], [8, 9, 10]);
});

test('two faces keep their own buckets for a shared vertex', () => {
  const index = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const faceIDs = new Uint32Array([1, 2]);
  const mesh = geometry({ index, faceIDs });
  const field = bindStressField(mesh, new Float32Array([5, 6, 7, 8]));
  assert.equal(stressAt(field, 1, 0), 5);
  assert.equal(stressAt(field, 2, 0), 5);
  assert.equal(stressAt(field, 1, 3) === 8, false);
  assert.equal(stressAt(field, 2, 3), 8);
  assert.ok(Number.isNaN(stressAt(field, 1, 3)));
});

test('a missing vertex and a short faceID list do not borrow another triangle', () => {
  const index = new Uint32Array([0, 1, 2, 2, 3, 0]);
  const faceIDs = new Float32Array([4]);
  const mesh = geometry({ index, faceIDs });
  const field = bindStressField(mesh, new Float32Array([1, 2]));
  assert.equal(stressAt(field, 4, 0), 1);
  assert.ok(Number.isNaN(stressAt(field, 4, 2)));
  const corners = cornerStresses(field, mesh, index, new Uint32Array([4, 4]));
  assert.equal(corners[0], 1);
  assert.equal(corners[1], 2);
  assert.ok(Number.isNaN(corners[2]));
  assert.ok(Number.isNaN(corners[3]));
});

test('bind rejects a mesh that cannot be keyed', () => {
  assert.equal(bindStressField(null, new Float32Array([1])), null);
  assert.equal(bindStressField(geometry({ index: new Uint32Array([0, 1, 2]), faceIDs: new Uint32Array([1]) }), [1, 2, 3]), null);
  const noFace = { index: { array: new Uint32Array([0, 1, 2]) }, attributes: {}, getAttribute() { return null; } };
  assert.equal(bindStressField(noFace, new Float32Array([1, 2, 3])), null);
});
