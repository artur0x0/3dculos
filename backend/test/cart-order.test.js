/**
 * Schema checks. No live Mongo.
 * Run: cd backend && npm install && node --test test/
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';
import User from '../db/models/User.js';
import Order from '../db/models/Order.js';
import { orderQuantity } from '../services/orderPrice.js';
import { calculatePackageDimensions, calculatePackageWeight } from '../services/ups.js';
import { plainLine } from '../routes/cart.js';

const LINE = {
  lineId: '00000000-0000-4000-8000-000000000001',
  source: 'local',
  assemblyName: 'Assembly',
  partId: 'part-1',
  partName: 'Bracket',
  scriptHash: 'abc',
  qty: 2,
  addedAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-02T00:00:00.000Z'),
};

function orderShell(quantity) {
  const model = {
    script: 'return part;',
    process: 'FDM',
    material: 'PLA',
    infill: 20,
    'volume-mm3': 1000,
  };
  if (quantity !== undefined) model.quantity = quantity;
  return new Order({
    'order-number': 'ORD-TEST-0001',
    status: 'pending',
    'model-data': model,
    quote: {
      'material-cost': 1,
      'machine-cost': 1,
      subtotal: 2,
      'shipping-cost': 1,
      total: 3,
    },
    shipping: {
      address: {
        name: 'A',
        'address-1': '1 St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      },
      method: 'ground',
    },
  });
}

describe('User.cart', () => {
  test('a new user starts with an empty cart and toJSON hides it', () => {
    const user = new User({ email: 'cart@example.com' });
    assert.equal(user.cart.length, 0);
    assert.equal(user.cartVersion, 0);
    assert.equal(user.cartTombstones.length, 0);
    user.cart.push(LINE);
    const json = user.toJSON();
    assert.equal(json.cart, undefined);
    assert.equal(json.cartVersion, undefined);
    assert.equal(json.cartTombstones, undefined);
    assert.equal(json.passwordHash, undefined);
  });

  test('qty outside 1..999 fails validation without a database', async () => {
    const user = new User({ email: 'bad-qty@example.com' });
    user.cart.push({ ...LINE, qty: 0 });
    await assert.rejects(user.validate());
  });

  test('an old line and a v3 line validate and plainLine keeps both', async () => {
    const user = new User({ email: 'v3-line@example.com' });
    const quotedAt = new Date('2026-06-01T00:00:00.000Z');
    user.cart.push(LINE);
    user.cart.push({
      ...LINE,
      lineId: '00000000-0000-4000-8000-000000000002',
      qty: 4,
      scriptHash: 'quoted-hash',
      options: { process: 'FDM', material: 'PLA', infill: 20 },
      quotedUnitPrice: 9.5,
      quoteId: 'quote-9',
      quotedAt,
    });
    await user.validate();
    const plain = user.cart.map(plainLine);
    assert.equal(plain[0].options, null);
    assert.equal(plain[0].quotedUnitPrice, null);
    assert.equal(plain[0].quoteId, null);
    assert.equal(plain[0].quotedAt, null);
    assert.equal(plain[0].scriptHash, LINE.scriptHash);
    assert.equal(plain[1].qty, 4);
    assert.equal(plain[1].scriptHash, 'quoted-hash');
    assert.equal(plain[1].options.process, 'FDM');
    assert.equal(plain[1].options.material, 'PLA');
    assert.equal(plain[1].options.infill, 20);
    assert.equal(plain[1].quotedUnitPrice, 9.5);
    assert.equal(plain[1].quoteId, 'quote-9');
    assert.equal(plain[1].quotedAt, quotedAt.toISOString());
  });

  test('a 24_000 character thumbnail is accepted and 24_001 is not', async () => {
    const ok = new User({ email: 'thumb-ok@example.com' });
    ok.cart.push({ ...LINE, thumbDataUrl: 'x'.repeat(24000) });
    await ok.validate();

    const tooBig = new User({ email: 'thumb-big@example.com' });
    tooBig.cart.push({ ...LINE, thumbDataUrl: 'x'.repeat(24001) });
    await assert.rejects(tooBig.validate());
  });
});

describe('Order.quantity', () => {
  test('omitted quantity defaults to 1 and old plain objects read as 1', async () => {
    const order = orderShell();
    await order.validate();
    assert.equal(order['model-data'].quantity, 1);
    assert.equal(orderQuantity({}), 1);
    assert.equal(orderQuantity({ quantity: 4 }), 4);
  });

  test('999 is valid and 1000 is not', async () => {
    const ok = orderShell(999);
    await ok.validate();
    assert.equal(ok['model-data'].quantity, 999);
    const bad = orderShell(1000);
    await assert.rejects(bad.validate());
  });
});

describe('package size', () => {
  test('copies stack before the inch conversion and packaging is added once', () => {
    const one = calculatePackageDimensions({ width: 40, height: 200, depth: 200 }, 1, 1);
    const four = calculatePackageDimensions({ width: 40, height: 200, depth: 200 }, 1, 4);
    assert.equal(one.length, 6);
    assert.equal(four.length, 9);

    const extended = calculatePackageWeight(50 * 3);
    const unit = calculatePackageWeight(50);
    assert.equal(extended, 0.6);
    assert.ok(extended < unit * 3);
  });
});

describe('mongoose is loaded for these tests only', () => {
  test('the model registry has User and Order', () => {
    assert.equal(mongoose.modelNames().includes('User'), true);
    assert.equal(mongoose.modelNames().includes('Order'), true);
  });
});
