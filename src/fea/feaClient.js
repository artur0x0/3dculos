// Main-thread client for the FEA module worker.
//
// createFeaClient() loads the wasm inside the worker. solve() transfers the
// mesh typed arrays in and transfers the nodal stress and displacement
// Float32Arrays back. Displacement is the magnitude in millimetres at each
// render vertex. The worker meshes a solid with TET10, or a pure sheet-metal
// part on its mid-surface with the shell solver. cancel() rejects the
// in-flight solve. dispose() terminates the worker.
//
// Units: material.E_MPa and material.yield_MPa are megapascals. material.nu
// is dimensionless and required. yield_MPa may be null; the safety factor
// is then null. The field is von Mises in MPa. A real run sets source to
// "tet10". fallback: "stub" is the dev-only placeholder and keeps the STUB
// badge. profile is "phone" or "desktop". On a phone the worker instantiates
// non-shared wasm memories with a 512 MiB ceiling.
//
// A pure sheetMetalSolid part is solved with the shell when the study model
// is "auto" or "shell". Pass `sheetSpec` from shellSheetFromScript. Model
// "solid" stays on TET10. A non-sheet part has no midsurface heuristic.

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
        sheetSpec: request && request.sheetSpec ? request.sheetSpec : null,
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
