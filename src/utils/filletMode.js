/**
 * Slice 27 — Fillet-in-mode: enter without edges, pick in-mode, live blend
 * preview, Accept commits makeSweepPath + filletAlongPath.
 *
 * Locked UX: tapping Fillet never soft-fails for empty selection. Edge-pick
 * chip (Tangent / Clear / Accept / Back) owns the session. Accept writes a
 * marked block and Auto-Runs; second Accept replaces the same block. Back
 * exits with no commit. Strategy default stays sweep (#30).
 *
 * Reuses Slice 22/23: makeSweepPath / filletAlongPath / canBuildFilletAlongPath.
 * Does not change Extrude / Revolve / Profile / Loft.
 */

import { composeHelperInsert, FILLET_MODE_BEGIN, FILLET_MODE_END } from './helperPaletteSnippets.js';
import {
  canBuildFilletAlongPath,
  filletWedgeContour,
  resolveFilletStrategy,
  FILLET_SWEEP_DISCONNECTED,
  FILLET_SWEEP_BRANCH,
} from './filletAlongPath.js';
import { assembleSweepPath, buildSweepPathPreview } from './edgeSweepPath.js';
import {
  defaultSweepBlendSize,
  edgeKey,
  pathLengthFromEdges,
  sweepBlendHardMax,
} from './selectEdge.js';

export const FILLET_ENTRY_IDS = new Set(['filletEdges']);

export const FILLET_MODE_EMPTY =
  'Pick edges in Fillet mode, then Accept. Tangent-on chains work for circular rims.';

export const FILLET_MODE_NO_COMMIT =
  'Back exits Fillet mode with no commit.';

export function isFilletEntry(id) {
  return FILLET_ENTRY_IDS.has(id);
}

export function defaultFilletParams(edges = null) {
  const pathLen = pathLengthFromEdges(edges);
  const radius = defaultSweepBlendSize(pathLen);
  return {
    body: 'part',
    strategy: 'sweep',
    radius,
    sphericalCorners: true,
    profile: 'fillet',
    reverse: false,
    edgeScope: 'selected',
  };
}

/**
 * Seed in-mode state. Empty edges are OK — never refuse on enter.
 */
export function enterFilletState(edges = null) {
  return {
    entry: 'filletEdges',
    params: defaultFilletParams(edges),
    radiusTouched: false,
    lastEdges: Array.isArray(edges) && edges.length ? edges.slice() : [],
    enterRefuse: null,
  };
}

export function normalizeFilletParams(raw = {}, edges = null) {
  const seeded = defaultFilletParams(edges);
  const radius = Number(raw.radius);
  return {
    body: raw.body || seeded.body,
    strategy: resolveFilletStrategy(raw.strategy),
    radius: Number.isFinite(radius) && radius > 0 ? radius : seeded.radius,
    sphericalCorners: raw.sphericalCorners !== false,
    profile: raw.profile === 'chamfer' ? 'chamfer' : 'fillet',
    reverse: !!raw.reverse,
    edgeScope: 'selected',
  };
}

export function validateFilletAccept(edges, params = {}) {
  const list = Array.isArray(edges) ? edges : [];
  if (!list.length) {
    return { ok: false, message: FILLET_MODE_EMPTY };
  }
  const n = normalizeFilletParams(params, list);
  if (!(n.radius > 0) || !Number.isFinite(n.radius)) {
    return { ok: false, message: 'Fillet radius must be > 0' };
  }
  if (n.strategy === 'sweep') {
    const gate = canBuildFilletAlongPath(list);
    if (!gate.ok) {
      const msg = gate.message || FILLET_MODE_EMPTY;
      if (/disconnect/i.test(msg)) {
        return { ok: false, message: msg.includes('disconnected') ? msg : FILLET_SWEEP_DISCONNECTED };
      }
      if (/branch/i.test(msg)) return { ok: false, message: FILLET_SWEEP_BRANCH };
      return { ok: false, message: msg };
    }
  }
  return { ok: true, normalized: n };
}

