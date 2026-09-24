/**
 * Slice 27 — Fillet-in-mode: enter without edges, pick in-mode, live blend
 * preview, Accept commits makeSweepPath + filletAlongPath.
 *
 * Locked UX: tapping Fillet never soft-fails for empty selection. Edge-pick
 * chip (Tangent / Clear / Accept / Back / X) owns the session. Accept writes
 * a marked block, Auto-Runs, and exits. A later Fillet on a different sharp
 * edge appends another block (commitMode 'append') so edge() runs on the
 * already-filleted solid. Replace stays the default for an in-place update
 * of the same block. Back and X exit with no commit. Strategy default stays
 * sweep (#30).
 *
 * Reuses Slice 22/23: makeSweepPath / filletAlongPath / canBuildFilletAlongPath.
 * Does not change Extrude / Revolve / Profile / Loft.
 */

import { composeHelperInsert, FILLET_MODE_BEGIN, FILLET_MODE_END } from './helperPaletteSnippets.js';
import {
  canBuildFilletAlongPath,
  filletWedgeContour,
  dihedralFilletContour,
  dihedralChamferContour,
  orientFilletFrame,
  resolveFilletStrategy,
  FILLET_SWEEP_DISCONNECTED,
  FILLET_SWEEP_BRANCH,
  FILLET_ARC_SEGMENTS,
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

export const FILLET_BLEND_ONLY =
  'Those edges are an existing blend. Pick a sharp edge — re-filleting a blend is not supported.';

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
  const strategy = resolveFilletStrategy(raw.strategy);
  let r = Number.isFinite(radius) && radius > 0 ? radius : seeded.radius;
  // Sweep regime mirrors the live preview (buildFilletBlendPreview) exactly:
  // clamp the committed radius to the path-length hard max so Accept writes the
  // same radius the blend preview painted — no preview≠commit divergence, and
  // the worker's loud "removed X vs expected" net never fires from the chip.
  // Planar keeps its own 0.45·L guard (different regime) — clamp only sweep.
  if (strategy === 'sweep') {
    r = Math.min(r, sweepBlendHardMax(pathLengthFromEdges(edges)));
  }
  return {
    body: raw.body || seeded.body,
    strategy,
    radius: r,
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
  if (list.every((edge) => edge && edge.blendStrip === true)) {
    return { ok: false, message: FILLET_BLEND_ONLY };
  }
  const n = normalizeFilletParams(params, list);
  // nit: dropped the `!(n.radius > 0)` arm here — normalizeFilletParams is the
  // single normaliser and already guarantees a finite radius > 0 (bad input seeds
  // the default; sweep additionally clamps to sweepBlendHardMax). 0/3076 probes
  // ever reached the old arm, so it was a pin on unreachable code. No behaviour
  // change; the empty-selection and connectivity gates above/below are the live ones.
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

function inFaceFromNormal(n, T, nOther) {
  if (!n || !T) return null;
  const f = _cross(n, T);
  if (_len(f) < 1e-8) return null;
  let out = _n(f);
  if (nOther && _dot(out, _mul(-1, nOther)) < 0) out = _mul(-1, out);
  return out;
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

function ringsFromFrames(frames) {
  if (!frames?.length) return null;
  const rings = [];
  for (const fr of frames) {
    const wedge = fr.wedge;
    if (!wedge?.length) return null;
    rings.push(wedge.map(([u, v]) => (
      _add(fr.origin, _add(_mul(u, fr.N), _mul(v, fr.B)))
    )));
  }
  return rings;
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
    wedge = n.profile === 'chamfer'
      ? dihedralChamferContour(radius, Math.PI / 2)
      : filletWedgeContour(radius, FILLET_ARC_SEGMENTS);
  } catch {
    wedge = null;
  }

  const normals = lookupNormals(list);
  const pts = assembled.value.points;
  const ordered = assembled.orderedEdges || [];
  const closed = !!assembled.value.closed;
  const frames = [];
  let prevN = null;
  for (let i = 0; i < pts.length; i++) {
    const e = ordered[Math.min(i, Math.max(0, ordered.length - 1))];
    const nr = e ? normals.get(e.key) : null;
    let T;
    if (i < pts.length - 1) T = _n(_sub(pts[i + 1], pts[i]));
    else if (closed) T = _n(_sub(pts[0], pts[i]));
    else T = _n(_sub(pts[i], pts[i - 1]));
    const f0 = inFaceFromNormal(nr?.n0, T, nr?.n1);
    const f1 = inFaceFromNormal(nr?.n1, T, nr?.n0);
    let N;
    let B;
    let theta = Math.PI / 2;
    let frameWedge = wedge;
    if (f0 && f1) {
      const fr = orientFilletFrame(T, f0, f1, prevN);
      N = fr.N;
      B = fr.B;
      theta = fr.theta;
      prevN = N;
      try {
        frameWedge = n.profile === 'chamfer'
          ? dihedralChamferContour(radius, theta)
          : dihedralFilletContour(radius, theta, FILLET_ARC_SEGMENTS);
      } catch {
        frameWedge = wedge;
      }
    } else {
      const fb = frameFromNormals(T, nr?.n0, nr?.n1);
      N = fb.N;
      B = fb.B;
    }
    frames.push({ origin: pts[i], T, N, B, theta, wedge: frameWedge });
  }

  return {
    ...base,
    ok: true,
    path: assembled.value,
    preview,
    wedge: frames[0]?.wedge || wedge,
    frames,
    rings: ringsFromFrames(frames),
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
 * Accept → insert, replace, or append in-mode Fillet (makeSweepPath + filletAlongPath).
 * commitMode 'replace' (default) updates the last marked block.
 * commitMode 'append' keeps that block and adds another, so a second sharp
 * edge is filleted on the solid the first block already produced.
 *
 * @returns {{ ok: true, buffer: string, run: true } | { ok: false, message: string }}
 */
export function composeFilletCommit(buffer, { edges = null, params = {}, commitMode = 'replace' } = {}) {
  const gate = validateFilletAccept(edges, params);
  if (!gate.ok) return gate;

  const text = String(buffer || '');
  if (markersUnbalanced(text, FILLET_MODE_BEGIN, FILLET_MODE_END)) {
    return {
      ok: false,
      message: 'composeFilletCommit: unbalanced fillet markers — refusing silent no-op.',
    };
  }

  const base = commitMode === 'append' ? text : stripFilletModeBlock(text);
  const composed = composeHelperInsert(
    base,
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
