import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addPartLine, emptyCart, makeCartDraft, noteLineQuote, scriptHash } from '../src/utils/cart.js';
import {
  MAX_CHECKOUT_LINES,
  buildCheckoutCreateBody,
  chargedLineIds,
  checkoutOverCap,
  checkoutPageNote,
  displayOrderLines,
  packagePreviewBody,
  planCheckout,
  sumBoxRateQuotes,
} from '../src/utils/checkoutPage.js';

function id(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const NOW = new Date('2026-10-09T12:00:00.000Z');
const FRESH = '2026-10-08T12:00:00.000Z';
const STALE = '2026-09-01T12:00:00.000Z';
const SCRIPT = 'return 1;';

function line(n, extra = {}) {
  return {
    lineId: id(n),
    source: 'local',
    assemblyName: 'Bracket Box',
    partId: `part-${n}`,
    surfId: null,
    partName: extra.partName || `Part ${n}`,
    scriptHash: scriptHash(SCRIPT),
    thumbDataUrl: null,
    qty: 1,
    options: { process: 'FDM', material: 'PLA', infill: 20 },
    quotedUnitPrice: 4.5,
    quoteId: `quote-${n}`,
    quotedAt: FRESH,
    addedAt: FRESH,
    updatedAt: FRESH,
    ...extra,
  };
}

const doc = {
  source: 'local',
  name: 'Bracket Box',
  parts: [
    { id: 'part-1', name: 'Bracket' },
    { id: 'part-2', name: 'Plate' },
  ],
};

describe('planCheckout', () => {
  test('a fresh quote checks out with the assembly closed', () => {
    const plan = planCheckout(null, {}, { lines: [line(1)], tombstones: [] }, null, NOW);
    assert.equal(plan.payable.length, 1);
    assert.equal(plan.payable[0].action, 'pay');
    assert.equal(plan.payable[0].script, null);
    assert.equal(plan.skipped.length, 0);
  });

  test('a quote-then-add line is charged from the stored quote', () => {
    const draft = makeCartDraft({
      doc: { source: 'local', name: 'Bracket Box' },
      part: { id: 'part-1', name: 'Bracket', surfId: null },
      script: SCRIPT,
      qty: 2,
      options: { process: 'FDM', material: 'PLA', infill: 20 },
      quotedUnitPrice: 6.5,
      quoteId: 'quote-added',
      quotedAt: FRESH,
      now: new Date(FRESH),
    });
    const stored = addPartLine(emptyCart(), draft, new Date(FRESH));
    assert.equal(stored.ok, true);
    const plan = planCheckout(null, {}, stored.cart, null, NOW);
    assert.equal(plan.payable.length, 1);
    assert.equal(plan.payable[0].action, 'pay');
    assert.equal(plan.payable[0].quoteId, 'quote-added');
    assert.equal(plan.payable[0].quotedUnitPrice, 6.5);
    assert.equal(plan.payable[0].qty, 2);
    const body = buildCheckoutCreateBody({
      rows: plan.payable,
      address: { name: 'Ada', street: '1 Main', city: 'Oakland', state: 'CA', zip: '94607' },
      shipping: { method: 'ground', service: 'UPS Ground', price: 8.5 },
    });
    assert.equal(body.lines[0].quoteId, 'quote-added');
    assert.equal(body.lines[0].quotedUnitPrice, 6.5);
    assert.equal(body.lines[0].quantity, 2);
    assert.equal(body.lines[0].scriptHash, scriptHash(SCRIPT));
  });

  test('an expired quote with the assembly closed is skipped', () => {
    const plan = planCheckout(null, {}, {
      lines: [line(1, { quotedAt: STALE })],
      tombstones: [],
    }, null, NOW);
    assert.equal(plan.payable.length, 0);
    assert.equal(plan.skipped[0].reason, 'closed');
    assert.equal(checkoutPageNote(plan), 'Open an assembly to check out.');
  });

  test('a changed script is re-quoted when the assembly is open', () => {
    const plan = planCheckout(doc, { 'part-1': 'return 2;' }, {
      lines: [line(1, { partName: 'Bracket' })],
      tombstones: [],
    }, null, NOW);
    assert.equal(plan.payable.length, 1);
    assert.equal(plan.payable[0].action, 'requote');
    assert.equal(plan.payable[0].hashStale, true);
    assert.equal(plan.payable[0].scriptHash, scriptHash('return 2;'));
  });

  test('an unquoted line re-quotes from the open script and assumes FDM PLA', () => {
    const plan = planCheckout(doc, { 'part-1': SCRIPT }, {
      lines: [line(1, {
        options: null,
        quotedUnitPrice: null,
        quoteId: null,
        quotedAt: null,
      })],
      tombstones: [],
    }, null, NOW);
    assert.equal(plan.payable[0].action, 'requote');
    assert.equal(plan.payable[0].options.process, 'FDM');
    assert.equal(plan.payable[0].options.material, 'PLA');
    assert.equal(plan.payable[0].options.assumed, true);
    assert.equal(plan.rows[0].quoteExpired, true);
  });

  test('a missing expired part is skipped and a fresh quote elsewhere is payable', () => {
    const plan = planCheckout(doc, { 'part-1': SCRIPT }, {
      lines: [
        line(1, { partId: 'part-1', partName: 'Bracket' }),
        line(3, { partId: 'gone', partName: 'Gone', quotedAt: STALE, quoteId: 'old' }),
        line(4, {
          partId: 'other',
          partName: 'Other',
          assemblyName: 'Other Box',
        }),
      ],
      tombstones: [],
    }, null, NOW);
    assert.deepEqual(plan.payable.map((row) => row.partName), ['Bracket', 'Other']);
    assert.deepEqual(plan.skipped.map((row) => row.reason), ['missing']);
    assert.match(checkoutPageNote(plan), /Missing parts are skipped/);
  });

  test('more than 20 payable lines is over the order cap', () => {
    const lines = Array.from({ length: 21 }, (_, index) => line(index + 1, {
      partId: `part-${index + 1}`,
      assemblyName: 'Elsewhere',
    }));
    const plan = planCheckout(null, {}, { lines, tombstones: [] }, null, NOW);
    assert.equal(plan.payable.length, 21);
    assert.equal(checkoutOverCap(plan.payable), true);
    assert.equal(MAX_CHECKOUT_LINES, 20);
  });
});

describe('checkout create body and shipping preview', () => {
  test('the create body is one lines payload and keeps the previewed shipping', () => {
    const body = buildCheckoutCreateBody({
      rows: [{
        lineId: id(1),
        partName: 'Bracket',
        assemblyName: 'Bracket Box',
        partId: 'part-1',
        source: 'local',
        surfId: null,
        scriptHash: 'abc',
        quoteId: 'quote-1',
        quotedUnitPrice: 4.5,
        quotedAt: FRESH,
        options: { process: 'FDM', material: 'PLA', infill: 20 },
        qty: 3,
      }],
      address: {
        name: 'Ada',
        street: '1 Engine Way',
        city: 'Oakland',
        state: 'CA',
        zip: '94607',
      },
      shipping: { method: 'ground', service: 'UPS Ground', price: 17, estimatedDelivery: 'Friday' },
    });
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].quantity, 3);
    assert.equal(body.lines[0].quotedUnitPrice, 4.5);
    assert.equal(body.modelData, undefined);
    assert.equal(body.shipping.price, 17);
    assert.equal(body.shipping.address.country, 'US');
    assert.equal(body.quote.shipping, 17);
  });

  test('preview grams are not multiplied again', () => {
    const body = packagePreviewBody([{
      boundingBox: { width: 40, height: 30, depth: 20 },
      materialGrams: 12.5,
      quantity: 3,
    }]);
    assert.equal(body.lines[0].materialGrams, 12.5);
    assert.equal(body.lines[0].quantity, 3);
  });

  test('two boxes sum the same method', () => {
    const rates = sumBoxRateQuotes([
      [{ code: 'ground', name: 'UPS Ground', price: 8.5, carrier: 'UPS' }],
      [{ code: 'ground', name: 'UPS Ground', price: 8.25, carrier: 'UPS' }],
    ]);
    assert.equal(rates.length, 1);
    assert.equal(rates[0].price, 16.75);
    assert.equal(rates[0].boxCount, 2);
  });
});

