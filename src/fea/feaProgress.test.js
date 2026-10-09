import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEA_STAGES,
  formatDofCount,
  formatFeaTimingLog,
  formatSeconds,
  initialFeaProgress,
  measureFraction,
  reduceFeaProgress,
} from './feaProgress.js';

function run(events) {
  return events.reduce((state, event) => reduceFeaProgress(state, event), initialFeaProgress(0));
}

test('PCG iterations advance against the estimate', () => {
  const measured = measureFraction({ solver: 'pcg', iteration: 25, estimatedIterations: 100 });
  assert.equal(measured.indeterminate, false);
  assert.equal(measured.fraction, 0.25);
  const state = run([
    { type: 'start', now: 0 },
    { type: 'stage', stage: 'solving', now: 10, solver: 'pcg', iteration: 25, estimatedIterations: 100 },
  ]);
  assert.equal(state.percent, 25);
  assert.equal(state.stageLabel, 'Solving');
  assert.equal(state.indeterminate, false);
});

test('PCG residual drop is measured on a log scale when there is no estimate', () => {
  const measured = measureFraction({ solver: 'pcg', residual0: 1, residual: 1e-4, tol: 1e-8 });
  assert.equal(measured.indeterminate, false);
  assert.ok(Math.abs(measured.fraction - 0.5) < 1e-9);
  const early = measureFraction({ residual0: 1, residual: 1, tol: 1e-8 });
  assert.equal(early.fraction, 0);
  const done = measureFraction({ residual0: 1, residual: 1e-8, tol: 1e-8 });
  assert.equal(done.fraction, 1);
});

test('an iteration estimate wins over the residual', () => {
  const measured = measureFraction({
    iteration: 10,
    estimatedIterations: 40,
    residual0: 1,
    residual: 1e-8,
    tol: 1e-8,
  });
  assert.equal(measured.fraction, 0.25);
});

test('Cholesky is a factor step then a solve step', () => {
  const factor = measureFraction({ solver: 'cholesky', choleskyStep: 'factor' });
  assert.equal(factor.fraction, 0.5);
  assert.equal(factor.stepLabel, 'factor');
  const solve = measureFraction({ solver: 'cholesky', choleskyStep: 'solve' });
  assert.equal(solve.fraction, 1);
  assert.equal(solve.stepLabel, 'solve');
  const state = run([
    { type: 'start', now: 0 },
    { type: 'stage', stage: 'solving', now: 5, solver: 'cholesky', choleskyStep: 'factor' },
  ]);
  assert.equal(state.percent, 50);
  assert.equal(state.stepLabel, 'factor');
});

test('a mesher fraction is shown, and no callback stays indeterminate', () => {
  const reported = measureFraction({ stage: 'meshing', fraction: 0.4 });
  assert.equal(reported.fraction, 0.4);
  const quiet = measureFraction({ stage: 'meshing' });
  assert.equal(quiet.fraction, null);
  assert.equal(quiet.indeterminate, true);
  const state = run([
    { type: 'start', now: 0 },
    { type: 'stage', stage: 'meshing', now: 20 },
    { type: 'tick', now: 2500 },
  ]);
  assert.equal(state.percent, null);
  assert.equal(state.indeterminate, true);
  assert.equal(state.stageLabel, 'Meshing');
  assert.equal(state.elapsedText, '2.5 s');
});

test('a finished run reads Meshed in, solved in, DOF, and total', () => {
  const state = run([
    { type: 'start', now: 1000 },
    { type: 'stage', stage: 'loading-mesher', now: 1000 },
    { type: 'stage', stage: 'meshing', now: 1200 },
    { type: 'stage', stage: 'solving', now: 3000 },
    {
      type: 'finish',
      now: 4600,
      dofs: 12000,
      stageTimings: {
        'loading-mesher': 200,
        meshing: 1800,
        assembling: 40,
        solving: 1400,
        'post-processing': 160,
      },
    },
  ]);
  assert.equal(state.status, 'done');
  assert.equal(state.text, 'Meshed in 2.0 s, solved in 1.4 s (12k DOF), total 3.6 s');
  assert.match(state.text, /Meshed in .* solved in .* DOF.*total/);
  assert.equal(state.details.length, FEA_STAGES.length);
  assert.equal(state.details.find((row) => row.id === 'assembling').seconds, '0.0 s');
  assert.equal(state.details.find((row) => row.id === 'solving').seconds, '1.4 s');
  const log = formatFeaTimingLog(state);
  assert.equal(log.startsWith('[fea-timing] ok '), true);
  assert.match(log, /meshed=2000ms/);
  assert.match(log, /solved=1400ms/);
  assert.match(log, /dofs=12000/);
  assert.match(log, /solving=1400ms/);
});

