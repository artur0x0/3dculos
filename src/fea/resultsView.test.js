import assert from 'node:assert/strict';
import test from 'node:test';
import { activePlot, showResults } from './resultsView.js';

const fresh = { stale: false, source: 'tet10' };

test('results open only after a finished solve that is still current', () => {
  assert.equal(showResults({ status: 'done', result: fresh }), true);
  assert.equal(showResults({ status: 'idle' }), false);
  assert.equal(showResults({ status: 'done', result: null }), false);
  assert.equal(showResults({ running: true, status: 'running', result: fresh }), false);
  assert.equal(showResults({ status: 'done', result: { stale: true } }), false);
});

test('a failed or stopped run stays on the setup', () => {
  assert.equal(showResults({ status: 'stopped', result: fresh }), false);
  assert.equal(showResults({ status: 'stopped', result: null }), false);
  assert.equal(showResults({ running: false, status: 'idle', result: { stale: false, warnings: [{ code: 'empty-mesh' }] } }), false);
});

test('Back to Setup leaves the overlay off without a new solve', () => {
  assert.equal(showResults({ status: 'done', result: fresh, dismissed: true }), false);
  assert.equal(showResults({ status: 'done', result: fresh, dismissed: false }), true);
});

test('the plot falls back to stress', () => {
  assert.equal(activePlot('displacement'), 'displacement');
  assert.equal(activePlot('stress'), 'stress');
  assert.equal(activePlot('other'), 'stress');
  assert.equal(activePlot(undefined), 'stress');
});
