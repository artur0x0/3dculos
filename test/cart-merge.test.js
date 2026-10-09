import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_CART_LINES,
  QUOTE_TTL_MS,
  THUMB_MAX_CHARS,
  isQuoteExpired,
  mergeCart,
  pruneTombstones,
  stripThumb,
  validateCartPayload,
} from '../backend/services/cartMerge.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function id(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function line(n, updatedAt, extra = {}) {
  return {
    lineId: id(n),
    source: 'local',
    assemblyName: 'Assembly',
    partId: `part-${n}`,
    surfId: null,
    partName: `Part ${n}`,
    scriptHash: 'abc',
    thumbDataUrl: null,
    qty: 1,
    options: null,
    addedAt: '2026-06-01T00:00:00.000Z',
    updatedAt,
    ...extra,
  };
}

describe('mergeCart', () => {
  test('a line missing from the client is kept', () => {
    const server = line(1, '2026-06-10T00:00:00.000Z');
    const result = mergeCart({
      serverLines: [server],
      serverVersion: 3,
      clientLines: [],
      clientTombstones: [],
      baseVersion: 3,
      now: NOW,
    });
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].lineId, server.lineId);
    assert.equal(result.merged, false);
    assert.equal(result.version, 4);
  });

  test('later updatedAt wins, and a tie keeps the server line', () => {
    const server = line(1, '2026-06-10T00:00:00.000Z', { partName: 'server' });
    const client = line(1, '2026-06-12T00:00:00.000Z', { partName: 'client' });
    const later = mergeCart({
      serverLines: [server],
      clientLines: [client],
      serverVersion: 1,
      baseVersion: 0,
      now: NOW,
    });
    assert.equal(later.lines[0].partName, 'client');
    assert.equal(later.merged, true);

    const tie = mergeCart({
      serverLines: [server],
      clientLines: [line(1, server.updatedAt, { partName: 'client-tie' })],
      serverVersion: 1,
      baseVersion: 1,
      now: NOW,
    });
    assert.equal(tie.lines[0].partName, 'server');
  });

  test('a tombstone deletes, absence does not', () => {
    const server = line(1, '2026-06-10T00:00:00.000Z');
    const kept = mergeCart({
      serverLines: [server],
      clientLines: [],
      now: NOW,
    });
    assert.equal(kept.lines.length, 1);

    const dropped = mergeCart({
      serverLines: [server],
      clientLines: [],
      clientTombstones: [{ lineId: server.lineId, deletedAt: '2026-06-11T00:00:00.000Z' }],
      now: NOW,
    });
    assert.equal(dropped.lines.length, 0);
    assert.equal(dropped.tombstones.length, 1);
  });

  test('an edit after the tombstone keeps the line', () => {
    const result = mergeCart({
      serverLines: [line(1, '2026-06-10T00:00:00.000Z')],
      serverTombstones: [{ lineId: id(1), deletedAt: '2026-06-11T00:00:00.000Z' }],
      clientLines: [line(1, '2026-06-12T00:00:00.000Z', { partName: 'back' })],
      now: NOW,
    });
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].partName, 'back');
  });

  test('a future timestamp is clamped to now plus five minutes', () => {
    const result = mergeCart({
      serverLines: [],
      clientLines: [line(1, '2099-01-01T00:00:00.000Z')],
      now: NOW,
    });
    assert.equal(result.lines[0].updatedAt, new Date(NOW.getTime() + 5 * 60 * 1000).toISOString());
  });

  test('tombstones older than 30 days are dropped and the list caps at 200', () => {
    const old = { lineId: id(1), deletedAt: '2026-05-01T00:00:00.000Z' };
    const fresh = { lineId: id(2), deletedAt: '2026-06-01T00:00:00.000Z' };
    const pruned = pruneTombstones([old, fresh], NOW);
    assert.deepEqual(pruned.map((t) => t.lineId), [id(2)]);

    const many = [];
    for (let n = 1; n <= 205; n += 1) {
      many.push({
        lineId: id(n),
        deletedAt: new Date(NOW.getTime() - n * 1000).toISOString(),
      });
    }
    const capped = pruneTombstones(many, NOW);
    assert.equal(capped.length, 200);
    assert.equal(capped[0].lineId, id(200));
  });

  test('merged carts stay at 100 lines', () => {
    const serverLines = [];
    for (let n = 1; n <= MAX_CART_LINES; n += 1) {
      serverLines.push(line(n, new Date(NOW.getTime() - n * 1000).toISOString()));
    }
    const result = mergeCart({
      serverLines,
      clientLines: [line(101, NOW.toISOString())],
      now: NOW,
    });
    assert.equal(result.lines.length, MAX_CART_LINES);
    assert.equal(result.lines.some((l) => l.lineId === id(101)), true);
    assert.equal(result.tombstones.some((t) => t.lineId === id(100)), true);
  });
});

