/**
 * Server charge for one order. Client money fields are comparison-only.
 * The Stripe amount is server unit price × quantity, plus server shipping, plus tax.
 * This module does not import mongoose.
 */
import { calculateTax } from '../config/taxRates.js';
import {
  clampQuantity,
  moneyDiffers,
  quoteFromGeometry,
  roundMoney,
} from '../../src/utils/quoteMath.js';

export function orderQuantity(modelData) {
  const n = Number(modelData?.quantity);
  if (!Number.isInteger(n) || n < 1 || n > 999) return 1;
  return n;
}

/**
 * @param {object} input
 * @param {number} input.shippingCost server shipping dollars for the selected method
 * @param {object} [input.clientQuote] display/comparison prices; never used as the charge
 */
export function priceOrder({
  volume,
  boundingBox,
  process,
  material,
  infill,
  quantity,
  shippingCost,
  state,
  country = 'US',
  clientQuote = {},
}) {
  const qty = clampQuantity(quantity, { missing: 1 });
  if (!qty) {
    return { ok: false, error: 'Quantity must be an integer from 1 to 999' };
  }

  let quote;
  try {
    quote = quoteFromGeometry({
      volume,
      boundingBox,
      process,
      material,
      infill,
      quantity: qty,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const shipping = roundMoney(Number(shippingCost) || 0);
  const { tax, rate } = calculateTax(roundMoney(quote.subtotal + shipping), state, country);
  const total = roundMoney(quote.subtotal + shipping + tax);

  const clientUnit = finiteOrNull(clientQuote.unitSubtotal);
  const clientSubtotal = finiteOrNull(clientQuote.subtotal);
  const clientShip = finiteOrNull(
    clientQuote.shipping ?? clientQuote['shipping-cost'] ?? clientQuote.clientShipping,
  );

  let priceUpdated = false;
  if (clientUnit != null) {
    if (moneyDiffers(clientUnit, quote.unitSubtotal)) priceUpdated = true;
  } else if (clientSubtotal != null) {
    if (moneyDiffers(clientSubtotal, quote.subtotal)) priceUpdated = true;
  }
  if (clientShip != null && moneyDiffers(clientShip, shipping)) priceUpdated = true;

  return {
    ok: true,
    priceUpdated,
    quantity: qty,
    quote,
    shipping,
    tax,
    taxRate: rate,
    total,
    stripeAmountCents: Math.round(total * 100),
  };
}

/**
 * Sum of server line subtotals, one combined shipping figure, and tax on
 * subtotal + shipping. Client money is comparison only. A line unit or the
 * shipping figure more than one cent away sets priceUpdated.
 */
export function priceMultiLineOrder({
  lineQuotes,
  shippingCost,
  state,
  country = 'US',
  clientLines = [],
  clientShipping,
}) {
  if (!Array.isArray(lineQuotes) || lineQuotes.length < 1) {
    return { ok: false, error: 'At least one line is required' };
  }

  const subtotal = roundMoney(lineQuotes.reduce((sum, quote) => sum + Number(quote.subtotal || 0), 0));
  const material = roundMoney(lineQuotes.reduce((sum, quote) => sum + Number(quote.costs?.material || 0), 0));
  const machine = roundMoney(lineQuotes.reduce((sum, quote) => sum + Number(quote.costs?.machine || 0), 0));
  const shipping = roundMoney(Number(shippingCost) || 0);
  const { tax, rate } = calculateTax(roundMoney(subtotal + shipping), state, country);
  const total = roundMoney(subtotal + shipping + tax);

  let priceUpdated = false;
  lineQuotes.forEach((quote, index) => {
    const client = clientLines[index] || {};
    const clientUnit = finiteOrNull(client.quotedUnitPrice ?? client.unitSubtotal);
    if (clientUnit != null && moneyDiffers(clientUnit, quote.unitSubtotal)) {
      priceUpdated = true;
    }
  });
  const clientShip = finiteOrNull(clientShipping);
  if (clientShip != null && moneyDiffers(clientShip, shipping)) priceUpdated = true;

  return {
    ok: true,
    priceUpdated,
    subtotal,
    material,
    machine,
    shipping,
    tax,
    taxRate: rate,
    total,
    stripeAmountCents: Math.round(total * 100),
  };
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
