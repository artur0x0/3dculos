/**
 * Shared sandbox harness for the SCS goldens: loads the real worker with the
 * Manifold resolve hook and exposes exec(script) → payload.
 */
import { register } from 'node:module';

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(msg.payload?.message || 'worker error'));
    else waiter.resolve(msg);
  },
};

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => {
      if (!workerSelf.onmessage) {
        reject(new Error('sandboxWorker handler missing'));
        return;
      }
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

let ready = null;
export async function loadSandbox() {
  if (!ready) {
    globalThis.self = workerSelf;
    register('./manifold-resolve-hook.mjs', import.meta.url);
    ready = import('../../src/workers/sandboxWorker.js').then(() => send('init'));
  }
  await ready;
  return {
    exec: async (script) => (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload,
  };
}
