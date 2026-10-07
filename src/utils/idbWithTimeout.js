/**
 * Race a promise against a timeout. Does not cancel the underlying work.
 * Used so IndexedDB open/tx cannot wedge App Loading forever (Safari / OAuth return).
 */
export function idbWithTimeout(promise, ms, label = 'IndexedDB') {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); },
    );
  });
}

/** Budget for open + a single transaction on mobile after OAuth. */
export const IDB_OP_TIMEOUT_MS = 3000;
