import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEdgeMeasurePick,
  buildFaceMeasurePick,
  buildPointMeasurePick,
  classifyMeasurePointer,
  measureChainIsCircular,
  measurePointerOnEdge,
  fitCircle,
  fitCylinder,
  measureReadout,
  segmentSegmentClosest,
  toggleMeasurePick,
} from './measurePicks.js';

function circlePoints(radius, z, count) {
  const pts = [];
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2;
    pts.push([radius * Math.cos(a), radius * Math.sin(a), z]);
  }
  return pts;
}

function row(readout, id) {
  return readout.rows.find((item) => item.id === id);
}

test('taps accumulate and the same pick removes itself', () => {
  const a = buildPointMeasurePick({ position: [0, 0, 0] });
  const b = buildPointMeasurePick({ position: [3, 4, 0] });
  let picks = toggleMeasurePick([], a);
  picks = toggleMeasurePick(picks, b);
  assert.equal(picks.length, 2);
  picks = toggleMeasurePick(picks, a);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].id, b.id);
  picks = toggleMeasurePick(picks, b);
  assert.equal(picks.length, 0);
});

test('point-point is distance and a signed delta', () => {
  const a = buildPointMeasurePick({ position: [0, 0, 0] });
  const b = buildPointMeasurePick({ position: [3, 4, 12] });
  const readout = measureReadout([a, b]);
  assert.ok(Math.abs(row(readout, 'distance').mm - 13) < 1e-9);
  assert.equal(row(readout, 'pair:dX').mm, 3);
  assert.equal(row(readout, 'pair:dY').mm, 4);
  assert.equal(row(readout, 'pair:dZ').mm, 12);
});

test('point-face distance is the perpendicular, with the delta to the foot', () => {
  const point = buildPointMeasurePick({ position: [2, 0, 25] });
  const face = buildFaceMeasurePick({
    patchId: 1,
    center: [0, 0, 10],
    normal: [0, 0, 1],
    points: [],
    indices: [],
  });
  const readout = measureReadout([point, face]);
  assert.ok(Math.abs(row(readout, 'distance').mm - 15) < 1e-9);
  assert.ok(Math.abs(row(readout, 'pair:dZ').mm - (-15)) < 1e-9);
  assert.ok(Math.abs(row(readout, 'pair:dX').mm) < 1e-9);
});

test('parallel faces report plane distance and the center delta', () => {
  const top = buildFaceMeasurePick({
    patchId: 'top',
    center: [0, 0, 15],
    normal: [0, 0, 1],
    points: [],
  });
  const bottom = buildFaceMeasurePick({
    patchId: 'bottom',
    center: [0, 0, -15],
    normal: [0, 0, -1],
    points: [],
  });
  const readout = measureReadout([top, bottom]);
  assert.ok(Math.abs(row(readout, 'distance').mm - 30) < 1e-9);
  assert.ok(row(readout, 'angle').deg < 0.01);
  assert.ok(Math.abs(row(readout, 'pair:dZ').mm - (-30)) < 1e-9);
  assert.ok(Math.abs(row(readout, 'pair:dX').mm) < 1e-9);
  assert.ok(Math.abs(row(readout, 'pair:dY').mm) < 1e-9);
});

test('angled faces report the angle and the center-to-center distance', () => {
  const top = buildFaceMeasurePick({
    patchId: 'top',
    center: [0, 0, 10],
    normal: [0, 0, 1],
    points: [],
  });
  const side = buildFaceMeasurePick({
    patchId: 'side',
    center: [20, 0, 0],
    normal: [1, 0, 0],
    points: [],
  });
  const readout = measureReadout([top, side]);
  assert.ok(Math.abs(row(readout, 'angle').deg - 90) < 1e-6);
  assert.ok(Math.abs(row(readout, 'distance').mm - Math.hypot(20, 10)) < 1e-6);
  assert.equal(row(readout, 'pair:dX').mm, 20);
  assert.equal(row(readout, 'pair:dZ').mm, -10);
});

