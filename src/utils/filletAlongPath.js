/**
 * Slice 23 — Fillet via swept cross-section.
 *
 * Pure helpers shared by palette soft-fail, goldens, and docs.
 * Script-facing filletAlongPath lives in sandboxWorker (sweep + boolean subtract).
 *
 * Cutter profile (fillet): first-quadrant wedge = corner square minus quarter-disk
 * centered at (r,r) — the material removed by a 90° external fillet. Chamfer:
 * triangle (0,0)-(c,0)-(0,c).
 *
 * Does NOT ship extrude/revolve/loft — wait for Product brief.
 */

import { assembleSweepPath } from './edgeSweepPath.js';

export const FILLET_SWEEP_EMPTY =
  'Select edges first (Edge pick mode), then Fillet with Strategy=sweep. Tangent-on chains work for circular rims.';

export const FILLET_SWEEP_DISCONNECTED =
  'Selected edges are disconnected — sweep fillet needs a single contiguous chain or loop (use Tangent for circular rims).';

export const FILLET_SWEEP_BRANCH =
  'Selected edges branch (junction) — sweep fillet needs a simple open chain or closed loop, not a Y/T junction.';

/**
 * Fillet cutter wedge in UV (u≥0, v≥0): origin → (r,0) → arc (center (r,r)) → (0,r).
 * Area = r²(1 − π/4). Opposite of a quarter-disk pie.
 * @param {number} radius
 * @param {number} [arcSegments=12]
 * @returns {number[][]} closed polyline (first ≠ last)
 */
export function filletWedgeContour(radius, arcSegments = 12) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error('filletWedgeContour: radius must be > 0');
  }
  const seg = Math.max(2, Math.round(Number(arcSegments) || 12));
  const pts = [[0, 0], [r, 0]];
  for (let i = 1; i <= seg; i++) {
    const t = (i / seg) * (Math.PI / 2);
    // Arc from (r,0) → (0,r) with center (r,r), short way near origin.
    pts.push([r - r * Math.sin(t), r - r * Math.cos(t)]);
  }
  return pts;
}

/**
 * Chamfer triangle cutter: (0,0) → (c,0) → (0,c).
 * @param {number} size
 * @returns {number[][]}
 */
export function chamferWedgeContour(size) {
  const c = Number(size);
  if (!(c > 0) || !Number.isFinite(c)) {
    throw new Error('chamferWedgeContour: size must be > 0');
  }
  return [[0, 0], [c, 0], [0, c]];
}

/**
 * Normalize path input to { points, closed, length, edgeCount? }.
 * Accepts makeSweepPath value, { points, closed }, or bare points[] (+ opts.closed).
 * @param {object|number[][]} path
 * @param {object} [opts]
 * @returns {{ points: number[][], closed: boolean, length: number, edgeCount: number|null }}
 */
export function normalizeFilletPath(path, opts = {}) {
  if (!path) {
    throw new Error('filletAlongPath: path is required (makeSweepPath result or points[])');
  }
  let points;
  let closed = !!opts.closed;
  let edgeCount = null;

  if (Array.isArray(path)) {
    points = path;
  } else if (typeof path === 'object') {
    if (path.kind && path.kind !== 'sweepPath') {
      throw new Error(`filletAlongPath: unexpected path.kind "${path.kind}" (want sweepPath)`);
    }
    if (!Array.isArray(path.points)) {
      throw new Error('filletAlongPath: path.points must be an array of [x,y,z]');
    }
    points = path.points;
    if (path.closed != null) closed = !!path.closed;
    if (Number.isFinite(path.edgeCount)) edgeCount = path.edgeCount;
  } else {
    throw new Error('filletAlongPath: path must be makeSweepPath result or points[]');
  }

  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('filletAlongPath: path needs ≥ 2 points');
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Array.isArray(p) || p.length < 3) {
      throw new Error(`filletAlongPath: point[${i}] must be [x,y,z]`);
    }
    const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`filletAlongPath: point[${i}] has non-finite coords`);
    }
    if (out.length) {
      const prev = out[out.length - 1];
      if (Math.hypot(x - prev[0], y - prev[1], z - prev[2]) < 1e-9) continue;
    }
    out.push([x, y, z]);
  }
  if (out.length < 2) {
    throw new Error('filletAlongPath: path collapsed to < 2 distinct points');
  }
  // Closed: strip duplicated close point if present
  if (closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-5) {
      out.pop();
    }
  }
  if (closed && out.length < 3) {
    throw new Error('filletAlongPath: closed path needs ≥ 3 distinct points');
  }

  let length = 0;
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (closed) {
    const a = out[out.length - 1], b = out[0];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (!(length > 1e-9)) {
    throw new Error('filletAlongPath: path has zero length');
  }
  return { points: out, closed, length, edgeCount };
}

/**
 * Soft-fail gate for UI (same topology rules as Path / makeSweepPath).
 * @param {object[]|null|undefined} edges
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function canBuildFilletAlongPath(edges) {
  const base = assembleSweepPath(edges);
  if (base.ok) return { ok: true };
  const msg = base.message || FILLET_SWEEP_EMPTY;
  if (/disconnect/i.test(msg)) return { ok: false, message: FILLET_SWEEP_DISCONNECTED };
  if (/branch/i.test(msg)) return { ok: false, message: FILLET_SWEEP_BRANCH };
  return { ok: false, message: msg || FILLET_SWEEP_EMPTY };
}

/**
 * Assemble path value for sweep fillet from edge selection (palette).
 * @param {object[]} edges
 * @param {object} [opts]
 */
export function assembleFilletSweepPath(edges, opts = {}) {
  const gate = canBuildFilletAlongPath(edges);
  if (!gate.ok) return gate;
  return assembleSweepPath(edges, opts);
}

/**
 * Analytic removed area for a 90° fillet cross-section (per unit length).
 * @param {number} r
 */
export function filletWedgeArea(r) {
  return r * r * (1 - Math.PI / 4);
}

/**
 * Analytic removed area for a 90° chamfer triangle (per unit length).
 * @param {number} c
 */
export function chamferWedgeArea(c) {
  return 0.5 * c * c;
}
