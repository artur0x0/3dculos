/**
 * Loft between profiles whose planes are not parallel.
 *
 * Each contour is mapped through its own plane (center + u·x + v·y). The
 * rings are arc-length resampled to one count, reversed when their winding
 * opposes the loft direction, then cyclically shifted so paired vertices
 * sit as close as they can in 3D.
 *
 * A straight ruling between those rings is the chord of the turn. At a large
 * angle (a 90° elbow) that chord cuts through the inside of the bend and the
 * ruled quads fold. Every non-parallel span is therefore carried on a cubic
 * spine that leaves along the first plane's forward normal and arrives along
 * the next. The section rides in a frame slerped between the two profiles,
 * with the in-plane X axis aimed at the paired start vertex so the shift
 * above is not undone by a frame twist. The first and last rings are the
 * authored profiles, so the caps stay on the given planes.
 *
 * The solid is expressed in the first profile's plane frame. placeInFrame on
 * that plane puts it back in the coordinates of the section planes.
 */

const ANGLED_SAMPLE_MIN = 16;
const ANGLED_SAMPLE_MAX = 256;
const KAPPA = 0.5522847498;

function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function _scale(s, v) {
  return [s * v[0], s * v[1], s * v[2]];
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
function _norm(v) {
  const L = _len(v);
  if (!(L > 1e-12)) return null;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function _planePoint(plane, u, v) {
  return [
    plane.center[0] + u * plane.x[0] + v * plane.y[0],
    plane.center[1] + u * plane.x[1] + v * plane.y[1],
    plane.center[2] + u * plane.x[2] + v * plane.y[2],
  ];
}

function _centroid(ring) {
  const c = [0, 0, 0];
  for (const p of ring) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = ring.length || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

function _newell(ring) {
  const n = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

function _ringArea(ring) {
  return 0.5 * _len(_newell(ring));
}

/** Closed polyline resample. Same arc-length rule as the parallel loft. */
function _resample(contour, count) {
  const n = Math.max(3, Math.round(count));
  const lengths = [0];
  for (let i = 1; i < contour.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(
      contour[i][0] - contour[i - 1][0],
      contour[i][1] - contour[i - 1][1],
    ));
  }
  const last = contour[contour.length - 1];
  lengths.push(lengths[lengths.length - 1] + Math.hypot(contour[0][0] - last[0], contour[0][1] - last[1]));
  const total = lengths[lengths.length - 1];
  if (!(total > 1e-12)) {
    throw new Error('makeLoft: degenerate profile (zero perimeter)');
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    let seg = 0;
    while (seg < lengths.length - 1 && target > lengths[seg + 1]) seg++;
    const s0 = lengths[seg];
    const s1 = lengths[seg + 1];
    const frac = Math.abs(s1 - s0) < 1e-12 ? 0 : (target - s0) / (s1 - s0);
    const i0 = seg % contour.length;
    const i1 = (seg + 1) % contour.length;
    out.push([
      contour[i0][0] + frac * (contour[i1][0] - contour[i0][0]),
      contour[i0][1] + frac * (contour[i1][1] - contour[i0][1]),
    ]);
  }
  return out;
}

function _requireFrame(plane, what) {
  const x = plane.x;
  const y = plane.y;
  const n = plane.normal;
  const lx = _len(x);
  const ly = _len(y);
  const ln = _len(n);
  if (!(lx > 1e-8) || !(ly > 1e-8) || !(ln > 1e-8)) {
    throw new Error(`${what}: plane axes are degenerate`);
  }
  const xu = _scale(1 / lx, x);
  const yu = _scale(1 / ly, y);
  const nu = _scale(1 / ln, n);
  if (Math.abs(_dot(xu, yu)) > 2e-2 || Math.abs(_dot(xu, nu)) > 2e-2 || Math.abs(_dot(yu, nu)) > 2e-2) {
    throw new Error(`${what}: plane axes must be perpendicular`);
  }
  if (Math.abs(lx - 1) > 2e-2 || Math.abs(ly - 1) > 2e-2 || Math.abs(ln - 1) > 2e-2) {
    throw new Error(`${what}: plane axes must be unit length`);
  }
  if (_dot(_cross(xu, yu), nu) < 0.5) {
    throw new Error(`${what}: plane axes must be a right-handed frame (x × y = normal)`);
  }
}

function _sampleCount(stations, opts) {
  const requested = Math.round(Number(opts.resolution) || 64);
  let n = Math.max(ANGLED_SAMPLE_MIN, Number.isFinite(requested) ? requested : 64);
  for (const s of stations) n = Math.max(n, s.contour.length);
  return Math.min(ANGLED_SAMPLE_MAX, n);
}

function _travelAt(centroids, i) {
  if (i <= 0) return _norm(_sub(centroids[1], centroids[0]));
  if (i >= centroids.length - 1) return _norm(_sub(centroids[i], centroids[i - 1]));
  return _norm(_sub(centroids[i + 1], centroids[i - 1]));
}

function _bestShift(prev, curr) {
  const n = prev.length;
  let bestK = 0;
  let best = Infinity;
  for (let k = 0; k < n; k++) {
    let d = 0;
    for (let i = 0; i < n; i++) {
      const p = prev[i];
      const q = curr[(i + k) % n];
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      const dz = p[2] - q[2];
      d += dx * dx + dy * dy + dz * dz;
    }
    if (d < best - 1e-8) {
      best = d;
      bestK = k;
    }
  }
  return bestK;
}

function _rotateRing(ring, k) {
  if (!k) return ring;
  return ring.slice(k).concat(ring.slice(0, k));
}

/**
 * In-plane axes aimed at the paired start vertex, normal along the ring.
 * Both ends then share a material X, so the frame slerp does not add a twist
 * the cyclic shift already removed.
 */
function _frameFromRing(ring, normal) {
  const origin = _centroid(ring);
  const n = _norm(normal) || _norm(_newell(ring));
  if (!n) throw new Error('makeLoft: profile normal is degenerate');
  let seed = 0;
  let seedR = -1;
  for (let i = 0; i < ring.length; i++) {
    const r = _len(_sub(ring[i], origin));
    if (r > seedR + 1e-9) {
      seedR = r;
      seed = i;
    }
  }
  // Prefer vertex 0 when it is essentially as far out as the farthest —
  // that is the paired start. A circle has every vertex at the same radius.
  const r0 = _len(_sub(ring[0], origin));
  if (r0 >= seedR - 1e-6) seed = 0;
  let x = _norm(_sub(ring[seed], origin));
  if (!x) throw new Error('makeLoft: profile has no in-plane extent');
  x = _norm(_sub(x, _scale(_dot(x, n), n)));
  if (!x) throw new Error('makeLoft: profile has no in-plane extent');
  const y = _cross(n, x);
  if (seed !== 0) {
    // Keep index 0 as the ring start. Rotate the axis pair so local +X
    // still tracks vertex 0 when some other vertex is farther (a triangle).
    const d = _sub(ring[0], origin);
    const lx = _dot(d, x);
    const ly = _dot(d, y);
    const axis = _norm([lx, ly, 0]);
    if (axis) {
      const rx = _add(_scale(axis[0], x), _scale(axis[1], y));
      const ry = _cross(n, rx);
      return { origin, x: _norm(rx), y: _norm(ry), n };
    }
  }
  return { origin, x, y: _norm(y), n };
}

function _locals(ring, frame) {
  return ring.map((p) => {
    const d = _sub(p, frame.origin);
    return [_dot(d, frame.x), _dot(d, frame.y)];
  });
}

function _place(origin, frame, u, v) {
  return [
    origin[0] + u * frame.x[0] + v * frame.y[0],
    origin[1] + u * frame.x[1] + v * frame.y[1],
    origin[2] + u * frame.x[2] + v * frame.y[2],
  ];
}

function _quatFromBasis(X, Y, N) {
  const m00 = X[0];
  const m01 = Y[0];
  const m02 = N[0];
  const m10 = X[1];
  const m11 = Y[1];
  const m12 = N[1];
  const m20 = X[2];
  const m21 = Y[2];
  const m22 = N[2];
  const tr = m00 + m11 + m22;
  let x;
  let y;
  let z;
  let w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const L = Math.hypot(x, y, z, w) || 1;
  return [x / L, y / L, z / L, w / L];
}

function _basisFromQuat(q) {
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const X = _norm([
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
  ]);
  const Y = _norm([
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
  ]);
  const N = _norm([
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ]);
  return { x: X, y: Y, n: N };
}

function _slerpQuat(q0, q1, t) {
  let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
  const b = dot < 0 ? q1.map((v) => -v) : q1;
  if (dot < 0) dot = -dot;
  if (dot > 0.9995) {
    const q = q0.map((v, i) => v + t * (b[i] - v));
    const L = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return q.map((v) => v / L);
  }
  const theta = Math.acos(_clamp(dot, -1, 1));
  const s = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / s;
  const w1 = Math.sin(t * theta) / s;
  return q0.map((v, i) => w0 * v + w1 * b[i]);
}

function _slerpFrame(f0, f1, t) {
  const q = _slerpQuat(_quatFromBasis(f0.x, f0.y, f0.n), _quatFromBasis(f1.x, f1.y, f1.n), t);
  return _basisFromQuat(q);
}

function _hermite(p0, p1, m0, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [
    h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0],
    h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1],
    h00 * p0[2] + h10 * m0[2] + h01 * p1[2] + h11 * m1[2],
  ];
}

function _tangentPair(n0, n1, c0, c1) {
  const chord = _sub(c1, c0);
  const L = _len(chord);
  const theta = Math.acos(_clamp(_dot(n0, n1), -1, 1));
  let mag;
  if (theta < 1e-4) mag = L;
  else {
    const R = L / (2 * Math.sin(theta / 2));
    mag = 3 * KAPPA * R * Math.min(1, theta / (Math.PI / 2));
  }
  mag = Math.min(L * 1.35, Math.max(L * 0.35, mag));
  return { mag, theta, chordLen: L };
}

function _pathForward(c0, c1, m0, m1, segments) {
  let prev = null;
  let prevStep = null;
  for (let i = 0; i <= segments; i++) {
    const p = _hermite(c0, c1, m0, m1, i / segments);
    if (prev) {
      const step = _sub(p, prev);
      if (_len(step) < 1e-8) return false;
      if (prevStep && _dot(prevStep, step) <= 0) return false;
      prevStep = step;
    }
    prev = p;
  }
  return true;
}

function _spanSegments(theta) {
  const deg = theta * 180 / Math.PI;
  if (deg < 1) return 1;
  return Math.max(2, Math.min(32, Math.ceil(deg / 6)));
}

/**
 * World-space rings (authored ends + spine samples) and the frame of each.
 * Throws a user-facing Error when the profiles cannot make a loft.
 */
export function planAngledLoft(stations, opts = {}) {
  if (!Array.isArray(stations) || stations.length < 2) {
    throw new Error('makeLoft: need at least 2 profiles');
  }
  const count = _sampleCount(stations, opts);
  const rings = [];
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const what = `makeLoft: profile ${i + 1}`;
    _requireFrame(s.plane, what);
    const uv = _resample(s.contour, count);
    rings.push(uv.map(([u, v]) => _planePoint(s.plane, u, v)));
  }
  const centroids = rings.map(_centroid);
  for (let i = 1; i < centroids.length; i++) {
    const d = _len(_sub(centroids[i], centroids[i - 1]));
    if (!(d > 1e-6)) {
      throw new Error('makeLoft: profiles sit on top of each other — would be a zero-length loft');
    }
  }
  for (let i = 0; i < rings.length; i++) {
    const travel = _travelAt(centroids, i);
    if (!travel) {
      throw new Error('makeLoft: profiles sit on top of each other — would be a zero-length loft');
    }
    const n = _norm(_newell(rings[i]));
    if (!n) throw new Error(`makeLoft: profile ${i + 1} is degenerate`);
    if (_dot(n, travel) < 0) rings[i].reverse();
  }
  if (opts.align !== false) {
    for (let i = 1; i < rings.length; i++) {
      const k = _bestShift(rings[i - 1], rings[i]);
      rings[i] = _rotateRing(rings[i], k);
    }
  }
  const endFrames = rings.map((ring) => _frameFromRing(ring, _newell(ring)));
  for (let i = 0; i < rings.length; i++) {
    const frame = endFrames[i];
    const locals = _locals(rings[i], frame);
    for (let k = 0; k < rings[i].length; k++) {
      const back = _place(frame.origin, frame, locals[k][0], locals[k][1]);
      const err = _len(_sub(back, rings[i][k]));
      if (err > 1e-3) {
        throw new Error(`makeLoft: profile ${i + 1} does not lie on its plane`);
      }
    }
    const q = _quatFromBasis(frame.x, frame.y, frame.n);
    const back = _basisFromQuat(q);
    const drift = _len(_sub(back.x, frame.x)) + _len(_sub(back.y, frame.y)) + _len(_sub(back.n, frame.n));
    if (drift > 1e-3) {
      throw new Error('makeLoft: could not build a frame between these planes');
    }
  }

  const outRings = [];
  const outFrames = [];
  const outLocals = [];
  for (let s = 0; s < rings.length - 1; s++) {
    const f0 = endFrames[s];
    const f1 = endFrames[s + 1];
    const uv0 = _locals(rings[s], f0);
    const uv1 = _locals(rings[s + 1], f1);
    const tan = _tangentPair(f0.n, f1.n, f0.origin, f1.origin);
    const segments = _spanSegments(tan.theta);
    let mag = tan.mag;
    let m0 = _scale(mag, f0.n);
    let m1 = _scale(mag, f1.n);
    let forward = _pathForward(f0.origin, f1.origin, m0, m1, Math.max(segments, 8));
    for (let attempt = 0; attempt < 5 && !forward; attempt++) {
      mag *= 0.5;
      m0 = _scale(mag, f0.n);
      m1 = _scale(mag, f1.n);
      forward = _pathForward(f0.origin, f1.origin, m0, m1, Math.max(segments, 8));
    }
    if (!forward) {
      throw new Error('makeLoft: these planes fold the loft back on itself — separate the profiles or ease the angle');
    }
    const areaRef = Math.max(_ringArea(rings[s]), _ringArea(rings[s + 1]), 1e-9);
    for (let step = 0; step < segments; step++) {
      const t = step / segments;
      if (step === 0) {
        outRings.push(rings[s]);
        outFrames.push(f0);
        outLocals.push(uv0);
        continue;
      }
      const basis = _slerpFrame(f0, f1, t);
      const origin = _hermite(f0.origin, f1.origin, m0, m1, t);
      const ring = [];
      const locals = [];
      for (let k = 0; k < count; k++) {
        const u = uv0[k][0] + t * (uv1[k][0] - uv0[k][0]);
        const v = uv0[k][1] + t * (uv1[k][1] - uv0[k][1]);
        locals.push([u, v]);
        ring.push(_place(origin, basis, u, v));
      }
      const area = _ringArea(ring);
      const n = _norm(_newell(ring));
      if (!(area > areaRef * 1e-4) || !n || _dot(n, basis.n) < 0.2) {
        throw new Error(
          'makeLoft: loft would self-intersect — the turn between these planes is tighter than the profiles',
        );
      }
      outRings.push(ring);
      outFrames.push({ origin, x: basis.x, y: basis.y, n: basis.n });
      outLocals.push(locals);
    }
  }
  const last = rings.length - 1;
  outRings.push(rings[last]);
  outFrames.push(endFrames[last]);
  outLocals.push(_locals(rings[last], endFrames[last]));
  return { rings: outRings, frames: outFrames, locals: outLocals };
}

