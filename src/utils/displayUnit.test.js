import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISPLAY_UNIT_KEY,
  formatDisplayAngle,
  formatDisplayDelta,
  formatDisplayLength,
  getDisplayUnit,
  loadDisplayUnit,
  saveDisplayUnit,
  setDisplayUnit,
  subscribeDisplayUnit,
} from './displayUnit.js';

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

test('display unit defaults to mm and persists in the given storage', () => {
  const mem = memoryStorage();
  assert.equal(loadDisplayUnit(mem), 'mm');
  assert.equal(saveDisplayUnit('in', mem), 'in');
  assert.equal(mem.getItem(DISPLAY_UNIT_KEY), 'in');
  assert.equal(loadDisplayUnit(mem), 'in');
  assert.equal(loadDisplayUnit(memoryStorage({ [DISPLAY_UNIT_KEY]: 'nope' })), 'mm');
});

test('lengths convert and angles do not', () => {
  assert.equal(formatDisplayLength(30, 'mm'), '30.00 mm');
  assert.equal(formatDisplayLength(30, 'in'), '1.1811 in');
  assert.equal(formatDisplayLength(12, 'in'), '0.4724 in');
  assert.equal(formatDisplayLength(24, 'in'), '0.9449 in');
  assert.equal(formatDisplayDelta(-30, 'mm'), '-30.00 mm');
  assert.equal(formatDisplayDelta(0, 'mm'), '0.00 mm');
  assert.equal(formatDisplayDelta(25.4, 'in'), '+1.0000 in');
  assert.equal(formatDisplayAngle(90), '90.0°');
  assert.equal(formatDisplayAngle(0), '0.0°');
});

test('the store notifies subscribers and is the global cache', () => {
  const mem = memoryStorage();
  const seen = [];
  const stop = subscribeDisplayUnit((unit) => seen.push(unit));
  assert.equal(setDisplayUnit('in', mem), 'in');
  assert.equal(getDisplayUnit(), 'in');
  assert.equal(setDisplayUnit('mm', mem), 'mm');
  stop();
  setDisplayUnit('in', mem);
  assert.deepEqual(seen, ['in', 'mm']);
  setDisplayUnit('mm', mem);
});
