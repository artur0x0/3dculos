import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { stackAlongShortestSide } from '../src/utils/packageSize.js';
import {
  applyClientQuantity,
  clientOrderQuote,
  extendQuote,
  quantityRejectionMessage,
  QUANTITY_UNSUPPORTED_MESSAGE,
  quoteFromGeometry,
} from '../src/utils/quoteMath.js';

const BOX = { width: 40, height: 30, depth: 20 };

function unitQuote() {
  return quoteFromGeometry({
    volume: 24000,
    boundingBox: BOX,
    process: 'FDM',
    material: 'PLA',
    infill: 20,
    quantity: 1,
  });
}

describe('quote quantity', () => {
  test('omitted quantity is one copy and the box stays one part', () => {
    const once = unitQuote();
    const omitted = quoteFromGeometry({
      volume: 24000,
      boundingBox: BOX,
      process: 'FDM',
      material: 'PLA',
      infill: 20,
    });
    assert.equal(omitted.quantity, 1);
    assert.equal(omitted.subtotal, once.subtotal);
    assert.equal(omitted.unitSubtotal, once.subtotal);
    assert.deepEqual(omitted.boundingBox, once.boundingBox);
  });

  test('quantity multiplies the money, grams, and time once', () => {
    const once = unitQuote();
    const triple = quoteFromGeometry({
      volume: 24000,
      boundingBox: BOX,
      process: 'FDM',
      material: 'PLA',
      infill: 20,
      quantity: 3,
    });
    assert.equal(triple.quantity, 3);
    assert.equal(triple.unitSubtotal, once.unitSubtotal);
    assert.equal(triple.subtotal, Number((once.unitSubtotal * 3).toFixed(2)));
    assert.equal(triple.costs.total, triple.subtotal);
    assert.equal(triple.materialGrams, Number((once.unitGrams * 3).toFixed(1)));
    assert.equal(triple.printTime, Number((once.unitPrintTime * 3).toFixed(1)));
    assert.deepEqual(triple.boundingBox, once.boundingBox);
    assert.notEqual(triple.subtotal, Number((once.unitSubtotal * 9).toFixed(2)));
  });

  test('the client sends the extended subtotal so an old server charges once', () => {
    const triple = quoteFromGeometry({
      volume: 24000,
      boundingBox: BOX,
      process: 'FDM',
      material: 'PLA',
      infill: 20,
      quantity: 3,
    });
    const body = clientOrderQuote({
      materialCost: triple.costs.material,
      machineCost: triple.costs.machine,
      subtotal: triple.subtotal,
      unitSubtotal: triple.unitSubtotal,
      unitMaterial: triple.unitMaterial,
      unitMachine: triple.unitMachine,
      unitGrams: triple.unitGrams,
    }, 8.5);
    assert.equal(body.subtotal, triple.subtotal);
    assert.equal(body.unitSubtotal, triple.unitSubtotal);
    assert.notEqual(body.subtotal, triple.unitSubtotal);
    assert.equal(body.shipping, 8.5);
  });

  test('applyClientQuantity extends a quote the modal already has', () => {
    const once = unitQuote();
    const next = applyClientQuantity({
      ...once,
      materialCost: once.unitMaterial,
      machineCost: once.unitMachine,
    }, 4);
    assert.equal(next.quantity, 4);
    assert.equal(next.subtotal, Number((once.unitSubtotal * 4).toFixed(2)));
    assert.deepEqual(next.boundingBox, once.boundingBox);
  });

  test('extendQuote multiplies a unit quote once and keeps the box', () => {
    const once = unitQuote();
    const triple = extendQuote(once, 3);
    assert.equal(triple.quantity, 3);
    assert.equal(triple.unitSubtotal, once.unitSubtotal);
    assert.equal(triple.subtotal, Number((once.unitSubtotal * 3).toFixed(2)));
    assert.equal(triple.costs.total, triple.subtotal);
    assert.equal(triple.materialGrams, Number((once.unitGrams * 3).toFixed(1)));
    assert.equal(triple.printTime, Number((once.unitPrintTime * 3).toFixed(1)));
    assert.deepEqual(triple.boundingBox, once.boundingBox);
    const again = extendQuote(triple, 3);
    assert.equal(again.subtotal, triple.subtotal);
    assert.equal(again.materialGrams, triple.materialGrams);
  });

  test('extendQuote rejects a quantity outside 1..999', () => {
    assert.throws(() => extendQuote(unitQuote(), 0), /1 to 999/);
    assert.throws(() => extendQuote(unitQuote(), 1000), /1 to 999/);
  });

  test('calculateQuote uses extendQuote without this file importing the worker', () => {
    const quoting = readFileSync(new URL('../src/utils/quoting.js', import.meta.url), 'utf8');
    assert.match(quoting, /return extendQuote\(/);
    assert.match(quoting, /resolvePartMeshes\(/);
    assert.match(quoting, /meshResolveError\(/);
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    assert.equal(/from ['"][^'"]*quoting\.js['"]/.test(self), false);
    assert.equal(/from ['"][^'"]*ManifoldWorker['"]/.test(self), false);
  });

  test('a server that rejects quantity gets a clear message', () => {
    assert.equal(
      quantityRejectionMessage(400, { error: "Unexpected field 'quantity'" }),
      QUANTITY_UNSUPPORTED_MESSAGE,
    );
    assert.match(
      quantityRejectionMessage(400, { error: 'Quantity must be an integer from 1 to 999' }),
      /1 to 999/,
    );
    assert.equal(quantityRejectionMessage(400, { error: 'Model file is required' }), null);
  });

  test('copies stack on the shortest side in millimetres', () => {
    assert.deepEqual(stackAlongShortestSide({ width: 10, height: 30, depth: 20 }, 3), {
      width: 30, height: 30, depth: 20,
    });
    assert.deepEqual(stackAlongShortestSide({ width: 20, height: 10, depth: 20 }, 2), {
      width: 20, height: 20, depth: 20,
    });
    assert.deepEqual(stackAlongShortestSide({ width: 10, height: 10, depth: 20 }, 2), {
      width: 20, height: 10, depth: 20,
    });
    assert.deepEqual(stackAlongShortestSide(BOX, 1), BOX);
  });
});
