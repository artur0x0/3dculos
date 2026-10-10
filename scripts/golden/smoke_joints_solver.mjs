#!/usr/bin/env node
/**
 * Joint solver. Pure numbers: two cubes, two cylinders, a distance,
 * an angle, a grounded part, one conflict, one redundant pair, the
 * analytic Jacobian, and a 2-scalar residual in the shared core.
 */
import { readFileSync } from 'node:fs';
import { solveResiduals } from '../../src/solver/residual.js';
import { jointSystem, solveJoints } from '../../src/joints/solveJoints.js';
import { quatFromOmega, rotateByQuat } from '../../src/joints/rigid.js';

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const Q0 = [0, 0, 0, 1];
const part = (id, t = [0, 0, 0], q = Q0) => ({ surfId: id, placement: { t: [...t], q: [...q] } });
const face = (id, at, n) => ({ part: id, kind: 'face', key: { at, n, area: 1 } });
const axis = (id, at, dir) => ({ part: id, kind: 'axis', key: { at, dir, radius: 1 } });

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const cubes = solveJoints({
  parts: [part('A'), part('B', [0.3, -0.2, 5])],
  joints: [{
    id: 'c', name: 'Coincident 1', type: 'coincident', opposed: true,
    a: face('A', [0, 0, 0.5], [0, 0, 1]),
    b: face('B', [0, 0, -0.5], [0, 0, -1]),
  }],
});
const pa = cubes.placements.A;
const pb = cubes.placements.B;
const na = rotateByQuat(pa.q, [0, 0, 1]);
const nb = rotateByQuat(pb.q, [0, 0, -1]);
const wa = [pa.t[0] + rotateByQuat(pa.q, [0, 0, 0.5])[0], pa.t[1] + rotateByQuat(pa.q, [0, 0, 0.5])[1], pa.t[2] + rotateByQuat(pa.q, [0, 0, 0.5])[2]];
const wb = [pb.t[0] + rotateByQuat(pb.q, [0, 0, -0.5])[0], pb.t[1] + rotateByQuat(pb.q, [0, 0, -0.5])[1], pb.t[2] + rotateByQuat(pb.q, [0, 0, -0.5])[2]];
ok('cubes solve', cubes.ok);
ok('cube gap under 1e-3', Math.abs(dot([wb[0] - wa[0], wb[1] - wa[1], wb[2] - wa[2]], na)) < 1e-3);
ok('cube normals opposed', dot(na, nb) < -1 + 1e-4);
ok('in-plane slide unchanged', Math.abs((pb.t[0] - pa.t[0]) - 0.3) < 1e-3 && Math.abs((pb.t[1] - pa.t[1]) + 0.2) < 1e-3);

const cyl = solveJoints({
  parts: [part('A'), part('B', [3, 4, 2])],
  joints: [{
    id: 'k', name: 'Concentric 1', type: 'concentric',
    a: axis('A', [0, 0, 0], [0, 0, 1]),
    b: axis('B', [0, 0, 0], [0, 0, 1]),
  }],
});
const da = rotateByQuat(cyl.placements.A.q, [0, 0, 1]);
const db = rotateByQuat(cyl.placements.B.q, [0, 0, 1]);
const rel = [
  cyl.placements.B.t[0] - cyl.placements.A.t[0],
  cyl.placements.B.t[1] - cyl.placements.A.t[1],
  cyl.placements.B.t[2] - cyl.placements.A.t[2],
];
const along = dot(rel, da);
const perp = Math.hypot(rel[0] - da[0] * along, rel[1] - da[1] * along, rel[2] - da[2] * along);
ok('cylinders solve', cyl.ok);
ok('axes collinear', perp < 1e-3 && dot(da, db) > 1 - 1e-4);
ok('axial slide unchanged', Math.abs(along - 2) < 1e-3);
ok('spin unchanged', Math.abs(cyl.placements.A.q[2]) < 1e-3 && Math.abs(cyl.placements.B.q[2]) < 1e-3);

const distance = solveJoints({
  parts: [part('A'), part('B', [0.25, -0.4, 1])],
  joints: [{
    id: 'd', name: 'Distance 1', type: 'distance', value: 10, sense: 1,
    a: face('A', [0, 0, 0.5], [0, 0, 1]),
    b: face('B', [0, 0, -0.5], [0, 0, -1]),
  }],
});
const dna = rotateByQuat(distance.placements.A.q, [0, 0, 1]);
const dnb = rotateByQuat(distance.placements.B.q, [0, 0, -1]);
const ra = rotateByQuat(distance.placements.A.q, [0, 0, 0.5]);
const rb = rotateByQuat(distance.placements.B.q, [0, 0, -0.5]);
const delta = [
  distance.placements.B.t[0] + rb[0] - (distance.placements.A.t[0] + ra[0]),
  distance.placements.B.t[1] + rb[1] - (distance.placements.A.t[1] + ra[1]),
  distance.placements.B.t[2] + rb[2] - (distance.placements.A.t[2] + ra[2]),
];
const signedGap = dot(delta, dna);
const cross = Math.hypot(
  dna[1] * dnb[2] - dna[2] * dnb[1],
  dna[2] * dnb[0] - dna[0] * dnb[2],
  dna[0] * dnb[1] - dna[1] * dnb[0],
);
ok('distance is 10 mm and faces stay parallel', distance.ok && Math.abs(signedGap - 10) < 1e-3 && cross < 1e-3);

