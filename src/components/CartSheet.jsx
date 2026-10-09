/**
 * Cart sheet. Checkout stays disabled until the stepper (slice 4c).
 * Opening the quote flow here would price the editor buffer, and only
 * the first line.
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, X } from 'lucide-react';
import { useCartChrome } from '../hooks/useCart';
import { CART_QTY_MAX, CART_QTY_MIN } from '../utils/cart.js';

export default function CartSheet() {
  const cart = useCartChrome();
  const open = !!cart?.open;

  useEffect(() => {
    if (!open) return undefined;
    cart.refill?.();
    const onKey = (event) => {
      if (event.key === 'Escape') cart.closeCart?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, cart]);

  if (!open || typeof document === 'undefined') return null;

  const lines = cart.lines || [];

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center"
      data-cart-root=""
    >
      <button
        type="button"
        data-cart-backdrop=""
        className="absolute inset-0 bg-black/55"
        aria-label="Close cart"
        onClick={() => cart.closeCart?.()}
      />
      <div
        role="dialog"
        aria-label="Cart"
        data-cart-sheet=""
        data-cart-count={cart.count || 0}
        className="relative z-10 flex max-h-[85vh] w-full flex-col rounded-t-xl border border-gray-600
          bg-gray-900 shadow-2xl sm:max-w-md sm:rounded-xl"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-100">Cart</h2>
          <button
            type="button"
            data-cart-close=""
            className="rounded-md p-1 text-gray-300 hover:bg-white/10"
            aria-label="Close cart"
            onClick={() => cart.closeCart?.()}
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {lines.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-gray-400" data-cart-empty="">
              Nothing ordered yet.
            </p>
          ) : lines.map((line) => (
            <div
              key={line.lineId}
              data-cart-line={line.lineId}
              data-cart-line-missing={line.missing ? 'true' : 'false'}
              className="flex items-center gap-3 border-b border-white/5 py-2"
            >
              {line.thumbDataUrl ? (
                <img
                  src={line.thumbDataUrl}
                  alt=""
                  data-cart-thumb="image"
                  className="h-12 w-12 shrink-0 rounded-md bg-[#1e1e1e] object-cover"
                />
              ) : (
                <div
                  data-cart-thumb="empty"
                  className="h-12 w-12 shrink-0 rounded-md bg-[#1e1e1e]"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-gray-100" data-cart-line-name="">
                  {line.liveName || line.partName}
                </p>
                <p className="truncate text-[11px] text-gray-500" data-cart-line-assembly="">
                  {line.assemblyName}
                </p>
                {line.missing ? (
                  <p className="text-[11px] font-medium text-amber-300" data-cart-missing="">
                    Part missing
                  </p>
                ) : null}
                {line.elsewhere ? (
                  <p className="text-[11px] text-gray-400" data-cart-elsewhere="">
                    Not in this assembly
                  </p>
                ) : null}
                {line.hashStale && !line.missing ? (
                  <p className="text-[11px] text-gray-500" data-cart-hash-stale="">
                    Script changed
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1" data-cart-qty={line.qty}>
                <button
                  type="button"
                  data-cart-qty-dec=""
                  className="rounded-md p-1 text-gray-200 hover:bg-white/10 disabled:opacity-30"
                  aria-label="Fewer"
                  disabled={line.qty <= CART_QTY_MIN}
                  onClick={() => cart.changeQty?.(line.lineId, line.qty - 1)}
                >
                  <Minus size={14} />
                </button>
                <span className="w-6 text-center text-xs tabular-nums text-gray-100">{line.qty}</span>
                <button
                  type="button"
                  data-cart-qty-inc=""
                  className="rounded-md p-1 text-gray-200 hover:bg-white/10 disabled:opacity-30"
                  aria-label="More"
                  disabled={line.qty >= CART_QTY_MAX}
                  onClick={() => cart.changeQty?.(line.lineId, line.qty + 1)}
                >
                  <Plus size={14} />
                </button>
              </div>
              <button
                type="button"
                data-cart-remove=""
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15"
                onClick={() => cart.removeLine?.(line.lineId)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-gray-700 px-4 py-3">
          <button
            type="button"
            data-cart-checkout=""
            disabled
            className="w-full rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white
              disabled:cursor-not-allowed disabled:opacity-50"
          >
            Checkout
          </button>
          <p className="mt-2 text-center text-[11px] text-gray-400" data-cart-checkout-note="">
            Checkout is coming next
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
