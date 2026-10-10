/**
 * Numbered probe markers for the results view. The study writes the list.
 * The viewport subscribes and draws it. No React.
 */

let probes = [];
const listeners = new Set();

export function setProbeOverlay(list) {
  probes = Array.isArray(list) ? list : [];
  for (const listener of listeners) listener();
}

export function getProbeOverlay() {
  return probes;
}

export function subscribeProbeOverlay(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