function _toLocal(ref, p) {
  const d0 = p[0] - ref.center[0];
  const d1 = p[1] - ref.center[1];
  const d2 = p[2] - ref.center[2];
  const along = (ax) => d0 * ax[0] + d1 * ax[1] + d2 * ax[2];
  return [along(ref.x), along(ref.y), along(ref.normal)];
}

function _pushFan(triVerts, ringStart, K, centerIndex, sign) {
  for (let k = 0; k < K; k++) {
    const k1 = (k + 1) % K;
    if (sign < 0) triVerts.push(centerIndex, ringStart + k1, ringStart + k);
    else triVerts.push(centerIndex, ringStart + k, ringStart + k1);
  }
}

function _buildTube(rings) {
  const m = rings.length;
  const K = rings[0].length;
  const verts = [];
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < K; k++) verts.push(rings[i][k]);
  }
  const triVerts = [];
  for (let i = 0; i < m - 1; i++) {
    const a = i * K;
    const b = (i + 1) * K;
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      triVerts.push(a + k, a + k1, b + k1);
      triVerts.push(a + k, b + k1, b + k);
    }
  }
  const c0 = verts.length;
  verts.push(_centroid(rings[0]));
  const c1 = verts.length;
  verts.push(_centroid(rings[m - 1]));
  _pushFan(triVerts, 0, K, c0, -1);
  _pushFan(triVerts, (m - 1) * K, K, c1, +1);
  // A fan triangle that points backward means the centroid cannot see the
  // whole cap (a concave bite). Fail instead of shipping a broken lid.
  const startN = _norm(_newell(rings[0]));
  const endN = _norm(_newell(rings[m - 1]));
  const fanBad = (center, ring, expect) => {
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const n = _cross(_sub(ring[k], center), _sub(ring[k1], center));
      if (_len(n) < 1e-12) continue;
      if (_dot(n, expect) < 0) return true;
    }
    return false;
  };
  if ((startN && fanBad(verts[c0], rings[0], startN)) || (endN && fanBad(verts[c1], rings[m - 1], endN))) {
    throw new Error('makeLoft: a profile is too concave to cap — use a simple outline');
  }
  let signed = 0;
  for (let i = 0; i < triVerts.length; i += 3) {
    const a = verts[triVerts[i]];
    const b = verts[triVerts[i + 1]];
    const c = verts[triVerts[i + 2]];
    signed += a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2])
      + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  if (signed < 0) {
    for (let i = 0; i < triVerts.length; i += 3) {
      const tmp = triVerts[i + 1];
      triVerts[i + 1] = triVerts[i + 2];
      triVerts[i + 2] = tmp;
    }
  }
  return { verts, triVerts };
}

