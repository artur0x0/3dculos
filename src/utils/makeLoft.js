/**
 * Slice 28 — makeLoft (multi-profile, same workplane + offsets).
 *
 * v1 plane model: every profile is makeCrossSection on a copy of one workplane
 * whose center is translated by `offset * normal`. Planes must be parallel.
 * Independent (non-parallel) planes are a later slice.
 *
 * Does not change the legacy loft({ topCS, bottomCS, height }) cup helper.
 */

export const MAKE_LOFT_MIN_PROFILES = 2;
export const MAKE_LOFT_RESOLUTION = 64;
export const MAKE_LOFT_EXTRUDE_SEGS = 64;

function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
function _norm(v) {
  const L = Math.hypot(v[0], v[1], v[2]);
  if (!(L > 1e-12)) return null;
  return [v[0] / L, v[1] / L, v[2] / L];
}

function _area2(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function _normalizeLoop(points, what) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error(`${what}: need ≥ 3 points for a closed polyline`);
  }
  const p = points.map((v) => [Number(v[0]), Number(v[1])]);
  if (p.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) {
    throw new Error(`${what}: contour points must be finite [u,v]`);
  }
  const f = p[0];
  const l = p[p.length - 1];
  if (p.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) p.pop();
  if (p.length < 3) throw new Error(`${what}: need ≥ 3 distinct points`);
  if (Math.abs(_area2(p)) < 1e-12) {
    throw new Error(`${what}: degenerate profile (zero area)`);
  }
  if (_area2(p) < 0) p.reverse();
  return p;
}

function _requirePlane(plane, what) {
  if (!plane || !plane.center || !plane.normal || !plane.x || !plane.y) {
    throw new Error(`${what}: plane must be a workplaneFromFace frame (center/normal/x/y)`);
  }
}

/**
 * Copy of a workplane translated along its normal. Shared v1 loft station.
 */
export function offsetPlaneFrame(plane, offset) {
  _requirePlane(plane, 'offsetPlaneFrame');
  const w = Number(offset);
  if (!Number.isFinite(w)) {
    throw new Error('offsetPlaneFrame: offset must be finite');
  }
  const n = plane.normal;
  return {
    center: [
      plane.center[0] + n[0] * w,
      plane.center[1] + n[1] * w,
      plane.center[2] + n[2] * w,
    ],
    normal: plane.normal.slice(),
    x: plane.x.slice(),
    y: plane.y.slice(),
  };
}

export function resampleContour(contour, n) {
  if (!Array.isArray(contour) || contour.length < 2) return contour ? contour.slice() : [];
  const count = Math.max(2, Math.round(Number(n) || 2));
  const lengths = [0];
  for (let i = 1; i < contour.length; i++) {
    const dx = contour[i][0] - contour[i - 1][0];
    const dy = contour[i][1] - contour[i - 1][1];
    lengths.push(lengths[i - 1] + Math.hypot(dx, dy));
  }
  const dxClose = contour[0][0] - contour[contour.length - 1][0];
  const dyClose = contour[0][1] - contour[contour.length - 1][1];
  lengths.push(lengths[lengths.length - 1] + Math.hypot(dxClose, dyClose));
  const total = lengths[lengths.length - 1];
  if (!(total > 1e-12)) return contour.slice(0, count);

  const resampled = [];
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    let seg = 0;
    while (seg < lengths.length - 1 && target > lengths[seg + 1]) seg++;
    const s0 = lengths[seg];
    const s1 = lengths[seg + 1];
    const frac = Math.abs(s1 - s0) < 1e-12 ? 0 : (target - s0) / (s1 - s0);
    const idx0 = seg % contour.length;
    const idx1 = (seg + 1) % contour.length;
    resampled.push([
      contour[idx0][0] + frac * (contour[idx1][0] - contour[idx0][0]),
      contour[idx0][1] + frac * (contour[idx1][1] - contour[idx0][1]),
    ]);
  }
  return resampled;
}

