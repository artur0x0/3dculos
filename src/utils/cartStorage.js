/**
 * Write-through cart for one signed-in user.
 * Key: `surfcad_cart:<user._id>`. The one-time upload flag is separate so
 * clearing the cart does not arm that upload again.
 * `clearLocalCadData` keeps both, same as checkout and the session.
 */
import { emptyCart, normalizeCart } from './cart.js';

export function cartStorageKey(userId) {
  return `surfcad_cart:${userId}`;
}

export function cartUploadedKey(userId) {
  return `surfcad_cart_uploaded:${userId}`;
}

export function readCart(storage, userId) {
  if (!storage || !userId) return emptyCart();
  try {
    const raw = storage.getItem(cartStorageKey(userId));
    if (!raw) return emptyCart();
    const parsed = JSON.parse(raw);
    return normalizeCart(parsed);
  } catch {
    return emptyCart();
  }
}

/** Write-through. A quota or private-mode failure leaves the in-memory cart. */
export function writeCart(storage, userId, cart) {
  if (!storage || !userId) return false;
  try {
    const next = normalizeCart(cart);
    storage.setItem(cartStorageKey(userId), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function hasCartUploaded(storage, userId) {
  if (!storage || !userId) return false;
  try {
    return storage.getItem(cartUploadedKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function markCartUploaded(storage, userId) {
  if (!storage || !userId) return false;
  try {
    storage.setItem(cartUploadedKey(userId), '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a successful GET should push this device's lines once.
 * The uploaded flag stays set after the cart is cleared.
 */
export function shouldMigrateCart({ serverLines = [], localLines = [], uploaded = false } = {}) {
  return serverLines.length === 0 && localLines.length > 0 && !uploaded;
}
