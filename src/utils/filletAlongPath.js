/**
 * Slice 23 — Fillet via swept cross-section.
 *
 * Pure helpers shared by palette soft-fail, goldens, and docs.
 * Script-facing filletAlongPath lives in sandboxWorker (sweep + boolean subtract).
 *
 * Cutter profile is shaped from the measured interior dihedral θ between the
 * two in-face directions (not a hard-coded 90° wedge). At θ = 90° the fillet
 * is the historical first-quadrant wedge (square minus quarter-disk at (r,r),
 * area r²(1−π/4)) and the chamfer is the right triangle (0,0)-(c,0)-(0,c).
 *
 * Strategy default (and auto) is sweep — the universal fillet. Planar is an
 * explicit manual override for classic filletEdges only.
 * Does NOT ship extrude/revolve/loft — wait for Product brief.
 */

import { assembleSweepPath } from './edgeSweepPath.js';
export { SLIVER_MAX_ABS, SLIVER_MAX_FRAC, isFilletSliverDirty } from './filletSliverGuard.js';

export const FILLET_SWEEP_EMPTY =
  'Select edges first (Edge pick mode), then Fillet (Strategy=sweep by default). Tangent-on chains work for circular rims.';

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
 * Fillet strategy from selected edges.
 * Sweep is the universal default — planar is never chosen automatically.
 * Manual Strategy=planar still overrides via resolveFilletStrategy.
 * Extra args (edge set) are ignored — kept so call sites stay stable.
 *
 * @returns {'planar'|'sweep'}
 */
export function pickFilletStrategy() {
  return 'sweep';
}

/**
 * Resolve Strategy select value: sweep is default; auto → sweep;
 * planar is the only manual override (classic filletEdges).
 * Extra args (edge set) are ignored — kept so call sites stay stable.
 * @param {string|null|undefined} strategy
 * @returns {'planar'|'sweep'}
 */
export function resolveFilletStrategy(strategy) {
  const s = String(strategy || 'sweep').toLowerCase();
  if (s === 'planar') return 'planar';
  return 'sweep';
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
  if (/disconnect/i.test(msg)) {
    const extra = (msg.match(/\([^)]*component[^)]*\)/) || [])[0];
    return {
      ok: false,
      message: FILLET_SWEEP_DISCONNECTED + (extra ? ` ${extra}` : ''),
    };
  }
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

/**
 * Sweep-path policy for filletAlongPath (sandboxWorker + goldens).
 *
 * PR #27 skipped tessellated prior-fillet micro-arcs (mixed long+micro → open
 * long runs only). That left a gap instead of wrapping the prior blend.
 * Always keep the full wire — including micro rim arcs. Slivers are consumed
 * by a size-neutral exterior overlap on the cutter (`expandFilletCutterContour`),
 * not by dropping path segments.
 *
 * sandboxWorker calls this (still passing closed/radius so a skip-micro
 * paste-back receives them) and honors `mode:'runs'` if a future planner
 * returns it — that is the skip-micro regression the fillet-on-fillet gap
 * net mutation-tests. Current policy never returns `runs`. Signature is
 * `(points)` — wrap does not split on closed/radius.
 *
 * @param {number[][]} points
 * @returns {{ mode:'as-is' } | { mode:'empty' }}
 */
export function planFilletSweepPath(points) {
  if (!Array.isArray(points) || points.length < 2) return { mode: 'empty' };
  return { mode: 'as-is' };
}

/** Fraction of radius used as exterior / rear boolean-fuzz (does not grow Q1 extent). */
export const FILLET_SWEEP_EXPAND_FRAC = 0.15;
/** Floor so tiny / tighter follow-on radii still get a rear overlap (mm). Size-neutral. */
export const FILLET_SWEEP_EXPAND_MIN = 0.30;
/** Cap on exterior / rear overlap (mm). Size-neutral — does not redefine fillet r. */
export const FILLET_SWEEP_EXPAND_MAX = 1.20;

/**
 * Exterior / rear overlap margin for the sweep cutter (−e,−e) family.
 * Decoupled from blend size: first-quadrant extent stays at requested r.
 * @param {number} radius
 * @returns {number}
 */
export function filletSweepCutterExpand(radius) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) return 0;
  return Math.min(
    FILLET_SWEEP_EXPAND_MAX,
    Math.max(FILLET_SWEEP_EXPAND_MIN, FILLET_SWEEP_EXPAND_FRAC * r),
  );
}

