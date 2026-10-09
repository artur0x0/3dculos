// Module worker for the FEA wasm. The page talks to it through feaClient.js.
// Single-threaded: the module is not built with atomics or shared memory, so
// the document does not need COOP/COEP headers.

import init, * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { FeaMessage } from '../fea/protocol.js';

const ready = init().then(
  () => {
    self.postMessage({ type: FeaMessage.loaded });
  },
  (error) => {
    self.postMessage({
      type: FeaMessage.loadError,
      error: error && error.message ? error.message : String(error),
    });
  },
);

function copyNodal(result) {
  if (!result || !(result.nodal instanceof Float32Array)) return result;
  // result.nodal views wasm memory. Copy before transfer so postMessage
  // does not detach the module's heap.
  const nodal = new Float32Array(result.nodal);
  result.nodal = nodal;
  return nodal.buffer;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === FeaMessage.cancel) {
    ready.then(() => fea.cancel()).catch(() => {});
    return;
  }
  if (msg.type === FeaMessage.dispose) {
    ready.then(() => fea.dispose()).catch(() => {});
    return;
  }
  try {
    await ready;
    if (msg.type === FeaMessage.capabilities) {
      self.postMessage({ id: msg.id, ok: true, result: fea.capabilities() });
      return;
    }
    if (msg.type === FeaMessage.solve) {
      const result = fea.solve(
        msg.study,
        msg.positions,
        msg.indices,
        msg.faceIDs,
        msg.material,
        msg.profile,
      );
      const transfer = copyNodal(result);
      const transfers = transfer ? [transfer] : [];
      self.postMessage({ id: msg.id, ok: true, result }, transfers);
      return;
    }
    self.postMessage({ id: msg.id, ok: false, error: `unknown FEA message ${msg.type}` });
  } catch (error) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
};
