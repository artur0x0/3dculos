import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { applyTrackballFeel } from './trackballFeel.js';
import { panViewByNdcY } from './viewCamera.js';
import {
  FEATURE_SHEET_SLIDE_MAX,
  applyViewPose,
  boxCornerPoints,
  captureViewPose,
  createSheetCameraSession,
  featureSheetCardTopNdc,
  featureSheetClearanceNdc,
  featureSheetSlideForYs,
  featureSheetSlideNdc,
  posesMatch,
  selectionNdcYs,
} from './featureSheetCamera.js';

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    pageXOffset: 0,
    pageYOffset: 0,
    addEventListener() {},
    removeEventListener() {},
  };
}

function fakeDom() {
  return {
    style: {},
    ownerDocument: {
      documentElement: { clientWidth: 800, clientHeight: 600, clientLeft: 0, clientTop: 0 },
    },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    },
  };
}

function rig() {
  const camera = new PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(80, -80, 60);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 10);
  camera.updateMatrixWorld();
  const controls = new TrackballControls(camera, fakeDom());
  applyTrackballFeel(controls);
  controls.target.set(0, 0, 10);
  controls.update();
  return { camera, controls };
}

test('a point already in the clear band does not slide', () => {
  assert.equal(featureSheetSlideNdc(0.2, 0.4), 0);
  assert.equal(featureSheetSlideNdc(0, 0), 0);
});

test('a point under the card slides up, and only as far as 0.6 NDC', () => {
  const mild = featureSheetSlideNdc(-0.8, 0.45);
  assert.ok(mild < 0, `expected content up, got ${mild}`);
  assert.ok(mild >= -FEATURE_SHEET_SLIDE_MAX);
  const buried = featureSheetSlideNdc(-1, 0.7);
  assert.equal(buried, -FEATURE_SHEET_SLIDE_MAX);
  assert.equal(featureSheetSlideNdc(0.99, 0.2), 0);
  assert.equal(featureSheetSlideNdc(Number.NaN, 0.2), 0);
});

test('the lowest corner of the part box drives the slide', () => {
  const delta = featureSheetSlideForYs([0.4, -0.9], 0.5);
  assert.equal(delta, featureSheetSlideNdc(-0.9, 0.5));
  assert.ok(delta < 0);
});

test('close restores the pre-open pose after an orbit, within epsilon', () => {
  const { camera, controls } = rig();
  let current = controls;
  const session = createSheetCameraSession({
    getCamera: () => camera,
    getControls: () => current,
    setControls: (next) => { current = next; },
    reducedMotion: () => true,
    flattenLift: () => {},
  });
  const before = captureViewPose(camera, current);
  session.slideBy(featureSheetSlideNdc(-0.85, 0.5));
  assert.ok(session.hasSnapshot());
  camera.position.applyAxisAngle(new Vector3(0, 0, 1), 0.4);
  camera.up.applyAxisAngle(new Vector3(0, 0, 1), 0.4);
  camera.lookAt(current.target);
  current.update();
  assert.equal(posesMatch(captureViewPose(camera, current), before, 1e-3), false);
  session.restore();
  current.update();
  const after = captureViewPose(camera, current);
  assert.equal(posesMatch(after, before, 1e-3), true, JSON.stringify({ before, after }));
  assert.equal(session.hasSnapshot(), false);
});

test('a second slide keeps the first snapshot', () => {
  const { camera, controls } = rig();
  let current = controls;
  const session = createSheetCameraSession({
    getCamera: () => camera,
    getControls: () => current,
    setControls: (next) => { current = next; },
    reducedMotion: () => true,
  });
  session.slideBy(-0.2);
  const first = session.snapshotPose();
  camera.position.x += 15;
  camera.lookAt(current.target);
  current.update();
  session.slideBy(-0.1);
  const second = session.snapshotPose();
  assert.deepEqual(second.position, first.position);
  session.restore();
  assert.equal(posesMatch(captureViewPose(camera, current), first, 1e-3), true);
});

test('projected part box sits above the card after the slide', () => {
  const { camera, controls } = rig();
  const box = { min: [-8, -8, 0], max: [8, 8, 16] };
  const points = boxCornerPoints(box, null);
  const fraction = 0.42;
  const cardTop = featureSheetCardTopNdc(fraction);
  panViewByNdcY({ camera, controls, ndcY: 0.35 });
  const buried = Math.min(...selectionNdcYs(camera, points));
  assert.ok(buried < cardTop, `expected the part under the card, ndc ${buried} top ${cardTop}`);
  const delta = featureSheetClearanceNdc({
    camera, controls, points, cardFraction: fraction,
  });
  assert.ok(delta < 0 && delta >= -FEATURE_SHEET_SLIDE_MAX, `delta ${delta}`);
  panViewByNdcY({ camera, controls, ndcY: delta });
  const cleared = Math.min(...selectionNdcYs(camera, points));
  assert.ok(cleared + 0.02 >= cardTop, `cleared ${cleared} cardTop ${cardTop} delta ${delta}`);
});

test('a part buried past 0.6 NDC slides only as far as the clamp', () => {
  const { camera, controls } = rig();
  const points = boxCornerPoints({ min: [-8, -8, 0], max: [8, 8, 16] }, null);
  const before = Math.min(...selectionNdcYs(camera, points));
  panViewByNdcY({ camera, controls, ndcY: 1.1 });
  const buried = Math.min(...selectionNdcYs(camera, points));
  const delta = featureSheetClearanceNdc({
    camera, controls, points, cardFraction: 0.42,
  });
  assert.equal(delta, -FEATURE_SHEET_SLIDE_MAX);
  panViewByNdcY({ camera, controls, ndcY: delta });
  const cleared = Math.min(...selectionNdcYs(camera, points));
  assert.ok(cleared > buried, `moved ${buried} -> ${cleared}, start ${before}`);
});
