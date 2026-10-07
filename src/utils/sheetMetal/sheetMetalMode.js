/**
 * Sheet-metal mode state (Viewport). Pure transitions so goldens can drive it.
 *
 * stage 'plane' — planes highlighted; tap one (or a Top/Front/Right button)
 * stage 'base'  — base-flange popup: width × height; Accept / Back / ✕
 * stage 'edit'  — spec committed; edges / features (S3+)
 *
 * mode = { stage, sku (S1 record), partId, spec, base?: { plane, width, height } }
 */
import {
  createSheetSpec,
  normalizeSheetSpec,
  panelById,
  panelEdge,
  panelLocal,
  respecSheetSku,
  sheetFeatureId,
  solveSheet,
  SHEET_PLANES,
  IN,
} from './sheetModel.js';
import { FASTENER_METRIC, FASTENER_UNC } from '../../workers/fastenerSizes.js';

export const BASE_DEFAULTS = Object.freeze({ width: 100, height: 60 });
export const BASE_MIN = 1;
export const BASE_MAX = 1200;

/** Inches pair → sorted [smaller, larger] mm, or null. */
function sortedPairMm(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const a = Number(pair[0]);
  const b = Number(pair[1]);
  if (!(a > 0) || !(b > 0)) return null;
  const mm = [a, b].map((n) => Math.round(n * IN * 1000) / 1000).sort((x, y) => x - y);
  return mm;
}

/**
 * Base-flange defaults: 100×60 mm, then each sorted side is raised to cover
 * the SKU minimum flat (`bend.minFlatIn` / bending min_flat_part_size) and
 * the cutting minimum part size (`minPartIn`). The longer minimum maps to
 * width. Already-larger defaults stay put. Result is millimetres.
 */