export function rotateContour(contour, deg) {
  if (!contour?.length) return contour;
  const rad = (Number(deg) || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return contour.map((p) => [
    p[0] * cos - p[1] * sin,
    p[0] * sin + p[1] * cos,
  ]);
}

function _sumSqDist(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i][0] - b[i][0];
    const dy = a[i][1] - b[i][1];
    d += dx * dx + dy * dy;
  }
  return d;
}

function _alignContours(bottom, top) {
  let bestRot = 0;
  let minDist = Infinity;
  const steps = 72;
  for (let k = 0; k < steps; k++) {
    const rot = k * (360 / steps);
    const d = _sumSqDist(bottom, rotateContour(top, rot));
    if (d < minDist) {
      minDist = d;
      bestRot = rot;
    }
  }
  return rotateContour(top, bestRot);
}

function _outerContour(section, what) {
  let contours = section?.contours;
  if ((!contours || !contours.length) && typeof section?.toPolygons === 'function') {
    contours = section.toPolygons();
  }
  if (!Array.isArray(contours) || !contours.length) {
    throw new Error(`${what}: section is missing contours`);
  }
  return _normalizeLoop(contours[0], what);
}

/**
 * Normalize makeCrossSection (or { plane, contours, offset }) values into
 * ordered loft stations. Loud-fail on <2, non-parallel planes, coincident
 * offsets, or degenerate contours.
 *
 * @returns {{ ok: true, stations: object[] } | { ok: false, message: string }}
 */
export function assembleLoftStations(sections) {
  try {
    if (!Array.isArray(sections) || sections.length < MAKE_LOFT_MIN_PROFILES) {
      return { ok: false, message: 'makeLoft: need at least 2 profiles' };
    }
    const raw = [];
    let baseNormal = null;
    let basePlane = null;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const what = `makeLoft: profile ${i + 1}`;
      if (!s || typeof s !== 'object') {
        return { ok: false, message: `${what}: expected a makeCrossSection value` };
      }
      const plane = s.plane;
      _requirePlane(plane, what);
      const n = _norm(plane.normal);
      if (!n) return { ok: false, message: `${what}: plane normal is degenerate` };
      if (!baseNormal) {
        baseNormal = n;
        basePlane = plane;
      } else if (Math.abs(_dot(n, baseNormal)) < 0.99) {
        return {
          ok: false,
          message:
            'makeLoft: v1 requires parallel profile planes (same workplane + offsets)',
        };
      }
      const contour = _outerContour(s, what);
      const offset = Number.isFinite(Number(s.offset))
        ? Number(s.offset)
        : _dot(_sub(plane.center, basePlane.center), baseNormal);
      if (!Number.isFinite(offset)) {
        return { ok: false, message: `${what}: offset must be finite` };
      }
      raw.push({
        index: i,
        plane,
        contour,
        offset,
        normal: n,
      });
    }
    const stations = raw.slice().sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < stations.length; i++) {
      if (Math.abs(stations[i].offset - stations[i - 1].offset) < 1e-6) {
        return {
          ok: false,
          message:
            'makeLoft: profiles share the same station offset — would be a zero-height loft',
        };
      }
    }
    return { ok: true, stations, plane: stations[0].plane };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
}

