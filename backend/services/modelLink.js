/**
 * Signed 3MF download. The signature is the capability: no session cookie.
 * HMAC-SHA256 over `orderNumber|lineId|exp` with the server session secret.
 * `exp` is milliseconds. A wrong signature and a past exp both fail the same way.
 */
import crypto from 'crypto';

export const MODEL_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function signModelLink({ orderNumber, lineId = '', exp, secret }) {
  const payload = `${orderNumber}|${lineId || ''}|${exp}`;
  return crypto.createHmac('sha256', String(secret || '')).update(payload).digest('hex');
}

export function verifyModelLink({ orderNumber, lineId = '', exp, sig, secret, now = Date.now() }) {
  const expNum = Number(exp);
  if (!orderNumber || !sig || !Number.isFinite(expNum) || now > expNum) return false;
  const expected = signModelLink({
    orderNumber,
    lineId: lineId || '',
    exp: expNum,
    secret,
  });
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function modelDownloadPath({ orderNumber, lineId = '', exp, sig }) {
  const params = new URLSearchParams({
    order: String(orderNumber),
    exp: String(exp),
    sig: String(sig),
  });
  if (lineId) params.set('line', String(lineId));
  return `/api/orders/model?${params.toString()}`;
}

export function buildModelDownloadUrl({
  orderNumber,
  lineId = '',
  secret,
  now = Date.now(),
  origin = '',
  ttlMs = MODEL_LINK_TTL_MS,
}) {
  const exp = now + ttlMs;
  const sig = signModelLink({ orderNumber, lineId, exp, secret });
  const path = modelDownloadPath({ orderNumber, lineId, exp, sig });
  const base = String(origin || '').replace(/\/$/, '');
  return { url: `${base}${path}`, exp, sig };
}
