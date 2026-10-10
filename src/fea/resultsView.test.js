import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODAL_MODE_SLOTS,
  activePlot,
  initialResultsView,
  plotTabs,
  reduceResultsView,
  resultsChrome,
} from './resultsView.js';

function apply(events) {
  return events.reduce((state, event) => reduceResultsView(state, event), initialResultsView());
}

test('the plot falls back to stress', () => {
  assert.equal(activePlot('displacement'), 'displacement');
  assert.equal(activePlot('stress'), 'stress');
  assert.equal(activePlot('contact'), 'contact');
  assert.equal(activePlot('other'), 'stress');
  assert.equal(activePlot(undefined), 'stress');
});

test('Contact is a results tab only for a non-bonded pair', () => {
  const values = (result) => plotTabs(result).map((tab) => tab.value);
  assert.deepEqual(values(null), ['stress', 'displacement']);
  assert.deepEqual(values({ contactActive: false }), ['stress', 'displacement']);
  assert.deepEqual(values({ contactActive: true }), ['stress', 'displacement', 'contact']);
});

test('Run opens the results frame before the solve finishes', () => {
  const running = reduceResultsView(initialResultsView(), { type: 'run', kind: 'static' });
  assert.equal(running.screen, 'running');
  assert.equal(running.kind, 'static');
  const chrome = resultsChrome(running);
  assert.equal(chrome.frame, true);
  assert.equal(chrome.progress, true);
  assert.equal(chrome.plots, true);
  assert.equal(chrome.modes, false);
  assert.equal(chrome.cancel, true);
  assert.equal(chrome.back, false);
  assert.equal(chrome.run, false);
  const done = reduceResultsView(running, { type: 'finish', source: 'tet10' });
  assert.equal(done.screen, 'results');
  assert.equal(done.kind, 'static');
  assert.equal(resultsChrome(done).progress, false);
  assert.equal(resultsChrome(done).back, true);
});

test('a modal run reserves the mode list', () => {
  assert.equal(MODAL_MODE_SLOTS, 6);
  const running = reduceResultsView(initialResultsView(), { type: 'run', studyType: 'modal' });
  assert.equal(running.kind, 'modal');
  const chrome = resultsChrome(running);
  assert.equal(chrome.modes, true);
  assert.equal(chrome.plots, false);
  assert.equal(chrome.progress, true);
  const done = reduceResultsView(running, { type: 'finish', source: 'modal' });
  assert.equal(done.screen, 'results');
  assert.equal(done.kind, 'modal');
});

test('failure, cancel, and a dead worker stay on the frame', () => {
  const running = reduceResultsView(initialResultsView(), { type: 'run', kind: 'static' });
  for (const outcome of ['error', 'cancelled', 'worker-died']) {
    const stopped = reduceResultsView(running, { type: 'stop', outcome });
    assert.equal(stopped.screen, 'stopped');
    const chrome = resultsChrome(stopped);
    assert.equal(chrome.frame, true);
    assert.equal(chrome.stopped, true);
    assert.equal(chrome.progress, false);
    assert.equal(chrome.back, true);
    assert.equal(chrome.cancel, false);
    assert.equal(chrome.plots, true);
  }
});

test('a stop that never started stays on setup', () => {
  const stayed = reduceResultsView(initialResultsView(), { type: 'stop', outcome: 'error' });
  assert.equal(stayed.screen, 'setup');
  assert.equal(resultsChrome(stayed).run, true);
});

test('Back to Setup and a stale result return to the form', () => {
  const results = apply([
    { type: 'run', kind: 'static' },
    { type: 'finish', source: 'tet10' },
  ]);
  assert.equal(reduceResultsView(results, { type: 'back' }).screen, 'setup');
  assert.equal(reduceResultsView(results, { type: 'stale' }).screen, 'setup');
  const staleFinish = apply([
    { type: 'run', kind: 'static' },
    { type: 'finish', stale: true, source: 'shell' },
  ]);
  assert.equal(staleFinish.screen, 'setup');
  assert.equal(staleFinish.kind, 'static');
});

test('a stale edit during the run leaves the frame up', () => {
  const running = reduceResultsView(initialResultsView(), { type: 'run', kind: 'modal' });
  const still = reduceResultsView(running, { type: 'stale' });
  assert.equal(still.screen, 'running');
  assert.equal(still.kind, 'modal');
});