export function defaultBaseDims(rec) {
  let height = BASE_DEFAULTS.height;
  let width = BASE_DEFAULTS.width;
  const raise = (pair) => {
    const min = sortedPairMm(pair);
    if (!min) return;
    height = Math.max(height, min[0]);
    width = Math.max(width, min[1]);
  };
  raise(rec?.bend?.minFlatIn);
  raise(rec?.minPartIn);
  return {
    width: Math.min(BASE_MAX, width),
    height: Math.min(BASE_MAX, height),
  };
}

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
  const dims = defaultBaseDims(mode.sku);
  return {
    ...mode,
    stage: 'base',
    base: {
      plane: planeId,
      width: prev.width ?? dims.width,
      height: prev.height ?? dims.height,
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

// ---------------------------------------------------------------- S3 bends
// Draft = the one feature the popup is editing ({ kind, id, isNew, … }).
// The overlay previews `draftPreviewSpec(mode)`; Accept commits it.

const round2 = (n) => Math.round(n * 100) / 100;

function panelOf(spec, id) {
  if (id === 'base') return { perp: { 'u+': spec.width, 'u-': spec.width, 'v+': spec.height, 'v-': spec.height } };
  const b = (spec.bends || []).find((x) => x.id === id);
  return b ? { perp: { 'u+': b.length, 'u-': b.length, 'v+': b.length, 'v-': b.length } } : null;
}

/** Slider ranges for a bend from the SKU (limits embedded in the spec). */
export function bendLimits(spec) {
  const L = spec?.limits || {};
  const minFlange = Number(L.minFlange) > 0 ? Number(L.minFlange) : Math.max(spec.t * 2, 1);
  const baseMax = Math.max(Number(spec.width) || 0, Number(spec.height) || 0);
  return {
    angleMin: Math.max(1, Number(L.minAngle) || 1),
    angleMax: Number(L.maxAngle) > 0 ? Number(L.maxAngle) : 180,
    lengthMin: round2(minFlange),
    // Length scales with the base flange (S3): up to its largest side.
    lengthMax: round2(Math.max(minFlange * 2, baseMax)),
  };
}

/** New bend on an edge: 90° (or the SKU max), length ¼ of the side it leaves. */
export function bendDefaults(spec, panelId, edge) {
  const lim = bendLimits(spec);
  const perp = panelOf(spec, panelId)?.perp?.[edge] || spec.width;
  const length = Math.min(lim.lengthMax, Math.max(lim.lengthMin * 1.5, round2(perp * 0.25)));
  return { angle: Math.min(90, lim.angleMax), length: round2(length), flip: false };
}

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

export function startBendDraft(mode, { panel, edge }) {
  if (!mode?.spec || mode.stage !== 'edit') return mode;
  if (!mode.spec.limits?.bendable) {
    return { ...mode, toast: 'This SKU has no bending service — use Tab or pick a bendable gauge.' };
  }
  const id = sheetFeatureId('b', mode.spec);
  return {
    ...mode,
    toast: null,
    hotEdge: { panel, edge },
    draft: { kind: 'bend', id, isNew: true, panel, edge, ...bendDefaults(mode.spec, panel, edge) },
  };
}

export function editFeatureDraft(mode, kind, id) {
  if (!mode?.spec || mode.stage !== 'edit') return mode;
  const list = kind === 'bend' ? mode.spec.bends : kind === 'tab' ? mode.spec.tabs : mode.spec.holes;
  const found = (list || []).find((f) => f.id === id);
  if (!found) return mode;
  const draft = { kind, isNew: false, ...found };
  if (kind === 'tab') {
    const p = panelById(solveSheet(mode.spec), found.panel);
    const ef = p ? panelEdge(p, found.edge) : null;
    if (ef) draft.span = round2(ef.q1 - ef.q0);
  }
  return { ...mode, toast: null, hotEdge: found.edge ? { panel: found.panel, edge: found.edge } : null, draft };
}

/** Popup edits, clamped to the SKU. */
export function updateDraft(mode, patch) {
  if (!mode?.draft) return mode;
  const d = { ...mode.draft };
  if (d.kind === 'bend') {
    const lim = bendLimits(mode.spec);
    if (patch.angle !== undefined && patch.angle !== '') d.angle = clamp(patch.angle, lim.angleMin, lim.angleMax, d.angle);
    if (patch.length !== undefined && patch.length !== '') d.length = clamp(patch.length, lim.lengthMin, Math.max(lim.lengthMax, d.length), d.length);
    if (patch.flip !== undefined) d.flip = !!patch.flip;
  } else if (d.kind === 'tab') {
    const span = Number(d.span) || 1e4;
    if (patch.width !== undefined && patch.width !== '') d.width = clamp(patch.width, 1, span, d.width);
    if (patch.depth !== undefined && patch.depth !== '') d.depth = clamp(patch.depth, 0.5, 1000, d.depth);
    if (patch.centered !== undefined) d.centered = !!patch.centered;
    if (patch.offset !== undefined && patch.offset !== '') d.offset = clamp(patch.offset, 0, Math.max(0, span - d.width), d.offset);
    if (d.offset > span - d.width) d.offset = Math.max(0, round2(span - d.width));
  } else if (d.kind === 'hole') {
    if (patch.u !== undefined && patch.u !== '') d.u = clamp(patch.u, -1e4, 1e4, d.u);
    if (patch.v !== undefined && patch.v !== '') d.v = clamp(patch.v, -1e4, 1e4, d.v);
    if (patch.d !== undefined && patch.d !== '') d.d = clamp(patch.d, 0.1, 500, d.d);
    if (patch.thread !== undefined) {
      const size = TAP_SIZES.find((x) => x.id === patch.thread);
      if (size) {
        d.thread = size.id;
        d.d = size.tap;
      }
    }
    if (patch.cskDia !== undefined && patch.cskDia !== '') d.cskDia = clamp(patch.cskDia, d.d, 500, d.cskDia);
  }
  return { ...mode, draft: d };
}

function featureFromDraft(d) {
  const { kind: _k, isNew: _n, span: _s, ...rest } = d;
  return rest;
}

/** Spec with the draft applied (preview + Accept). */
export function draftPreviewSpec(mode) {
  const spec = mode?.spec;
  const d = mode?.draft;
  if (!spec || !d) return spec || null;
  const key = d.kind === 'bend' ? 'bends' : d.kind === 'tab' ? 'tabs' : 'holes';
  const list = [...(spec[key] || [])];
  const feat = featureFromDraft(d);
  const at = list.findIndex((f) => f.id === d.id);
  if (at >= 0) list[at] = feat;
  else list.push(feat);
  return { ...spec, [key]: list };
}

export function acceptDraft(mode) {
  if (!mode?.draft) return { mode, spec: null };
  const spec = draftPreviewSpec(mode);
  return { mode: { ...mode, spec, draft: null, hotEdge: null, toast: null }, spec };
}

/** Back from a feature popup: drop the draft, stay in edge / face pick. */
export function cancelDraft(mode) {
  if (!mode) return mode;
  return { ...mode, draft: null, hotEdge: null, toast: null };
}

/** Delete the edited feature; a bend takes its flange's children with it. */
export function deleteDraftFeature(mode) {
  const d = mode?.draft;
  if (!d || d.isNew) return { mode: cancelDraft(mode), spec: null };
  const spec = mode.spec;
  const gone = new Set();
  if (d.kind === 'bend') {
    gone.add(d.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const b of spec.bends || []) {
        if (!gone.has(b.id) && gone.has(b.panel)) {
          gone.add(b.id);
          grew = true;
        }
      }
    }
  }
  const next = {
    ...spec,
    bends: (spec.bends || []).filter((b) => (d.kind === 'bend' ? !gone.has(b.id) : true)),
    tabs: (spec.tabs || []).filter((tb) => !(d.kind === 'tab' && tb.id === d.id) && !gone.has(tb.panel)),
    holes: (spec.holes || []).filter((h) => !(d.kind === 'hole' && h.id === d.id) && !gone.has(h.panel)),
  };
  return { mode: { ...mode, spec: next, draft: null, hotEdge: null }, spec: next };
}

/**
 * Viewport tap router (pick = sheetPickFromHits result, point in part frame).
 * plane → base popup; edge → new feature for the active tool; feature → edit.
 */
export function sheetTap(mode, pick) {
  if (!mode || !pick) return mode;
  if (mode.stage === 'plane') return pick.kind === 'plane' ? pickSheetPlane(mode, pick.plane) : mode;
  if (mode.stage !== 'edit' || mode.draft || mode.exportOpen) return mode;
  if (pick.kind === 'edge') {
    if (mode.tool === 'bend') return startBendDraft(mode, pick);
    if (mode.tool === 'tab') return startTabDraft(mode, pick);
    return mode;
  }
  if (pick.kind === 'bend' || pick.kind === 'tab' || pick.kind === 'hole') return editFeatureDraft(mode, pick.kind, pick.id);
  if (pick.kind === 'panel' && HOLE_TOOLS.has(mode.tool)) return startHoleDraft(mode, pick);
  return mode;
}

// ---------------------------------------------------------------- S4 tools
// The sheet rail lists only what SendCutSend can make on this SKU, Tab first.

export const SHEET_TOOLS = Object.freeze([
  { id: 'tab', label: 'Tab', title: 'Tab — extend an edge in-plane', service: null },
  { id: 'bend', label: 'Bend', title: 'Bend — tap an edge to fold a flange', service: 'bending' },
  { id: 'hole', label: 'Hole', title: 'Hole — tap a face to cut a round hole', service: null },
  { id: 'countersink', label: 'Csk', title: 'Countersunk hole (SCS countersinking)', service: 'countersinking' },
  { id: 'tapped', label: 'Tap', title: 'Tapped hole (SCS tapping)', service: 'tapping' },
]);
const HOLE_TOOLS = new Set(['hole', 'countersink', 'tapped']);

/** Tools available for a spec: no-service tools always; others need the SKU service. */
export function sheetToolsFor(spec) {
  const services = new Set(spec?.limits?.services || []);
  return SHEET_TOOLS.filter((tool) => {
    if (tool.id === 'bend') return !!spec?.limits?.bendable && services.has('bending');
    return !tool.service || services.has(tool.service);
  });
}

export function setSheetTool(mode, tool) {
  if (!mode || mode.stage !== 'edit' || mode.exportOpen) return mode;
  if (!sheetToolsFor(mode.spec).some((t) => t.id === tool)) return mode;
  return { ...mode, tool, draft: null, hotEdge: null, toast: null };
}

/** Tab defaults: Centered on, width 40% of the edge (≤ 25 mm), depth 10 mm. */
export function startTabDraft(mode, { panel, edge }) {
  if (!mode?.spec || mode.stage !== 'edit') return mode;
  const solved = solveSheet(mode.spec);
  const p = panelById(solved, panel);
  if (!p) return mode;
  const ef = panelEdge(p, edge);
  const span = ef.q1 - ef.q0;
  const width = round2(Math.max(1, Math.min(25, span * 0.4)));
  return {
    ...mode,
    toast: null,
    hotEdge: { panel, edge },
    draft: {
      kind: 'tab',
      id: sheetFeatureId('t', mode.spec),
      isNew: true,
      panel,
      edge,
      width,
      depth: 10,
      centered: true,
      offset: round2((span - width) / 2),
      span: round2(span),
    },
  };
}

/** Tapped-hole sizes SCS taps (metric + UNC), tap-drill Ø in mm. */
export const TAP_SIZES = Object.freeze([
  ...['M2_5', 'M3', 'M4', 'M5', 'M6', 'M8'].map((k) => ({ id: k.replace('_', '.'), tap: FASTENER_METRIC[k].tap })),
  ...['#4-40', '#6-32', '#8-32', '#10-32', '1/4-20'].map((k) => ({ id: k, tap: FASTENER_UNC[k].tap })),
]);

/** Hole at the tapped point of a panel face. */
export function startHoleDraft(mode, { panel, point }) {
  if (!mode?.spec || mode.stage !== 'edit' || !Array.isArray(point)) return mode;
  const solved = solveSheet(mode.spec);
  const p = panelById(solved, panel);
  if (!p) return mode;
  const [u, v] = panelLocal(p, point);
  const minHole = Number(mode.spec.limits?.minHole) || 1;
  const kind = mode.tool;
  const thread = kind === 'tapped' ? 'M4' : null;
  const d = kind === 'tapped'
    ? TAP_SIZES.find((x) => x.id === thread).tap
    : round2(Math.max(5, minHole * 2));
  return {
    ...mode,
    toast: null,
    draft: {
      kind: 'hole',
      id: sheetFeatureId('h', mode.spec),
      isNew: true,
      panel,
      u: round2(u),
      v: round2(v),
      d,
      type: kind,
      ...(thread ? { thread } : {}),
      ...(kind === 'countersink' ? { cskDia: round2(d * 2), cskAngle: 82 } : {}),
    },
  };
}

/** u / v ranges for the hole popup (panel extents). */
export function holeRange(mode) {
  const d = mode?.draft;
  if (!d || d.kind !== 'hole') return null;
  const p = panelById(solveSheet(mode.spec), d.panel);
  if (!p) return null;
  return { u0: p.u0, u1: p.u1, v0: p.v0, v1: p.v1 };
}

/** Bend deduction for display: 2(r+t)·tan(θ/2) − BA (SCS publishes the 90° value). */
export function bendDeductionAt(spec, angle) {
  const th = (Number(angle) * Math.PI) / 180;
  const ba = th * (spec.r + spec.k * spec.t);
  return 2 * (spec.r + spec.t) * Math.tan(th / 2) - ba;
}

// ---------------------------------------------------------------- S5 export
/** Check & Export popup: only from edit with no open draft. */
export function openSheetExport(mode) {
  if (!mode || mode.stage !== 'edit' || mode.draft) return mode;
  return { ...mode, exportOpen: true, hotEdge: null, toast: null };
}
export function closeSheetExport(mode) {
  return mode ? { ...mode, exportOpen: false } : mode;
}