const tilt = quatFromOmega([50 * Math.PI / 180, 0, 0]);
const angle = solveJoints({
  parts: [part('A'), part('B', [1, 2, 3], tilt)],
  joints: [{
    id: 'ang', name: 'Angle 1', type: 'angle', value: 30, sense: 1,
    a: axis('A', [0, 0, 0], [0, 0, 1]),
    b: axis('B', [0, 0, 0], [0, 0, 1]),
  }],
});
const ua = rotateByQuat(angle.placements.A.q, [0, 0, 1]);
const ub = rotateByQuat(angle.placements.B.q, [0, 0, 1]);
ok('angle is 30 degrees', angle.ok && Math.abs(dot(ua, ub) - Math.cos(30 * Math.PI / 180)) < 1e-3);

const groundedQ = quatFromOmega([0, 0, Math.PI / 2]);
const grounded = solveJoints({
  parts: [part('A', [1, 2, 3], groundedQ), part('B', [0, 0, 8])],
  joints: [
    { id: 'g', name: 'Ground 1', type: 'fixed', a: { part: 'A' } },
    {
      id: 'c2', name: 'Coincident 1', type: 'coincident', opposed: true,
      a: face('A', [0, 0, 0.5], [0, 0, 1]),
      b: face('B', [0, 0, -0.5], [0, 0, -1]),
    },
  ],
});
ok('fixed part does not move', grounded.ok
  && grounded.placements.A.t.every((v, i) => Math.abs(v - [1, 2, 3][i]) < 1e-9)
  && grounded.placements.A.q.every((v, i) => Math.abs(v - groundedQ[i]) < 1e-9));

const conflict = solveJoints({
  parts: [part('A'), part('B', [0.3, -0.2, 5])],
  joints: [
    {
      id: 'j1', name: 'Coincident 1', type: 'coincident', opposed: true,
      a: face('A', [0, 0, 0.5], [0, 0, 1]),
      b: face('B', [0, 0, -0.5], [0, 0, -1]),
    },
    {
      id: 'j2', name: 'Coincident 2', type: 'coincident', opposed: true,
      a: face('A', [0, 0, 0.5], [0, 0, 1]),
      b: face('B', [0, 0, 0.5], [0, 0, 1]),
    },
  ],
});
ok('conflict names the newest joint', conflict.ok === false && conflict.message === 'Joint "Coincident 2" conflicts');
ok('conflict restores the seed', conflict.placements.B.t[0] === 0.3 && conflict.placements.B.t[1] === -0.2 && conflict.placements.B.t[2] === 5);

const redundant = solveJoints({
  parts: [part('A'), part('B', [0, 0, 4])],
  joints: [
    { id: 'r1', name: 'Coincident 1', type: 'coincident', opposed: true, a: face('A', [0, 0, 0.5], [0, 0, 1]), b: face('B', [0, 0, -0.5], [0, 0, -1]) },
    { id: 'r2', name: 'Coincident 2', type: 'coincident', opposed: true, a: face('A', [0, 0, 0.5], [0, 0, 1]), b: face('B', [0, 0, -0.5], [0, 0, -1]) },
  ],
});
ok('redundant coincident agrees', redundant.ok && redundant.statuses.r1 === 'ok' && redundant.statuses.r2 === 'ok');

const partsJ = [part('A', [0.2, -0.1, 0.4]), part('B', [1.2, 0.3, 2], quatFromOmega([0.2, -0.1, 0.15]))];
const jointsJ = [{
  id: 'c', name: 'Coincident 1', type: 'coincident', opposed: true,
  a: face('A', [0, 0, 0.5], [0, 0, 1]),
  b: face('B', [0, 0.1, -0.5], [0.1, 0, -1]),
}];
const system = jointSystem(partsJ, jointsJ);
const x = [0.02, -0.03, 0.04, 0.1, -0.2, 0.05, -0.01, 0.02, 0.03, 0.2, 0.1, -0.4];
const J = system.jacobian(x);
const eps = 1e-6;
let jacOk = true;
for (let col = 0; col < system.n; col++) {
  const xp = x.slice();
  const xm = x.slice();
  xp[col] += eps;
  xm[col] -= eps;
  const rp = system.residual(xp);
  const rm = system.residual(xm);
  for (let row = 0; row < rp.length; row++) {
    if (Math.abs(J[row][col] - (rp[row] - rm[row]) / (2 * eps)) > 1e-5) jacOk = false;
  }
}
ok('analytic Jacobian matches finite differences', jacOk);

const sketch = solveResiduals({
  n: 2,
  residual: (v) => [v[0] * v[0] + v[1] * v[1] - 1, v[0] - v[1]],
  jacobian: null,
  x0: [0.2, 0.8],
  tol: 1e-8,
});
const core = readFileSync(new URL('../../src/solver/residual.js', import.meta.url), 'utf8');
ok('2-scalar residual solves', sketch.ok && Math.abs(sketch.x[0] - Math.SQRT1_2) < 1e-6 && Math.abs(sketch.x[0] - sketch.x[1]) < 1e-6);
ok('residual core does not import joints', !core.includes('joints') && !core.includes("from '../joints"));

console.log(`\njoints solver: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