function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function _mul(s, a) {
  return [s * a[0], s * a[1], s * a[2]];
}
function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function _len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function _n(v) {
  const L = _len(v) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

function projectPerp(v, T) {
  if (!v) return null;
  const out = _sub(v, _mul(_dot(v, T), T));
  return _len(out) > 1e-8 ? _n(out) : null;
}

function frameFromNormals(T, n0, n1) {
  let N = projectPerp(n0, T);
  let B = projectPerp(n1, T);
  if (!N && B) N = _n(_cross(B, T));
  if (!B && N) B = _n(_cross(T, N));
  if (!N) {
    const up = Math.abs(T[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    N = _n(_cross(T, up));
  }
  if (!B) B = _n(_cross(T, N));
  if (_dot(B, _cross(T, N)) < 0) B = _mul(-1, B);
  return { N, B };
}

function lookupNormals(edges) {
  const map = new Map();
  for (const e of edges || []) {
    const k = edgeKey(e);
    if (!k) continue;
    map.set(k, { n0: e.n0, n1: e.n1 });
  }
  return map;
}

/**
 * Visible polylines when the selection is disconnected / branched.
 * Loud-fail Accept; do not invent a single path (wrong solid).
 */
export function disconnectedPathPolylines(edges) {
  const list = Array.isArray(edges) ? edges : [];
  const out = [];
  for (const e of list) {
    const va = e?.va;
    const vb = e?.vb;
    if (!Array.isArray(va) || !Array.isArray(vb) || va.length < 3 || vb.length < 3) continue;
    out.push([
      [Number(va[0]), Number(va[1]), Number(va[2])],
      [Number(vb[0]), Number(vb[1]), Number(vb[2])],
    ]);
  }
  return out;
}

function ringsFromFrames(frames, wedge) {
  if (!frames?.length || !wedge?.length) return null;
  return frames.map((fr) => wedge.map(([u, v]) => (
    _add(fr.origin, _add(_mul(u, fr.N), _mul(v, fr.B)))
  )));
}

/**
 * Live blend preview (sweep / filletAlongPath intent).
 * Valid chain → path + swept wedge rings.
 * Disconnected / empty → ok:false, but polylines stay so the path stays visible.
 */
export function buildFilletBlendPreview(edges, params = {}) {
  const list = Array.isArray(edges) ? edges : [];
  const n = normalizeFilletParams(params, list);
  const sweepMax = sweepBlendHardMax(pathLengthFromEdges(list));
  const radius = Math.min(n.radius, sweepMax);
  const base = {
    strategy: n.strategy,
    profile: n.profile,
    reverse: n.reverse,
    radius,
    sweepMax,
    edgeCount: list.length,
  };

  if (!list.length) {
    return {
      ...base,
      ok: false,
      message: FILLET_MODE_EMPTY,
      path: null,
      preview: null,
      rings: null,
      polylines: [],
    };
  }

  const assembled = assembleSweepPath(list, { reverse: n.reverse });
  if (!assembled.ok) {
    return {
      ...base,
      ok: false,
      message: assembled.message,
      code: assembled.code,
      path: null,
      preview: null,
      rings: null,
      polylines: disconnectedPathPolylines(list),
    };
  }

  const preview = buildSweepPathPreview(list, { reverse: n.reverse });
  let wedge = null;
  try {
    wedge = filletWedgeContour(radius, 8);
  } catch {
    wedge = null;
  }

  const normals = lookupNormals(list);
  const pts = assembled.value.points;
  const ordered = assembled.orderedEdges || [];
  const closed = !!assembled.value.closed;
  const frames = [];
  for (let i = 0; i < pts.length; i++) {
    const e = ordered[Math.min(i, Math.max(0, ordered.length - 1))];
    const nr = e ? normals.get(e.key) : null;
    let T;
    if (i < pts.length - 1) T = _n(_sub(pts[i + 1], pts[i]));
    else if (closed) T = _n(_sub(pts[0], pts[i]));
    else T = _n(_sub(pts[i], pts[i - 1]));
    const { N, B } = frameFromNormals(T, nr?.n0, nr?.n1);
    frames.push({ origin: pts[i], T, N, B });
  }

  return {
    ...base,
    ok: true,
    path: assembled.value,
    preview,
    wedge,
    frames,
    rings: ringsFromFrames(frames, wedge),
    polylines: preview?.points ? [preview.points] : [],
    closed,
    length: assembled.value.length,
  };
}

export function hasFilletModeBlock(buffer) {
  const t = String(buffer || '');
  return t.includes(FILLET_MODE_BEGIN) && t.includes(FILLET_MODE_END);
}

export function filletModeOwnedRegion(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(FILLET_MODE_BEGIN);
  if (i < 0) return '';
  const j = text.indexOf(FILLET_MODE_END, i);
  if (j < 0) return '';
  return text.slice(i, j + FILLET_MODE_END.length);
}

export function stripFilletModeBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(FILLET_MODE_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(FILLET_MODE_END, i);
  if (j < 0) return text;
  const after = text.slice(j + FILLET_MODE_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

function markersUnbalanced(text, begin, end) {
  const i = text.lastIndexOf(begin);
  const j = text.indexOf(end, i < 0 ? 0 : i);
  if (text.includes(begin) && i < 0) return true;
  if (i >= 0 && j < 0) return true;
  if (i < 0 && text.includes(end)) return true;
  return false;
}

export function countFilletAlongPath(buffer) {
  const m = String(buffer || '').match(/filletAlongPath\s*\(/g);
  return m ? m.length : 0;
}

export function countMakeSweepPath(buffer) {
  const m = String(buffer || '').match(/makeSweepPath\s*\(/g);
  return m ? m.length : 0;
}

/**
 * Accept → insert or replace in-mode Fillet (makeSweepPath + filletAlongPath).
 * Second Accept updates the same marked block (no duplicate stack).
 *
 * @returns {{ ok: true, buffer: string, run: true } | { ok: false, message: string }}
 */
export function composeFilletCommit(buffer, { edges = null, params = {} } = {}) {
  const gate = validateFilletAccept(edges, params);
  if (!gate.ok) return gate;

  const text = String(buffer || '');
  if (markersUnbalanced(text, FILLET_MODE_BEGIN, FILLET_MODE_END)) {
    return {
      ok: false,
      message: 'composeFilletCommit: unbalanced fillet markers — refusing silent no-op.',
    };
  }

  const stripped = stripFilletModeBlock(buffer);
  const composed = composeHelperInsert(
    stripped,
    'filletEdges',
    null,
    { ...gate.normalized, _filletMode: true },
    null,
    edges,
  );
  if (typeof composed !== 'string') {
    return {
      ok: false,
      message: gate.message || FILLET_MODE_EMPTY,
    };
  }
  const owned = filletModeOwnedRegion(composed);
  if (gate.normalized.strategy === 'sweep') {
    if (!/makeSweepPath\s*\(/.test(owned)) {
      return {
        ok: false,
        message: 'composeFilletCommit: makeSweepPath missing — refusing silent no-op.',
      };
    }
    if (!/filletAlongPath\s*\(/.test(owned)) {
      return {
        ok: false,
        message: 'composeFilletCommit: filletAlongPath missing — refusing silent no-op.',
      };
    }
  } else if (!/filletEdges\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeFilletCommit: filletEdges missing — refusing silent no-op.',
    };
  }
  if (!hasFilletModeBlock(composed)) {
    return {
      ok: false,
      message: 'composeFilletCommit: fillet-mode markers missing — refusing unscoped insert.',
    };
  }
  return { ok: true, buffer: composed, run: true };
}
