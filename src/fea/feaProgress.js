/**
 * Analyze run progress and timing. Pure: no worker, no React.
 *
 * Stages are Loading mesher, Meshing, Assembling, Solving, and
 * Post-processing. A fraction is shown when it can be measured:
 * PCG iterations over an estimate, otherwise the residual drop on a
 * log scale; Cholesky as the factor step then the solve step; an
 * explicit fraction from a mesher callback. Anything else stays
 * indeterminate and the UI shows the stage name with elapsed seconds.
 */

export const HEARTBEAT_TIMEOUT_MS = 20_000;

export const FEA_STAGES = Object.freeze([
  { id: 'loading-mesher', label: 'Loading mesher' },
  { id: 'meshing', label: 'Meshing' },
  { id: 'assembling', label: 'Assembling' },
  { id: 'solving', label: 'Solving' },
  { id: 'post-processing', label: 'Post-processing' },
]);

const STAGE_LABEL = Object.fromEntries(FEA_STAGES.map((stage) => [stage.id, stage.label]));

export function stageLabel(id) {
  if (!id) return '';
  return STAGE_LABEL[id] || String(id);
}

export function formatSeconds(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  if (seconds >= 10) return `${Math.round(seconds)} s`;
  return `${seconds.toFixed(1)} s`;
}