test('a finished shell or solid names the mesh kind', () => {
  const shell = run([
    { type: 'start', now: 0 },
    {
      type: 'finish',
      now: 2500,
      dofs: 29520,
      source: 'shell',
      stageTimings: { 'loading-mesher': 0, meshing: 20, assembling: 10, solving: 460, 'post-processing': 80 },
    },
  ]);
  assert.match(shell.text, /^Shell mesh in .+ solved in .+ DOF.+total/);
  const solid = run([
    { type: 'start', now: 0 },
    {
      type: 'finish',
      now: 4000,
      dofs: 12000,
      source: 'tet10',
      meshReused: true,
      stageTimings: { meshing: 0, solving: 400, 'post-processing': 20 },
    },
  ]);
  assert.match(solid.text, /^Solid mesh reused, solved in .+ DOF.+total/);
});

test('a reused mesh says Mesh reused instead of Meshed in', () => {
  const state = run([
    { type: 'start', now: 1000 },
    { type: 'stage', stage: 'assembling', now: 1100 },
    {
      type: 'finish',
      now: 1800,
      dofs: 4200,
      meshReused: true,
      stageTimings: {
        'loading-mesher': 0,
        meshing: 0,
        assembling: 30,
        solving: 400,
        'post-processing': 50,
      },
    },
  ]);
  assert.equal(state.meshReused, true);
  assert.equal(state.text, 'Mesh reused, solved in 0.4 s (4.2k DOF), total 0.8 s');
  assert.equal(state.details.find((row) => row.id === 'meshing').seconds, 'Mesh reused');
  assert.equal(state.details.find((row) => row.id === 'solving').seconds, '0.4 s');
  const log = formatFeaTimingLog(state);
  assert.match(log, /reused=1/);
  assert.match(log, /meshed=0ms/);
  assert.match(log, /solved=400ms/);
});

test('stopping mid-solve names the stage, the elapsed time, the DOF count, and the error', () => {
  const state = run([
    { type: 'start', now: 1000 },
    { type: 'stage', stage: 'meshing', now: 1000 },
    { type: 'stage', stage: 'solving', now: 5000, dofs: 98000 },
    { type: 'stop', now: 42000, outcome: 'worker-died', error: 'out of memory' },
  ]);
  assert.equal(state.text, 'Stopped during Solving after 41 s (98k DOF): out of memory');
  assert.equal(state.outcome, 'worker-died');
  assert.equal(state.details.find((row) => row.id === 'post-processing').seconds, '—');
  const log = formatFeaTimingLog(state);
  assert.equal(log.startsWith('[fea-timing] worker-died '), true);
  assert.match(log, /stage=solving/);
  assert.match(log, /elapsed=41000ms/);
  assert.match(log, /dofs=98000/);
  assert.match(log, /error=out of memory/);
});

test('cancel and a death without a DOF count still name the stage', () => {
  const cancelled = run([
    { type: 'start', now: 0 },
    { type: 'stage', stage: 'assembling', now: 0 },
    { type: 'stop', now: 1200, outcome: 'cancelled', error: 'cancelled' },
  ]);
  assert.equal(cancelled.text, 'Stopped during Assembling after 1.2 s: cancelled');

  const died = run([
    { type: 'start', now: 0 },
    { type: 'stage', stage: 'loading-mesher', now: 0 },
    { type: 'stop', now: 21000, outcome: 'worker-died', error: 'worker stopped responding' },
  ]);
  assert.equal(died.text, 'Stopped during Loading mesher after 21 s: worker stopped responding');
  assert.equal(died.text.includes('DOF'), false);
});

test('a second terminal event does not replace the first', () => {
  const stopped = run([
    { type: 'start', now: 0 },
    { type: 'stage', stage: 'solving', now: 0, dofs: 10 },
    { type: 'stop', now: 1000, outcome: 'error', error: 'not positive definite' },
  ]);
  const again = reduceFeaProgress(stopped, { type: 'stop', now: 9000, outcome: 'worker-died', error: 'worker error' });
  assert.equal(again, stopped);
  assert.equal(again.text, 'Stopped during Solving after 1.0 s (10 DOF): not positive definite');
});

test('DOF counts and seconds format for the chip', () => {
  assert.equal(formatDofCount(12), '12');
  assert.equal(formatDofCount(98000), '98k');
  assert.equal(formatDofCount(1500), '1.5k');
  assert.equal(formatDofCount(10000), '10k');
  assert.equal(formatSeconds(0), '0.0 s');
  assert.equal(formatSeconds(41000), '41 s');
  assert.equal(formatSeconds(9500), '9.5 s');
});
