import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { solveResiduals } from './residual.js';

test('a 2-scalar residual solves without a caller-supplied Jacobian', () => {
  const solved = solveResiduals({
    n: 2,
    residual: (x) => [x[0] * x[0] + x[1] * x[1] - 1, x[0] - x[1]],
    jacobian: null,
    x0: [0.2, 0.8],
    tol: 1e-8,
    maxIter: 40,
  });
  assert.equal(solved.ok, true);
  assert.ok(Math.abs(solved.x[0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(solved.x[1] - solved.x[0]) < 1e-6);
  assert.ok(Math.abs(solved.residual[0]) < 1e-8);
});

test('an unconstrained component stays at x0', () => {
  const solved = solveResiduals({
    n: 2,
    residual: (x) => [x[0] - 1],
    jacobian: () => [[1, 0]],
    x0: [4, 7],
    tol: 1e-9,
  });
  assert.equal(solved.ok, true);
  assert.ok(Math.abs(solved.x[0] - 1) < 1e-6);
  assert.ok(Math.abs(solved.x[1] - 7) < 1e-6);
});

test('the residual core does not import joints', () => {
  const src = readFileSync(new URL('./residual.js', import.meta.url), 'utf8');
  assert.equal(src.includes('joints'), false);
  assert.equal(src.includes("from '../joints"), false);
});
