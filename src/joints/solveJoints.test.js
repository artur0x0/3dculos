import assert from 'node:assert/strict';
import test from 'node:test';
import { jointSystem, solveJoints } from './solveJoints.js';
import { rotateByQuat, quatFromOmega } from './rigid.js';

const Q0 = [0, 0, 0, 1];

function part(id, t = [0, 0, 0], q = Q0) {
  return { surfId: id, placement: { t: t.slice(), q: q.slice() } };
}

function face(partId, at, n) {
  return { part: partId, kind: 'face', key: { at, n, area: 1 } };
}

function axis(partId, at, dir) {
  return { part: partId, kind: 'axis', key: { at, dir, radius: 1 } };
}

function world(placement, local) {
  return {
    at: [
      placement.t[0] + rotateByQuat(placement.q, local)[0],
      placement.t[1] + rotateByQuat(placement.q, local)[1],
      placement.t[2] + rotateByQuat(placement.q, local)[2],
    ],
    dir: rotateByQuat(placement.q, local),
  };
}

function gap(placementA, localA, nA, placementB, localB) {
  const pa = world(placementA, localA).at;
  const pb = world(placementB, localB).at;
  const n = world(placementA, nA).dir;
  return (pb[0] - pa[0]) * n[0] + (pb[1] - pa[1]) * n[1] + (pb[2] - pa[2]) * n[2];
}

test('two cubes go coincident and keep the in-plane slide', () => {
  const solved = solveJoints({
    parts: [part('A'), part('B', [0.3, -0.2, 5])],
    joints: [{
      id: 'j1',
      name: 'Coincident 1',
      type: 'coincident',
      opposed: true,
      a: face('A', [0, 0, 0.5], [0, 0, 1]),
      b: face('B', [0, 0, -0.5], [0, 0, -1]),
    }],
  });
  assert.equal(solved.ok, true);
  assert.equal(solved.statuses.j1, 'ok');
  const a = solved.placements.A;
  const b = solved.placements.B;
  assert.ok(Math.abs(gap(a, [0, 0, 0.5], [0, 0, 1], b, [0, 0, -0.5])) < 1e-3);
  const na = world(a, [0, 0, 1]).dir;
  const nb = world(b, [0, 0, -1]).dir;
  const dot = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
  assert.ok(dot < -1 + 1e-6);
  assert.ok(Math.abs((b.t[0] - a.t[0]) - 0.3) < 1e-4);
  assert.ok(Math.abs((b.t[1] - a.t[1]) - (-0.2)) < 1e-4);
  for (const pose of [a, b]) {
    assert.ok(Math.hypot(pose.q[0], pose.q[1], pose.q[2]) < 1e-2);
  }
});

test('two cylinders go concentric and keep slide and spin', () => {
  const solved = solveJoints({
    parts: [part('A'), part('B', [3, 4, 2])],
    joints: [{
      id: 'j1',
      name: 'Concentric 1',
      type: 'concentric',
      a: axis('A', [0, 0, 0], [0, 0, 1]),
      b: axis('B', [0, 0, 0], [0, 0, 1]),
    }],
  });
  assert.equal(solved.ok, true);
  const a = solved.placements.A;
  const b = solved.placements.B;
  const da = world(a, [0, 0, 1]).dir;
  const db = world(b, [0, 0, 1]).dir;
  const align = da[0] * db[0] + da[1] * db[1] + da[2] * db[2];
  assert.ok(align > 1 - 1e-4);
  const rel = [b.t[0] - a.t[0], b.t[1] - a.t[1], b.t[2] - a.t[2]];
  const along = rel[0] * da[0] + rel[1] * da[1] + rel[2] * da[2];
  const perp = Math.hypot(rel[0] - da[0] * along, rel[1] - da[1] * along, rel[2] - da[2] * along);
  assert.ok(perp < 1e-3);
  assert.ok(Math.abs(along - 2) < 1e-3);
  assert.ok(Math.abs(a.q[2]) < 1e-3 && Math.abs(b.q[2]) < 1e-3);
});