test('edge-edge reports the gap and the angle', () => {
  const gap = segmentSegmentClosest([0, 0, 0], [10, 0, 0], [0, 4, 0], [10, 4, 0]);
  assert.ok(Math.abs(gap.distance - 4) < 1e-9);
  const a = buildEdgeMeasurePick({
    edge: { key: 'a', va: [0, 0, 0], vb: [10, 0, 0], tangent: [1, 0, 0], length: 10 },
  });
  const b = buildEdgeMeasurePick({
    edge: { key: 'b', va: [0, 0, 0], vb: [0, 10, 0], tangent: [0, 1, 0], length: 10 },
  });
  const readout = measureReadout([a, b]);
  assert.ok(row(readout, 'distance').mm < 1e-6);
  assert.ok(Math.abs(row(readout, 'angle').deg - 90) < 1e-6);
});

test('a circular edge and a cylindrical face report radius and diameter', () => {
  const ring = circlePoints(12, 15, 16);
  const circle = fitCircle(ring);
  assert.ok(circle);
  assert.ok(Math.abs(circle.radius - 12) < 1e-6);
  const edge = buildEdgeMeasurePick({
    edge: {
      key: 'rim',
      va: ring[0],
      vb: ring[1],
      tangent: [0, 1, 0],
      length: 1,
      pts: ring,
    },
  });
  assert.ok(edge.circle);
  const edgeReadout = measureReadout([edge]);
  assert.ok(Math.abs(row(edgeReadout, `radius:${edge.id}`).mm - 12) < 1e-4);
  assert.ok(Math.abs(row(edgeReadout, `diameter:${edge.id}`).mm - 24) < 1e-4);
  assert.equal(row(edgeReadout, 'distance'), undefined);

  const wall = [
    ...circlePoints(12, -15, 16),
    ...circlePoints(12, 15, 16),
  ];
  const cylinder = fitCylinder(wall);
  assert.ok(cylinder);
  assert.ok(Math.abs(cylinder.radius - 12) < 1e-4);
  const face = buildFaceMeasurePick({
    patchId: 'wall',
    center: [0, 0, 0],
    normal: [1, 0, 0],
    points: wall,
  });
  const faceReadout = measureReadout([face]);
  assert.ok(Math.abs(row(faceReadout, `radius:${face.id}`).mm - 12) < 1e-3);
  assert.ok(Math.abs(row(faceReadout, `diameter:${face.id}`).mm - 24) < 1e-3);
});

test('a flat cap is not a cylinder and a straight edge is not a circle', () => {
  const cap = circlePoints(12, 15, 16);
  assert.equal(fitCylinder(cap), null);
  const straight = buildEdgeMeasurePick({
    edge: { key: 'line', va: [0, 0, 0], vb: [10, 0, 0], tangent: [1, 0, 0], length: 10 },
  });
  assert.equal(straight.circle, null);
  const readout = measureReadout([straight]);
  assert.ok(Math.abs(row(readout, 'distance').mm - 10) < 1e-9);
});

test('a tessellated circle is an edge, not a corner point', () => {
  const pts = circlePoints(7, 28, 16);
  const members = pts.map((a, i) => ({ va: a, vb: pts[(i + 1) % pts.length] }));
  assert.equal(measureChainIsCircular(members), true);
  assert.equal(measureChainIsCircular([{ va: [0, 0, 0], vb: [10, 0, 0] }]), false);
});

test('a face hit counts as an edge only when it is on that edge', () => {
  assert.equal(measurePointerOnEdge({ edgeGap: 0.4, hasFace: true }), true);
  assert.equal(measurePointerOnEdge({ edgeGap: 12, hasFace: true }), false);
  assert.equal(measurePointerOnEdge({ edgeGap: Infinity, hasFace: false }), true);
});

test('classify prefers a corner point, then an edge, then a face', () => {
  assert.equal(classifyMeasurePointer({
    vertexDist: 4, vertexT: 0.02, edgeDist: 4, hasFace: true,
  }), 'point');
  assert.equal(classifyMeasurePointer({
    vertexDist: 8, vertexT: 0.5, edgeDist: 2, hasFace: true,
  }), 'edge');
  assert.equal(classifyMeasurePointer({
    vertexDist: 40, vertexT: 0.5, edgeDist: 40, hasFace: true,
  }), 'face');
  assert.equal(classifyMeasurePointer({ hasFace: false, edgeDist: 80 }), null);
});
