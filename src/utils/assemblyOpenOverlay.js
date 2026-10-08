/**
 * Assembly-open overlay.
 *
 * The spinner stays hidden for `showDelayMs` (150) so a fast open does not
 * flash. It clears on success, failure, and cancel. Silence longer than
 * `safetyMs` clears a stuck open and reports a failure the shell shows as
 * the error toast with Retry.
 *
 * Tests delay or fail an open with globalThis.__ASSEMBLY_OPEN_DELAY_MS__
 * and globalThis.__ASSEMBLY_OPEN_FAIL__ (string message, or true).
 */

export const ASSEMBLY_OPEN_SHOW_MS = 150;
export const ASSEMBLY_OPEN_SAFETY_MS = 45000;

export function assemblyOpenLabel(name, progress) {
  const raw = String(name ?? '').trim() || 'assembly';
  const label = `Opening ${raw}…`;
  const index = Number(progress?.index);
  const total = Number(progress?.total);
  const detail = (
    Number.isFinite(index) && Number.isFinite(total) && total > 0 && index > 0
  ) ? `part ${Math.min(Math.trunc(index), Math.trunc(total))} of ${Math.trunc(total)}` : '';
  return { label, detail };
}

export function readAssemblyOpenTestDelayMs() {
  try {
    const ms = Number(globalThis.__ASSEMBLY_OPEN_DELAY_MS__);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch {
    return 0;
  }
}

/**
 * Extra pause after the document is in hand, before the worker build.
 * Goldens and the mobile screenshot set globalThis.__ASSEMBLY_OPEN_HOLD_MS__.
 * No-op in normal use.
 */
export async function applyAssemblyOpenHold() {
  let ms = 0;
  try { ms = Number(globalThis.__ASSEMBLY_OPEN_HOLD_MS__); } catch { ms = 0; }
  if (Number.isFinite(ms) && ms > 0) {
    await new Promise((resolve) => { setTimeout(resolve, ms); });
  }
}

/** Artificial delay / forced failure for goldens. No-op in normal use. */
export async function applyAssemblyOpenTestHooks() {
  const ms = readAssemblyOpenTestDelayMs();
  if (ms > 0) {
    await new Promise((resolve) => { setTimeout(resolve, ms); });
  }
  let fail = null;
  try { fail = globalThis.__ASSEMBLY_OPEN_FAIL__; } catch { fail = null; }
  if (fail) {
    const message = typeof fail === 'string' && fail.trim()
      ? fail.trim()
      : 'Could not open assembly';
    const err = new Error(message);
    err.assemblyOpen = true;
    throw err;
  }
}

function failureText(name, err, reason) {
  if (reason === 'timeout') {
    const raw = String(name ?? '').trim() || 'assembly';
    return `Could not open ${raw}`;
  }
  if (err?.message) return String(err.message);
  return 'Could not open assembly';
}

export function createAssemblyOpenController({
  showDelayMs = ASSEMBLY_OPEN_SHOW_MS,
  safetyMs = ASSEMBLY_OPEN_SAFETY_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onChange = null,
  onBegin = null,
  onFailure = null,
  onRecover = null,
} = {}) {
  let generation = 0;
  let visible = false;
  let snapshot = null;
  let showTimer = null;
  let safetyTimer = null;
  const timedOut = new Set();

  function emit() {
    if (typeof onChange !== 'function') return;
    if (!snapshot || !visible) {
      onChange(null);
      return;
    }
    onChange({
      visible: true,
      generation: snapshot.generation,
      name: snapshot.name,
      index: snapshot.index,
      total: snapshot.total,
    });
  }

  function clearTimers() {
    if (showTimer != null) clearTimer(showTimer);
    if (safetyTimer != null) clearTimer(safetyTimer);
    showTimer = null;
    safetyTimer = null;
  }

  function hide() {
    clearTimers();
    visible = false;
    snapshot = null;
    emit();
  }

  function armSafety(gen) {
    if (safetyTimer != null) clearTimer(safetyTimer);
    safetyTimer = setTimer(() => {
      if (gen !== generation || !snapshot) return;
      const failed = snapshot;
      timedOut.add(gen);
      generation += 1;
      hide();
      onFailure?.({
        generation: gen,
        reason: 'timeout',
        name: failed.name,
        message: failureText(failed.name, null, 'timeout'),
        retry: failed.retry || null,
      });
    }, safetyMs);
  }

  function begin({ name = 'assembly', total = 0, retry = null } = {}) {
    const gen = ++generation;
    clearTimers();
    visible = false;
    snapshot = {
      generation: gen,
      name: String(name || '').trim() || 'assembly',
      index: 0,
      total: Number(total) || 0,
      retry: typeof retry === 'function' ? retry : null,
    };
    onBegin?.();
    emit();
    showTimer = setTimer(() => {
      if (gen !== generation || !snapshot) return;
      visible = true;
      emit();
    }, showDelayMs);
    armSafety(gen);
    return gen;
  }

  function isCurrent(gen) {
    return gen === generation && !!snapshot;
  }

  function progress(gen, next = {}) {
    if (gen !== generation || !snapshot) return;
    if (typeof next.name === 'string' && next.name.trim()) snapshot.name = next.name.trim();
    if (Number.isFinite(Number(next.index))) snapshot.index = Number(next.index);
    if (Number.isFinite(Number(next.total))) snapshot.total = Number(next.total);
    armSafety(gen);
    if (visible) emit();
  }

  /** Success or cancel. False when a newer open or the safety timer won. */
  function finish(gen) {
    if (gen !== generation) return false;
    generation += 1;
    hide();
    return true;
  }

  /** Failure while this open is still current. False if already settled. */
  function fail(gen, err) {
    if (gen !== generation || !snapshot) return false;
    const failed = snapshot;
    generation += 1;
    hide();
    onFailure?.({
      generation: gen,
      reason: 'error',
      name: failed.name,
      message: failureText(failed.name, err, 'error'),
      retry: failed.retry || null,
    });
    return true;
  }

  /**
   * A load that finished after the safety timer. Clears that timer's toast
   * so a late success does not leave a stuck failure.
   */
  function acknowledgeLate(gen) {
    if (!timedOut.has(gen)) return false;
    timedOut.delete(gen);
    onRecover?.(gen);
    return true;
  }

  function isOpen() {
    return !!snapshot;
  }

  return {
    begin, progress, finish, fail, isCurrent, acknowledgeLate, isOpen,
  };
}

/**
 * One open: show-delay, progress, first-build wait inside `load`, then clear.
 * `load` receives `{ progress, signal }`. Throw to fail. Return to succeed.
 * A stale `signal()` means a newer open replaced this one — return without
 * writing.
 */
export async function runTrackedAssemblyOpen(ctrl, {
  name = 'assembly',
  total = 0,
  retry = null,
  load,
} = {}) {
  const gen = ctrl.begin({ name, total, retry });
  try {
    await applyAssemblyOpenTestHooks();
    if (!ctrl.isCurrent(gen)) return undefined;
    const value = await load({
      progress: (update) => ctrl.progress(gen, update),
      signal: () => ctrl.isCurrent(gen),
    });
    if (!ctrl.finish(gen)) ctrl.acknowledgeLate(gen);
    return value;
  } catch (err) {
    ctrl.fail(gen, err);
    throw err;
  }
}
