/**
 * Which Analyze screen is up. Pure: no React and no worker.
 *
 * A finished solve that is still current opens Results. Back to Setup sets
 * `dismissed` and the overlay comes off. A stale edit does the same. A
 * failed or stopped run stays on the setup.
 */

export const PLOT_TABS = Object.freeze([
  Object.freeze({ value: 'stress', label: 'Stress' }),
  Object.freeze({ value: 'displacement', label: 'Displacement' }),
]);

export function activePlot(plot) {
  return plot === 'displacement' ? 'displacement' : 'stress';
}

/**
 * True only for a successful, current solve the user has not left.
 * `running` covers the in-flight bar. `status` is the progress report:
 * `done` is a finished solve, `stopped` is a failure or a cancel.
 */
export function showResults({ running = false, status = 'idle', result = null, dismissed = false } = {}) {
  if (running || dismissed) return false;
  if (status !== 'done') return false;
  if (!result || result.stale === true) return false;
  return true;
}
