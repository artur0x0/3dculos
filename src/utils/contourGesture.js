/**
 * Dimension and Arc gestures on a contour.
 *
 * Neither gesture is a profile tool. Selecting one does not reset the
 * points. The first selection promotes a circle, rectangle, polygon, or
 * polyline into a contour, once. Cancel writes nothing and leaves that
 * promotion in the session.
 */

import {
  contourFromCircle,
  contourFromPolygon,
  contourFromPolyline,
  contourFromRectangle,
  roundContourCorner,
  solveContour,
} from './contourSolve.js';
import { stickyPickToggle } from './stickyPick.js';

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PARALLEL_SPLIT_DEG = 15;

export function specFromSolved(solved) {
  return {
    points: (solved.points || []).map((p) => ({ id: p.id, at: p.at.slice() })),
    lines: (solved.lines || []).map((l) => ({ id: l.id, a: l.a, b: l.b })),
    arcs: (solved.arcs || []).map((a) => ({ ...a })),
    dimensions: (solved.dimensions || []).map((d) => ({
      ...d,
      items: d.items ? [...d.items] : undefined,
    })),
    constraints: (solved.constraints || []).map((c) => ({
      ...c,
      items: c.items ? [...c.items] : undefined,
    })),
  };
}

export function contourFromTool(tool, params = {}) {
  const p = params || {};
  if (p.contour) return p.contour;
  if (tool === 'polyline') return contourFromPolyline(p.points || []);
  if (tool === 'rectangle') return contourFromRectangle(p.width, p.height, p.centered !== false);
  if (tool === 'polygon') return contourFromPolygon(p.polygonPreset || 'hexagon', p.radius);
  return contourFromCircle(p.radius, p.segments ?? 64);
}

export function promoteContourState(state) {
  if (!state) return state;
  if (state.params?.contour) return state;
  let contour;
  try {
    contour = contourFromTool(state.tool, state.params);
  } catch (err) {
    return { ...state, gestureNote: err.message || String(err) };
  }
  return {
    ...state,
    params: { ...(state.params || {}), contour },
    gestureNote: null,
  };
}

export function selectContourGesture(state, gesture) {
  if (!state || state.entry === 'workplane') return state;
  if (gesture !== 'arc' && gesture !== 'dimension') return state;
  if (state.gesture === gesture) {
    return { ...state, gesture: null, picks: [], tagId: null, gestureNote: null };
  }
  const armed = {
    ...state,
    gesture,
    picks: [],
    tagId: null,
    gestureNote: null,
  };
  return promoteContourState(armed);
}

export function toggleContourPick(state, pick) {
  if (!state?.gesture) return state;
  const max = state.gesture === 'arc' ? 3 : 2;
  let item = pick;
  if (state.gesture === 'arc' && pick?.kind !== 'line') {
    return { ...state, gestureNote: 'An arc rounds lines. Tap a segment.' };
  }
  const picks = stickyPickToggle(state.picks, item, max);
  return { ...state, picks, tagId: null, gestureNote: null };
}

function pointAt(model, id) {
  return (model.points || []).find((p) => p.id === id)?.at || null;
}

function lineEnds(model, id) {
  const line = (model.lines || []).find((l) => l.id === id);
  if (!line) return null;
  const a = pointAt(model, line.a);
  const b = pointAt(model, line.b);
  if (!a || !b) return null;
  return { line, a, b, d: [b[0] - a[0], b[1] - a[1]] };
}

function unitDot(d1, d2) {
  const L1 = Math.hypot(d1[0], d1[1]);
  const L2 = Math.hypot(d2[0], d2[1]);
  if (L1 < 1e-12 || L2 < 1e-12) return 1;
  return (d1[0] * d2[0] + d1[1] * d2[1]) / (L1 * L2);
}

export function linesFromParallelDeg(model, idA, idB) {
  const A = lineEnds(model, idA);
  const B = lineEnds(model, idB);
  if (!A || !B) return 90;
  const dot = Math.min(1, Math.abs(unitDot(A.d, B.d)));
  return Math.acos(dot) * 180 / Math.PI;
}

function signedPointLine(p, a, d) {
  const L = Math.hypot(d[0], d[1]);
  if (L < 1e-12) return 0;
  return ((p[0] - a[0]) * (-d[1]) + (p[1] - a[1]) * d[0]) / L;
}

function angleOf(model, idA, idB) {
  const A = lineEnds(model, idA);
  const B = lineEnds(model, idB);
  if (!A || !B) return { value: 90, sense: 1 };
  const cross = A.d[0] * B.d[1] - A.d[1] * B.d[0];
  const dot = A.d[0] * B.d[0] + A.d[1] * B.d[1];
  const sense = cross >= 0 ? 1 : -1;
  const value = Math.atan2(sense * cross, dot) * 180 / Math.PI;
  return { value, sense };
}

function separationOf(model, idA, idB) {
  const A = lineEnds(model, idA);
  const B = lineEnds(model, idB);
  if (!A || !B) return { value: 0, side: 1 };
  const value = signedPointLine(A.a, B.a, B.d);
  return { value, side: value >= 0 ? 1 : -1 };
}

