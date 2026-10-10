/**
 * Fillet and chamfer size from the adjacent edge, not from characteristic length.
 *
 * Among edges that share a vertex with the pick and are not collinear with it,
 * take the one closest to perpendicular. Ties take the shorter edge. A chain
 * uses the shortest of those lengths. Default is 0.10 × that length. The
 * slider max is 0.20 × that length, also capped by sweepBlendHardMax.
 * No neighbor: 0.10 × the picked edge, then 2 mm.
 */
import { effectiveBlendEdgeLength, pathLengthFromEdges, sweepBlendHardMax } from './selectEdge.js';

export const BLEND_DEFAULT_MIN_MM = 0.1;
const COLLINEAR = 0.999;
const VERTEX_MM = 0.05;

function edgeLength(edge) {
  const n = Number(edge?.length);
  if (Number.isFinite(n) && n > 0) return n;
  if (Array.isArray(edge?.va) && Array.isArray(edge?.vb)) {
    return Math.hypot(
      edge.vb[0] - edge.va[0],
      edge.vb[1] - edge.va[1],
      edge.vb[2] - edge.va[2],
    );
  }
  return 0;
}

function edgeDirection(edge) {
  const tangent = edge?.tangent;
  if (Array.isArray(tangent) && tangent.length >= 3) {
    const len = Math.hypot(tangent[0], tangent[1], tangent[2]);
    if (len > 1e-12) return [tangent[0] / len, tangent[1] / len, tangent[2] / len];
  }
  if (!Array.isArray(edge?.va) || !Array.isArray(edge?.vb)) return null;
  const d = [
    edge.vb[0] - edge.va[0],
    edge.vb[1] - edge.va[1],
    edge.vb[2] - edge.va[2],
  ];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-12) return null;
  return [d[0] / len, d[1] / len, d[2] / len];
}

function sameEdge(a, b) {
  if (a === b) return true;
  if (a?.key != null && b?.key != null && a.key === b.key) {
    return String(a.partId || '') === String(b.partId || '');
  }
  return false;
}

function nearPoint(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= VERTEX_MM;
}

function sharesVertex(a, b) {
  const samePart = String(a?.partId || '') === String(b?.partId || '');
  if (samePart && Number.isInteger(a?.a) && Number.isInteger(a?.b) && Number.isInteger(b?.a) && Number.isInteger(b?.b)) {
    if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) return true;
  }
  if (!Array.isArray(a?.va) || !Array.isArray(a?.vb) || !Array.isArray(b?.va) || !Array.isArray(b?.vb)) {
    return false;
  }
  return nearPoint(a.va, b.va) || nearPoint(a.va, b.vb) || nearPoint(a.vb, b.va) || nearPoint(a.vb, b.vb);
}

/**
 * Shortest perpendicular-neighbor length across the picked edges, or null.
 * @param {object[]|null} picked
 * @param {object[]|null} [neighbors] the part's feature edges; defaults to the picks
 */
export function adjacentPerpendicularLength(picked, neighbors) {
  const picks = Array.isArray(picked) ? picked.filter(Boolean) : [];
  const pool = Array.isArray(neighbors) && neighbors.length ? neighbors : picks;
  let best = null;
  for (const pick of picks) {
    const dir = edgeDirection(pick);
    if (!dir) continue;
    let closest = Infinity;
    const lengths = [];
    for (const other of pool) {
      if (!other || sameEdge(pick, other) || !sharesVertex(pick, other)) continue;
      const otherDir = edgeDirection(other);
      if (!otherDir) continue;
      const dot = Math.abs(dir[0] * otherDir[0] + dir[1] * otherDir[1] + dir[2] * otherDir[2]);
      if (dot >= COLLINEAR) continue;
      const len = edgeLength(other);
      if (!(len > 0)) continue;
      if (dot < closest - 1e-6) {
        closest = dot;
        lengths.length = 0;
        lengths.push(len);
      } else if (Math.abs(dot - closest) <= 1e-6) {
        lengths.push(len);
      }
    }
    if (!lengths.length) continue;
    const shortest = Math.min(...lengths);
    best = best == null ? shortest : Math.min(best, shortest);
  }
  return best;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Default and slider max for a fillet or chamfer.
 * @returns {{ basisMm: number|null, defaultMm: number, maxMm: number, minMm: number }}
 */
export function adjacentBlendSize(picked, neighbors) {
  const kernel = sweepBlendHardMax(pathLengthFromEdges(Array.isArray(picked) ? picked : []));
  let basis = adjacentPerpendicularLength(picked, neighbors);
  if (!(basis > 0)) basis = effectiveBlendEdgeLength(picked);
  if (!(basis > 0)) {
    const maxMm = kernel;
    return {
      basisMm: null,
      defaultMm: Math.min(2, maxMm),
      maxMm,
      minMm: Math.min(BLEND_DEFAULT_MIN_MM, maxMm),
    };
  }
  const maxMm = Math.min(0.2 * basis, kernel);
  const minMm = Math.min(BLEND_DEFAULT_MIN_MM, maxMm);
  let defaultMm = 0.1 * basis;
  if (defaultMm < minMm) defaultMm = minMm;
  if (defaultMm > maxMm) defaultMm = maxMm;
  return {
    basisMm: basis,
    defaultMm: round2(defaultMm),
    maxMm: round2(Math.max(maxMm, minMm)),
    minMm: round2(minMm),
  };
}
