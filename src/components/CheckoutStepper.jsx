/**
 * Which cart line the quote and order modals are on.
 * Quantity is the line's. This is not a second quantity control.
 */
export default function CheckoutStepper({ index = 0, total = 0, name = '', qty = null, scriptChanged = false }) {
  if (!total) return null;
  const n = index + 1;
  return (
    <div
      data-checkout-stepper=""
      data-checkout-index={n}
      data-checkout-total={total}
      className="border-b border-gray-700/40 bg-gray-900/50 px-5 py-2"
    >
      <p className="text-xs font-medium text-gray-100" data-checkout-progress="">
        Line {n} of {total}
      </p>
      <p className="truncate text-[11px] text-gray-400" data-checkout-part="">
        {name}
        {qty ? <span data-checkout-qty=""> · Qty {qty}</span> : null}
      </p>
      {scriptChanged ? (
        <p className="text-[11px] text-gray-500" data-checkout-script-changed="">
          Script changed — quoting this part as it is now
        </p>
      ) : null}
    </div>
  );
}
