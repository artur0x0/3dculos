import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dimensionAngle,
  dimensionEndpoints,
  dimensionLayout,
  dimensionMarkup,
} from './contourDimensionDraw.js';
import { sketchPointScaleFromDistance, SKETCH_POINT_PX, SKETCH_POINT_RADIUS } from './sketchLine.js';

const model = {
  points: [
    { id: 'p0', at: [0, 0] },
    { id: 'p1', at: [30, 0] },
    { id: 'p2', at: [10, 24] },
  ],
  lines: [
    { id: 'e0', a: 'p0', b: 'p1' },
    { id: 'e1', a: 'p1', b: 'p2' },
    { id: 'e2', a: 'p2', b: 'p0' },
  ],
  arcs: [{ id: 'a0', center: 'p0', radius: 8, full: true }],
};

function project(uv) {
  return { x: uv[0] * 4, y: uv[1] * -4 };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test('a length dimension offsets a double-headed arrow from the edge', () => {
  const ends = dimensionEndpoints(model, { kind: 'length', edge: 'e0' });
  assert.deepEqual(ends.a, [0, 0]);
  assert.deepEqual(ends.b, [30, 0]);
  const fig = dimensionLayout(model, { kind: 'length', edge: 'e0' }, project);
  assert.equal(fig.kind, 'length');
  assert.equal(fig.extensions.length, 2);
  assert.equal(fig.arrows.length, 2);
  assert.ok(fig.shaft);
  const span = dist(fig.shaft[0], fig.shaft[1]);
  assert.ok(Math.abs(span - 120) < 1, `shaft ${span}`);
  assert.ok(Math.abs(fig.label.x - (fig.shaft[0].x + fig.shaft[1].x) / 2) < 0.5);
  assert.ok(Math.abs(fig.label.y - (fig.shaft[0].y + fig.shaft[1].y) / 2) < 0.5);
  assert.ok(Math.abs(fig.label.y - project([0, 0]).y) > 16, 'the arrow leaves the edge');
  const tipOut = dist(fig.arrows[0].tip, fig.shaft[1]) > dist(fig.arrows[0].left, fig.shaft[1]);
  assert.equal(tipOut, true);
  const html = dimensionMarkup({ ...fig, id: 'd0' });
  assert.match(html, /data-contour-dim-kind="length"/);
  assert.match(html, /data-contour-dim-ext/);
  assert.match(html, /data-contour-dim-shaft/);
  assert.equal(html.match(/data-contour-dim-arrow/g).length, 2);
});

test('an offset dimension runs from the point to its foot on the line', () => {
  const ends = dimensionEndpoints(model, { kind: 'offset', point: 'p2', edge: 'e0' });
  assert.deepEqual(ends.a, [10, 24]);
  assert.ok(Math.abs(ends.b[0] - 10) < 1e-6 && Math.abs(ends.b[1]) < 1e-6);
  const fig = dimensionLayout(model, { kind: 'offset', point: 'p2', edge: 'e0' }, project);
  assert.equal(fig.arrows.length, 2);
  assert.equal(fig.extensions.length, 2);
});

test('a distance between two points uses those endpoints', () => {
  const ends = dimensionEndpoints(model, { kind: 'distance', a: 'p0', b: 'p2' });
  assert.deepEqual(ends.a, [0, 0]);
  assert.deepEqual(ends.b, [10, 24]);
});

test('a radius dimension connects the center to the rim', () => {
  const ends = dimensionEndpoints(model, { kind: 'radius', arc: 'a0' });
  assert.deepEqual(ends.a, [0, 0]);
  assert.ok(Math.hypot(ends.b[0] - 0, ends.b[1] - 0) - 8 < 1e-6);
  const fig = dimensionLayout(model, { kind: 'radius', arc: 'a0' }, project);
  assert.equal(fig.kind, 'radius');
  assert.equal(fig.arrows.length, 2);
});

test('an angle dimension is an arc with two arrowheads', () => {
  const dim = { kind: 'angle', a: 'e0', b: 'e2', value: 67, sense: 1 };
  const angle = dimensionAngle(model, dim);
  assert.ok(angle);
  assert.ok(Math.abs(angle.vertex[0]) < 1e-6 && Math.abs(angle.vertex[1]) < 1e-6);
  assert.ok(Math.abs(Math.abs(angle.sweep) * 180 / Math.PI - 67) < 2, String(angle.sweep));
  const fig = dimensionLayout(model, dim, project);
  assert.equal(fig.kind, 'angle');
  assert.equal(fig.shaft, null);
  assert.ok(fig.arc.length > 4);
  assert.equal(fig.arrows.length, 2);
  assert.equal(fig.extensions.length, 2);
  const html = dimensionMarkup({ ...fig, id: 'd1' });
  assert.match(html, /data-contour-dim-arc/);
  assert.equal(html.match(/data-contour-dim-arrow/g).length, 2);
});

test('a sketch point keeps a constant screen diameter', () => {
  const fov = 45;
  const height = 800;
  for (const distance of [40, 180, 900]) {
    const scale = sketchPointScaleFromDistance(distance, fov, height, 1);
    const worldPerPx = (2 * Math.tan((fov * Math.PI / 180) / 2) * distance) / height;
    const diameterPx = (SKETCH_POINT_RADIUS * scale * 2) / worldPerPx;
    assert.ok(Math.abs(diameterPx - SKETCH_POINT_PX) < 0.05, `${distance} -> ${diameterPx}`);
  }
});
