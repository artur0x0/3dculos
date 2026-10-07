/**
 * Sheet-metal mode state (Viewport). Pure transitions so goldens can drive it.
 *
 * stage 'plane' — planes highlighted; tap one (or a Top/Front/Right button)
 * stage 'base'  — base-flange popup: width × height; Accept / Back / ✕
 * stage 'edit'  — spec committed; edges / features (S3+)
 *
 * mode = { stage, sku (S1 record), partId, spec, base?: { plane, width, height } }
 */
import { createSheetSpec, normalizeSheetSpec, respecSheetSku, SHEET_PLANES } from './sheetModel.js';

export const BASE_DEFAULTS = Object.freeze({ width: 100, height: 60 });
export const BASE_MIN = 1;
export const BASE_MAX = 1200;

/** Start designing. An existing sheet spec on the part skips straight to edit. */
export function enterSheetMetalMode(record, partId = null, existingSpec = null) {
  if (!record?.sku) return null;
  const spec = normalizeSheetSpec(existingSpec);
  if (spec) {
    return { stage: 'edit', sku: record, partId: partId ?? null, spec: respecSheetSku(spec, record), tool: defaultTool(record) };
  }
  return { stage: 'plane', sku: record, partId: partId ?? null, spec: null, base: null };
}

export function defaultTool(record) {
  return record?.bendable ? 'bend' : 'tab';
}

export function pickSheetPlane(mode, planeId) {
  if (!mode || mode.stage !== 'plane' || !SHEET_PLANES[planeId]) return mode;
  const prev = mode.base || {};
  return {
    ...mode,
    stage: 'base',
    base: {
      plane: planeId,
      width: prev.width ?? BASE_DEFAULTS.width,
      height: prev.height ?? BASE_DEFAULTS.height,
    },
  };
}

const clampDim = (n, fallback) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(BASE_MAX, Math.max(BASE_MIN, v));
};

export function setBaseDims(mode, patch) {
  if (!mode || mode.stage !== 'base' || !mode.base) return mode;
  const base = { ...mode.base };
  if (patch?.width !== undefined && patch.width !== '') base.width = clampDim(patch.width, base.width);
  if (patch?.height !== undefined && patch.height !== '') base.height = clampDim(patch.height, base.height);
  return { ...mode, base };
}

/** Back from the base popup: one tap re-enters plane pick (dims kept). */
export function backToPlanePick(mode) {
  if (!mode || mode.stage !== 'base') return mode;
  return { ...mode, stage: 'plane' };
}

/** Spec the base popup is previewing (base flange at SKU thickness). */
export function baseDraftSpec(mode) {
  if (!mode?.base) return null;
  return createSheetSpec(mode.sku, mode.base.plane, mode.base);
}

/** Accept the base flange → { mode (edit), spec to commit }. */
export function acceptBaseFlange(mode) {
  const spec = baseDraftSpec(mode);
  if (!spec) return { mode, spec: null };
  return { mode: { ...mode, stage: 'edit', spec, base: null, tool: defaultTool(mode.sku) }, spec };
}
