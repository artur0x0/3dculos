/**
 * Contour status colours and the conflict / repeated note.
 *
 * The solver stays free of display units and of these colours. Under is
 * gray-400, full is the idle ghost zinc, conflict is red-400. An unpromoted
 * polyline, circle, rectangle, or polygon stays the draft cyan; that colour
 * is not a status.
 */

import { analyzeContour } from './contourSolve.js';

export const CONTOUR_STATUS_COLOR = {
  under: 0x9ca3af,
  full: 0x3f3f46,
  conflict: 0xf87171,
};

/** Draft wire before the contour painter owns it. */
export const CONTOUR_DRAFT_COLOR = 0x22d3ee;

/** Selected saved ghost. Status colour is for every ghost that is not the pick. */
export const CONTOUR_SELECTED_COLOR = 0xff9900;

/** A dimension pick stays this colour until Add or X. Amber, same as a hovered dot. */
export const CONTOUR_PICK_COLOR = 0xfbbf24;

/**
 * Paint the current dimension picks over status colour. A picked line also
 * lights its two endpoints, so both dots stay visible with the edge.
 */
export function highlightContourPaint(paint, model, picks) {
  if (!paint) return paint;
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) return paint;
  const points = new Set();
  const marked = new Set();
  for (const pick of list) {
    if (!pick?.id) continue;
    if (pick.kind === 'point') points.add(pick.id);
    else if (pick.kind === 'line') {
      marked.add(pick.id);
      const line = (model?.lines || []).find((l) => l.id === pick.id);
      if (line) {
        points.add(line.a);
        points.add(line.b);
      }
    } else if (pick.kind === 'arc') marked.add(pick.id);
  }
  return {
    ...paint,
    pointColors: (paint.pointIds || []).map((id, i) => (
      points.has(id) ? CONTOUR_PICK_COLOR : paint.pointColors[i]
    )),
    segments: (paint.segments || []).map((seg) => (
      marked.has(seg.id) ? { ...seg, color: CONTOUR_PICK_COLOR, picked: true } : seg
    )),
  };
}

export function contourEntityColor(status) {
  return CONTOUR_STATUS_COLOR[status] || CONTOUR_STATUS_COLOR.under;
}

function itemRefs(item) {
  const refs = [];
  for (const key of ['edge', 'arc', 'point', 'a', 'b']) {
    if (item?.[key]) refs.push(item[key]);
  }
  for (const ref of item?.items || []) {
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function itemLabel(model, id) {
  const dim = (model.dimensions || []).find((d) => d.id === id);
  const con = (model.constraints || []).find((c) => c.id === id);
  const item = dim || con;
  if (!item) return id;
  if (item.name) return item.name;
  const kind = String(item.kind || 'item');
  const refs = itemRefs(item);
  if (!refs.length) return `${kind} ${id}`;
  return `${kind} ${refs.join(' · ')}`;
}

/**
 * Conflict names the primary id (and a short label). Other sufficient ids
 * follow the plan's "Also conflicts with" sentence. Repeated is the word
 * Repeated. and is not a conflict.
 *
 * @returns {{ text: string, conflict: boolean, repeated: boolean, primaryId: string|null }}
 */
export function contourStatusNote(specOrSolved) {
  const empty = { text: '', conflict: false, repeated: false, primaryId: null };
  if (!specOrSolved) return empty;
  let solved = specOrSolved;
  if (!solved.status) {
    try {
      solved = analyzeContour(specOrSolved);
    } catch {
      return empty;
    }
  }
  if (solved.status === 'conflict' && solved.conflict?.primary) {
    const primaryId = solved.conflict.primary;
    const label = itemLabel(solved, primaryId);
    const others = (solved.conflict.ids || []).filter((id) => id !== primaryId);
    let text = label === primaryId
      ? `Conflict — ${primaryId}.`
      : `Conflict — ${primaryId} ${label}.`;
    if (others.length) text += ` Also conflicts with ${others.join(', ')}.`;
    return { text, conflict: true, repeated: false, primaryId };
  }
  if (solved.repeated?.length) {
    return { text: 'Repeated.', conflict: false, repeated: true, primaryId: null };
  }
  return empty;
}

function arcUvs(arc, at) {
  const c = at[arc.center];
  const r = Number(arc.radius);
  if (!c || !Number.isFinite(r)) return [];
  if (arc.full) {
    const n = Math.max(12, Math.min(64, Number(arc.segments) || 48));
    const uvs = [];
    for (let i = 0; i <= n; i += 1) {
      const t = (i / n) * Math.PI * 2;
      uvs.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
    }
    return uvs;
  }
  const start = at[arc.start];
  const end = at[arc.end];
  if (!start || !end) return [];
  const a0 = Math.atan2(start[1] - c[1], start[0] - c[0]);
  const a1 = Math.atan2(end[1] - c[1], end[0] - c[0]);
  let delta = arc.sweep === 'cw' ? a0 - a1 : a1 - a0;
  if (delta <= 1e-12) delta += Math.PI * 2;
  const n = 16;
  const uvs = [[start[0], start[1]]];
  for (let i = 1; i < n; i += 1) {
    const t = a0 + (arc.sweep === 'cw' ? -1 : 1) * delta * (i / n);
    uvs.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  uvs.push([end[0], end[1]]);
  return uvs;
}

/**
 * Per-entity paint for a promoted contour. Null when there is nothing to paint.
 * @returns {{ status: string, dof: number, pointIds: string[], pointColors: number[], segments: { id: string, status: string, color: number, uvs: number[][] }[] } | null}
 */
export function contourPaintModel(spec) {
  if (!spec?.points?.length) return null;
  let solved;
  try {
    solved = analyzeContour(spec);
  } catch {
    return null;
  }
  const at = {};
  for (const point of solved.points) at[point.id] = point.at;
  const entities = solved.entities || { points: {}, lines: {}, arcs: {} };
  const pointIds = solved.points.map((p) => p.id);
  const pointColors = solved.points.map((p) => contourEntityColor(entities.points?.[p.id] || 'under'));
  const segments = [];
  for (const line of solved.lines || []) {
    const a = at[line.a];
    const b = at[line.b];
    if (!a || !b) continue;
    const status = entities.lines?.[line.id] || 'under';
    segments.push({
      id: line.id,
      kind: 'line',
      status,
      color: contourEntityColor(status),
      uvs: [a.slice(), b.slice()],
    });
  }
  for (const arc of solved.arcs || []) {
    const uvs = arcUvs(arc, at);
    if (uvs.length < 2) continue;
    const status = entities.arcs?.[arc.id] || 'under';
    segments.push({
      id: arc.id,
      kind: 'arc',
      status,
      color: contourEntityColor(status),
      uvs,
    });
  }
  return {
    status: solved.status,
    dof: solved.dof,
    pointIds,
    pointColors,
    segments,
  };
}

/** Saved-ghost status, or null when the entry is not a solved contour. */
export function savedContourStatus(contour) {
  const spec = contour?.params?.contour;
  if (!spec) return null;
  try {
    return analyzeContour(spec).status;
  } catch {
    return null;
  }
}