function _statusError(m) {
  if (!m || typeof m.status !== 'function') return 'not a manifold';
  const s = m.status();
  if (typeof s === 'string') return s === 'NoError' ? null : s;
  if (s && typeof s.value === 'number') return s.value === 0 ? null : `code ${s.value}`;
  return null;
}

export function buildAngledLoftSolid(Manifold, stations, opts = {}) {
  const Mesh = opts.Mesh;
  if (typeof Mesh !== 'function') {
    throw new Error('makeLoft: angled profiles need the Manifold Mesh constructor');
  }
  const planned = planAngledLoft(stations, opts);
  const ref = stations[0].plane;
  const localRings = planned.rings.map((ring) => ring.map((p) => _toLocal(ref, p)));
  const { verts, triVerts } = _buildTube(localRings);
  if (loftMeshSelfIntersects(
    verts.flat(),
    triVerts,
    3,
  )) {
    throw new Error(
      'makeLoft: loft would self-intersect — the turn between these planes is tighter than the profiles',
    );
  }
  const vp = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    vp[i * 3] = verts[i][0];
    vp[i * 3 + 1] = verts[i][1];
    vp[i * 3 + 2] = verts[i][2];
  }
  let solid;
  try {
    solid = new Manifold(new Mesh({
      numProp: 3,
      vertProperties: vp,
      triVerts: new Uint32Array(triVerts),
    }));
  } catch (e) {
    const msg = (e && e.message) || String(e);
    throw new Error(`makeLoft: loft is not a closed solid (${msg})`);
  }
  const se = _statusError(solid);
  if (se) {
    throw new Error(`makeLoft: loft is not a closed solid (${se})`);
  }
  const vol = typeof solid.volume === 'function' ? solid.volume() : 0;
  if (!(vol > 1e-9)) {
    throw new Error('makeLoft: result is EMPTY (volume 0) — check profiles have area and sit on different planes');
  }
  if (typeof solid.genus === 'function' && solid.genus() !== 0) {
    throw new Error('makeLoft: loft is not a simple solid');
  }
  return solid;
}

