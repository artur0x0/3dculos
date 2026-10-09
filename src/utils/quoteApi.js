/**
 * POST /api/quotes — see backend/routes/quotes.js.
 *
 * Request: { scriptHash, process, material, infill, modelFile: { data, filename, contentType } }
 * Response 201: { quoteId, quotedAt, quotedUnitPrice, scriptHash, process, material, infill, ... }
 *
 * Quantity stays on the cart line. Client volume is not sent. A 404 (route
 * not deployed) is an error and must not become a cart line.
 */

export class QuoteRequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'QuoteRequestError';
    this.status = status;
  }
}

function asIso(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? value.toISOString() : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/** The fields the cart line stores. Null when the body is not that shape. */
export function parseQuoteResponse(body) {
  if (!body || typeof body !== 'object') return null;
  const quoteId = body.quoteId == null ? '' : String(body.quoteId).trim();
  const price = body.quotedUnitPrice;
  const priceNum = typeof price === 'number' ? price : Number(price);
  const quotedAt = asIso(body.quotedAt);
  if (!quoteId || quoteId.length > 128) return null;
  if (!Number.isFinite(priceNum) || priceNum < 0) return null;
  if (!quotedAt) return null;
  const infill = body.infill == null || body.infill === '' ? null : Number(body.infill);
  return {
    quoteId,
    quotedAt,
    quotedUnitPrice: priceNum,
    scriptHash: body.scriptHash == null ? '' : String(body.scriptHash),
    process: body.process == null ? '' : String(body.process),
    material: body.material == null ? '' : String(body.material),
    infill: Number.isFinite(infill) ? infill : null,
  };
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function requestPartQuote({
  scriptHash,
  process,
  material,
  infill,
  modelFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  const hash = String(scriptHash || '').trim();
  const proc = String(process || '').trim();
  const mat = String(material || '').trim();
  const data = modelFile?.data;
  if (!hash || !proc || !mat || !data) {
    throw new QuoteRequestError('scriptHash, process, material, and a model file are required');
  }
  const payload = {
    scriptHash: hash,
    process: proc,
    material: mat,
    infill,
    modelFile: {
      data,
      filename: modelFile.filename || 'part.3mf',
      contentType: modelFile.contentType
        || 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    },
  };
  let res;
  try {
    res = await fetchImpl('/api/quotes', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new QuoteRequestError('Could not reach the quote service. Nothing was added to the cart.');
  }
  const body = await readJson(res);
  if (res.status === 404) {
    throw new QuoteRequestError(
      'Quotes are not available yet. Nothing was added to the cart.',
      404,
    );
  }
  if (!res.ok) {
    const message = body && typeof body.error === 'string' && body.error.trim()
      ? body.error.trim()
      : 'Could not price this part. Nothing was added to the cart.';
    throw new QuoteRequestError(message, res.status);
  }
  const parsed = parseQuoteResponse(body);
  if (!parsed) {
    throw new QuoteRequestError(
      'The quote response was incomplete. Nothing was added to the cart.',
      res.status,
    );
  }
  if (parsed.scriptHash && parsed.scriptHash !== hash) {
    throw new QuoteRequestError(
      'The quote did not match this part. Nothing was added to the cart.',
      res.status,
    );
  }
  return parsed;
}
