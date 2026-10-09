import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseQuoteResponse, QuoteRequestError, requestPartQuote } from '../src/utils/quoteApi.js';

const MODEL = {
  data: 'abc',
  filename: 'Bracket.3mf',
  contentType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
};

function fetchJson(status, body, sink) {
  return async (url, init) => {
    sink.url = url;
    sink.init = init;
    sink.body = JSON.parse(init.body);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
}

describe('POST /api/quotes', () => {
  test('the request matches the quotes route and the response is the cart price', async () => {
    const sink = {};
    const quote = await requestPartQuote({
      scriptHash: 'hash-1',
      process: 'FDM',
      material: 'PLA',
      infill: 20,
      modelFile: MODEL,
      fetchImpl: fetchJson(201, {
        success: true,
        quoteId: 'quote-1',
        quotedAt: '2026-10-09T12:00:00.000Z',
        quotedUnitPrice: 6.5,
        scriptHash: 'hash-1',
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        unitMaterial: 2,
        unitMachine: 4.5,
        unitGrams: 11,
      }, sink),
    });
    assert.equal(sink.url, '/api/quotes');
    assert.equal(sink.init.method, 'POST');
    assert.equal(sink.body.scriptHash, 'hash-1');
    assert.equal(sink.body.process, 'FDM');
    assert.equal(sink.body.material, 'PLA');
    assert.equal(sink.body.infill, 20);
    assert.equal(sink.body.modelFile.data, 'abc');
    assert.equal(sink.body.modelFile.filename, 'Bracket.3mf');
    assert.equal(Object.hasOwn(sink.body, 'volume'), false);
    assert.equal(Object.hasOwn(sink.body, 'quantity'), false);
    assert.equal(quote.quoteId, 'quote-1');
    assert.equal(quote.quotedUnitPrice, 6.5);
    assert.equal(quote.quotedAt, '2026-10-09T12:00:00.000Z');
    assert.equal(quote.scriptHash, 'hash-1');
  });

  test('a 404 is an error and does not return a quote', async () => {
    await assert.rejects(
      () => requestPartQuote({
        scriptHash: 'hash-1',
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        modelFile: MODEL,
        fetchImpl: fetchJson(404, {}, {}),
      }),
      (err) => err instanceof QuoteRequestError && err.status === 404,
    );
  });

  test('an incomplete body is an error', async () => {
    await assert.rejects(
      () => requestPartQuote({
        scriptHash: 'hash-1',
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        modelFile: MODEL,
        fetchImpl: fetchJson(201, { success: true, quoteId: 'quote-1' }, {}),
      }),
      (err) => err instanceof QuoteRequestError,
    );
  });

  test('a hash the server did not store is an error', async () => {
    await assert.rejects(
      () => requestPartQuote({
        scriptHash: 'hash-1',
        process: 'FDM',
        material: 'PLA',
        infill: 20,
        modelFile: MODEL,
        fetchImpl: fetchJson(201, {
          quoteId: 'quote-1',
          quotedAt: '2026-10-09T12:00:00.000Z',
          quotedUnitPrice: 1,
          scriptHash: 'other',
        }, {}),
      }),
      (err) => err instanceof QuoteRequestError,
    );
  });

  test('parseQuoteResponse keeps a zero unit price and drops a partial body', () => {
    const zero = parseQuoteResponse({
      quoteId: 'q0',
      quotedAt: '2026-10-09T12:00:00.000Z',
      quotedUnitPrice: 0,
    });
    assert.equal(zero.quotedUnitPrice, 0);
    assert.equal(parseQuoteResponse({ quoteId: 'q', quotedUnitPrice: 1 }), null);
    assert.equal(parseQuoteResponse(null), null);
  });
});