export function buildAngledLoftPreview(stations, sampleN = 32, opts = {}) {
  try {
    const planned = planAngledLoft(stations, {
      ...opts,
      resolution: Math.max(8, Math.round(Number(sampleN) || 32)),
    });
    return {
      plane: stations[0].plane,
      parallel: false,
      stations: planned.frames.map((frame, i) => ({
        offset: i,
        plane: {
          center: frame.origin.slice(),
          normal: frame.n.slice(),
          x: frame.x.slice(),
          y: frame.y.slice(),
        },
        ring: planned.locals[i],
        contour: planned.locals[i],
      })),
    };
  } catch {
    return null;
  }
}

function _triAreaNormal(a, b, c) {
  return _cross(_sub(b, a), _sub(c, a));
}

function _interval(p0, s0, p1, s1, p2, s2, dir, eps) {
  const marks = [];
  const edges = [[p0, s0, p1, s1], [p1, s1, p2, s2], [p2, s2, p0, s0]];
  for (const [p, sp, q, sq] of edges) {
    const az = Math.abs(sp) <= eps;
    const bz = Math.abs(sq) <= eps;
    if (az && bz) {
      marks.push(_dot(p, dir), _dot(q, dir));
    } else if (az) {
      marks.push(_dot(p, dir));
    } else if (!bz && sp * sq < 0) {
      const t = sp / (sp - sq);
      const ip = [
        p[0] + t * (q[0] - p[0]),
        p[1] + t * (q[1] - p[1]),
        p[2] + t * (q[2] - p[2]),
      ];
      marks.push(_dot(ip, dir));
    }
  }
  if (marks.length < 2) return null;
  let lo = Math.min(...marks);
  let hi = Math.max(...marks);
  if (hi - lo < eps) return null;
  return [lo, hi];
}

