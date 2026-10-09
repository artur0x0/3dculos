/**
 * Multi-line checkout: one PaymentIntent, server prices, box splits,
 * the 20-line cap, a 7-day quote, and old single-part orders.
 *
 * Run: cd backend && npm ci && node --test test/*.js
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import JSZip from 'jszip';
import Order from '../db/models/Order.js';
import Quote from '../db/models/Quote.js';
import { checkoutLines, idempotentReplay } from '../services/multiLineCheckout.js';
import { priceMultiLineOrder } from '../services/orderPrice.js';
import { createPaymentIntent } from '../services/stripe.js';
import { packOrderBoxes } from '../services/packOrder.js';
import { ratePackedBoxes, sumBoxRates } from '../services/combinedShipping.js';
import { mockRatesForPackage } from '../services/ups.js';
import { QUOTE_TTL_MS, isQuoteExpired } from '../services/cartMerge.js';
import {
  MAX_ORDER_LINES,
  USER_ORDERS_SELECT,
  pickModelFile,
  readOrderLines,
} from '../services/orderLines.js';
import { verifyModelLink, MODEL_LINK_TTL_MS } from '../services/modelLink.js';
import { lineTableHtml, fulfillmentDownloads } from '../services/orderMail.js';
import { modelFileForDownload, parseDownloadArgs } from '../download-model.js';
import { calculateTax } from '../config/taxRates.js';
import { quoteFromGeometry, roundMoney } from '../../src/utils/quoteMath.js';

const CUBE_XML = `
  <model>
    <mesh>
      <vertices>
        <vertex x="0" y="0" z="0"/>
        <vertex x="10" y="0" z="0"/>
        <vertex x="10" y="10" z="0"/>
        <vertex x="0" y="10" z="0"/>
        <vertex x="0" y="0" z="10"/>
        <vertex x="10" y="0" z="10"/>
        <vertex x="10" y="10" z="10"/>
        <vertex x="0" y="10" z="10"/>
      </vertices>
      <triangles>
        <triangle v1="0" v2="2" v3="1"/>
        <triangle v1="0" v2="3" v3="2"/>
        <triangle v1="4" v2="5" v3="6"/>
        <triangle v1="4" v2="6" v3="7"/>
        <triangle v1="0" v2="1" v3="5"/>
        <triangle v1="0" v2="5" v3="4"/>
        <triangle v1="3" v2="6" v3="2"/>
        <triangle v1="3" v2="7" v3="6"/>
        <triangle v1="0" v2="4" v3="7"/>
        <triangle v1="0" v2="7" v3="3"/>
        <triangle v1="1" v2="2" v3="6"/>
        <triangle v1="1" v2="6" v3="5"/>
      </triangles>
    </mesh>
  </model>`;

function cubeXml(size) {
  const s = String(size);
  return CUBE_XML.replaceAll('10', s);
}

async function zipModel(xml) {
  const zip = new JSZip();
  zip.file('3D/3dmodel.model', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return buffer.toString('base64');
}

const USER = '507f1f77bcf86cd799439011';
const ADDRESS = {
  name: 'A',
  street: '1 St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  country: 'US',
};

function freshQuote({ quoteId, file, hash = 'hash-1', quotedAt }) {
  return {
    'user-id': USER,
    quoteId,
    scriptHash: hash,
    quotedAt: quotedAt || new Date(Date.now() - 60 * 60 * 1000),
    quotedUnitPrice: 1,
    'model-file': { data: file, filename: 'part.3mf' },
  };
}

function shipping(extra = {}) {
  return { address: ADDRESS, method: 'ground', ...extra };
}

function mockRate(_address, packageInfo) {
  return mockRatesForPackage(packageInfo);
}

async function threeLineCheckout(file, { quotedUnitPrice, shipPrice, otherFile } = {}) {
  const quotes = {
    q1: freshQuote({ quoteId: 'q1', file, hash: 'h1' }),
    q2: freshQuote({ quoteId: 'q2', file, hash: 'h2' }),
    q3: freshQuote({ quoteId: 'q3', file, hash: 'h3' }),
  };
  const specs = [
    { lineId: 'l1', partName: 'Bracket', quoteId: 'q1', scriptHash: 'h1', material: 'PLA', quantity: 1 },
    { lineId: 'l2', partName: 'Clip', quoteId: 'q2', scriptHash: 'h2', material: 'PETG', quantity: 2 },
    { lineId: 'l3', partName: 'Hook', quoteId: 'q3', scriptHash: 'h3', material: 'ABS', quantity: 3 },
  ];
  return checkoutLines({
    userId: USER,
    shipping: shipping(shipPrice == null ? {} : { price: shipPrice }),
    rateFn: mockRate,
    loadQuote: async (id) => quotes[id] || null,
    lines: specs.map((spec) => ({
      ...spec,
      process: 'FDM',
      infill: 20,
      quotedAt: quotes[spec.quoteId].quotedAt,
      quotedUnitPrice,
      modelFile: otherFile ? { data: otherFile, filename: 'tampered.3mf' } : undefined,
    })),
  });
}

function orderFrom(result, id = 'order-id-1') {
  return {
    _id: id,
    'order-number': 'ORD-TEST-0001',
    quote: { total: result.priced.total },
    lines: result.orderLines,
    shipping: {
      address: {
        name: 'A',
        'address-1': '1 St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        country: 'US',
      },
    },
  };
}

function fakeStripe(calls) {
  return {
    paymentIntents: {
      create: async (params, opts) => {
        calls.push({ params, opts });
        return { id: 'pi_test', client_secret: 'sec_test' };
      },
    },
  };
}

describe('3-line order, one PaymentIntent', () => {
  test('the PaymentIntent amount is the server total of all three lines', async () => {
    const file = await zipModel(CUBE_XML);
    const bigger = await zipModel(cubeXml(20));
    const result = await threeLineCheckout(file, { otherFile: bigger });
    assert.equal(result.ok, true);
    assert.equal(result.orderLines.length, 3);
    assert.equal(result.priced.priceUpdated, false);
    for (const line of result.orderLines) {
      assert.equal(line['volume-mm3'], 1000);
    }

    const box = { width: 10, height: 10, depth: 10 };
    const quotes = ['PLA', 'PETG', 'ABS'].map((material, index) => quoteFromGeometry({
      volume: 1000,
      boundingBox: box,
      process: 'FDM',
      material,
      infill: 20,
      quantity: index + 1,
    }));
    const subtotal = roundMoney(quotes.reduce((sum, quote) => sum + quote.subtotal, 0));
    const packed = packOrderBoxes(quotes.map((quote, index) => ({
      boundingBox: box,
      quantity: index + 1,
      grams: quote.materialGrams,
    })));
    assert.equal(packed.length, 1);
    const ground = mockRatesForPackage({
      dimensions: packed[0].dimensions,
      weight: packed[0].weight,
    }).find((rate) => rate.code === 'ground');
    const { tax } = calculateTax(roundMoney(subtotal + ground.price), 'TX', 'US');
    const total = roundMoney(subtotal + ground.price + tax);
    assert.equal(result.priced.subtotal, subtotal);
    assert.equal(result.priced.shipping, ground.price);
    assert.equal(result.priced.tax, tax);
    assert.equal(result.priced.total, total);

    const calls = [];
    const payment = await createPaymentIntent(orderFrom(result), {
      stripeClient: fakeStripe(calls),
      customerEmail: 'a@example.com',
    });
    assert.equal(calls.length, 1);
    assert.equal(payment.paymentIntentId, 'pi_test');
    assert.equal(calls[0].params.amount, Math.round(total * 100));
    assert.equal(calls[0].params.amount, result.priced.stripeAmountCents);
    assert.equal(calls[0].opts.idempotencyKey, 'order_order-id-1');
    assert.equal(calls[0].params.metadata.orderId, 'order-id-1');
    assert.equal(calls[0].params.metadata.lineCount, '3');
    assert.match(calls[0].params.metadata.lines, /Bracket×1/);
    assert.match(calls[0].params.metadata.lines, /Clip×2/);
    assert.match(calls[0].params.metadata.lines, /Hook×3/);
    assert.doesNotMatch(calls[0].params.metadata.lines, /\$/);
    assert.match(calls[0].params.description, /3 lines/);
  });

  test('a singular order still uses quantity metadata and no idempotency key', async () => {
    const calls = [];
    await createPaymentIntent({
      _id: 'single',
      'order-number': 'ORD-ONE',
      quote: { total: 12.34 },
      'model-data': { process: 'FDM', material: 'PLA', quantity: 2 },
      shipping: {
        address: {
          name: 'A',
          'address-1': '1 St',
          city: 'Austin',
          state: 'TX',
          zip: '78701',
          country: 'US',
        },
      },
    }, { stripeClient: fakeStripe(calls), customerEmail: 'a@example.com' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts, undefined);
    assert.equal(calls[0].params.metadata.quantity, '2');
    assert.equal(calls[0].params.amount, 1234);
    assert.match(calls[0].params.description, /×2/);
    assert.equal(calls[0].params.metadata.lineCount, undefined);
  });
});

describe('client money is ignored', () => {
  test('a tampered unit price and shipping preview do not change the charge', async () => {
    const file = await zipModel(CUBE_XML);
    const honest = await threeLineCheckout(file);
    const tampered = await threeLineCheckout(file, { quotedUnitPrice: 0.01, shipPrice: 0.01 });
    assert.equal(tampered.ok, true);
    assert.equal(tampered.priced.priceUpdated, true);
    assert.equal(tampered.priced.total, honest.priced.total);
    assert.notEqual(tampered.priced.total, roundMoney(0.01 * (1 + 2 + 3) + 0.01));
    assert.ok(tampered.priced.total > 1);
  });

  test('one cent is rounding and two cents sets priceUpdated', () => {
    const line = quoteFromGeometry({
      volume: 1000,
      boundingBox: { width: 10, height: 10, depth: 10 },
      process: 'FDM',
      material: 'PLA',
      infill: 20,
      quantity: 1,
    });
    const same = priceMultiLineOrder({
      lineQuotes: [line],
      shippingCost: 5,
      state: 'OR',
      clientLines: [{ quotedUnitPrice: line.unitSubtotal }],
      clientShipping: 5,
    });
    const penny = priceMultiLineOrder({
      lineQuotes: [line],
      shippingCost: 5,
      state: 'OR',
      clientLines: [{ quotedUnitPrice: roundMoney(line.unitSubtotal + 0.01) }],
      clientShipping: 5.01,
    });
    const two = priceMultiLineOrder({
      lineQuotes: [line],
      shippingCost: 5,
      state: 'OR',
      clientLines: [{ quotedUnitPrice: roundMoney(line.unitSubtotal + 0.02) }],
      clientShipping: 5,
    });
    assert.equal(same.priceUpdated, false);
    assert.equal(penny.priceUpdated, false);
    assert.equal(two.priceUpdated, true);
    assert.equal(two.total, same.total);
  });
});

describe('UPS box split', () => {
  test('an oversize or overweight order splits into N boxes, sums the rates, and does not error', async () => {
    const heavy = [
      { boundingBox: { width: 40, height: 40, depth: 40 }, quantity: 1, grams: 80_000 },
      { boundingBox: { width: 40, height: 40, depth: 40 }, quantity: 1, grams: 80_000 },
    ];
    const huge = [
      { boundingBox: { width: 3000, height: 20, depth: 20 }, quantity: 1, grams: 10 },
      { boundingBox: { width: 3000, height: 20, depth: 20 }, quantity: 1, grams: 10 },
    ];

    for (const lines of [heavy, huge]) {
      const boxes = packOrderBoxes(lines);
      assert.ok(boxes.length >= 2, `expected a split, got ${boxes.length} box`);
      const rates = await ratePackedBoxes(ADDRESS, boxes, mockRate);
      const perBox = boxes.map((box) => mockRatesForPackage({
        dimensions: box.dimensions,
        weight: box.weight,
      }));
      const summed = sumBoxRates(perBox);
      const ground = rates.find((rate) => rate.code === 'ground');
      assert.equal(ground.price, summed.find((rate) => rate.code === 'ground').price);
      assert.equal(ground.boxCount, boxes.length);
      const manual = roundMoney(perBox.reduce((sum, boxRates) => (
        sum + boxRates.find((rate) => rate.code === 'ground').price
      ), 0));
      assert.equal(ground.price, manual);
      assert.ok(ground.price > perBox[0].find((rate) => rate.code === 'ground').price);
    }

    const file = await zipModel(CUBE_XML);
    let measured = 0;
    const splitCheckout = await checkoutLines({
      userId: USER,
      shipping: shipping(),
      rateFn: mockRate,
      loadQuote: async () => null,
      measure: async () => {
        measured += 1;
        return {
          ok: true,
          geometry: {
            volume: 256 ** 3,
            boundingBox: { width: 256, height: 256, depth: 256 },
          },
        };
      },
      lines: Array.from({ length: 7 }, (_, index) => ({
        lineId: `heavy-${index}`,
        partName: `Block ${index}`,
        scriptHash: 'h',
        process: 'FDM',
        material: 'PLA',
        infill: 100,
        quantity: 1,
        modelFile: { data: file },
      })),
    });
    assert.equal(splitCheckout.ok, true, splitCheckout.error);
    assert.equal(splitCheckout.error, undefined);
    assert.equal(measured, 7);
    assert.ok(splitCheckout.boxes.length >= 2);
    assert.equal(splitCheckout.priced.shipping, splitCheckout.selectedRate.price);
    assert.equal(splitCheckout.selectedRate.boxCount, splitCheckout.boxes.length);
  });
});

describe('order line cap', () => {
  test('21 lines are rejected before any line is measured', async () => {
    assert.equal(MAX_ORDER_LINES, 20);
    let measured = 0;
    const lines = Array.from({ length: 21 }, (_, index) => ({
      lineId: `l${index}`,
      process: 'FDM',
      material: 'PLA',
      quantity: 1,
      modelFile: { data: 'x' },
    }));
    const result = await checkoutLines({
      userId: USER,
      lines,
      shipping: shipping(),
      measure: async () => {
        measured += 1;
        return { ok: true, geometry: { volume: 1, boundingBox: { width: 1, height: 1, depth: 1 } } };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /20/);
    assert.equal(measured, 0);
  });
});

describe('quote TTL', () => {
  test('a quote over 7 days is re-quoted from the fresh 3MF', async () => {
    const storedFile = await zipModel(CUBE_XML);
    const freshFile = await zipModel(cubeXml(20));
    const now = Date.now();
    const atTtl = new Date(now - QUOTE_TTL_MS);
    const pastTtl = new Date(now - QUOTE_TTL_MS - 1);
    assert.equal(isQuoteExpired({ quoteId: 'q', quotedAt: atTtl }, now), false);
    assert.equal(isQuoteExpired({ quoteId: 'q', quotedAt: pastTtl }, now), true);

    const expiredAt = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const expired = {
      'user-id': USER,
      quoteId: 'old-quote',
      scriptHash: 'hash',
      quotedAt: expiredAt,
      quotedUnitPrice: 1,
      'volume-mm3': 1,
      'model-file': { data: storedFile },
    };
    const result = await checkoutLines({
      userId: USER,
      now,
      shipping: shipping(),
      rateFn: mockRate,
      loadQuote: async () => expired,
      lines: [{
        lineId: 'l1',
        partName: 'Grown',
        scriptHash: 'hash',
        quoteId: 'old-quote',
        quotedAt: expiredAt,
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        quantity: 1,
        quotedUnitPrice: 999,
        modelFile: { data: freshFile, filename: 'fresh.3mf' },
      }],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.orderLines[0]['volume-mm3'], 8000);
    assert.equal(result.orderLines[0].requoted, true);
    assert.notEqual(result.orderLines[0].quoteId, 'old-quote');
    assert.equal(result.quotesToSave.length, 1);
    assert.equal(result.quotesToSave[0]['volume-mm3'], 8000);
    assert.equal(result.quotesToSave[0]['model-file'].data, freshFile);
    assert.equal(result.priced.priceUpdated, true);

    const stillQuotedAt = new Date(now - 6 * 24 * 60 * 60 * 1000);
    const stillFresh = {
      ...expired,
      quotedAt: stillQuotedAt,
    };
    const kept = await checkoutLines({
      userId: USER,
      now,
      shipping: shipping(),
      rateFn: mockRate,
      loadQuote: async () => stillFresh,
      lines: [{
        lineId: 'l1',
        partName: 'Grown',
        scriptHash: 'hash',
        quoteId: 'old-quote',
        quotedAt: stillQuotedAt,
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        quantity: 1,
        modelFile: { data: freshFile },
      }],
    });
    assert.equal(kept.ok, true, kept.error);
    assert.equal(kept.orderLines[0]['volume-mm3'], 1000);
    assert.equal(kept.orderLines[0].requoted, false);
    assert.equal(kept.orderLines[0].quoteId, 'old-quote');
    assert.equal(kept.quotesToSave.length, 0);
  });

  test('the quotes collection TTL is 7 days', () => {
    const ttl = Quote.schema.indexes().find((entry) => entry[0].quotedAt === 1);
    assert.ok(ttl);
    assert.equal(ttl[1].expireAfterSeconds, QUOTE_TTL_MS / 1000);
    assert.equal(QUOTE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  });
});

describe('old orders stay readable', () => {
  test('no lines array synthesizes one line from model-data', async () => {
    const plain = {
      'order-number': 'ORD-OLD',
      'model-data': {
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        'volume-mm3': 50,
        'model-file': { data: 'OLDFILE', filename: 'legacy.3mf' },
      },
      quote: {
        subtotal: 6,
        'material-cost': 2,
        'machine-cost': 4,
        'shipping-cost': 1,
        total: 7,
      },
    };
    const omitted = readOrderLines(plain);
    assert.equal(omitted.length, 1);
    assert.equal(omitted[0].synthesized, true);
    assert.equal(omitted[0].quantity, 1);
    assert.equal(omitted[0].partName, 'legacy.3mf');
    assert.equal(omitted[0]['model-file'].data, 'OLDFILE');
    assert.equal(pickModelFile(plain, '').data, 'OLDFILE');
    assert.equal(pickModelFile(plain, 'anything'), null);

    plain['model-data'].quantity = 3;
    assert.equal(readOrderLines(plain)[0].quantity, 3);

    const stored = new Order({
      'order-number': 'ORD-LINES-1',
      lines: [{
        lineId: 'line-a',
        partName: 'Bracket',
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        quantity: 2,
        'volume-mm3': 1000,
        'unit-subtotal': 1.5,
        'material-cost': 0.4,
        'machine-cost': 1.1,
        'model-file': { data: 'NEWER', filename: 'bracket.3mf' },
      }, {
        lineId: 'line-b',
        partName: 'Clip',
        process: 'FDM',
        material: 'PETG',
        infill: 20,
        quantity: 4,
        'volume-mm3': 1000,
        'unit-subtotal': 2,
        'material-cost': 0.5,
        'machine-cost': 1.5,
        'model-file': { data: 'CLIP', filename: 'clip.3mf' },
      }],
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
    await stored.validate();
    assert.equal(stored['model-data'], undefined);
    const json = stored.toJSON();
    assert.equal(json.lines[0]['model-file'], undefined);
    assert.equal(json.lines[1]['model-file'], undefined);
    assert.equal(stored.lines[0]['model-file'].data, 'NEWER');
    assert.equal(readOrderLines(stored).length, 2);
    assert.equal(pickModelFile(stored, 'line-b').data, 'CLIP');
    assert.match(USER_ORDERS_SELECT, /-lines\.model-file/);
    assert.match(USER_ORDERS_SELECT, /-model-data\.model-file/);

    const secret = 'session-secret';
    const now = 1_700_000_000_000;
    const admin = lineTableHtml(stored, {
      downloads: true,
      secret,
      now,
      origin: 'https://api.example',
    });
    assert.equal((admin.match(/Download 3MF/g) || []).length, 2);
    assert.match(admin, /Bracket/);
    assert.match(admin, /Qty 4/);
    const customer = lineTableHtml(stored);
    assert.doesNotMatch(customer, /orders\/model/);
    const links = fulfillmentDownloads(stored, { secret, now, origin: 'https://api.example' });
    assert.equal(links.length, 2);
    assert.equal(links[0].exp - now, MODEL_LINK_TTL_MS);
    assert.equal(verifyModelLink({
      orderNumber: 'ORD-LINES-1',
      lineId: 'line-a',
      exp: links[0].exp,
      sig: links[0].sig,
      secret,
      now,
    }), true);
    assert.equal(verifyModelLink({
      orderNumber: 'ORD-LINES-1',
      lineId: 'line-a',
      exp: links[0].exp,
      sig: 'nope',
      secret,
      now,
    }), false);
    assert.equal(verifyModelLink({
      orderNumber: 'ORD-LINES-1',
      lineId: 'line-a',
      exp: links[0].exp,
      sig: links[0].sig,
      secret,
      now: links[0].exp + 1,
    }), false);

    const oldLinks = fulfillmentDownloads(plain, { secret, now, origin: '' });
    assert.equal(oldLinks.length, 1);
    assert.doesNotMatch(oldLinks[0].url, /line=/);
    assert.equal(verifyModelLink({
      orderNumber: 'ORD-OLD',
      lineId: '',
      exp: oldLinks[0].exp,
      sig: oldLinks[0].sig,
      secret,
      now,
    }), true);

    assert.deepEqual(parseDownloadArgs(['node', 'download-model.js', 'ORD-1', '--line', 'line-a', 'out.3mf']), {
      orderNumber: 'ORD-1',
      lineId: 'line-a',
      outputPath: 'out.3mf',
    });
    const multi = modelFileForDownload({
      lines: stored.lines.map((line) => line.toObject()),
    }, null);
    assert.equal(multi.needsLine, true);
    const one = modelFileForDownload(plain, null);
    assert.equal(one.ok, true);
    assert.equal(one.quantity, 3);
    assert.equal(one.file.data, 'OLDFILE');
  });
});

describe('idempotent replay', () => {
  test('a paid order is returned without a new PaymentIntent', () => {
    assert.equal(idempotentReplay(null), null);
    assert.deepEqual(idempotentReplay({
      status: 'pending',
      payment: { 'stripe-payment-intent-id': 'pi_1' },
    }), { kind: 'pending', paymentIntentId: 'pi_1' });
    assert.deepEqual(idempotentReplay({
      status: 'paid',
      payment: { 'stripe-payment-intent-id': 'pi_1', 'paid-at': new Date() },
    }), { kind: 'paid' });
    const idem = Order.schema.indexes().find((entry) => entry[0]['metadata.idempotency-key'] === 1);
    assert.equal(idem[1].unique, true);
    assert.equal(idem[1].sparse, true);
  });
});
