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
 * Strategy=auto picks sweep vs planar from the edge set (manual override kept).
 * Does NOT ship extrude/revolve/loft — wait for Product brief.
 */

import { assembleSweepPath } from './edgeSweepPath.js';
export { SLIVER_MAX_ABS, SLIVER_MAX_FRAC, isFilletSliverDirty } from './filletSliverGuard.js';

export const FILLET_SWEEP_EMPTY =
  'Select edges first (Edge pick mode), then Fillet with Strategy=sweep (or Strategy=auto). Tangent-on chains work for circular rims.';

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


function _dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Cluster unit-ish normals; count distinct directions within cosTol.
 * Many clusters ⇒ curved / compound face set (rim wall fans around).
 * @param {number[][]} normals
 * @param {number} cosTol
 */
function _clusterNormals(normals, cosTol) {
  const clusters = [];
  for (const n of normals) {
    if (!n || n.length < 3) continue;
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const u = [n[0] / len, n[1] / len, n[2] / len];
    let found = false;
    for (const c of clusters) {
      if (_dot3(c, u) >= cosTol) {
        found = true;
        break;
      }
    }
    if (!found) clusters.push(u);
  }
  return clusters.length;
}

/**
 * Auto fillet strategy from selected edges.
 * Heuristic: curved-adjacent (normal fan) → sweep; clean planar–planar → planar.
 * Manual Strategy select overrides.
 *
 * Signals for sweep:
 * - adjacent-face normals fan into >6 direction clusters (curved / tessellated
 *   walls; 8° bins). Requires ≥4 normals collected from n0/n1.
 *
 * Clean multi-edge planar loops (box-like top + cardinal sides) stay planar —
 * edge count alone never forces sweep.
 *
 * @param {object[]|null|undefined} edges
 * @returns {'planar'|'sweep'}
 */
export function pickFilletStrategy(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return 'planar';

  const normals = [];
  for (const e of edges) {
    if (Array.isArray(e?.n0)) normals.push(e.n0);
    if (Array.isArray(e?.n1)) normals.push(e.n1);
  }
  // 8° bins: tessellated cylinder wall fans into many clusters; a box top
  // rectangle stays at ≤5 (top + 4 sides). Threshold >6 catches curved walls
  // without flipping clean planar polygons to sweep.
  const curvedFaces = normals.length >= 4
    && _clusterNormals(normals, Math.cos((8 * Math.PI) / 180)) > 6;

  if (curvedFaces) return 'sweep';
  return 'planar';
}

/**
 * Resolve Strategy select value: auto → heuristic; planar|sweep passthrough.
 * @param {string|null|undefined} strategy
 * @param {object[]|null|undefined} edges
 * @returns {'planar'|'sweep'}
 */
export function resolveFilletStrategy(strategy, edges) {
  const s = String(strategy || 'auto').toLowerCase();
  if (s === 'planar' || s === 'sweep') return s;
  return pickFilletStrategy(edges);
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

/**
 * Minimum vertex count after micro-path decimation.
 * Absolute floor so a 12-gon rim can never collapse to a triangle (ceil(12/4)=3
 * alone is not enough). Golden pins this; mutating it below ~12 fails the probe.
 */
export const FILLET_SWEEP_DECIMATE_MIN = 16;

/**
 * Fillet-on-fillet / path-on-blend prep (shared by sandboxWorker + goldens).
 * Tessellated prior-fillet rims are dense micro-segments. Sweeping the full
 * closed wire (straights + micro arcs) leaves jagged sheets; sweeping only the
 * significant open runs is clean. Uniform closed curved fans stay as-is so the
 * revolve / polyline fast-path keeps full tessellation (never chord to a triangle).
 *
 * @param {number[][]} points
 * @param {boolean} closed
 * @param {number} radius
 * @returns {{ mode:'as-is' }
 *   | { mode:'runs', runs:number[][][] }
 *   | { mode:'decimate', points:number[][], closed:boolean }}
 */
export function planFilletSweepPath(points, closed, radius) {
  const n = points.length;
  if (n < 2) return { mode: 'as-is' };
  const segCount = closed ? n : n - 1;
  if (segCount < 2) return { mode: 'as-is' };
  const lens = [];
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    lens.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const sorted = lens.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const rNum = Number(radius);
  const rTerm = Number.isFinite(rNum) ? 0.15 * rNum : 0;
  const thr = Math.max(0.25 * med, rTerm, 1e-3);
  let nMicro = 0;
  let nLong = 0;
  for (const L of lens) {
    if (L < thr) nMicro++;
    else nLong++;
  }
  // Mixed: long straights + micro arcs on prior fillet — fillet long runs only.
  if (nLong >= 1 && nMicro >= 2) {
    const runs = [];
    let cur = [];
    const pushRun = () => {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    };
    for (let i = 0; i < segCount; i++) {
      if (lens[i] >= thr) {
        if (cur.length === 0) cur.push(points[i].slice());
        cur.push(points[(i + 1) % n].slice());
      } else {
        pushRun();
      }
    }
    pushRun();
    if (runs.length >= 1) return { mode: 'runs', runs };
  }
  // Mostly micro. Decimate only with bimodal evidence (some segments ≥ thr).
  // Uniform all-micro fans (closed or open) keep full tessellation — pre-#27.
  if (nLong >= 1 && nMicro >= 4 && nMicro >= 0.5 * segCount) {

    let pathLen = 0;
    for (const L of lens) pathLen += L;
    const rSpace = Number.isFinite(rNum) ? 0.25 * rNum : 0;
    // Scale-relative spacing: aim for ≥ FILLET_SWEEP_DECIMATE_MIN samples.
    // (Absolute 0.5 floor used to force ~3 pts on a unit 12-gon — removed.)
    const minKeep = Math.max(FILLET_SWEEP_DECIMATE_MIN, Math.ceil(segCount / 4));
    const spacing = Math.max(pathLen / minKeep, pathLen / Math.max(segCount, 1), rSpace, 1e-9);
    const dec = [points[0].slice()];
    let last = points[0];
    const lim = n;
    for (let i = 1; i < lim; i++) {
      const p = points[i % n];
      if (Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) >= spacing) {
        dec.push(p.slice());
        last = p;
      }
    }
    if (!closed) {
      const end = points[n - 1];
      if (Math.hypot(end[0] - dec[dec.length - 1][0], end[1] - dec[dec.length - 1][1], end[2] - dec[dec.length - 1][2]) > 1e-6) {
        dec.push(end.slice());
      }
    }
    const need = closed ? 3 : 2;
    const floor = Math.min(minKeep, n);
    // Over-decimation guard: if spacing still collapsed below the floor, keep as-is.
    if (dec.length >= need && dec.length >= floor) {
      return { mode: 'decimate', points: dec, closed: !!closed };
    }
  }
  return { mode: 'as-is' };
}