function _coplanarOverlap(a, b, c, d, e, f, n, eps) {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const p2 = (p) => (drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[0], p[2]] : [p[0], p[1]]);
  const A = p2(a);
  const B = p2(b);
  const C = p2(c);
  const D = p2(d);
  const E = p2(e);
  const F = p2(f);
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const proper = (p, q, r, s) => {
    const a1 = side(p, q, r);
    const a2 = side(p, q, s);
    const a3 = side(r, s, p);
    const a4 = side(r, s, q);
    if (Math.abs(a1) <= eps || Math.abs(a2) <= eps || Math.abs(a3) <= eps || Math.abs(a4) <= eps) {
      return false;
    }
    return a1 * a2 < 0 && a3 * a4 < 0;
  };
  const inside = (p, t0, t1, t2) => {
    const s0 = side(t0, t1, p);
    const s1 = side(t1, t2, p);
    const s2 = side(t2, t0, p);
    const pos = (s0 > eps) + (s1 > eps) + (s2 > eps);
    const neg = (s0 < -eps) + (s1 < -eps) + (s2 < -eps);
    return pos === 3 || neg === 3;
  };
  if (proper(A, B, D, E) || proper(A, B, E, F) || proper(A, B, F, D)) return true;
  if (proper(B, C, D, E) || proper(B, C, E, F) || proper(B, C, F, D)) return true;
  if (proper(C, A, D, E) || proper(C, A, E, F) || proper(C, A, F, D)) return true;
  if (inside(D, A, B, C) || inside(A, D, E, F)) return true;
  return false;
}

