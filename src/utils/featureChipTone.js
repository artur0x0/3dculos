/** Feature strip chip classes (shared by the strip and its goldens). */

/**
 * Chip colours. A feature that holds a frozen copy of another part's
 * geometry (externalBody) gets a yellow border, active or not. A feature
 * the last run failed in gets a red border (the error popup's red-400),
 * active or not; it wins over yellow.
 */
export function chipTone(active, external = false, failed = false) {
  if (failed) {
    return active
      ? 'bg-cyan-600 text-white border-2 border-red-400 shadow'
      : 'bg-gray-800/70 text-gray-200 border-2 border-red-400 hover:text-white';
  }
  if (active) {
    return external
      ? 'bg-cyan-600 text-white border-2 border-yellow-400 shadow'
      : 'bg-cyan-600 text-white border-cyan-400/70 shadow';
  }
  return external
    ? 'bg-gray-800/70 text-gray-200 border-2 border-yellow-400 hover:text-white'
    : 'bg-gray-800/70 text-gray-200 border-gray-500/40 hover:text-white';
}
