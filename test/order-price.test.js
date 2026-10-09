import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { priceOrder } from '../backend/services/orderPrice.js';
import { quoteFromGeometry } from '../src/utils/quoteMath.js';

const geometry = {
  volume: 24000,
  boundingBox: { width: 40, height: 30, depth: 20 },
  process: 'FDM',
  material: 'PLA',
  infill: 20,
};

describe('server price ignores the client', () => {
  test('a tampered client price cannot change the charged amount', () => {
    const honest = priceOrder({
      ...geometry,
      quantity: 3,
      shippingCost: 12.4,
      state: 'OR',
      clientQuote: {},
    });
    const tampered = priceOrder({
      ...geometry,
      quantity: 3,
      shippingCost: 12.4,
      state: 'OR',
      clientQuote: {
        subtotal: 0.01,
        unitSubtotal: 0.01,
        material: 0.01,
        machine: 0.01,
        shipping: 0.01,
      },
    });

    const expected = quoteFromGeometry({ ...geometry, quantity: 3 });
    assert.equal(honest.ok, true);
    assert.equal(tampered.ok, true);
    assert.equal(tampered.quote.subtotal, expected.subtotal);
    assert.equal(tampered.quote.subtotal, Number((expected.unitSubtotal * 3).toFixed(2)));
    assert.equal(tampered.total, honest.total);
    assert.equal(tampered.stripeAmountCents, honest.stripeAmountCents);
    assert.equal(tampered.stripeAmountCents, Math.round(honest.total * 100));
    assert.notEqual(tampered.stripeAmountCents, 1);
    assert.notEqual(tampered.total, 0.01);
    assert.equal(tampered.priceUpdated, true);
    assert.equal(tampered.shipping, 12.4);
  });

  test('a one-cent gap is rounding and does not flag a price update', () => {
    const server = quoteFromGeometry({ ...geometry, quantity: 1 });
    const priced = priceOrder({
      ...geometry,
      quantity: 1,
      shippingCost: 5,
      state: 'OR',
      clientQuote: {
        unitSubtotal: server.unitSubtotal + 0.01,
        shipping: 5,
      },
    });
    assert.equal(priced.priceUpdated, false);
    assert.equal(priced.quote.unitSubtotal, server.unitSubtotal);
    assert.equal(priced.total, Number((server.subtotal + 5).toFixed(2)));
  });

  test('quantity omitted is one copy', () => {
    const priced = priceOrder({
      ...geometry,
      shippingCost: 0,
      state: 'OR',
    });
    assert.equal(priced.quantity, 1);
    assert.equal(priced.quote.subtotal, priced.quote.unitSubtotal);
  });
});