function _trisProperHit(a, b, c, d, e, f, eps) {
  const n1 = _triAreaNormal(a, b, c);
  const n1L = _len(n1);
  const n2 = _triAreaNormal(d, e, f);
  const n2L = _len(n2);
  if (n1L < eps || n2L < eps) return false;
  const sd = (n, p, q) => _dot(n, _sub(q, p)) / _len(n);
  const d0 = sd(n1, a, d);
  const d1 = sd(n1, a, e);
  const d2 = sd(n1, a, f);
  const a0 = sd(n2, d, a);
  const a1 = sd(n2, d, b);
  const a2 = sd(n2, d, c);
  const near = (x) => Math.abs(x) <= eps;
  const separated = (u, v, w) => (u > eps && v > eps && w > eps) || (u < -eps && v < -eps && w < -eps);
  if (separated(d0, d1, d2) || separated(a0, a1, a2)) return false;
  if (near(d0) && near(d1) && near(d2)) {
    return _coplanarOverlap(a, b, c, d, e, f, n1, eps);
  }
  const dir = _norm(_cross(n1, n2));
  if (!dir) return false;
  const i1 = _interval(a, a0, b, a1, c, a2, dir, eps);
  const i2 = _interval(d, d0, e, d1, f, d2, dir, eps);
  if (!i1 || !i2) return false;
  const lo = Math.max(i1[0], i2[0]);
  const hi = Math.min(i1[1], i2[1]);
  return hi - lo > eps;
}

