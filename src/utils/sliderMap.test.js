import assert from 'node:assert/strict';
import test from 'node:test';
import { MM_PER_IN, getDisplayUnit, setDisplayUnit } from './displayUnit.js';
import {
  THUMB_COUNT,
  fallbackOffscreenDistance,
  lengthFromThumb,
  lengthSnap,
  offscreenRange,
  shape,
  snapLength,
  snapMm,
  snapMmForSpan,
  thumbFromLength,
  unshape,
} from './sliderMap.js';

const near = (actual, expected, tol = 1e-9) => Math.abs(actual - expected) <= tol;

test('shape is linear through half travel, then accelerates', () => {
  assert.ok(near(shape(0), 0));
  assert.ok(near(shape(0.5), 1 / 3));
  assert.ok(near(shape(2 / 3), 13 / 27));
  assert.ok(near(shape(1), 1));
  assert.ok(near(shape(-1), 0));
  assert.ok(near(shape(2), 1));
  const left = (shape(0.5) - shape(0.5 - 1e-6)) / 1e-6;
  const right = (shape(0.5 + 1e-6) - shape(0.5)) / 1e-6;
  assert.ok(Math.abs(left - 2 / 3) < 1e-4);
  assert.ok(Math.abs(right - 2 / 3) < 1e-4);
});

test('unshape inverts shape', () => {
  for (let i = 0; i <= 20; i++) {
    const s = i / 20;
    assert.ok(near(unshape(shape(s)), s, 1e-9), `s=${s}`);
  }
  assert.ok(near(unshape(0), 0));
  assert.ok(near(unshape(1), 1));
  assert.ok(near(unshape(1 / 3), 0.5));
});

test('a one-sided thumb maps through the curve', () => {
  assert.ok(near(lengthFromThumb(0, { min: 0.1, max: 80 }), 0.1));
  assert.ok(near(lengthFromThumb(THUMB_COUNT / 2, { min: 0, max: 90 }), 30));
  assert.ok(near(lengthFromThumb(THUMB_COUNT, { min: 0.1, max: 80 }), 80));
  const typed = 12.5;
  const thumb = thumbFromLength(typed, { min: 0, max: 80 });
  assert.ok(near(lengthFromThumb(thumb, { min: 0, max: 80 }), typed, 1e-6));
});

test('a signed thumb is zero at the middle and reaches ±R at the ends', () => {
  assert.ok(near(lengthFromThumb(0, { max: 100, signed: true }), -100));
  assert.ok(near(lengthFromThumb(THUMB_COUNT / 2, { max: 100, signed: true }), 0));
  assert.ok(near(lengthFromThumb(THUMB_COUNT, { max: 100, signed: true }), 100));
  const twoThirds = (THUMB_COUNT * (0.5 + (2 / 3) / 2));
  assert.ok(near(lengthFromThumb(twoThirds, { max: 27, signed: true }), 13, 1e-9));
  const thumb = thumbFromLength(-12.5, { max: 80, signed: true });
  assert.ok(near(lengthFromThumb(thumb, { max: 80, signed: true }), -12.5, 1e-6));
});

test('two-thirds of the thumb equals the off-screen distance', () => {
  assert.ok(near(offscreenRange(13), 27));
  assert.equal(offscreenRange(0), 0);
  assert.ok(near(fallbackOffscreenDistance(100), 150));
  const dOff = 40;
  const R = offscreenRange(dOff);
  const thumb = THUMB_COUNT * (0.5 + (2 / 3) / 2);
  assert.ok(near(lengthFromThumb(thumb, { max: R, signed: true }), dOff, 1e-9));
});

test('snap is 0.1 mm or 1/16 in, and shrinks once on a short span', () => {
  assert.equal(snapMm('mm'), 0.1);
  assert.ok(near(snapMm('in'), MM_PER_IN / 16));
  assert.ok(near(MM_PER_IN / 16, 1.5875, 1e-12));
  assert.equal(snapMmForSpan(10, 'mm'), 0.1);
  assert.equal(snapMmForSpan(0.3, 'mm'), 0.01);
  assert.ok(near(snapMmForSpan(5, 'in'), (MM_PER_IN / 16) / 10));
  assert.ok(near(snapMmForSpan(10, 'in'), MM_PER_IN / 16));
  assert.ok(near(snapLength(12.54, 0.1), 12.5));
  assert.equal(snapLength(12.5, 0), 12.5);
});

test('the thumb snaps and the inverse of a typed value does not', () => {
  const snapped = lengthFromThumb(THUMB_COUNT * 0.2, { min: 0, max: 80, snap: 0.1 });
  assert.ok(near(snapped, Math.round(snapped * 10) / 10));
  assert.ok(snapped > 0 && snapped < 80);
  const thumb = thumbFromLength(12.54, { min: 0, max: 80 });
  assert.ok(near(lengthFromThumb(thumb, { min: 0, max: 80 }), 12.54, 1e-6));
});

test('length snap follows the global display unit', () => {
  const prev = getDisplayUnit();
  setDisplayUnit('in');
  try {
    assert.ok(near(lengthSnap(), MM_PER_IN / 16));
    setDisplayUnit('mm');
    assert.equal(lengthSnap(), 0.1);
  } finally {
    setDisplayUnit(prev);
  }
});