function offsetOf(model, pointId, lineId) {
  const p = pointAt(model, pointId);
  const line = lineEnds(model, lineId);
  if (!p || !line) return { value: 0, side: 1 };
  const value = signedPointLine(p, line.a, line.d);
  return { value, side: value >= 0 ? 1 : -1 };
}

/**
 * What a dimension pick offers. Two lines more than 15° from parallel
 * suggest an angle. Otherwise they suggest a distance. Both stay available.
 */
export function suggestContourDimension(model, picks) {
  const list = Array.isArray(picks) ? picks : [];
  const empty = { ok: false, kind: null, kinds: [], value: 0, side: 1, sense: 1, note: 'Tap a line, an arc, or a point and a line.' };
  if (!model) return { ...empty, note: 'Draw a contour first.' };
  if (list.length === 1 && list[0].kind === 'line') {
    const ends = lineEnds(model, list[0].id);
    const value = ends ? Math.hypot(ends.d[0], ends.d[1]) : 0;
    return { ok: value > 0, kind: 'length', kinds: ['length'], value, side: 1, sense: 1, note: value > 0 ? '' : 'That line has no length.' };
  }
  if (list.length === 1 && list[0].kind === 'arc') {
    const arc = (model.arcs || []).find((a) => a.id === list[0].id);
    const value = Number(arc?.radius) || 0;
    return { ok: value > 0, kind: 'radius', kinds: ['radius'], value, side: 1, sense: 1, note: '' };
  }
  if (list.length === 1 && list[0].kind === 'point') {
    return { ...empty, note: 'Tap a line as well to offset the point.' };
  }
  if (list.length === 2 && list.every((p) => p.kind === 'line')) {
    const fromParallel = linesFromParallelDeg(model, list[0].id, list[1].id);
    const angle = angleOf(model, list[0].id, list[1].id);
    const gap = separationOf(model, list[0].id, list[1].id);
    if (fromParallel > PARALLEL_SPLIT_DEG) {
      return { ok: true, kind: 'angle', kinds: ['angle', 'distance'], value: angle.value, side: gap.side, sense: angle.sense, note: '' };
    }
    return { ok: true, kind: 'distance', kinds: ['distance', 'angle'], value: gap.value, side: gap.side, sense: angle.sense, note: '' };
  }
  if (list.length === 2) {
    const point = list.find((p) => p.kind === 'point');
    const line = list.find((p) => p.kind === 'line');
    if (point && line) {
      const gap = offsetOf(model, point.id, line.id);
      return { ok: true, kind: 'offset', kinds: ['offset'], value: gap.value, side: gap.side, sense: 1, note: '' };
    }
  }
  if (list.length === 0) return empty;
  return { ...empty, note: 'That pair is not a length, angle, distance, offset, or radius.' };
}

export function prefillForKind(model, picks, kind) {
  const suggested = suggestContourDimension(model, picks);
  if (kind === 'angle') {
    if (picks?.length === 2 && picks.every((p) => p.kind === 'line')) {
      const angle = angleOf(model, picks[0].id, picks[1].id);
      return { value: angle.value, side: suggested.side, sense: angle.sense };
    }
  }
  if (kind === 'distance' && picks?.length === 2 && picks.every((p) => p.kind === 'line')) {
    const gap = separationOf(model, picks[0].id, picks[1].id);
    return { value: gap.value, side: gap.side, sense: suggested.sense };
  }
  if (kind === suggested.kind) return { value: suggested.value, side: suggested.side, sense: suggested.sense };
  return { value: suggested.value, side: suggested.side, sense: suggested.sense };
}

export function validateDimensionName(name, model, ignoreId = null) {
  const text = String(name || '').trim();
  if (!text) return { ok: true, name: '' };
  if (!NAME_RE.test(text)) {
    return { ok: false, message: 'A dimension name is one word: a letter, then letters or digits.' };
  }
  const taken = (model?.dimensions || []).some((d) => d.name === text && d.id !== ignoreId);
  if (taken) return { ok: false, message: `“${text}” is already a dimension on this contour.` };
  return { ok: true, name: text };
}