/**
 * Boolean-fuzz a fillet/chamfer wedge so cutter legs are not
 * tangent-coincident with the part faces.
 *
 * Mechanism: the nominal wedge legs (0,0)→(r,0) and (0,0)→(0,r) lie ON the
 * two adjacent faces. Manifold CSG on coincident surfaces can leave sliver
 * sheets — worse when the path includes tessellated prior-fillet micro-arcs
 * (chordal RMF frames sitting near-tangent to the old cylinder).
 *
 * Size-neutral boolean robustness: keep every first-quadrant vertex at the
 * requested r (realized blend extent = requested r) and replace the origin
 * with a rear bumper in the (−e,−e) family: (−e,−e) plus thickness-e strips
 * in Q2/Q4. Extra cutter lives in empty space past the crease so the legs
 * are not coplanar-coincident with the faces — mixed-radius / tighter
 * follow-on sweeps need a deeper rear pad than the original 4%·r sliver.
 * Uniform Q1 scale is not used — it only redefined requested r.
 *
 * (−e,−e) family is an unvalidated boolean-robustness margin: kept because
 * legs must not coplanar-coincide with faces, and as the origin vertex (the
 * (0,0) corner is skipped so this must replace it or the contour
 * collapses). Size-neutral. It is not proven load-bearing by the rim
 * fIn net — that net is a gap detector on the whole rim sphere and
 * cannot certify pad / coincident slivers. The same net still catches
 * path truncation / skip-micro (M6), separately from the pad.
 *
 * Pure 2D — no Manifold.
 *
 * @param {number[][]} contour  wedge from filletWedgeContour / chamferWedgeContour
 * @param {number} radius
 * @returns {number[][]}
 */
export function expandFilletCutterContour(contour, radius) {
  if (!Array.isArray(contour) || contour.length < 3) {
    throw new Error('expandFilletCutterContour: need a wedge (≥3 pts)');
  }
  const e = filletSweepCutterExpand(radius);
  const r = Number(radius);
  if (!(e > 0) || !(r > 0) || !Number.isFinite(r)) {
    return contour.map((p) => [Number(p[0]), Number(p[1])]);
  }
  const q1 = [];
  for (const p of contour) {
    const u = Number(p[0]);
    const v = Number(p[1]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      throw new Error('expandFilletCutterContour: non-finite vertex');
    }
    if (Math.abs(u) < 1e-15 && Math.abs(v) < 1e-15) continue;
    q1.push([u, v]);
  }
  if (q1.length < 2) {
    throw new Error('expandFilletCutterContour: contour collapsed');
  }
  // Rear bumper: Q3 origin + Q4/Q2 strips of thickness e. Q1 stays at r.
  const uMax = Math.max(...q1.map((p) => p[0]));
  const vMax = Math.max(...q1.map((p) => p[1]));
  const out = [[-e, -e], [uMax, -e], ...q1, [-e, vMax]];
  if (out.length < 3) {
    throw new Error('expandFilletCutterContour: contour collapsed');
  }
  return out;
}

function _v3(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Orthonormal cross-section frame for a dihedral fillet/chamfer.
 * N is one in-face direction, B is the in-plane perpendicular toward the
 * other, and (N, B, T) is right-handed so a CCW (u,v) contour extrudes
 * along +T. θ is the interior angle between the in-face rays.
 * prevN, when set, prefers the face that continues the previous segment
 * so a chain does not swap axes at every sample.
 *
 * @param {number[]} T tangent
 * @param {number[]} f0 in-face direction
 * @param {number[]} f1 in-face direction
 * @param {number[]|null} [prevN]
 * @returns {{ N: number[], B: number[], theta: number }}
 */
export function orientFilletFrame(T, f0, f1, prevN = null) {
  let A = _v3(f0);
  let C = _v3(f1);
  if (prevN && _dot3(C, prevN) > _dot3(A, prevN)) {
    const tmp = A;
    A = C;
    C = tmp;
  }
  const Tn = _v3(T);
  let N = A;
  let B = _v3(_cross3(Tn, N));
  if (_dot3(B, C) < 0) {
    N = C;
    B = _v3(_cross3(Tn, N));
    const other = A;
    if (_dot3(B, other) < 0) B = [-B[0], -B[1], -B[2]];
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, _dot3(_v3(f0), _v3(f1)))));
  return { N, B, theta };
}

/**
 * Interior setback along each face for a radius-r fillet of dihedral θ.
 * t = r / tan(θ/2). At 90° this is r.
 * @param {number} radius
 * @param {number} theta radians, (0, π)
 */
export function filletSetback(radius, theta) {
  const r = Number(radius);
  const th = Number(theta);
  if (!(r > 0) || !Number.isFinite(r)) throw new Error('filletSetback: radius must be > 0');
  if (!(th > 0) || !(th < Math.PI) || !Number.isFinite(th)) {
    throw new Error(`filletSetback: face angle ${th} rad is degenerate`);
  }
  return r / Math.tan(th / 2);
}

/**
 * Analytic removed area of a dihedral fillet (per unit length).
 * r·t − ½·r²·(π − θ), with t = r/tan(θ/2). At 90° this is r²(1−π/4).
 * @param {number} radius
 * @param {number} theta
 */