describe('orders list and quote write-back', () => {
  test('old orders synthesize one line from model-data', () => {
    const lines = displayOrderLines({
      'order-number': 'ORD-1',
      'model-data': {
        process: 'FDM',
        material: 'PLA',
        quantity: 4,
        'model-file': { filename: 'bracket.3mf' },
      },
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].synthesized, true);
    assert.equal(lines[0].partName, 'bracket.3mf');
    assert.equal(lines[0].quantity, 4);
    assert.equal(lines[0].process, 'FDM');
  });

  test('new orders list stored lines and ignore model-data', () => {
    const lines = displayOrderLines({
      lines: [
        { lineId: id(1), partName: 'Bracket', process: 'FDM', material: 'PLA', infill: 20, quantity: 2, 'unit-subtotal': 4.5 },
        { lineId: id(2), partName: 'Plate', process: 'FDM', material: 'PETG', infill: 40, quantity: 1, 'unit-subtotal': 3 },
      ],
      'model-data': { process: 'SLA', material: 'Resin', quantity: 9 },
    });
    assert.deepEqual(lines.map((row) => row.partName), ['Bracket', 'Plate']);
    assert.equal(lines[0].synthesized, false);
    assert.equal(lines[0].quantity, 2);
  });

  test('a confirmed re-quote replaces the cart line price', () => {
    const cart = { version: 1, lines: [line(1)], tombstones: [] };
    const next = noteLineQuote(cart, id(1), {
      quoteId: 'quote-new',
      quotedAt: FRESH,
      quotedUnitPrice: 6.25,
      scriptHash: scriptHash('return 2;'),
      process: 'FDM',
      material: 'PETG',
      infill: 30,
    }, NOW);
    assert.equal(next.lines[0].quoteId, 'quote-new');
    assert.equal(next.lines[0].quotedUnitPrice, 6.25);
    assert.equal(next.lines[0].options.material, 'PETG');
    assert.equal(next.lines[0].scriptHash, scriptHash('return 2;'));
  });

  test('charged ids come from the create response lines', () => {
    assert.deepEqual(chargedLineIds({
      lines: [{ lineId: id(1) }, { lineId: '' }, { partName: 'No id' }],
    }), [id(1)]);
  });
});
