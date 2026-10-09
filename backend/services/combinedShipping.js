/**
 * Rate every packed box and sum the prices for each UPS method.
 * Mock rates and the UPS fail-open path live in getShippingRates; this
 * function does not turn a size or weight limit into an error.
 */
import { roundMoney } from '../../src/utils/quoteMath.js';
import { getShippingRates } from './ups.js';

const METHODS = ['ground', '2day', 'overnight'];

export async function ratePackedBoxes(address, boxes, rateFn = getShippingRates) {
  const perBox = [];
  for (const box of boxes) {
    const rates = await rateFn(address, {
      dimensions: box.dimensions,
      weight: box.weight,
    });
    perBox.push(Array.isArray(rates) ? rates : []);
  }
  return sumBoxRates(perBox);
}

export function sumBoxRates(perBox) {
  const rates = [];
  for (const code of METHODS) {
    let price = 0;
    let sample = null;
    let complete = perBox.length > 0;
    for (const boxRates of perBox) {
      const hit = boxRates.find((rate) => rate.code === code);
      if (!hit || !Number.isFinite(Number(hit.price))) {
        complete = false;
        break;
      }
      price += Number(hit.price);
      sample = hit;
    }
    if (!complete || !sample) continue;
    rates.push({
      code: sample.code,
      name: sample.name,
      price: roundMoney(price),
      currency: sample.currency || 'USD',
      estimatedDays: sample.estimatedDays,
      estimatedDelivery: sample.estimatedDelivery,
      carrier: sample.carrier || 'UPS',
      boxCount: perBox.length,
    });
  }
  return rates;
}
