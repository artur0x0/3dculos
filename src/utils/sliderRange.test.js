import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PerspectiveCamera } from 'three';
import {
  cutTravelMm,
  directionOffscreenMm,
  moveFaceRange,
  scaleFreshContour,
  sectionThumbRange,
  shellWallRange,
  travelRangeMm,
} from './sliderRange.js';

describe('feature-card ranges', () => {
  it('shell and move-face follow L, and a thin part caps the wall', () => {
    const shell = shellWallRange(100);
    assert.equal(shell.maxMm, 25);
    assert.equal(shell.defaultMm, 2.5);
    const thin = shellWallRange(100, 2);
    assert.equal(thin.maxMm, 0.9);
    assert.equal(thin.defaultMm, 0.9);
    const face = moveFaceRange(100);
    assert.equal(face.maxMm, 50);
    assert.equal(face.defaultMm, 2);
  });

  it('cut travel is the far side of the box, then the 2/3 thumb rule', () => {
    const bounds = { min: [-10, -10, -10], max: [10, 10, 10] };
    const far = cutTravelMm(bounds, { center: [0, 0, 0], normal: [0, 0, 1] });
    assert.equal(far, 10);
    assert.equal(travelRangeMm(far, 100), (10 * 27) / 13);
    assert.equal(travelRangeMm(null, 100), (150 * 27) / 13);
  });

  it('measures how far a direction must travel to leave the view', () => {
    const camera = new PerspectiveCamera(50, 1, 0.1, 5000);
    camera.position.set(0, 0, 200);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const box = { min: [-20, -15, -10], max: [20, 15, 10] };
    const along = directionOffscreenMm(camera, box, [1, 0, 0]);
    assert.ok(along > 20);
    const already = { min: [800, 800, 0], max: [840, 830, 20] };
    assert.equal(directionOffscreenMm(camera, already, [1, 0, 0]), 0);
    assert.equal(directionOffscreenMm(null, box, [1, 0, 0]), null);
  });

  it('scales a fresh contour off the 100 mm reference and leaves L = 100 alone', () => {
    const fresh = {
      params: { radius: 5, segments: 64 },
      extrude: { distance: 10, direction: 'normal' },
      loft: { profiles: [{ offset: 20, params: { radius: 8 } }] },
    };
    assert.equal(scaleFreshContour(fresh, 100), fresh);
    const scaled = scaleFreshContour(fresh, 400);
    assert.equal(scaled.params.radius, 20);
    assert.equal(scaled.params.segments, 64);
    assert.equal(scaled.extrude.distance, 40);
    assert.equal(scaled.loft.profiles[0].offset, 80);
    assert.equal(scaled.loft.profiles[0].params.radius, 32);
  });

  it('keeps the section box at two-thirds of the thumb', () => {
    const range = sectionThumbRange(-10, 30);
    assert.equal(range.center, 10);
    assert.equal(range.reach, (20 * 27) / 13);
    assert.equal(range.min, 10 - range.reach);
    assert.equal(range.max, 10 + range.reach);
    const fallback = sectionThumbRange(-100, 100);
    assert.ok(Math.abs(fallback.reach - (100 * 27) / 13) < 1e-9);
  });
});