test('distance and angle hit their values', () => {
  const distance = solveJoints({
    parts: [part('A'), part('B', [0.25, -0.4, 1])],
    joints: [{
      id: 'd',
      name: 'Distance 1',
      type: 'distance',
      value: 10,
      sense: 1,
      a: face('A', [0, 0, 0.5], [0, 0, 1]),
      b: face('B', [0, 0, -0.5], [0, 0, -1]),
    }],
  });
  assert.equal(distance.ok, true);
  const measured = gap(distance.placements.A, [0, 0, 0.5], [0, 0, 1], distance.placements.B, [0, 0, -0.5]);
  assert.ok(Math.abs(measured - 10) < 1e-3);
  assert.ok(Math.abs((distance.placements.B.t[0] - distance.placements.A.t[0]) - 0.25) < 1e-4);
  assert.ok(Math.abs((distance.placements.B.t[1] - distance.placements.A.t[1]) - (-0.4)) < 1e-4);
  const na = world(distance.placements.A, [0, 0, 1]).dir;
  const nb = world(distance.placements.B, [0, 0, -1]).dir;
  const cross = Math.hypot(na[1] * nb[2] - na[2] * nb[1], na[2] * nb[0] - na[0] * nb[2], na[0] * nb[1] - na[1] * nb[0]);
  assert.ok(cross < 1e-3);

  const tilt = quatFromOmega([50 * Math.PI / 180, 0, 0]);
  const angle = solveJoints({
    parts: [part('A'), part('B', [1, 2, 3], tilt)],
    joints: [{
      id: 'ang',
      name: 'Angle 1',
      type: 'angle',
      value: 30,
      sense: 1,
      a: axis('A', [0, 0, 0], [0, 0, 1]),
      b: axis('B', [0, 0, 0], [0, 0, 1]),
    }],
  });
  assert.equal(angle.ok, true);
  const da = world(angle.placements.A, [0, 0, 1]).dir;
  const db = world(angle.placements.B, [0, 0, 1]).dir;
  const dot = da[0] * db[0] + da[1] * db[1] + da[2] * db[2];
  assert.ok(Math.abs(dot - Math.cos(30 * Math.PI / 180)) < 1e-3);
  assert.ok(Math.abs(angle.placements.B.t[0] - 1) < 1e-4);
  assert.ok(Math.abs(angle.placements.B.t[1] - 2) < 1e-4);
  assert.ok(Math.abs(angle.placements.B.t[2] - 3) < 1e-4);
});

test('fixed does not move the grounded part', () => {
  const q = quatFromOmega([0, 0, Math.PI / 2]);
  const solved = solveJoints({
    parts: [part('A', [1, 2, 3], q), part('B', [0, 0, 8])],
    joints: [
      { id: 'g', name: 'Ground 1', type: 'fixed', a: { part: 'A' } },
      {
        id: 'c',
        name: 'Coincident 1',
        type: 'coincident',
        opposed: true,
        a: face('A', [0, 0, 0.5], [0, 0, 1]),
        b: face('B', [0, 0, -0.5], [0, 0, -1]),
      },
    ],
  });
  assert.equal(solved.ok, true);
  assert.deepEqual(solved.placements.A.t, [1, 2, 3]);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(solved.placements.A.q[i] - q[i]) < 1e-9);
});

test('an inconsistent second coincident is named and the seed poses stay', () => {
  const parts = [part('A'), part('B', [0.3, -0.2, 5])];
  const solved = solveJoints({
    parts,
    joints: [
      {
        id: 'j1',
        name: 'Coincident 1',
        type: 'coincident',
        opposed: true,
        a: face('A', [0, 0, 0.5], [0, 0, 1]),
        b: face('B', [0, 0, -0.5], [0, 0, -1]),
      },
      {
        id: 'j2',
        name: 'Coincident 2',
        type: 'coincident',
        opposed: true,
        a: face('A', [0, 0, 0.5], [0, 0, 1]),
        b: face('B', [0, 0, 0.5], [0, 0, 1]),
      },
    ],
  });
  assert.equal(solved.ok, false);
  assert.equal(solved.statuses.j2, 'conflict');
  assert.equal(solved.message, 'Joint "Coincident 2" conflicts');
  assert.deepEqual(solved.placements.B.t, [0.3, -0.2, 5]);
  assert.deepEqual(solved.placements.A.t, [0, 0, 0]);
});

