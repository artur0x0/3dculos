import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmFeatureEdit, openFeatureEdit } from '../src/utils/featureEdit.js';
import { parseFeatureMarkers } from '../src/utils/featureMarkers.js';
import { scsGaugeLabel } from '../src/utils/scs/scsCatalog.js';
import { createSheetSpec } from '../src/utils/sheetMetal/sheetModel.js';
import {
  pushSheetHistory,
  reopenSheetMetalMode,
  sheetStepCount,
  sheetStepHistory,
  undoSheetStep,
} from '../src/utils/sheetMetal/sheetMetalMode.js';
import { composeSheetMetalCommit, readSheetMetalSpec } from '../src/utils/sheetMetal/sheetMetalScript.js';

const alu = {
  sku: 'ALU-090',
  name: '5052 H32 Aluminum',
  thicknessMm: 2.286,
  bendable: true,
  services: ['bending'],
  bend: { radiusIn: 0.032, kFactor: 0.38 },
};

function withFeatures(base) {
  return {
    ...base,
    bends: [
      { id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20, flip: false },
      { id: 'b2', panel: 'base', edge: 'u-', angle: 90, length: 18, flip: false },
    ],
    tabs: [{ id: 't1', panel: 'base', edge: 'v+', width: 20, depth: 10, centered: true, offset: 20 }],
    holes: [],
  };
}

test('gauge label does not throw on the partial sku the ribbon used to build', () => {
  const partial = { sku: 'ALU-090', name: '5052 H32 Aluminum', bendable: true, thicknessMm: 2.286 };
  assert.equal(scsGaugeLabel(partial), '2.29 mm');
  assert.equal(
    scsGaugeLabel({ sku: 'ALU-090', thicknessIn: 0.09, thicknessMm: 2.286, gauge: 11 }),
    '0.090" · 11 ga · 2.29 mm',
  );
});

test('reopen restores the last screen and one step per bend or feature', () => {
  const spec = withFeatures(createSheetSpec(alu, 'XY', { width: 100, height: 60 }));
  const mode = reopenSheetMetalMode(spec, 'p1', {
    sku: 'ALU-090', name: '5052 H32 Aluminum', thicknessIn: 0.09, gauge: 11,
  });
  assert.equal(mode.stage, 'edit');
  assert.equal(mode.reopen, true);
  assert.equal(mode.tool, 'bend');
  assert.equal(mode.sku.thicknessIn, 0.09);
  assert.equal(mode.sku.thicknessMm, spec.t);
  assert.equal(mode.sku.gauge, 11);
  assert.equal(scsGaugeLabel(mode.sku).includes('mm'), true);
  assert.equal(sheetStepCount(mode.spec), 3);
  assert.equal(mode.step, 3);
  assert.equal(mode.history.length, 4);
  assert.equal(sheetStepCount(mode.history[0]), 0);
  assert.equal(mode.history[1].bends.length, 1);
  assert.equal(mode.history[2].bends.length, 2);
  assert.equal(mode.history[3].tabs.length, 1);

  let cur = mode;
  const counts = [sheetStepCount(cur.spec)];
  while (cur.step > 0) {
    const next = undoSheetStep(cur);
    assert.notEqual(next, cur);
    counts.push(sheetStepCount(next.spec));
    cur = next;
  }
  assert.deepEqual(counts, [3, 2, 1, 0]);
  assert.equal(cur.stage, 'edit');
  assert.equal(undoSheetStep(cur), cur);
  assert.equal(sheetStepHistory(spec).length, 4);
});

test('confirm writes the undone spec; an unchanged confirm does not touch the script', () => {
  const spec = withFeatures(createSheetSpec(alu, 'XY', { width: 100, height: 60 }));
  const composed = composeSheetMetalCommit('', spec);
  assert.equal(composed.ok, true);
  const feature = parseFeatureMarkers(composed.buffer).find((item) => item.kind === 'sheetMetal');
  const opened = openFeatureEdit(composed.buffer, feature);
  assert.equal(opened.ok, true);
  const mode = reopenSheetMetalMode(opened.spec, 'p1');
  const same = confirmFeatureEdit(composed.buffer, feature, { fields: opened.fields, spec: mode.spec });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.equal(same.buffer, composed.buffer);

  const undone = undoSheetStep(undoSheetStep(mode));
  assert.equal(sheetStepCount(undone.spec), 1);
  const wrote = confirmFeatureEdit(composed.buffer, feature, { fields: opened.fields, spec: undone.spec });
  assert.equal(wrote.ok, true);
  assert.equal(wrote.changed, true);
  assert.equal(parseFeatureMarkers(wrote.buffer).length, 1);
  const saved = readSheetMetalSpec(wrote.buffer);
  assert.equal(saved.bends.length, 1);
  assert.equal(saved.tabs.length, 0);
  assert.equal(saved.bends[0].id, 'b1');
});

test('a new step after undo drops the redo tail', () => {
  const spec = withFeatures(createSheetSpec(alu, 'XY', { width: 80, height: 50 }));
  const mode = undoSheetStep(reopenSheetMetalMode(spec, 'p1'));
  assert.equal(mode.step, 2);
  const nextSpec = { ...mode.spec, holes: [{ id: 'h1', panel: 'base', u: 0, v: 0, d: 5, type: 'hole' }] };
  const pushed = pushSheetHistory(mode, nextSpec);
  assert.equal(pushed.history.length, 4);
  assert.equal(pushed.spec.holes.length, 1);
  assert.equal(pushed.spec.tabs.length, 0);
});
