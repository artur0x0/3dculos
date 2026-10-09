/**
 * Main-thread side of the FEA worker: progress, heartbeats, and death.
 *
 * onerror and messageerror stop the run immediately. A stage that is not
 * inside a synchronous wasm call must send a heartbeat; more than 20s of
 * silence is treated as the worker dying. fTetWild and the solver are one
 * blocking call and cannot post while they run, so those calls are marked
 * blocking. A trap or OOM still arrives as an error event. The 20s watchdog
 * covers every other stall.
 */

import { HEARTBEAT_TIMEOUT_MS, workerFailureText } from './feaProgress.js';
import { FeaMessage } from './protocol.js';

function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('FEA solve cancelled', 'AbortError');
  }
  const error = new Error('FEA solve cancelled');
  error.name = 'AbortError';
  return error;
}

function deathError(message) {
  const error = new Error(workerFailureText(message));
  error.name = 'FeaWorkerError';
  error.outcome = 'worker-died';
  return error;
}

export function createFeaWorkerHost(worker, options = {}) {
  const now = options.now || Date.now;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const schedule = options.schedule || ((fn, ms) => setInterval(fn, ms));
  const clear = options.clear || ((id) => clearInterval(id));

  let disposed = false;
  let nextId = 1;
  let watchTimer = null;
  const pending = new Map();
  let readySettled = false;
  let readyBlocking = false;
  let readyBeat = now();

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function ensureWatch() {
    if (watchTimer != null || disposed) return;
    watchTimer = schedule(checkWatch, Math.min(1000, heartbeatTimeoutMs));
  }

  function stopWatchIfIdle() {
    if (!readySettled || pending.size) return;
    if (watchTimer != null) {
      clear(watchTimer);
      watchTimer = null;
    }
  }

  function settleReady(error) {
    if (readySettled) return;
    readySettled = true;
    if (error) rejectReady(error);
    else resolveReady();
    stopWatchIfIdle();
  }

  function failSlot(id, error) {
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    if (typeof slot.onProgress === 'function' && error && error.outcome === 'worker-died') {
      slot.onProgress({
        type: 'stop',
        outcome: 'worker-died',
        error: error.message,
        now: now(),
      });
    }
    slot.reject(error);
    stopWatchIfIdle();
  }

  function failAll(error) {
    for (const id of [...pending.keys()]) failSlot(id, error);
  }

  function touch(slot, blocking) {
    if (!slot) return;
    slot.lastBeat = now();
    if (blocking != null) slot.blocking = !!blocking;
  }

  function checkWatch() {
    const t = now();
    if (!readySettled && !readyBlocking && t - readyBeat > heartbeatTimeoutMs) {
      settleReady(deathError('worker stopped responding'));
      failAll(deathError('worker stopped responding'));
      return;
    }
    for (const [id, slot] of pending) {
      if (slot.blocking) continue;
      if (t - slot.lastBeat > heartbeatTimeoutMs) failSlot(id, deathError('worker stopped responding'));
    }
  }

  function stageEvent(data) {
    return {
      type: 'stage',
      stage: data.stage,
      now: data.t != null ? data.t : now(),
      fraction: data.fraction,
      solver: data.solver,
      iteration: data.iteration,
      estimatedIterations: data.estimatedIterations,
      residual: data.residual,
      residual0: data.residual0,
      tol: data.tol,
      choleskyStep: data.choleskyStep,
      dofs: data.dofs,
    };
  }

  worker.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === FeaMessage.loaded) {
      readyBeat = now();
      settleReady();
      return;
    }
    if (data.type === FeaMessage.loadError) {
      const error = new Error(data.error || 'FEA wasm failed to load');
      settleReady(error);
      failAll(error);
      return;
    }
    if (data.type === FeaMessage.heartbeat) {
      readyBeat = now();
      if (data.blocking != null) readyBlocking = !!data.blocking;
      if (data.id != null && pending.has(data.id)) touch(pending.get(data.id), data.blocking);
      else {
        for (const slot of pending.values()) touch(slot, data.blocking);
      }
      return;
    }
    if (data.type === FeaMessage.progress) {
      readyBeat = now();
      const slot = pending.get(data.id);
      touch(slot, data.blocking);
      if (slot && typeof slot.onProgress === 'function') slot.onProgress(stageEvent(data));
      return;
    }
    const slot = pending.get(data.id);
    if (!slot) return;
    pending.delete(data.id);
    if (data.ok) slot.resolve(data.result);
    else {
      const error = new Error(data.error || 'FEA worker error');
      if (data.name) error.name = data.name;
      slot.reject(error);
    }
    stopWatchIfIdle();
  };

  worker.onerror = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const error = deathError((event && event.message) || 'worker error');
    settleReady(error);
    failAll(error);
  };

  worker.onmessageerror = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const error = deathError((event && event.message) || 'worker message error');
    settleReady(error);
    failAll(error);
  };

  ensureWatch();

  function request(type, fields, transfer, hooks) {
    if (disposed) return Promise.reject(new Error('FEA client disposed'));
    if (hooks && hooks.signal && hooks.signal.aborted) return Promise.reject(abortError());
    const id = nextId++;
    const slot = {
      type,
      onProgress: hooks && hooks.onProgress,
      lastBeat: now(),
      blocking: false,
    };
    const promise = new Promise((resolve, reject) => {
      slot.resolve = resolve;
      slot.reject = reject;
      pending.set(id, slot);
    });
    ensureWatch();
    worker.postMessage({ id, type, ...(fields || {}) }, transfer || []);
    const onAbort = () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      slot.reject(abortError());
      try {
        worker.postMessage({ type: FeaMessage.cancel });
      } catch {
        /* worker already gone */
      }
      stopWatchIfIdle();
    };
    if (hooks && hooks.signal) hooks.signal.addEventListener('abort', onAbort, { once: true });
    return promise.finally(() => {
      if (hooks && hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
    });
  }

  return {
    ready,
    request,
    cancel() {
      if (disposed) throw new Error('FEA client disposed');
      for (const [id, slot] of pending) {
        if (slot.type !== FeaMessage.solve) continue;
        pending.delete(id);
        slot.reject(abortError());
      }
      worker.postMessage({ type: FeaMessage.cancel });
      stopWatchIfIdle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (watchTimer != null) {
        clear(watchTimer);
        watchTimer = null;
      }
      failAll(new Error('FEA client disposed'));
      if (!readySettled) settleReady(new Error('FEA client disposed'));
      try {
        worker.postMessage({ type: FeaMessage.dispose });
      } catch {
        /* already terminated */
      }
      if (typeof worker.terminate === 'function') worker.terminate();
    },
  };
}
