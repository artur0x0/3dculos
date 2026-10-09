/**
 * Signed-in cart for the part row, the profile chip, and the sheet.
 * Signed-out taps open LoginModal and do not write `surfcad_cart`.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  addPartLine,
  cartChipSelector,
  cartCount,
  cartUserId,
  checkoutQueue,
  checkoutSkipNote,
  emptyCart,
  makeCartDraft,
  orderIntent,
  presentCartLines,
  refillThumbs,
  removeCartLine,
  scriptsForOrder,
  setCartQty,
} from '../utils/cart.js';
import { useAuthState } from './useAuthState';
import { readCart, writeCart } from '../utils/cartStorage.js';
import {
  acceptCartExchange,
  cartSyncIsLocalOnly,
  exchangeCart,
  noteCartSignIn,
} from '../utils/cartSync.js';
import { scriptForRow } from '../utils/assembly.js';

const CartChromeContext = createContext(null);

export function CartChromeProvider({ value, children }) {
  return (
    <CartChromeContext.Provider value={value}>
      {children}
    </CartChromeContext.Provider>
  );
}

export function useCartChrome() {
  return useContext(CartChromeContext);
}

function cssEscape(value) {
  const text = String(value ?? '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text);
  return text.replace(/["\\]/g, '\\$&');
}

function thumbForPart(partId) {
  if (typeof document === 'undefined') return null;
  const canvas = document.querySelector(
    `[data-part-row="${cssEscape(partId)}"] [data-part-thumbnail]`,
  );
  if (!canvas || typeof canvas.toDataURL !== 'function') return null;
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function measureFlight(partId) {
  if (typeof document === 'undefined') return null;
  const thumb = document.querySelector(
    `[data-part-row="${cssEscape(partId)}"] [data-part-thumbnail]`,
  );
  const width = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const chip = document.querySelector(cartChipSelector(width));
  if (!thumb || !chip) return null;
  const from = thumb.getBoundingClientRect();
  const to = chip.getBoundingClientRect();
  if (from.width < 1 || to.width < 1) return null;
  return {
    from: { left: from.left, top: from.top, width: from.width, height: from.height },
    to: { left: to.left, top: to.top, width: to.width, height: to.height },
    image: thumbForPart(partId),
  };
}

function thumbsFromFeed() {
  if (typeof document === 'undefined') return {};
  const map = {};
  document.querySelectorAll('[data-part-row]').forEach((row) => {
    const id = row.getAttribute('data-part-row');
    const canvas = row.querySelector('[data-part-thumbnail]');
    if (!id || !canvas || typeof canvas.toDataURL !== 'function') return;
    try {
      const url = canvas.toDataURL('image/png');
      if (url) map[id] = url;
    } catch {
      /* a tainted canvas stays empty; the line keeps its stored thumb */
    }
  });
  return map;
}

