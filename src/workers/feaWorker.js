// Module worker for the FEA wasm. The page talks to it through feaClient.js.
// Single-threaded: the module is not built with atomics or shared memory, so
// the document does not need COOP/COEP headers.
//
// A phone profile rewrites both wasm memories to a non-shared 512 MiB ceiling
// before instantiate. The mesher is imported from solveSolid on the first
// solve, not when this worker boots.

import init, * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { createMeshCache, releaseMeshCache, solveSolid } from '../fea/solveSolid.js';
import { PHONE_WASM_BYTES, capWasmMemory, memoryIsShared, wasmMemoryLimits } from '../fea/wasmMemory.js';
import { FeaMessage } from '../fea/protocol.js';

let ready = null;
let memory = null;
let cancelled = false;
// One or two TET10 meshes. Phone keeps one so the 512 MiB worker budget
// is not held by a mesh the next geometry replaced.
let meshCache = createMeshCache();
let peakBytes = 0;
let heartbeatTimer = null;
let heartbeatId = null;
let heartbeatStage = '';
let heartbeatBlocking = false;

function stopHeartbeat() {
  if (heartbeatTimer != null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function postHeartbeat() {
  self.postMessage({
    type: FeaMessage.heartbeat,
    id: heartbeatId,
    stage: heartbeatStage,
    blocking: heartbeatBlocking,
    t: Date.now(),
  });
}

function startHeartbeat(id) {
  stopHeartbeat();
  heartbeatId = id ?? null;
  postHeartbeat();
  heartbeatTimer = setInterval(postHeartbeat, 1000);
}

function noteMemory(volume) {
  const feaBytes = memory && memory.buffer ? memory.buffer.byteLength : 0;
  const meshBytes = volume && volume.stats ? volume.stats.wasmBytes || 0 : 0;
  peakBytes = Math.max(peakBytes, feaBytes + meshBytes);
}

async function boot(profile) {
  heartbeatStage = 'loading-mesher';
  startHeartbeat(heartbeatId);
  const wasmUrl = new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`FEA wasm fetch failed (${response.status})`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (profile === 'phone') bytes = capWasmMemory(bytes, PHONE_WASM_BYTES);
  const limits = wasmMemoryLimits(bytes);
  if (limits.shared) throw new Error('FEA wasm memory must not be shared');
  const exports = await init(bytes);
  memory = exports.memory;
  if (memoryIsShared(memory)) throw new Error('FEA wasm memory must not be shared');
  if (profile === 'phone' && limits.maxPages * 65536 > PHONE_WASM_BYTES) {
    throw new Error('FEA wasm memory is above the 512 MiB phone ceiling');
  }
}

function ensureBoot(profile) {
  if (!ready) {
    const useProfile = profile === 'phone' ? 'phone' : 'desktop';
    ready = boot(useProfile).then(
      () => {
        self.postMessage({ type: FeaMessage.loaded });
      },
      (error) => {
        ready = null;
        self.postMessage({
          type: FeaMessage.loadError,
          error: error && error.message ? error.message : String(error),
        });
        throw error;
      },
    );
  }
  return ready;
}

function ownFloat32(result, key) {
  if (!result || !(result[key] instanceof Float32Array)) return null;
  const copy = new Float32Array(result[key]);
  result[key] = copy;
  return copy.buffer;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === FeaMessage.cancel) {
    cancelled = true;
    heartbeatBlocking = false;
    if (ready) ready.then(() => fea.cancel()).catch(() => {});
    return;
  }
  if (msg.type === FeaMessage.dispose) {
    stopHeartbeat();
    releaseMeshCache(meshCache);
    meshCache = createMeshCache();
    if (ready) ready.then(() => fea.dispose()).catch(() => {});
    return;
  }
  try {
    if (msg.type === FeaMessage.configure) {
      await ensureBoot(msg.profile);
      return;
    }
    await ensureBoot(msg.profile);
    if (msg.type === FeaMessage.capabilities) {
      self.postMessage({ id: msg.id, ok: true, result: fea.capabilities() });
      return;
    }
    if (msg.type === FeaMessage.solve) {
      cancelled = false;
      heartbeatBlocking = false;
      peakBytes = 0;
      noteMemory(null);
      startHeartbeat(msg.id);
      try {
        const result = await solveSolid({
          study: msg.study,
          positions: msg.positions,
          indices: msg.indices,
          faceIDs: msg.faceIDs,
          material: msg.material,
          profile: msg.profile,
          fallback: msg.fallback,
          solveTet10: fea.solve_tet10,
          solveShell: fea.solve_shell,
          solveStub: fea.solve,
          sheetSpec: msg.sheetSpec || null,
          cache: meshCache,
          isCancelled: () => cancelled,
          memory,
          noteMemory,
          peakMemory: () => {
            noteMemory(null);
            return peakBytes;
          },
          onProgress: (progress) => {
            const update = progress || {};
            if (update.stage) heartbeatStage = update.stage;
            if (update.blocking != null) heartbeatBlocking = !!update.blocking;
            const payload = {
              type: FeaMessage.progress,
              id: msg.id,
              t: Date.now(),
            };
            for (const key of [
              'stage', 'fraction', 'solver', 'iteration', 'estimatedIterations',
              'residual', 'residual0', 'tol', 'choleskyStep', 'dofs', 'blocking',
            ]) {
              if (update[key] != null) payload[key] = update[key];
            }
            self.postMessage(payload);
          },
        });
        if (cancelled) return;
        noteMemory(null);
        if (result && result.stats) result.stats.peakMemoryBytes = peakBytes;
        const transfers = [];
        for (const key of ['nodal', 'displacement']) {
          const buffer = ownFloat32(result, key);
          if (buffer) transfers.push(buffer);
        }
        self.postMessage({ id: msg.id, ok: true, result }, transfers);
      } finally {
        heartbeatBlocking = false;
        stopHeartbeat();
      }
      return;
    }
    self.postMessage({ id: msg.id, ok: false, error: `unknown FEA message ${msg.type}` });
  } catch (error) {
    if (cancelled || (error && error.name === 'AbortError')) return;
    self.postMessage({
      id: msg.id,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
};
