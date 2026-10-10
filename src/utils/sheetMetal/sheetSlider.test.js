import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDisplayUnit, saveDisplayUnit, DISPLAY_UNIT_KEY } from '../displayUnit.js';
import {
  baseSliderRange,
  defaultBaseDims,
  holeDraftDiameter,
  tabDraftSize,
} from './sheetMetalMode.js';

describe('sheet-metal slider seeds', () => {
  it('keeps 100 × 60 at L = 100 and scales when the part is smaller', () => {
    assert.deepEqual(defaultBaseDims(null), { width: 100, height: 60 });
    assert.deepEqual(defaultBaseDims(null, 40), { width: 40, height: 24 });
    assert.deepEqual(defaultBaseDims(null, 200), { width: 200, height: 120 });
    assert.deepEqual(defaultBaseDims(null, 5000), { width: 1200, height: 1200 });
  });

  it('lets the SKU floor win over L, and the thumb still reaches 1200', () => {
    const rec = { bend: { minFlatIn: [1.2, 5.2] }, minPartIn: [0.25, 0.375] };
    const dims = defaultBaseDims(rec, 40);
    assert.ok(Math.abs(dims.width - 5.2 * 25.4) < 1e-6);
    assert.ok(Math.abs(dims.height - 1.2 * 25.4) < 1e-6);
    const ends = baseSliderRange(rec);
    assert.ok(Math.abs(ends.widthMin - 5.2 * 25.4) < 1e-6);
    assert.ok(Math.abs(ends.heightMin - 1.2 * 25.4) < 1e-6);
    assert.equal(ends.max, 1200);
    assert.equal(baseSliderRange(null).widthMin, 1);
  });

  it('matches the old tab and hole seeds at L = 100', () => {
    assert.deepEqual(tabDraftSize(100), { width: 25, depth: 10 });
    assert.deepEqual(tabDraftSize(10), { width: 4, depth: 10 });
    assert.deepEqual(tabDraftSize(100, 40), { width: 10, depth: 4 });
    assert.equal(holeDraftDiameter(1.27), 5);
    assert.equal(holeDraftDiameter(1.27, 40), 2.54);
    assert.equal(holeDraftDiameter(0, 100), 5);
  });

  it('does not let a leftover sheet-metal unit key override the global unit', () => {
    const mem = {
      store: { 'surfcad.sheetMetal.displayUnit': 'in' },
      getItem(k) { return this.store[k] ?? null; },
      setItem(k, v) { this.store[k] = String(v); },
    };
    assert.equal(loadDisplayUnit(mem), 'mm');
    assert.equal(saveDisplayUnit('in', mem), 'in');
    assert.equal(mem.store[DISPLAY_UNIT_KEY], 'in');
    assert.equal(mem.store['surfcad.sheetMetal.displayUnit'], 'in');
    assert.equal(loadDisplayUnit(mem), 'in');
  });
});
