/**
 * Which Analyze screen is up. Pure: no React and no worker.
 *
 * Run switches to the results frame immediately and reserves the tabs (or
 * the modal mode list) plus the plot. Progress sits in the plot until the
 * solve finishes. A failure, a cancel, or a dead worker keeps that frame
 * and shows the stopped line. Back to Setup, or a stale edit, returns to
 * the study form. A stale edit during the run does not.
 */

export const PLOT_TABS = Object.freeze([
  Object.freeze({ value: 'stress', label: 'Stress' }),
  Object.freeze({ value: 'displacement', label: 'Displacement' }),
]);

/** Mode rows reserved while a modal solve is in flight. The solver asks for six. */
export const MODAL_MODE_SLOTS = 6;

export function activePlot(plot) {
  return plot === 'displacement' ? 'displacement' : 'stress';
}

export function initialResultsView() {
  return { screen: 'setup', kind: 'static' };
}

function normalize(state) {
  if (!state || (state.screen !== 'setup' && state.screen !== 'running' && state.screen !== 'results' && state.screen !== 'stopped')) {
    return initialResultsView();
  }
  return {
    screen: state.screen,
    kind: state.kind === 'modal' ? 'modal' : 'static',
  };
}

function kindOf(event, fallback) {
  if (!event) return fallback;
  if (event.kind === 'modal' || event.studyType === 'modal' || event.source === 'modal') return 'modal';
  if (
    event.kind === 'static'
    || event.studyType === 'linear-static'
    || event.source === 'tet10'
    || event.source === 'shell'
  ) return 'static';
  return fallback;
}

/**
 * `run` opens the frame. `finish` fills it, unless the solve is already
 * stale. `stop` is a failure, a cancel, or a dead worker. `back` and
 * `stale` return to setup. `stale` during `running` stays on the frame.
 */
export function reduceResultsView(state, event) {
  const current = normalize(state);
  const type = event && event.type;
  if (type === 'reset') return initialResultsView();
  if (type === 'run') {
    return { screen: 'running', kind: kindOf(event, current.kind) };
  }
  if (type === 'finish') {
    const kind = kindOf(event, current.kind);
    if (event && event.stale) return { screen: 'setup', kind };
    return { screen: 'results', kind };
  }
  if (type === 'stop') {
    if (current.screen === 'setup') return current;
    return { screen: 'stopped', kind: current.kind };
  }
  if (type === 'back') return { screen: 'setup', kind: current.kind };
  if (type === 'stale') {
    if (current.screen === 'running') return current;
    return { screen: 'setup', kind: current.kind };
  }
  return current;
}

/** What the card shows for a view. The readout and the run bar both use this. */
export function resultsChrome(view) {
  const current = normalize(view);
  const frame = current.screen !== 'setup';
  return {
    screen: current.screen,
    kind: current.kind,
    frame,
    progress: current.screen === 'running',
    stopped: current.screen === 'stopped',
    back: current.screen === 'results' || current.screen === 'stopped',
    cancel: current.screen === 'running',
    run: !frame,
    modes: frame && current.kind === 'modal',
    plots: frame && current.kind === 'static',
  };
}
