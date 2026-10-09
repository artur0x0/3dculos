import assert from 'node:assert/strict';
import test from 'node:test';
import { readSheetMetalSpec, sheetStarterScript } from '../src/utils/sheetMetal/sheetMetalScript.js';

const alu = {
  sku: 'ALU-090',
  name: '5052 H32 Aluminum',
  thicknessMm: 2.286,
  bend: { radiusIn: 0.032, kFactor: 0.38 },
};

test('Start designing script is a base flange, not the starter cube', () => {
  const started = sheetStarterScript(alu);
  assert.ok(started?.script);
  assert.match(started.script, /sheet-metal begin/);
  assert.match(started.script, /sheetMetalSolid/);
  assert.match(started.script, /return part;/);
  assert.doesNotMatch(started.script, /Manifold\.cube/);
  assert.equal(started.spec.sku, 'ALU-090');
  assert.equal(started.spec.plane, 'XY');
  assert.equal(started.spec.t, 2.286);
  assert.ok(started.spec.width >= 100);
  assert.ok(started.spec.height >= 60);
  assert.deepEqual(started.spec.bends, []);
  assert.deepEqual(readSheetMetalSpec(started.script), started.spec);
});

test('a record with no SKU does not invent a starter', () => {
  assert.equal(sheetStarterScript(null), null);
  assert.equal(sheetStarterScript({ name: 'Aluminum' }), null);
});
