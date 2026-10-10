/**
 * Global display unit (the L2 seed).
 *
 * Scripts and the kernel stay millimetres. This module never writes a
 * script and never changes a stored length. It only converts for display,
 * and turns a typed display number back into millimetres before a later
 * field writes. Length captions carry the unit suffix (`Distance mm`).
 * Angles stay degrees.
 *
 * Persisted at `surfcad.displayUnit`. Measure and the joint distance
 * field read it. Sheet metal keeps `surfcad.sheetMetal.displayUnit`
 * (`sheetUnits.js`) until that pass.
 */
export const DISPLAY_UNIT_KEY = 'surfcad.displayUnit';
export const MM_PER_IN = 25.4;

const listeners = new Set();
let cached = null;

export function normalizeDisplayUnit(unit) {
  return unit === 'in' ? 'in' : 'mm';
}

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function loadDisplayUnit(storage) {
  try {
    return normalizeDisplayUnit(storageOf(storage)?.getItem?.(DISPLAY_UNIT_KEY));
  } catch {
    return 'mm';
  }
}

export function saveDisplayUnit(unit, storage) {
  const next = normalizeDisplayUnit(unit);
  try {
    storageOf(storage)?.setItem?.(DISPLAY_UNIT_KEY, next);
  } catch {
    /* private mode / no storage */
  }
  return next;
}

export function getDisplayUnit() {
  if (cached == null) cached = loadDisplayUnit();
  return cached;
}

export function setDisplayUnit(unit, storage) {
  cached = saveDisplayUnit(unit, storage);
  for (const fn of listeners) fn(cached);
  return cached;
}

export function subscribeDisplayUnit(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stored millimetres → the number a caption or field shows. */
export function lengthToDisplay(mm, unit) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return n;
  return normalizeDisplayUnit(unit) === 'in' ? n / MM_PER_IN : n;
}

/**
 * A typed display number → millimetres. Non-finite input stays non-finite.
 * Call this before a length is written. Do not parse a formatted caption.
 */
export function displayToMm(value, unit) {
  if (value == null || String(value).trim() === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  return normalizeDisplayUnit(unit) === 'in' ? n * MM_PER_IN : n;
}

/** `Distance mm` or `Radius in`. A caption that already ends with the unit stays. */
export function lengthCaption(label, unit) {
  const text = label == null ? '' : String(label).trim();
  const suffix = normalizeDisplayUnit(unit);
  if (!text) return suffix;
  if (text.endsWith(` ${suffix}`)) return text;
  return `${text} ${suffix}`;
}

/** `30.00 mm` or `1.1811 in`. Lengths only — angles stay degrees. */
export function formatDisplayLength(mm, unit) {
  const u = normalizeDisplayUnit(unit);
  const n = lengthToDisplay(mm, u);
  if (!Number.isFinite(n)) return '';
  const digits = u === 'in' ? 4 : 2;
  return `${n.toFixed(digits)} ${u}`;
}

/** Signed length. A zero rounds to `0.00 mm`, not `-0.00`. */
export function formatDisplayDelta(mm, unit) {
  const u = normalizeDisplayUnit(unit);
  const n = lengthToDisplay(mm, u);
  if (!Number.isFinite(n)) return '';
  const digits = u === 'in' ? 4 : 2;
  const rounded = Number(n.toFixed(digits));
  if (rounded === 0) return `${(0).toFixed(digits)} ${u}`;
  const body = rounded > 0 ? `+${rounded.toFixed(digits)}` : rounded.toFixed(digits);
  return `${body} ${u}`;
}

export function formatDisplayAngle(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return '';
  return `${n.toFixed(1)}°`;
}