function nextDimId(model) {
  let max = -1;
  for (const dim of model.dimensions || []) {
    const m = /^d(\d+)$/.exec(dim.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `d${max + 1}`;
}

export function buildDimension(model, picks, draft) {
  const kind = draft?.kind;
  const value = Number(draft?.valueMm);
  if (!Number.isFinite(value)) return { ok: false, message: 'Enter a number.' };
  const nameCheck = validateDimensionName(draft?.name, model);
  if (!nameCheck.ok) return nameCheck;
  const list = picks || [];
  const dim = { id: nextDimId(model), kind, value };
  if (nameCheck.name) dim.name = nameCheck.name;
  if (kind === 'length' && list.length === 1 && list[0].kind === 'line') {
    if (!(value > 0)) return { ok: false, message: 'Length must be greater than 0.' };
    dim.edge = list[0].id;
  } else if (kind === 'radius' && list.length === 1 && list[0].kind === 'arc') {
    if (!(value > 0)) return { ok: false, message: 'Radius must be greater than 0.' };
    dim.arc = list[0].id;
  } else if ((kind === 'angle' || kind === 'distance') && list.length === 2 && list.every((p) => p.kind === 'line')) {
    dim.a = list[0].id;
    dim.b = list[1].id;
    if (kind === 'angle') dim.sense = draft.sense < 0 ? -1 : 1;
    else dim.side = draft.side < 0 ? -1 : 1;
  } else if (kind === 'offset') {
    const point = list.find((p) => p.kind === 'point');
    const line = list.find((p) => p.kind === 'line');
    if (!point || !line) return { ok: false, message: 'Offset needs a point and a line.' };
    dim.point = point.id;
    dim.edge = line.id;
    dim.side = draft.side < 0 ? -1 : 1;
  } else {
    return { ok: false, message: 'That dimension does not match the pick.' };
  }
  return { ok: true, dimension: dim };
}

function storeSolved(state, model) {
  let solved;
  try {
    solved = solveContour(model);
  } catch (err) {
    return { state, error: err.message || String(err) };
  }
  const contour = specFromSolved(solved);
  const params = { ...(state.params || {}), contour };
  const next = { ...state, params, picks: [], gestureNote: null };
  if (solved.status === 'conflict') next.gestureNote = 'Conflict — the contour kept the closest shape.';
  else if (solved.repeated?.length) next.gestureNote = 'Repeated.';
  return { state: next, error: null, solved };
}

export function commitDimension(state, draft) {
  const ready = state?.params?.contour ? state : promoteContourState(state);
  if (!ready?.params?.contour) {
    return { state: ready, error: ready?.gestureNote || 'Draw a contour first.' };
  }
  const built = buildDimension(ready.params.contour, ready.picks, draft);
  if (!built.ok) return { state: ready, error: built.message };
  const model = {
    ...ready.params.contour,
    dimensions: [...(ready.params.contour.dimensions || []), built.dimension],
  };
  return storeSolved(ready, model);
}

export function deleteContourDimension(state, id) {
  const contour = state?.params?.contour;
  if (!contour) return { state, error: 'No contour.' };
  const dimensions = (contour.dimensions || []).filter((d) => d.id !== id);
  if (dimensions.length === (contour.dimensions || []).length) {
    return { state, error: 'That dimension is already gone.' };
  }
  const result = storeSolved(state, { ...contour, dimensions });
  if (result.state) result.state = { ...result.state, tagId: null };
  return result;
}

function fitRadius(model, ids) {
  try {
    roundContourCorner(model, ids, 1);
  } catch {
    /* probed below */
  }
  const lines = ids.map((id) => (model.lines || []).find((l) => l.id === id)).filter(Boolean);
  if (lines.length < 2) return 2;
  const lens = lines.map((line) => {
    const ends = lineEnds(model, line.id);
    return ends ? Math.hypot(ends.d[0], ends.d[1]) : 0;
  });
  const shortest = Math.min(...lens.filter((n) => n > 0));
  if (!Number.isFinite(shortest)) return 2;
  return Math.max(0.5, Math.round(shortest * 0.2 * 10) / 10);
}

export function suggestContourArc(model, picks) {
  const lines = (model?.lines || []);
  if (!lines.length) {
    return { ok: false, radius: 2, note: 'A circle has no corner to round. Draw a polyline.' };
  }
  const ids = (picks || []).filter((p) => p.kind === 'line').map((p) => p.id);
  if (ids.length < 2) {
    return { ok: false, radius: fitRadius(model, lines.slice(0, 2).map((l) => l.id)), note: 'Tap two or three adjacent segments.' };
  }
  if (ids.length > 3) return { ok: false, radius: 2, note: 'An arc rounds two or three segments.' };
  const radius = fitRadius(model, ids);
  try {
    roundContourCorner(model, ids, radius);
    return { ok: true, radius, note: '' };
  } catch (err) {
    return { ok: false, radius, note: err.message || String(err) };
  }
}

export function commitArc(state, radiusMm) {
  const ready = state?.params?.contour ? state : promoteContourState(state);
  if (!ready?.params?.contour) {
    return { state: ready, error: ready?.gestureNote || 'Draw a polyline first.' };
  }
  const ids = (ready.picks || []).filter((p) => p.kind === 'line').map((p) => p.id);
  const radius = Number(radiusMm);
  if (!(radius > 0)) return { state: ready, error: 'Radius must be greater than 0.' };
  let rounded;
  try {
    rounded = roundContourCorner(ready.params.contour, ids, radius);
  } catch (err) {
    return { state: ready, error: err.message || String(err) };
  }
  const result = storeSolved(ready, rounded);
  return result;
}

export const DIMENSION_LABELS = {
  length: 'Length',
  angle: 'Angle',
  distance: 'Distance',
  offset: 'Offset',
  radius: 'Radius',
};