function _loftPair(Manifold, CrossSection, bottom, top, height, opts) {
  const resolution = Math.max(16, Math.round(Number(opts.resolution) || MAKE_LOFT_RESOLUTION));
  const segs = Math.max(8, Math.round(Number(opts.extrudeSegments) || MAKE_LOFT_EXTRUDE_SEGS));
  const h = Number(height);
  if (!(h > 1e-9) || !Number.isFinite(h)) {
    throw new Error('makeLoft: station spacing must be > 0');
  }
  const bottomTable = resampleContour(bottom, resolution);
  let topTable = resampleContour(top, resolution);
  if (opts.align !== false) {
    topTable = _alignContours(bottomTable, topTable);
  }
  const radialTable = bottomTable.map((p) => Math.hypot(p[0], p[1]));
  const bottomCS = new CrossSection([bottom]);
  const straight = Manifold.extrude
    ? Manifold.extrude(bottomCS, h, segs)
    : bottomCS.extrude(h, segs);
  const warp = (v) => {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    const t = z / h;
    const rOrig = Math.hypot(x, y);
    if (rOrig < 1e-8) {
      v[0] = 0;
      v[1] = 0;
      return;
    }
    let angle = Math.atan2(y, x);
    if (angle < 0) angle += 2 * Math.PI;
    const s = angle / (2 * Math.PI);
    const i = Math.floor(s * resolution);
    const frac = (s * resolution) - i;
    const i0 = ((i % resolution) + resolution) % resolution;
    const i1 = (i0 + 1) % resolution;
    let rBottom = radialTable[i0];
    rBottom += frac * (radialTable[i1] - radialTable[i0]);
    const scale = rBottom > 1e-9 ? rOrig / rBottom : 1;
    let tx = topTable[i0][0];
    let ty = topTable[i0][1];
    tx += frac * (topTable[i1][0] - tx);
    ty += frac * (topTable[i1][1] - ty);
    v[0] = x + t * (tx * scale - x);
    v[1] = y + t * (ty * scale - y);
  };
  return straight.warp(warp);
}

function _transformToPlane(manifold, plane, z0) {
  const x = plane.x;
  const y = plane.y;
  const n = plane.normal;
  const c = _add(plane.center, _mul(z0, n));
  return manifold.warp((v) => {
    const u = v[0];
    const vv = v[1];
    const w = v[2];
    v[0] = c[0] + u * x[0] + vv * y[0] + w * n[0];
    v[1] = c[1] + u * x[1] + vv * y[1] + w * n[1];
    v[2] = c[2] + u * x[2] + vv * y[2] + w * n[2];
  });
}

/**
 * Build a loft solid from ≥2 makeCrossSection values (or {plane,contours,offset}).
 * Result is local to the shared workplane: XY = station UV, Z along the shared
 * normal, z=0 at the lowest-offset station. Confirm places it with
 * `placeInFrame(frame, makeLoft(sections), [0, 0, minOffset])`.
 */
export function buildMakeLoftSolid(Manifold, CrossSection, sections, opts = {}) {
  const assembled = assembleLoftStations(sections);
  if (!assembled.ok) throw new Error(assembled.message);
  const { stations } = assembled;
  const z0 = stations[0].offset;
  const pieces = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const height = b.offset - a.offset;
    const pair = _loftPair(Manifold, CrossSection, a.contour, b.contour, height, opts);
    // Local pair sits on XY at z=0…height. Shift so z=0 is the lowest station.
    const zLocal = a.offset - z0;
    pieces.push(
      Math.abs(zLocal) < 1e-12
        ? pair
        : (typeof pair.translate === 'function'
          ? pair.translate([0, 0, zLocal])
          : _transformToPlane(pair, {
            center: [0, 0, 0],
            normal: [0, 0, 1],
            x: [1, 0, 0],
            y: [0, 1, 0],
          }, zLocal)),
    );
  }
  let out = pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    out = out.add ? out.add(pieces[i]) : Manifold.union([out, pieces[i]]);
  }
  const vol = typeof out.volume === 'function' ? out.volume() : 0;
  if (!(vol > 1e-9)) {
    throw new Error('makeLoft: result is EMPTY (volume 0) — check profiles have area and distinct offsets');
  }
  return out;
}

/**
 * Client / golden preview payload: resampled UV rings + world frames.
 * Null when <2 valid stations (incomplete polyline, bad offset, …).
 */
export function buildLoftPreviewStations(sections, sampleN = 32) {
  const assembled = assembleLoftStations(sections);
  if (!assembled.ok) return null;
  const n = Math.max(8, Math.round(Number(sampleN) || 32));
  return {
    plane: assembled.stations[0].plane,
    stations: assembled.stations.map((s) => ({
      offset: s.offset,
      plane: s.plane,
      ring: resampleContour(s.contour, n),
      contour: s.contour,
    })),
  };
}