describe('validateCartPayload', () => {
  test('strips an oversized thumbnail and rejects 101 lines', () => {
    const body = {
      baseVersion: 0,
      lines: [line(1, '2026-06-10T00:00:00.000Z', { thumbDataUrl: 'x'.repeat(THUMB_MAX_CHARS + 1) })],
      tombstones: [],
    };
    const ok = validateCartPayload(body);
    assert.equal(ok.ok, true);
    assert.equal(ok.lines[0].thumbDataUrl, null);
    assert.equal(stripThumb('x'.repeat(THUMB_MAX_CHARS)), 'x'.repeat(THUMB_MAX_CHARS));

    const tooMany = validateCartPayload({
      baseVersion: 0,
      lines: Array.from({ length: 101 }, (_, i) => line(i + 1, '2026-06-10T00:00:00.000Z')),
    });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.status, 400);
  });

  test('If-Match must agree with baseVersion', () => {
    const body = { baseVersion: 2, lines: [], tombstones: [] };
    assert.equal(validateCartPayload(body, '4').ok, false);
    assert.equal(validateCartPayload(body, '2').ok, true);
  });

  test('a v3 line round-trips beside an old line', () => {
    const oldLine = line(1, '2026-06-10T00:00:00.000Z');
    const quoted = line(2, '2026-06-11T00:00:00.000Z', {
      qty: 3,
      scriptHash: 'deadbeef',
      options: { process: 'FDM', material: 'PLA', infill: 0 },
      quotedUnitPrice: 12.5,
      quoteId: 'quote-1',
      quotedAt: '2026-06-01T00:00:00.000Z',
    });
    const prepared = validateCartPayload({ baseVersion: 0, lines: [oldLine, quoted] });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.lines[0].options, null);
    assert.equal(prepared.lines[0].quotedUnitPrice, null);
    assert.equal(prepared.lines[0].quoteId, null);
    assert.equal(prepared.lines[0].quotedAt, null);
    assert.equal(prepared.lines[0].qty, 1);
    assert.equal(prepared.lines[1].qty, 3);
    assert.equal(prepared.lines[1].scriptHash, 'deadbeef');
    assert.equal(prepared.lines[1].options.process, 'FDM');
    assert.equal(prepared.lines[1].options.material, 'PLA');
    assert.equal(prepared.lines[1].options.infill, 0);
    assert.equal(prepared.lines[1].quotedUnitPrice, 12.5);
    assert.equal(prepared.lines[1].quoteId, 'quote-1');
    assert.equal(prepared.lines[1].quotedAt, '2026-06-01T00:00:00.000Z');

    const merged = mergeCart({
      serverLines: [],
      clientLines: prepared.lines,
      serverVersion: 0,
      baseVersion: 0,
      now: NOW,
    });
    assert.equal(merged.lines.length, 2);
    const again = validateCartPayload({ baseVersion: 0, lines: merged.lines });
    assert.equal(again.ok, true);
    assert.equal(again.lines[0].quoteId, null);
    assert.equal(again.lines[0].options, null);
    const kept = again.lines.find((row) => row.lineId === id(2));
    assert.equal(kept.quotedUnitPrice, 12.5);
    assert.equal(kept.quoteId, 'quote-1');
    assert.equal(kept.options.infill, 0);
    assert.equal(kept.scriptHash, 'deadbeef');
  });

  test('a partial quote is rejected and a future quotedAt is clamped', () => {
    const partial = validateCartPayload({
      baseVersion: 0,
      lines: [line(1, '2026-06-10T00:00:00.000Z', { quotedUnitPrice: 4 })],
    });
    assert.equal(partial.ok, false);
    assert.equal(partial.status, 400);

    const prepared = validateCartPayload({
      baseVersion: 0,
      lines: [line(1, '2026-06-10T00:00:00.000Z', {
        options: { process: 'SLA', material: 'Resin', infill: 20 },
        quotedUnitPrice: 1,
        quoteId: 'quote-future',
        quotedAt: '2099-01-01T00:00:00.000Z',
      })],
    });
    assert.equal(prepared.ok, true);
    const merged = mergeCart({
      serverLines: [],
      clientLines: prepared.lines,
      now: NOW,
    });
    assert.equal(merged.lines[0].quotedAt, new Date(NOW.getTime() + 5 * 60 * 1000).toISOString());
    assert.equal(merged.lines[0].quotedUnitPrice, 1);
  });

  test('a quote expires after 7 days, and a missing quote id is already expired', () => {
    assert.equal(QUOTE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    const freshAt = new Date(NOW.getTime() - QUOTE_TTL_MS).toISOString();
    const staleAt = new Date(NOW.getTime() - QUOTE_TTL_MS - 1).toISOString();
    const quoted = {
      quoteId: 'quote-1',
      quotedAt: freshAt,
      options: { process: 'FDM', material: 'PLA', infill: 20 },
    };
    assert.equal(isQuoteExpired(quoted, NOW), false);
    assert.equal(isQuoteExpired({ ...quoted, quotedAt: staleAt }, NOW), true);
    assert.equal(isQuoteExpired({ ...quoted, quoteId: null }, NOW), true);
    assert.equal(isQuoteExpired({ options: null }, NOW), true);
  });

  test('qty must be an integer from 1 to 999', () => {
    const bad = validateCartPayload({
      baseVersion: 0,
      lines: [line(1, '2026-06-10T00:00:00.000Z', { qty: 1000 })],
    });
    assert.equal(bad.ok, false);
    const good = validateCartPayload({
      baseVersion: 0,
      lines: [line(1, '2026-06-10T00:00:00.000Z', { qty: 999 })],
    });
    assert.equal(good.ok, true);
  });
});
