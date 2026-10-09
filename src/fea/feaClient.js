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
import { createFeaWorkerHost } from './feaRunSession.js';
import { packMesh } from './meshTransfer.js';
import { FeaMessage } from './protocol.js';

export async function createFeaClient(options = {}) {
  const worker = options.worker || new FeaWorker();
  const profile = options.profile === 'phone' ? 'phone' : 'desktop';
  const host = createFeaWorkerHost(worker, options);
  worker.postMessage({ type: FeaMessage.configure, profile });
  await host.ready;

  return {
    capabilities() {
      return host.request(FeaMessage.capabilities, { profile }).then((caps) => appCapabilities(caps));
    },

    solve(request, hooks = {}) {
      const mesh = packMesh(request && request.mesh);
      return host.request(FeaMessage.solve, {
        study: request && request.study != null ? request.study : null,
        material: request ? request.material : null,
        profile: request && request.profile ? request.profile : profile,
        fallback: request && request.fallback,
        positions: mesh.positions,
        indices: mesh.indices,
        faceIDs: mesh.faceIDs,
      }, mesh.transfer, hooks);
    },

    cancel() {
      host.cancel();
    },

    dispose() {
      host.dispose();
    },
  };
}