test('a redundant coincident that agrees is success', () => {
  const faceA = face('A', [0, 0, 0.5], [0, 0, 1]);
  const faceB = face('B', [0, 0, -0.5], [0, 0, -1]);
  const solved = solveJoints({
    parts: [part('A'), part('B', [0, 0, 4])],
    joints: [
      { id: 'j1', name: 'Coincident 1', type: 'coincident', opposed: true, a: faceA, b: faceB },
      { id: 'j2', name: 'Coincident 2', type: 'coincident', opposed: true, a: faceA, b: faceB },
    ],
  });
  assert.equal(solved.ok, true);
  assert.equal(solved.statuses.j1, 'ok');
  assert.equal(solved.statuses.j2, 'ok');
  assert.ok(Math.abs(gap(
    solved.placements.A, [0, 0, 0.5], [0, 0, 1],
    solved.placements.B, [0, 0, -0.5],
  )) < 1e-3);
});

test('the analytic Jacobian matches finite differences', () => {
  const parts = [part('A', [0.2, -0.1, 0.4]), part('B', [1.2, 0.3, 2], quatFromOmega([0.2, -0.1, 0.15]))];
  const joints = [
    {
      id: 'c',
      name: 'Coincident 1',
      type: 'coincident',
      opposed: true,
      a: face('A', [0, 0, 0.5], [0, 0, 1]),
      b: face('B', [0, 0.1, -0.5], [0.1, 0, -1]),
    },
    {
      id: 'k',
      name: 'Concentric 1',
      type: 'concentric',
      a: axis('A', [0, 0, 0], [0, 0, 1]),
      b: axis('B', [0.2, 0, 0], [0.1, 0.2, 1]),
    },
    {
      id: 'd',
      name: 'Distance 1',
      type: 'distance',
      value: 10,
      sense: -1,
      a: face('A', [0.5, 0, 0], [1, 0, 0]),
      b: face('B', [-0.5, 0, 0], [-1, 0.2, 0]),
    },
    {
      id: 'ang',
      name: 'Angle 1',
      type: 'angle',
      value: 30,
      sense: 1,
      a: axis('A', [0, 0, 0], [0, 1, 0]),
      b: axis('B', [0, 0, 0], [0, 0, 1]),
    },
    {
      id: 'sym',
      name: 'Symmetric 1',
      type: 'symmetric',
      a: face('A', [0, 0, 1], [0, 0.1, 1]),
      a2: face('A', [0, 0, -1], [0.05, 0, -1]),
      b: face('B', [0.2, 0, 1], [0, 0, 1]),
      b2: face('B', [-0.2, 0.1, -1], [0.1, 0, -1]),
    },
  ];
  const system = jointSystem(parts, joints);
  const x = [0.02, -0.03, 0.04, 0.1, -0.2, 0.05, -0.01, 0.02, 0.03, 0.2, 0.1, -0.4];
  const J = system.jacobian(x);
  const eps = 1e-6;
  for (let col = 0; col < system.n; col++) {
    const xp = x.slice();
    const xm = x.slice();
    xp[col] += eps;
    xm[col] -= eps;
    const rp = system.residual(xp);
    const rm = system.residual(xm);
    for (let row = 0; row < rp.length; row++) {
      const fd = (rp[row] - rm[row]) / (2 * eps);
      assert.ok(Math.abs(J[row][col] - fd) < 1e-5, `J[${row}][${col}] ${J[row][col]} vs ${fd}`);
    }
  }
});

