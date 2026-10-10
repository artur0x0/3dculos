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

export function stageLabel(id, extra) {
  const pass = Number(extra && extra.refinePass);
  const total = Number(extra && extra.refinePasses);
  if (pass > 0 && total > 0) return `Refining ${pass}/${total}`;
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

function detailsFrom(timings, meshReused = false) {
  return FEA_STAGES.map((stage) => {
    if (meshReused && stage.id === 'meshing') {
      const ms = timings[stage.id];
      const known = ms != null && Number.isFinite(ms);
      return {
        id: stage.id,
        label: stage.label,
        ms: known ? ms : 0,
        seconds: 'Mesh reused',
      };
    }
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

function meshKind(source) {
  if (source === 'shell') return 'Shell';
  if (source === 'tet10') return 'Solid';
  return '';
}

function refineSuffix(state) {
  const count = Number(state && state.refineCount);
  let text = '';
  if (count > 0) {
    text = `, refined ${Math.round(count)}x, ${state.converged ? 'converged' : 'not converged'}`;
  }
  if (state && state.refineNote) text += `. ${state.refineNote}`;
  return text;
}

/** `5242880` → `peak 5.0 MiB`. Counts of 10 MiB and up round to a whole MiB. */
export function formatPeakMiB(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const mib = n / (1024 * 1024);
  if (mib >= 10) return `peak ${Math.round(mib)} MiB`;
  return `peak ${mib.toFixed(1)} MiB`;
}

function peakSuffix(state) {
  if (!state || state.showPeakMemory !== true) return '';
  const label = formatPeakMiB(state.peakMemoryBytes);
  return label ? `, ${label}` : '';
}

/**
 * Dev readout. True when the page URL has `?feadebug=1` or localStorage
 * `feaDebug` is `1`. Pass `{ location, localStorage }` in tests.
 */
export function feaDebugEnabled(env) {
  const loc = env && Object.prototype.hasOwnProperty.call(env, 'location')
    ? env.location
    : (typeof location !== 'undefined' ? location : null);
  const store = env && Object.prototype.hasOwnProperty.call(env, 'localStorage')
    ? env.localStorage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  let query = false;
  try {
    const search = loc && typeof loc.search === 'string' ? loc.search : '';
    query = new URLSearchParams(search).get('feadebug') === '1';
  } catch {
    query = false;
  }
  let stored = false;
  try {
    stored = !!(store && typeof store.getItem === 'function' && store.getItem('feaDebug') === '1');
  } catch {
    stored = false;
  }
  return query || stored;
}

export function formatDoneText(state) {
  const timings = state.timings || {};
  const solvedMs = timings.solving || 0;
  const dofs = formatDofCount(state.dofs) || '0';
  const tail = `solved in ${formatSeconds(solvedMs)} (${dofs} DOF), total ${formatSeconds(elapsedMs(state))}`;
  const kind = meshKind(state.source);
  const suffix = `${refineSuffix(state)}${peakSuffix(state)}`;
  if (state.meshReused) return kind ? `${kind} mesh reused, ${tail}${suffix}` : `Mesh reused, ${tail}${suffix}`;
  const meshedMs = (timings['loading-mesher'] || 0) + (timings.meshing || 0);
  if (kind) return `${kind} mesh in ${formatSeconds(meshedMs)}, ${tail}${suffix}`;
  return `Meshed in ${formatSeconds(meshedMs)}, ${tail}${suffix}`;
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
    const reused = state.meshReused ? ' reused=1' : '';
    return `${head} ok meshed=${meshed}ms solved=${timings.solving || 0}ms dofs=${state.dofs ?? ''} total=${elapsedMs(state)}ms${reused} ${stages}`;
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
    meshReused: false,
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
      stageLabel: stageLabel(event.stage || current.stage, event),
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
      source: event.source || current.source || '',
      dofs: event.dofs != null ? event.dofs : current.dofs,
      error: '',
      indeterminate: false,
      fraction: 1,
      percent: 100,
      meshReused: event.meshReused === true,
      refineCount: Number(event.refineCount) || 0,
      converged: event.converged === true,
      refineNote: event.refineNote ? String(event.refineNote) : '',
      showPeakMemory: event.showPeakMemory === true,
      peakMemoryBytes: Number.isFinite(Number(event.peakMemoryBytes)) ? Number(event.peakMemoryBytes) : null,
    };
    done.text = formatDoneText(done);
    done.elapsedText = formatSeconds(elapsedMs(done));
    done.details = detailsFrom(timings, done.meshReused);
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
