import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GREY,
  MAGENTA,
  displacementColor,
  displacementGradientCss,
  displacementTicks,
  legendGradientCss,
  legendStops,
  legendTicks,
  scaleTop,
  stressColor,
  viridis,
} from './colormap.js';

const OFFICIAL = {
  0: [68 / 255, 1 / 255, 84 / 255],
  0.25: [59 / 255, 82 / 255, 139 / 255],
  0.5: [33 / 255, 145 / 255, 140 / 255],
  0.75: [94 / 255, 201 / 255, 98 / 255],
  1: [253 / 255, 231 / 255, 37 / 255],
};

function near(rgb, expected, slack) {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(rgb[i] - expected[i]) <= slack, `${rgb} vs ${expected} channel ${i}`);
  }
}

test('viridis endpoints and mid samples stay on the matplotlib ramp', () => {
  near(viridis(0), OFFICIAL[0], 0.02);
  near(viridis(0.25), OFFICIAL[0.25], 0.02);
  near(viridis(0.5), OFFICIAL[0.5], 0.02);
  near(viridis(0.75), OFFICIAL[0.75], 0.03);
  near(viridis(1), OFFICIAL[1], 0.02);
  near(viridis(-1), OFFICIAL[0], 0.02);
  near(viridis(2), OFFICIAL[1], 0.02);
});

test('scale top is max(p95, yield) in MPa', () => {
  assert.equal(scaleTop({ p95: 10, yield_MPa: 40 }), 40);
  assert.equal(scaleTop({ p95: 80, yield_MPa: 40 }), 80);
  assert.equal(scaleTop({ p95: 12, yield_MPa: null }), 12);
  assert.equal(scaleTop({ p95: 0, yield_MPa: 0 }), 0);
  assert.equal(scaleTop({}), 0);
});

test('0 and the scale top are the viridis ends when they are inside the limit', () => {
  const scale = { p95: 100, yield_MPa: 100 };
  near(stressColor(0, scale), OFFICIAL[0], 0.02);
  near(stressColor(100, scale), OFFICIAL[1], 0.02);
  near(stressColor(-4, scale), OFFICIAL[0], 0.02);
});

test('values above yield are magenta, including when yield is below p95', () => {
  const scale = { p95: 80, yield_MPa: 40 };
  near(stressColor(40, scale), OFFICIAL[0.5], 0.02);
  assert.deepEqual(stressColor(40.001, scale), [MAGENTA[0], MAGENTA[1], MAGENTA[2]]);
  assert.deepEqual(stressColor(80, scale), [1, 0, 1]);
});

test('with no yield, magenta starts above p95 and the top of the ramp is yellow', () => {
  const scale = { p95: 10, yield_MPa: null };
  near(stressColor(10, scale), OFFICIAL[1], 0.02);
  assert.deepEqual(stressColor(10.01, scale), [1, 0, 1]);
  assert.deepEqual(stressColor(10, { p95: 10 }), [stressColor(10, scale)[0], stressColor(10, scale)[1], stressColor(10, scale)[2]]);
  assert.deepEqual(stressColor(0.01, { p95: 10, yield_MPa: 0 }), [1, 0, 1]);
  near(stressColor(0, { p95: 10, yield_MPa: 0 }), OFFICIAL[0], 0.02);
});

test('NaN and other non-finite samples are grey', () => {
  const scale = { p95: 10, yield_MPa: 10 };
  assert.deepEqual(stressColor(NaN, scale), [GREY[0], GREY[1], GREY[2]]);
  assert.deepEqual(stressColor(undefined, scale), [GREY[0], GREY[1], GREY[2]]);
  assert.deepEqual(stressColor(Infinity, scale), [GREY[0], GREY[1], GREY[2]]);
});

test('legend ticks run from 0 to the scale top', () => {
  const ticks = legendTicks({ p95: 20, yield_MPa: 80 }, 5);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[4], 80);
  assert.ok(ticks[1] < ticks[2] && ticks[2] < ticks[3]);
});

test('legend gradient paints magenta only past the limit', () => {
  const css = legendGradientCss({ p95: 100, yield_MPa: 50 });
  assert.match(css, /^linear-gradient\(90deg, rgb\(71, 1, 85\)/);
  assert.match(css, /rgb\(255, 0, 255\) 100\.00%\)$/);
  const stops = legendStops({ p95: 100, yield_MPa: 50 });
  const atYield = stops.find((stop) => Math.abs(stop.value - 50) < 1e-6);
  assert.ok(atYield);
  assert.notDeepEqual(atYield.rgb, [1, 0, 1]);
  const above = stops.find((stop) => stop.value > 50);
  assert.deepEqual(above.rgb, [1, 0, 1]);
});

test('displacement runs viridis from min to max millimetres', () => {
  const scale = { min: 0.2, max: 1.2 };
  near(displacementColor(0.2, scale), OFFICIAL[0], 0.02);
  near(displacementColor(0.7, scale), OFFICIAL[0.5], 0.02);
  near(displacementColor(1.2, scale), OFFICIAL[1], 0.02);
  assert.deepEqual(displacementColor(NaN, scale), [GREY[0], GREY[1], GREY[2]]);
  const ticks = displacementTicks(scale, 5);
  assert.equal(ticks[0], 0.2);
  assert.equal(ticks[4], 1.2);
  assert.match(displacementGradientCss(scale), /^linear-gradient\(90deg, /);
});