/**
 * Proper triangle-triangle hits (shared edges and point touches do not count).
 * `vertProperties` is a flat xyz list (or interleaved with `numProp`).
 */
export function loftMeshSelfIntersects(vertProperties, triVerts, numProp = 3) {
  const np = numProp || 3;
  const raw = [];
  const nV = Math.floor(vertProperties.length / np);
  for (let i = 0; i < nV; i++) {
    raw.push([
      vertProperties[i * np],
      vertProperties[i * np + 1],
      vertProperties[i * np + 2],
    ]);
  }
  let scale = 0;
  for (const p of raw) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps = Math.max(1e-5, scale * 1e-6);
  const weld = new Map();
  const verts = [];
  const map = new Array(raw.length);
  const inv = 1 / Math.max(eps, 1e-5);
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const key = `${Math.round(p[0] * inv)},${Math.round(p[1] * inv)},${Math.round(p[2] * inv)}`;
    if (weld.has(key)) map[i] = weld.get(key);
    else {
      weld.set(key, verts.length);
      map[i] = verts.length;
      verts.push(p);
    }
  }
  const tris = [];
  for (let i = 0; i < triVerts.length; i += 3) {
    const a = map[triVerts[i]];
    const b = map[triVerts[i + 1]];
    const c = map[triVerts[i + 2]];
    if (a === b || b === c || c === a) continue;
    tris.push([a, b, c]);
  }
  const cell = Math.max(eps * 100, scale / 32 || 1);
  const bins = new Map();
  const triBox = tris.map(([a, b, c]) => {
    const pa = verts[a];
    const pb = verts[b];
    const pc = verts[c];
    return {
      min: [
        Math.min(pa[0], pb[0], pc[0]),
        Math.min(pa[1], pb[1], pc[1]),
        Math.min(pa[2], pb[2], pc[2]),
      ],
      max: [
        Math.max(pa[0], pb[0], pc[0]),
        Math.max(pa[1], pb[1], pc[1]),
        Math.max(pa[2], pb[2], pc[2]),
      ],
    };
  });
  const keyOf = (ix, iy, iz) => `${ix},${iy},${iz}`;
  for (let t = 0; t < tris.length; t++) {
    const box = triBox[t];
    const i0 = Math.floor(box.min[0] / cell);
    const j0 = Math.floor(box.min[1] / cell);
    const k0 = Math.floor(box.min[2] / cell);
    const i1 = Math.floor(box.max[0] / cell);
    const j1 = Math.floor(box.max[1] / cell);
    const k1 = Math.floor(box.max[2] / cell);
    for (let ix = i0; ix <= i1; ix++) {
      for (let iy = j0; iy <= j1; iy++) {
        for (let iz = k0; iz <= k1; iz++) {
          const key = keyOf(ix, iy, iz);
          if (!bins.has(key)) bins.set(key, []);
          bins.get(key).push(t);
        }
      }
    }
  }
  const seen = new Set();
  for (const list of bins.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ta = list[i];
        const tb = list[j];
        const id = ta < tb ? `${ta}:${tb}` : `${tb}:${ta}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const A = tris[ta];
        const B = tris[tb];
        if (A[0] === B[0] || A[0] === B[1] || A[0] === B[2]
          || A[1] === B[0] || A[1] === B[1] || A[1] === B[2]
          || A[2] === B[0] || A[2] === B[1] || A[2] === B[2]) {
          continue;
        }
        const ba = triBox[ta];
        const bb = triBox[tb];
        if (ba.max[0] < bb.min[0] - eps || bb.max[0] < ba.min[0] - eps) continue;
        if (ba.max[1] < bb.min[1] - eps || bb.max[1] < ba.min[1] - eps) continue;
        if (ba.max[2] < bb.min[2] - eps || bb.max[2] < ba.min[2] - eps) continue;
        if (_trisProperHit(
          verts[A[0]], verts[A[1]], verts[A[2]],
          verts[B[0]], verts[B[1]], verts[B[2]],
          eps,
        )) return true;
      }
    }
  }
  return false;
}
