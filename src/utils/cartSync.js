/**
 * Cart sync. PUT on sign-in, focus, and online. The hook also schedules a
 * PUT after an edit so a tab that stays focused still reaches the server.
 *
 * 404: this sign-in stays on localStorage, no error, no retry.
 * 401: ask for sign-in, do not write.
 * Anything else: keep the local cart and try again later. No toast.
 */
import { interpretCartResponse } from './cartApi.js';
import { normalizeCart } from './cart.js';
import {
  hasCartUploaded,
  markCartUploaded,
  readCart,
  shouldMigrateCart,
  writeCart,
} from './cartStorage.js';

let localOnlyUserId = '';

/** Next sign-in may try `/api/cart` again. Focus and online do not. */
export function noteCartSignIn() {
  localOnlyUserId = '';
}

export function markCartSyncLocalOnly(userId) {
  localOnlyUserId = String(userId || '');
}

export function cartSyncIsLocalOnly(userId) {
  return !!userId && localOnlyUserId === String(userId);
}

export function resetCartSyncSession() {
  localOnlyUserId = '';
}

function classifyCartStatus(status) {
  if (status === 200 || status === 201) return null;
  const plan = interpretCartResponse(status);
  if (plan.localOnly) return 'local-only';
  if (plan.auth) return 'auth';
  return 'retry';
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * GET then PUT. Does not write localStorage; the caller does that only
 * when it still owns the edit. Sets the 404 session flag itself.
 * Sets the upload flag only after a migration PUT is accepted by the caller
 * (`markUploaded` on the result).
 */
export async function exchangeCart({
  userId,
  storage,
  fetchImpl = globalThis.fetch,
  onNeedLogin,
}) {
  if (!userId) return { status: 'signed-out' };
  if (cartSyncIsLocalOnly(userId)) return { status: 'local-only' };

  let got;
  try {
    got = await fetchImpl('/api/cart', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { status: 'retry' };
  }

  const gotPlan = classifyCartStatus(got.status);
  if (gotPlan) {
    if (gotPlan === 'local-only') markCartSyncLocalOnly(userId);
    if (gotPlan === 'auth') onNeedLogin?.();
    return { status: gotPlan };
  }

  const server = await readJson(got);
  if (!server || !Array.isArray(server.lines)) return { status: 'retry' };

  const local = readCart(storage, userId);
  const uploaded = hasCartUploaded(storage, userId);
  const migrate = shouldMigrateCart({
    serverLines: server.lines,
    localLines: local.lines,
    uploaded,
  });
  const baseVersion = Number(server.version) || 0;
  const body = cartSyncPayload(local, baseVersion);

  let put;
  try {
    put = await fetchImpl('/api/cart', {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'If-Match': String(baseVersion),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: 'retry' };
  }

  const putPlan = classifyCartStatus(put.status);
  if (putPlan) {
    if (putPlan === 'local-only') markCartSyncLocalOnly(userId);
    if (putPlan === 'auth') onNeedLogin?.();
    return { status: putPlan };
  }

  const merged = await readJson(put);
  if (!merged || !Array.isArray(merged.lines)) return { status: 'retry' };

  return {
    status: 'ok',
    migrated: migrate,
    markUploaded: migrate || server.lines.length > 0,
    cart: {
      version: Number(merged.version) || 0,
      lines: merged.lines,
      tombstones: Array.isArray(merged.tombstones) ? merged.tombstones : [],
    },
  };
}

/**
 * PUT body. Quote fields ride the same merge. A line without a quote sends
 * nulls so an old server that only knows the v2 shape can still drop them,
 * and a v3 server keeps them.
 */
export function cartSyncPayload(cart, baseVersion) {
  const state = normalizeCart(cart);
  return {
    baseVersion: Number(baseVersion) || 0,
    lines: state.lines.map((line) => ({
      lineId: line.lineId,
      source: line.source,
      assemblyName: line.assemblyName,
      partId: line.partId,
      surfId: line.surfId,
      partName: line.partName,
      scriptHash: line.scriptHash,
      thumbDataUrl: line.thumbDataUrl,
      qty: line.qty,
      options: line.options,
      quotedUnitPrice: line.quotedUnitPrice,
      quoteId: line.quoteId,
      quotedAt: line.quotedAt,
      addedAt: line.addedAt,
      updatedAt: line.updatedAt,
    })),
    tombstones: state.tombstones,
  };
}

export function acceptCartExchange(storage, userId, result) {
  if (!result || result.status !== 'ok' || !result.cart) return false;
  const wrote = writeCart(storage, userId, result.cart);
  if (wrote && result.markUploaded) markCartUploaded(storage, userId);
  return wrote;
}
