// Main-thread client for the FEA module worker.
//
// createFeaClient() loads the wasm inside the worker. solve() transfers the
// mesh typed arrays in and transfers the nodal Float32Array back. cancel()
// rejects the in-flight solve (the stub itself is synchronous). dispose()
// terminates the worker.
//
// Units: material.E_MPa and material.yield_MPa are megapascals. material.nu
// is dimensionless and required. yield_MPa may be null; the safety factor
// is then null and the result carries a missing-yield warning. The returned
// field is von Mises in MPa, labeled source: "stub" until a real solver
// replaces it. profile is "phone" or "desktop".

import FeaWorker from '../workers/feaWorker.js?worker';
import { packMesh } from './meshTransfer.js';
import { FeaMessage } from './protocol.js';

function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('FEA solve cancelled', 'AbortError');
  }
  const error = new Error('FEA solve cancelled');
  error.name = 'AbortError';
  return error;
}

export async function createFeaClient() {
  const worker = new FeaWorker();
  let disposed = false;
  let nextId = 1;
  const pending = new Map();

  function failAll(error) {
    for (const slot of pending.values()) slot.reject(error);
    pending.clear();
  }

  function assertOpen() {
    if (disposed) throw new Error('FEA client disposed');
  }

  const ready = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === FeaMessage.loaded) {
        resolve();
        return;
      }
      if (data.type === FeaMessage.loadError) {
        const error = new Error(data.error || 'FEA wasm failed to load');
        reject(error);
        failAll(error);
        return;
      }
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || 'FEA worker error'));
    };
    worker.onerror = (event) => {
      const error = new Error((event && event.message) || 'FEA worker error');
      reject(error);
      failAll(error);
    };
  });

  await ready;

  function begin(type, fields, transfer) {
    assertOpen();
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, type });
    });
    worker.postMessage({ id, type, ...fields }, transfer || []);
    return { id, promise };
  }

  return {
    capabilities() {
      return begin(FeaMessage.capabilities, {}).promise;
    },

    solve(request, options = {}) {
      assertOpen();
      if (options.signal && options.signal.aborted) return Promise.reject(abortError());
      const mesh = packMesh(request && request.mesh);
      if (typeof options.onProgress === 'function') {
        options.onProgress({ fraction: 0, stage: 'stub' });
      }
      const { id, promise } = begin(FeaMessage.solve, {
        study: request && request.study != null ? request.study : null,
        material: request ? request.material : null,
        profile: request && request.profile,
        positions: mesh.positions,
        indices: mesh.indices,
        faceIDs: mesh.faceIDs,
      }, mesh.transfer);
      const onAbort = () => {
        const slot = pending.get(id);
        if (!slot) return;
        pending.delete(id);
        slot.reject(abortError());
        try {
          worker.postMessage({ type: FeaMessage.cancel });
        } catch {
          /* worker already gone */
        }
      };
      if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
      return promise.then((result) => {
        if (typeof options.onProgress === 'function') {
          options.onProgress({ fraction: 1, stage: 'stub' });
        }
        return result;
      }).finally(() => {
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
      });
    },

    cancel() {
      assertOpen();
      for (const [id, slot] of pending) {
        if (slot.type !== FeaMessage.solve) continue;
        pending.delete(id);
        slot.reject(abortError());
      }
      worker.postMessage({ type: FeaMessage.cancel });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      failAll(new Error('FEA client disposed'));
      try {
        worker.postMessage({ type: FeaMessage.dispose });
      } catch {
        /* already terminated */
      }
      worker.terminate();
    },
  };
}
