/**
 * FEA wasm init for unit tests.
 *
 * Call this from `before()` or from inside a test. A top-level `await` in a
 * test file runs while the file is still loading, before the runner has
 * registered any test, so a hang there never starts the per-test timeout
 * and the process sits until the job limit.
 */
import { readFile } from 'node:fs/promises';
import * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';

const wasmUrl = new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);

/** Long enough for a cold wasm compile, short of the CI job limit. */
export const FEA_SETUP_TIMEOUT_MS = 180_000;

let bytesPromise = null;
let initPromise = null;

export function readFeaWasm() {
  if (!bytesPromise) bytesPromise = readFile(wasmUrl);
  return bytesPromise;
}

export function initFeaWasm() {
  if (!initPromise) {
    initPromise = (async () => {
      const bytes = await readFeaWasm();
      const init = fea.default ?? fea.init;
      await init({ module_or_path: bytes });
      return bytes;
    })();
  }
  return initPromise;
}