/** 98000 → "98k". Counts under 1000 stay plain. */
export function formatDofCount(dofs) {
  if (dofs == null || !Number.isFinite(Number(dofs))) return null;
  const n = Math.max(0, Math.round(Number(dofs)));
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  const digits = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${digits}k`;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Fraction in [0, 1], or null when the bar should stay indeterminate.
 * Iteration ratio wins when an estimate is present. Otherwise a residual
 * drop is measured on a log scale from residual0 down to tol (default 1e-8).
 * Cholesky is two steps: factor at 50%, solve at 100%.
 */
export function measureFraction(update) {
  const source = update || {};
  if (source.choleskyStep === 'factor') {
    return { fraction: 0.5, indeterminate: false, stepLabel: 'factor' };
  }
  if (source.choleskyStep === 'solve') {
    return { fraction: 1, indeterminate: false, stepLabel: 'solve' };
  }
  const estimate = Number(source.estimatedIterations);
  const iteration = Number(source.iteration);
  if (estimate > 0 && Number.isFinite(iteration) && iteration >= 0) {
    return { fraction: clamp01(iteration / estimate), indeterminate: false, stepLabel: '' };
  }
  const residual0 = Number(source.residual0);
  const residual = Number(source.residual);
  if (residual0 > 0 && residual > 0) {
    const tol = Number(source.tol) > 0 && Number(source.tol) < residual0 ? Number(source.tol) : 1e-8;
    const floor = Math.min(residual0, tol);
    const span = Math.log(residual0 / floor);
    const drop = Math.log(residual0 / Math.min(residual, residual0));
    if (span > 0 && Number.isFinite(drop)) {
      return { fraction: clamp01(drop / span), indeterminate: false, stepLabel: '' };
    }
  }
  const given = Number(source.fraction);
  if (Number.isFinite(given) && given >= 0) {
    return { fraction: clamp01(given), indeterminate: false, stepLabel: '' };
  }
  return { fraction: null, indeterminate: true, stepLabel: '' };
}

function elapsedMs(state) {
  if (state.startedAt == null || state.now == null) return 0;
  return Math.max(0, state.now - state.startedAt);
}

function withMeasure(state, update) {
  const measured = measureFraction(update);
  const percent = measured.fraction == null ? null : Math.round(measured.fraction * 100);
  return {
    ...state,
    fraction: measured.fraction,
    indeterminate: measured.indeterminate,
    percent,
    stepLabel: measured.stepLabel,
  };
}

function detailsFrom(timings) {
  return FEA_STAGES.map((stage) => {
    const ms = timings[stage.id];
    const known = ms != null && Number.isFinite(ms);
    return {
      id: stage.id,
      label: stage.label,
      ms: known ? ms : null,
      seconds: known ? formatSeconds(ms) : '—',
    };
  });
}

export function formatDoneText(state) {
  const timings = state.timings || {};
  const meshedMs = (timings['loading-mesher'] || 0) + (timings.meshing || 0);
  const solvedMs = timings.solving || 0;
  const dofs = formatDofCount(state.dofs) || '0';
  return `Meshed in ${formatSeconds(meshedMs)}, solved in ${formatSeconds(solvedMs)} (${dofs} DOF), total ${formatSeconds(elapsedMs(state))}`;
}

export function formatStoppedText(state) {
  const stage = state.stageLabel || 'Solving';
  const dofs = formatDofCount(state.dofs);
  const dofPart = dofs ? ` (${dofs} DOF)` : '';
  const reason = state.error || 'stopped';
  return `Stopped during ${stage} after ${formatSeconds(elapsedMs(state))}${dofPart}: ${reason}`;
}

export function formatFeaTimingLog(state) {
  const head = '[fea-timing]';
  const stages = FEA_STAGES.map((stage) => {
    const ms = state.timings && state.timings[stage.id];
    return `${stage.id}=${ms == null ? '' : ms}ms`;
  }).join(' ');
  if (state.status === 'done') {
    const timings = state.timings || {};
    const meshed = (timings['loading-mesher'] || 0) + (timings.meshing || 0);
    return `${head} ok meshed=${meshed}ms solved=${timings.solving || 0}ms dofs=${state.dofs ?? ''} total=${elapsedMs(state)}ms ${stages}`;
  }
  const dofPart = state.dofs != null ? ` dofs=${state.dofs}` : '';
  return `${head} ${state.outcome || 'stopped'} stage=${state.stage || ''} elapsed=${elapsedMs(state)}ms${dofPart} error=${state.error || ''} ${stages}`;
}

export function logFeaTiming(state, logger = console) {
  logger.log(formatFeaTimingLog(state));
}

function closeStage(state, now) {
  if (!state.stage || state.stageStartedAt == null) return { ...(state.timings || {}) };
  const timings = { ...(state.timings || {}) };
  const previous = timings[state.stage] || 0;
  timings[state.stage] = previous + Math.max(0, now - state.stageStartedAt);
  return timings;
}

export function initialFeaProgress(now = 0) {
  return {
    status: 'idle',
    stage: null,
    stageLabel: '',
    fraction: null,
    indeterminate: true,
    percent: null,
    stepLabel: '',
    dofs: null,
    startedAt: null,
    stageStartedAt: null,
    now,
    timings: {},
    error: '',
    outcome: null,
    text: '',
    elapsedText: '',
    details: detailsFrom({}),
  };
}

function runningView(state) {
  return {
    ...state,
    elapsedText: formatSeconds(elapsedMs(state)),
    details: detailsFrom(state.timings || {}),
  };
}

export function reduceFeaProgress(state, event) {
  const current = state || initialFeaProgress(event && event.now);
  const type = event && event.type;
  const now = event && event.now != null ? event.now : current.now;

  if (type === 'start') {
    return runningView({
      ...initialFeaProgress(now),
      status: 'running',
      startedAt: now,
      now,
    });
  }

  if (current.status === 'done' || current.status === 'stopped') return current;
  if (current.status !== 'running') return current;

  if (type === 'tick') {
    return runningView({ ...current, now });
  }

  if (type === 'stage') {
    const same = event.stage === current.stage;
    const timings = same ? (current.timings || {}) : closeStage(current, now);
    const next = withMeasure({
      ...current,
      stage: event.stage || current.stage,
      stageLabel: stageLabel(event.stage || current.stage),
      stageStartedAt: same ? current.stageStartedAt : now,
      timings,
      now,
      dofs: event.dofs != null ? event.dofs : current.dofs,
    }, event);
    return runningView(next);
  }

  if (type === 'finish') {
    let timings = closeStage(current, now);
    if (event.stageTimings && typeof event.stageTimings === 'object') {
      timings = { ...timings };
      for (const stage of FEA_STAGES) {
        const value = event.stageTimings[stage.id];
        if (value != null && Number.isFinite(Number(value))) timings[stage.id] = Number(value);
      }
    }
    const done = {
      ...current,
      status: 'done',
      outcome: 'ok',
      now,
      timings,
      dofs: event.dofs != null ? event.dofs : current.dofs,
      error: '',
      indeterminate: false,
      fraction: 1,
      percent: 100,
    };
    done.text = formatDoneText(done);
    done.elapsedText = formatSeconds(elapsedMs(done));
    done.details = detailsFrom(timings);
    return done;
  }

  if (type === 'stop') {
    const timings = closeStage(current, now);
    const stopped = {
      ...current,
      status: 'stopped',
      outcome: event.outcome || 'error',
      now,
      timings,
      dofs: event.dofs != null ? event.dofs : current.dofs,
      error: event.error || 'stopped',
    };
    stopped.text = formatStoppedText(stopped);
    stopped.elapsedText = formatSeconds(elapsedMs(stopped));
    stopped.details = detailsFrom(timings);
    return stopped;
  }

  return current;
}

/** Strip a worker ErrorEvent prefix so the chip can show "out of memory". */
export function workerFailureText(message) {
  const text = String(message || 'worker error').replace(/^Uncaught (?:[\w.]*Error):\s*/i, '').trim();
  return text || 'worker error';
}
