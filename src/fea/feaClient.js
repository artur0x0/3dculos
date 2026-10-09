// Main-thread client for the FEA module worker.
//
// createFeaClient() loads the wasm inside the worker. solve() transfers the
// mesh typed arrays in and transfers the nodal Float32Array back. The worker
// meshes the surface and runs solve_tet10. cancel() rejects the in-flight
// solve. dispose() terminates the worker.
//
// Units: material.E_MPa and material.yield_MPa are megapascals. material.nu
// is dimensionless and required. yield_MPa may be null; the safety factor
// is then null. The field is von Mises in MPa. A real run sets source to
// "tet10". fallback: "stub" is the dev-only placeholder and keeps the STUB
// badge. profile is "phone" or "desktop". On a phone the worker instantiates
// non-shared wasm memories with a 512 MiB ceiling.
//
// TODO: shells need a midsurface extraction. capabilities().shells is false
// and solids always use TET10.

import FeaWorker from '../workers/feaWorker.js?worker';
import { appCapabilities } from './deviceProfile.js';
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

export async function createFeaClient(options = {}) {
  const worker = new FeaWorker();
  const profile = options.profile === 'phone' ? 'phone' : 'desktop';
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
      if (data.type === FeaMessage.progress) {
        const slot = pending.get(data.id);
        if (slot && typeof slot.onProgress === 'function') {
          slot.onProgress({ stage: data.stage, fraction: data.fraction });
        }
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

  worker.postMessage({ type: FeaMessage.configure, profile });
  await ready;

  function begin(type, fields, transfer, hooks) {
    assertOpen();
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, type, onProgress: hooks && hooks.onProgress });
    });
    worker.postMessage({ id, type, profile, ...fields }, transfer || []);
    return { id, promise };
  }

  return {
    capabilities() {
      return begin(FeaMessage.capabilities, {}).promise.then((caps) => appCapabilities(caps));
    },

    solve(request, hooks = {}) {
      assertOpen();
      if (hooks.signal && hooks.signal.aborted) return Promise.reject(abortError());
      const mesh = packMesh(request && request.mesh);
      const { id, promise } = begin(FeaMessage.solve, {
        study: request && request.study != null ? request.study : null,
        material: request ? request.material : null,
        profile: request && request.profile ? request.profile : profile,
        fallback: request && request.fallback,
        positions: mesh.positions,
        indices: mesh.indices,
        faceIDs: mesh.faceIDs,
      }, mesh.transfer, { onProgress: hooks.onProgress });
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
      if (hooks.signal) hooks.signal.addEventListener('abort', onAbort, { once: true });
      return promise.finally(() => {
        if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
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