export function filletRemovedArea(radius, theta) {
  const r = Number(radius);
  const th = Number(theta);
  const t = filletSetback(r, th);
  return r * t - 0.5 * r * r * (Math.PI - th);
}

/**
 * Analytic removed area of an equal-leg chamfer (per unit length).
 * ½·c²·sin(θ). At 90° this is ½·c².
 * @param {number} size leg length
 * @param {number} theta
 */
export function chamferRemovedArea(size, theta) {
  const c = Number(size);
  const th = Number(theta);
  if (!(c > 0) || !Number.isFinite(c)) throw new Error('chamferRemovedArea: size must be > 0');
  if (!(th > 0) || !(th < Math.PI) || !Number.isFinite(th)) {
    throw new Error(`chamferRemovedArea: face angle ${th} rad is degenerate`);
  }
  return 0.5 * c * c * Math.sin(th);
}

function _requireDihedral(name, radius, theta) {
  const r = Number(radius);
  const th = Number(theta);
  if (!(r > 0) || !Number.isFinite(r)) throw new Error(`${name}: radius must be > 0`);
  if (!(th > 0.05) || th > Math.PI - 0.05 || !Number.isFinite(th)) {
    throw new Error(`${name}: face angle ${th} rad is degenerate`);
  }
  return { r, th };
}

/**
 * Fillet cutter in orthonormal (u,v): u along one face, +v toward the other.
 * Origin → setback on face 0 → arc (center inset by r) → setback on face 1.
 * At θ = π/2 this matches filletWedgeContour.
 * @param {number} radius
 * @param {number} theta interior angle, radians
 * @param {number} [arcSegments=12]
 * @returns {number[][]}
 */
export function dihedralFilletContour(radius, theta, arcSegments = 12) {
  const { r, th } = _requireDihedral('dihedralFilletContour', radius, theta);
  const seg = Math.max(2, Math.round(Number(arcSegments) || 12));
  const t = r / Math.tan(th / 2);
  const p1 = [t * Math.cos(th), t * Math.sin(th)];
  const span = Math.PI - th;
  const pts = [[0, 0], [t, 0]];
  for (let i = 1; i <= seg; i++) {
    const phi = -Math.PI / 2 - (i / seg) * span;
    pts.push([t + r * Math.cos(phi), r + r * Math.sin(phi)]);
  }
  pts[pts.length - 1] = p1;
  return pts;
}

/**
 * Equal-leg chamfer triangle for interior angle θ.
 * (0,0) → (c,0) → c·(cos θ, sin θ). At 90° this is chamferWedgeContour.
 * @param {number} size
 * @param {number} theta
 * @returns {number[][]}
 */
export function dihedralChamferContour(size, theta) {
  const { r: c, th } = _requireDihedral('dihedralChamferContour', size, theta);
  return [[0, 0], [c, 0], [c * Math.cos(th), c * Math.sin(th)]];
}

/**
 * Exterior bumper for a dihedral wedge so cutter legs are not coincident
 * with the faces. At θ = π/2 this matches expandFilletCutterContour
 * (rear corner (−e,−e), strips (leg,−e) and (−e,leg)).
 * Contour must be origin, face-0 point, …, face-1 point.
 * @param {number[][]} contour
 * @param {number} radius
 * @param {number} theta
 * @returns {number[][]}
 */
export function expandDihedralCutterContour(contour, radius, theta) {
  if (!Array.isArray(contour) || contour.length < 3) {
    throw new Error('expandDihedralCutterContour: need a wedge (≥3 pts)');
  }
  const { r, th } = _requireDihedral('expandDihedralCutterContour', radius, theta);
  const e = filletSweepCutterExpand(r);
  if (!(e > 0)) {
    return contour.map((p) => [Number(p[0]), Number(p[1])]);
  }
  const p0 = contour[1];
  const p1 = contour[contour.length - 1];
  const u0 = Number(p0[0]);
  const v0 = Number(p0[1]);
  const u1 = Number(p1[0]);
  const v1 = Number(p1[1]);
  if (![u0, v0, u1, v1].every(Number.isFinite)) {
    throw new Error('expandDihedralCutterContour: non-finite vertex');
  }
  const cot = 1 / Math.tan(th / 2);
  const sin = Math.sin(th);
  const cos = Math.cos(th);
  const exterior = [-e * cot, -e];
  const face0Out = [u0, -e];
  const face1Out = [u1 + e * (-sin), v1 + e * cos];
  const q1 = [];
  for (let i = 1; i < contour.length; i++) {
    const u = Number(contour[i][0]);
    const v = Number(contour[i][1]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      throw new Error('expandDihedralCutterContour: non-finite vertex');
    }
    q1.push([u, v]);
  }
  return [exterior, face0Out, ...q1, face1Out];
}