test('symmetric of two free parts slides the gap shut and does not tilt', () => {
  const solved = solveJoints({
    parts: [part('A', [0, 0, 0]), part('B', [80, 0, 20])],
    joints: [{
      id: 's',
      name: 'Symmetric 1',
      type: 'symmetric',
      a: face('A', [0, 0, 15], [0, 0, 1]),
      a2: face('A', [0, 0, -15], [0, 0, -1]),
      b: face('B', [0, 0, 15], [0, 0, 1]),
      b2: face('B', [0, 0, -15], [0, 0, -1]),
    }],
  });
  assert.equal(solved.ok, true, solved.message || String(solved.residual));
  const a = solved.placements.A;
  const b = solved.placements.B;
  const na = world(a, [0, 0, 1]).dir;
  const planeGap = (b.t[0] - a.t[0]) * na[0] + (b.t[1] - a.t[1]) * na[1] + (b.t[2] - a.t[2]) * na[2];
  assert.ok(Math.abs(planeGap) < 1e-3, String(planeGap));
  assert.ok(Math.abs(b.t[2] - a.t[2]) < 0.1, String(b.t[2] - a.t[2]));
  assert.ok(Math.abs(a.t[0]) < 1e-2, String(a.t[0]));
  assert.ok(Math.abs(b.t[0] - 80) < 1e-2, String(b.t[0]));
  assert.ok(Math.abs(a.t[1]) < 1e-2 && Math.abs(b.t[1]) < 1e-2);
  for (const pose of [a, b]) {
    assert.ok(Math.hypot(pose.q[0], pose.q[1], pose.q[2]) < 1e-2, pose.q.join(','));
  }
});

test('symmetric aligns the center planes and leaves the in-plane slide', () => {
  const tilt = quatFromOmega([25 * Math.PI / 180, 0, 0]);
  const solved = solveJoints({
    parts: [part('A', [1, 2, 3]), part('B', [6, -3, 12], tilt)],
    joints: [
      { id: 'g', name: 'Fixed 1', type: 'fixed', a: { part: 'A' } },
      {
        id: 's',
        name: 'Symmetric 1',
        type: 'symmetric',
        a: face('A', [0, 0, 1], [0, 0, 1]),
        a2: face('A', [0, 0, -1], [0, 0, -1]),
        b: face('B', [0, 0, 1], [0, 0, 1]),
        b2: face('B', [0, 0, -1], [0, 0, -1]),
      },
    ],
  });
  assert.equal(solved.ok, true, solved.message || '');
  assert.equal(solved.statuses.s, 'ok');
  assert.deepEqual(solved.placements.A.t, [1, 2, 3]);
  const na = world(solved.placements.A, [0, 0, 1]).dir;
  const nb = world(solved.placements.B, [0, 0, 1]).dir;
  const align = Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]);
  assert.ok(align > 1 - 1e-3, String(align));
  const midA = world(solved.placements.A, [0, 0, 0]).at;
  const midB = world(solved.placements.B, [0, 0, 0]).at;
  const gapZ = (midB[0] - midA[0]) * na[0] + (midB[1] - midA[1]) * na[1] + (midB[2] - midA[2]) * na[2];
  assert.ok(Math.abs(gapZ) < 1e-3, String(gapZ));
  assert.ok(Math.abs(solved.placements.B.t[0] - 6) < 1e-2);
  assert.ok(Math.abs(solved.placements.B.t[1] - (-3)) < 1e-2);
});

test('a concentric edge uses the circle axis, not the tangent', () => {
  const solved = solveJoints({
    parts: [part('A'), part('B', [2, 0, 0])],
    joints: [{
      id: 'e',
      name: 'Concentric 1',
      type: 'concentric',
      a: {
        part: 'A',
        kind: 'edge',
        key: {
          at: [1, 0, 0],
          dir: [0, 1, 0],
          length: 1,
          circle: { at: [0, 0, 0], dir: [0, 0, 1] },
          faces: [],
        },
      },
      b: axis('B', [0, 0, 0], [0, 0, 1]),
    }],
  });
  assert.equal(solved.ok, true);
  const a = solved.placements.A;
  const b = solved.placements.B;
  assert.ok(Math.abs(b.t[0] - a.t[0]) < 1e-3);
  assert.ok(Math.abs(b.t[1] - a.t[1]) < 1e-3);
});
