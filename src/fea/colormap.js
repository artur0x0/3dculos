/**
 * Von Mises colour scale for the stress skin and the legend.
 *
 * Viridis from 0 to max(p95, yield), in megapascals. A value above yield is
 * magenta. With no yield, the same magenta starts above p95. A non-finite
 * sample is grey so a hole in the field cannot be read as a real stress.
 *
 * The ramp is the published viridis polynomial (purple, teal, yellow). It
 * stays within a few levels of the matplotlib samples at 0, 1/4, 1/2, 3/4
 * and 1.
 */

export const MAGENTA = Object.freeze([1, 0, 1]);
export const GREY = Object.freeze([0.5, 0.5, 0.5]);

const C0 = [0.2777273272234177, 0.005407344544966578, 0.3340998053353061];
const C1 = [0.1050930431085774, 1.404613529898575, 1.384590162594685];
const C2 = [-0.3308618287255563, 0.214847559468213, 0.09509516302823659];
const C3 = [-4.634230498983486, -5.799100973351585, -19.33244095627987];
const C4 = [6.228269936347423, 14.17993336680509, 56.69055260068105];
const C5 = [4.776384997670288, -13.74514537774601, -65.35303263337234];
const C6 = [-5.435455855934631, 4.645852612178535, 26.3124352495832];

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** sRGB viridis at t in [0, 1]. t is clamped. */
export function viridis(t) {
  const u = clamp01(Number(t) || 0);
  const rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = C0[i] + u * (C1[i] + u * (C2[i] + u * (C3[i] + u * (C4[i] + u * (C5[i] + u * C6[i])))));
    rgb[i] = clamp01(v);
  }
  return rgb;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = finiteOrNull(value);
  return n != null && n > 0 ? n : 0;
}

/** Top of the viridis ramp: max(p95, yield). Missing numbers count as 0. */
export function scaleTop(scale = {}) {
  return Math.max(positive(scale.p95), positive(scale.yield_MPa));
}

/**
 * Magenta starts strictly above this value. A finite yield, including 0,
 * wins. Otherwise p95. No finite threshold means 0.
 */
export function magentaAbove(scale = {}) {
  const y = finiteOrNull(scale.yield_MPa);
  if (y != null && y >= 0) return y;
  const p = finiteOrNull(scale.p95);
  if (p != null && p >= 0) return p;
  return 0;
}

/** sRGB in 0..1. Non-finite values are grey. Above the limit is magenta. */
export function stressColor(valueMPa, scale = {}) {
  const value = Number(valueMPa);
  if (!Number.isFinite(value)) return [GREY[0], GREY[1], GREY[2]];
  if (value > magentaAbove(scale)) return [MAGENTA[0], MAGENTA[1], MAGENTA[2]];
  const top = scaleTop(scale);
  if (!(top > 0)) return viridis(0);
  return viridis(clamp01(value / top));
}

/** Evenly spaced stresses from 0 through the scale top. Default is 5 ticks. */
export function legendTicks(scale = {}, count = 5) {
  const n = Math.max(2, count | 0);
  const top = scaleTop(scale);
  const ticks = [];
  for (let i = 0; i < n; i++) ticks.push(top * (i / (n - 1)));
  return ticks;
}

/**
 * Gradient stops from 0 to the scale top. A yield below p95 gets its own
 * stop so the magenta region starts on the yield, not on the next sample.
 */
export function legendStops(scale = {}, samples = 16) {
  const top = scaleTop(scale);
  const n = Math.max(1, samples | 0);
  const stops = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const value = top > 0 ? top * t : 0;
    stops.push({ t, value, rgb: stressColor(value, scale) });
  }
  const limit = magentaAbove(scale);
  if (top > limit && limit >= 0) {
    const t = limit / top;
    const has = stops.some((stop) => Math.abs(stop.t - t) < 1e-6);
    if (!has) {
      stops.push({ t, value: limit, rgb: stressColor(limit, scale) });
      stops.sort((a, b) => a.t - b.t);
    }
  }
  return stops;
}

function rgbCss(rgb) {
  const [r, g, b] = rgb.map((channel) => Math.round(clamp01(channel) * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/** CSS linear-gradient for the legend bar. Left is 0 MPa. */
export function legendGradientCss(scale = {}) {
  const parts = legendStops(scale).map((stop) => `${rgbCss(stop.rgb)} ${(stop.t * 100).toFixed(2)}%`);
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