export function useCart({
  user,
  onNeedLogin,
  onCheckout,
  assemblyRef,
  partScriptsRef,
  liveScriptRef,
  partRunsRef,
}) {
  const auth = useAuthState();
  const signedIn = auth.signedIn;
  const pending = auth.pending;
  const userId = cartUserId(user);
  const [cart, setCart] = useState(emptyCart);
  const [open, setOpen] = useState(false);
  const [flight, setFlight] = useState(null);
  const rev = useRef(0);
  const flightSeq = useRef(0);
  const syncing = useRef(false);
  const syncAgain = useRef(false);
  const syncTimer = useRef(null);
  const userIdRef = useRef(userId);
  const signedInRef = useRef(signedIn);
  const pendingRef = useRef(pending);
  const onNeedLoginRef = useRef(onNeedLogin);
  const onCheckoutRef = useRef(onCheckout);
  onCheckoutRef.current = onCheckout;
  const seenUser = useRef('');
  userIdRef.current = userId;
  signedInRef.current = signedIn;
  pendingRef.current = pending;
  onNeedLoginRef.current = onNeedLogin;

  const persist = useCallback((next) => {
    rev.current += 1;
    const id = userIdRef.current;
    if (id && signedInRef.current) writeCart(localStorage, id, next);
    setCart(next);
  }, []);

  const runSync = useCallback(async () => {
    const id = userIdRef.current;
    if (!signedInRef.current || !id) return;
    if (cartSyncIsLocalOnly(id)) return;
    if (syncing.current) {
      syncAgain.current = true;
      return;
    }
    syncing.current = true;
    const seen = rev.current;
    try {
      const result = await exchangeCart({
        userId: id,
        storage: localStorage,
        onNeedLogin: () => onNeedLoginRef.current?.(),
      });
      if (!signedInRef.current || userIdRef.current !== id) return;
      if (rev.current !== seen) return;
      if (result.status === 'ok') {
        acceptCartExchange(localStorage, id, result);
        setCart(readCart(localStorage, id));
      }
    } finally {
      syncing.current = false;
      if (syncAgain.current || rev.current !== seen) {
        syncAgain.current = false;
        if (signedInRef.current && userIdRef.current === id) void runSync();
      }
    }
  }, []);

  useEffect(() => {
    if (!signedIn || !userId) {
      setCart(emptyCart());
      setOpen(false);
      seenUser.current = '';
      return undefined;
    }
    if (seenUser.current !== userId) {
      seenUser.current = userId;
      noteCartSignIn();
      rev.current += 1;
      setCart(readCart(localStorage, userId));
    }
    void runSync();
    const onWake = () => { void runSync(); };
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [signedIn, userId, runSync]);

  const scheduleSync = useCallback(() => {
    const id = userIdRef.current;
    if (!id || cartSyncIsLocalOnly(id)) return;
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => { void runSync(); }, 400);
  }, [runSync]);

  const openCart = useCallback(() => {
    const intent = orderIntent({
      signedIn: signedInRef.current,
      pending: pendingRef.current,
    });
    if (intent === 'login') {
      onNeedLoginRef.current?.();
      return;
    }
    if (intent !== 'add') return;
    setOpen(true);
  }, []);

  const closeCart = useCallback(() => setOpen(false), []);

  const clearFlight = useCallback((id) => {
    setFlight((current) => (current && current.id === id ? null : current));
  }, []);

  const orderPart = useCallback((partId) => {
    const intent = orderIntent({
      signedIn: signedInRef.current,
      pending: pendingRef.current,
    });
    if (intent === 'login') {
      onNeedLoginRef.current?.();
      return { ok: false, reason: 'signed-out' };
    }
    if (intent !== 'add') return { ok: false, reason: 'pending' };
    const doc = assemblyRef?.current;
    const scripts = scriptsForOrder(partScriptsRef?.current, liveScriptRef?.current);
    const picked = scriptForRow(doc, scripts, partId);
    if (!picked.ok || !picked.part) {
      return { ok: false, reason: picked.reason || 'missing' };
    }
    const draft = makeCartDraft({
      doc,
      part: picked.part,
      script: picked.script,
      thumbDataUrl: thumbForPart(partId),
    });
    const result = addPartLine(readCart(localStorage, userIdRef.current), draft);
    if (!result.ok) return result;
    persist(result.cart);
    scheduleSync();
    const shot = measureFlight(partId);
    if (shot) {
      flightSeq.current += 1;
      setFlight({ id: flightSeq.current, ...shot });
    }
    return result;
  }, [assemblyRef, liveScriptRef, partScriptsRef, persist, scheduleSync]);

  const changeQty = useCallback((lineId, qty) => {
    if (!signedInRef.current) return;
    persist(setCartQty(readCart(localStorage, userIdRef.current), lineId, qty));
    scheduleSync();
  }, [persist, scheduleSync]);

  const removeLine = useCallback((lineId) => {
    if (!signedInRef.current) return;
    persist(removeCartLine(readCart(localStorage, userIdRef.current), lineId));
    scheduleSync();
  }, [persist, scheduleSync]);

  const startCheckout = useCallback(() => {
    const intent = orderIntent({
      signedIn: signedInRef.current,
      pending: pendingRef.current,
    });
    if (intent === 'login') {
      onNeedLoginRef.current?.();
      return { ok: false, reason: 'signed-out' };
    }
    if (intent !== 'add') return { ok: false, reason: 'pending' };
    const doc = assemblyRef?.current || null;
    const scripts = scriptsForOrder(partScriptsRef?.current, liveScriptRef?.current);
    const queue = checkoutQueue(
      doc,
      scripts,
      readCart(localStorage, userIdRef.current),
      partRunsRef?.current,
    );
    if (!queue.lines.length) return { ok: false, reason: 'empty', ...queue };
    setOpen(false);
    onCheckoutRef.current?.(queue);
    return { ok: true, ...queue };
  }, [assemblyRef, liveScriptRef, partRunsRef, partScriptsRef]);

  const refill = useCallback(() => {
    if (!signedInRef.current) return;
    const current = readCart(localStorage, userIdRef.current);
    const next = refillThumbs(current, thumbsFromFeed());
    if (next === current) return;
    persist(next);
    scheduleSync();
  }, [persist, scheduleSync]);

  const doc = signedIn ? assemblyRef?.current : null;
  const scripts = scriptsForOrder(partScriptsRef?.current, liveScriptRef?.current);
  const stored = signedIn ? cart : emptyCart();
  const lines = presentCartLines(doc, scripts, stored);
  const queue = checkoutQueue(doc, scripts, stored, partRunsRef?.current);

  return useMemo(() => ({
    count: signedIn ? cartCount(cart) : 0,
    lines,
    checkoutLines: queue.lines,
    checkoutNote: checkoutSkipNote(queue),
    open,
    flight,
    openCart,
    closeCart,
    orderPart,
    changeQty,
    removeLine,
    refill,
    clearFlight,
    startCheckout,
  }), [
    signedIn,
    cart,
    lines,
    queue,
    open,
    flight,
    openCart,
    closeCart,
    orderPart,
    changeQty,
    removeLine,
    refill,
    clearFlight,
    startCheckout,
  ]);
}

export default useCart;
