import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import {
  REFERENCE_LENGTH_MM,
  boundsFromGeometry,
  characteristicLengthFor,
  characteristicLengthMm,
  characteristicLengthRecord,
  forgetCharacteristicLength,
  rememberCharacteristicLength,
} from './characteristicLength.js';
import { featureGraphFor } from './partSolidCache.js';

test('empty and degenerate parts use the 100 mm reference', () => {
  assert.equal(REFERENCE_LENGTH_MM, 100);
  assert.equal(characteristicLengthMm(), 100);
  assert.equal(characteristicLengthMm({}), 100);
  assert.equal(characteristicLengthMm({ size: [0, 0, 0] }), 100);
  assert.equal(characteristicLengthMm({ size: [NaN, -5, 0] }), 100);
  assert.equal(characteristicLengthMm({ bounds: { size: [0, 0, 0] } }), 100);
});

test('L is the longest side of the overall box', () => {
  assert.equal(characteristicLengthMm({ size: [40, 30, 20] }), 40);
  assert.equal(characteristicLengthMm({ size: [100, 100, 100] }), 100);
  assert.equal(characteristicLengthMm({ bounds: { size: [100, 60, 2] } }), 100);
  assert.equal(characteristicLengthMm({ size: [10, 10, 400] }), 400);
  assert.equal(characteristicLengthMm({ size: [100, 60, 1.5] }), 100);
});

test('a gap between bodies is inside the longest side', () => {
  // Two 10 mm bodies whose boxes are 200 mm apart on X.
  assert.equal(characteristicLengthMm({ size: [210, 10, 10] }), 210);
});

test('rejected scales are not what L returns', () => {
  const cube = [100, 100, 100];
  assert.equal(characteristicLengthMm({ size: cube }), 100);
  assert.ok(Math.hypot(...cube) > 170);
  const plateVolume = 100 * 60 * 2;
  assert.ok(Math.cbrt(plateVolume) < 30);
  assert.equal(characteristicLengthMm({ size: [100, 60, 2] }), 100);
});

function triangleGeometry(positions) {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const index = [];
  for (let i = 0; i < positions.length / 3; i += 1) index.push(i);
  geom.setIndex(index);
  return geom;
}

test('geometry bounds feed L, including a mesh with no feature edges', () => {
  const geom = triangleGeometry([
    0, 0, 0, 40, 0, 0, 0, 30, 0,
  ]);
  const bounds = boundsFromGeometry(geom);
  assert.deepEqual(bounds.size, [40, 30, 0]);
  assert.equal(characteristicLengthMm({ bounds }), 40);
  const graph = featureGraphFor(geom, null);
  assert.equal(graph.characteristicLengthMm, 40);
  assert.equal(graph.featureEdges.length, 0);
  const again = featureGraphFor(geom, null);
  assert.equal(again.cached, true);
  assert.equal(again.characteristicLengthMm, 40);
});

test('disjoint triangles keep the gap in the cached length', () => {
  const geom = triangleGeometry([
    0, 0, 0, 10, 0, 0, 0, 10, 0,
    200, 0, 0, 210, 0, 0, 200, 10, 0,
  ]);
  const graph = featureGraphFor(geom, null);
  assert.equal(graph.characteristicLengthMm, 210);
});

test('a missing geometry is the reference length', () => {
  const graph = featureGraphFor(null, null);
  assert.equal(graph.characteristicLengthMm, 100);
  assert.equal(graph.cached, false);
});

test('the viewport map is keyed by mesh and by part, and a clear forgets it', () => {
  const mesh = { id: 'solid' };
  const other = { id: 'other' };
  assert.equal(rememberCharacteristicLength({
    partId: 'part-a',
    meshData: mesh,
    bounds: { size: [40, 30, 20] },
  }), 40);
  assert.equal(characteristicLengthFor({ partId: 'part-a' }), 40);
  assert.equal(characteristicLengthFor({ meshData: mesh }), 40);
  assert.equal(characteristicLengthFor({ partId: 'missing' }), 100);
  assert.equal(characteristicLengthRecord('part-a').meshData, mesh);

  rememberCharacteristicLength({
    partId: 'part-b',
    meshData: other,
    size: [10, 10, 400],
  });
  assert.equal(characteristicLengthFor({ partId: 'part-a' }), 40);
  assert.equal(characteristicLengthFor({ partId: 'part-b' }), 400);

  forgetCharacteristicLength('part-a');
  assert.equal(characteristicLengthFor({ partId: 'part-a' }), 100);
  assert.equal(characteristicLengthFor({ meshData: mesh }), 100);
  assert.equal(characteristicLengthFor({ partId: 'part-b' }), 400);
  forgetCharacteristicLength('part-b');
});
