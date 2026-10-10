/**
 * Sheet-metal length captions. The spec, the sliders' stored values, and
 * the kernel stay millimetres. The unit is the global `surfcad.displayUnit`.
 * A leftover `surfcad.sheetMetal.displayUnit` is not read and does not
 * override that key. Gauge numbers stay on the picker.
 */
import { MM_PER_IN, normalizeDisplayUnit } from '../displayUnit.js';

/** `12.50 mm` or `0.492 in`. Angles are not lengths — don't pass them here. */
export function formatSheetLength(mm, unit = 'mm', mmDigits = 2) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return '';
  if (normalizeDisplayUnit(unit) === 'in') return `${(n / MM_PER_IN).toFixed(3)} in`;
  return `${n.toFixed(mmDigits)} mm`;
}

/** `10.00 × 6.00 mm` or `0.394 × 0.236 in`. */
export function formatSheetPair(pair, unit = 'mm', mmDigits = 1) {
  if (!Array.isArray(pair)) return '';
  const u = normalizeDisplayUnit(unit);
  const body = pair
    .map((n) => formatSheetLength(n, u, mmDigits).replace(/ (mm|in)$/, ''))
    .join(' × ');
  return `${body} ${u}`;
}
