/**
 * Touching face pairs between assembly parts.
 *
 * Broad phase hashes face bounding boxes. Narrow phase accepts a pair only
 * when a triangle centroid of one face projects inside a triangle of the
 * other, within the gap. A shared edge is not a bond: side faces of two
 * cubes meet on the interface perimeter and fail that test.
 *
 * The default gap is 0.05 mm or 1% of the shortest triangle edge, whichever
 * is larger. A new pair is bonded. A pair the user set to frictionless or
 * frictional keeps that kind, and frictional keeps its coefficient.
 * `enabled: false` is the off switch; an enabled pair omits the flag.
 */

/** Coulomb coefficient stored when a frictional pair does not set one. */
export const DEFAULT_FRICTION = 0.2;

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function hypot(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function pointAt(positions, index) {
  const i = index * 3;
  return [positions[i] || 0, positions[i + 1] || 0, positions[i + 2] || 0];
}

/** Gap in millimetres. An explicit positive override replaces the default. */
export function contactTolerance(minEdge, override) {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const edge = Number.isFinite(minEdge) && minEdge > 0 ? minEdge : 0;
  return Math.max(0.05, 0.01 * edge);
}

function facesOf(part, minEdge) {
  const positions = part.positions;
  const indices = part.indices;
  const faceIDs = part.faceIDs;
  const groups = new Map();
  const triangles = Math.floor(indices.length / 3);
  let shortest = minEdge;
  for (let t = 0; t < triangles; t += 1) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    const pa = pointAt(positions, ia);
    const pb = pointAt(positions, ib);
    const pc = pointAt(positions, ic);
    shortest = Math.min(shortest, hypot(sub(pa, pb)), hypot(sub(pb, pc)), hypot(sub(pc, pa)));
    const faceID = faceIDs && faceIDs.length > t ? (faceIDs[t] >>> 0) : 0;
    let face = groups.get(faceID);
    if (!face) {
      face = {
        part: String(part.id),
        faceID,
        tris: [],
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
      };
      groups.set(faceID, face);
    }
    const centroid = [
      (pa[0] + pb[0] + pc[0]) / 3,
      (pa[1] + pb[1] + pc[1]) / 3,
      (pa[2] + pb[2] + pc[2]) / 3,
    ];
    face.tris.push({ pa, pb, pc, centroid });
    for (const p of [pa, pb, pc]) {
      for (let k = 0; k < 3; k += 1) {
        if (p[k] < face.min[k]) face.min[k] = p[k];
        if (p[k] > face.max[k]) face.max[k] = p[k];
      }
    }
  }
  return { faces: [...groups.values()], minEdge: shortest };
}

function boxesOverlap(a, b, tol) {
  for (let k = 0; k < 3; k += 1) {
    if (a.max[k] + tol < b.min[k] || b.max[k] + tol < a.min[k]) return false;
  }
  return true;
}

function projectInside(tri, point, tol) {
  const ab = sub(tri.pb, tri.pa);
  const ac = sub(tri.pc, tri.pa);
  const n = cross(ab, ac);
  const nn = hypot(n);
  if (!(nn > 0)) return false;
  const signed = dot(n, sub(point, tri.pa)) / nn;
  if (Math.abs(signed) > tol) return false;
  const unit = [n[0] / nn, n[1] / nn, n[2] / nn];
  const proj = [
    point[0] - unit[0] * signed,
    point[1] - unit[1] * signed,
    point[2] - unit[2] * signed,
  ];
  const v2 = sub(proj, tri.pa);
  const dot00 = dot(ab, ab);
  const dot01 = dot(ab, ac);
  const dot11 = dot(ac, ac);
  const dot02 = dot(ab, v2);
  const dot12 = dot(ac, v2);
  const denom = dot00 * dot11 - dot01 * dot01;
  if (!(Math.abs(denom) > 1e-18)) return false;
  const inv = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  const eps = 1e-6;
  return u >= -eps && v >= -eps && u + v <= 1 + eps;
}

function centroidsHit(from, onto, tol) {
  for (let i = 0; i < from.tris.length; i += 1) {
    const centroid = from.tris[i].centroid;
    for (let j = 0; j < onto.tris.length; j += 1) {
      if (projectInside(onto.tris[j], centroid, tol)) return true;
    }
  }
  return false;
}

function narrowHit(a, b, tol) {
  return centroidsHit(a, b, tol) || centroidsHit(b, a, tol);
}

function cellRange(face, tol, cell) {
  const out = [];
  const i0 = Math.floor((face.min[0] - tol) / cell);
  const j0 = Math.floor((face.min[1] - tol) / cell);
  const k0 = Math.floor((face.min[2] - tol) / cell);
  const i1 = Math.floor((face.max[0] + tol) / cell);
  const j1 = Math.floor((face.max[1] + tol) / cell);
  const k1 = Math.floor((face.max[2] + tol) / cell);
  for (let i = i0; i <= i1; i += 1) {
    for (let j = j0; j <= j1; j += 1) {
      for (let k = k0; k <= k1; k += 1) out.push(`${i},${j},${k}`);
    }
  }
  return out;
}

function pairKey(a, b) {
  const left = `${a.part}\0${a.faceID}`;
  const right = `${b.part}\0${b.faceID}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function orderedPair(a, b) {
  const left = { part: a.part, faceID: a.faceID };
  const right = { part: b.part, faceID: b.faceID };
  const ka = `${left.part}\0${String(left.faceID).padStart(8, '0')}`;
  const kb = `${right.part}\0${String(right.faceID).padStart(8, '0')}`;
  if (ka <= kb) return { a: left, b: right, kind: 'bonded' };
  return { a: right, b: left, kind: 'bonded' };
}

/**
 * `parts` are `{ id, positions, indices, faceIDs }` in one frame (world).
 * Returns bonded pairs and the gap that was used.
 */
export function detectContacts(parts, options = {}) {
  const list = (Array.isArray(parts) ? parts : []).filter((part) => (
    part && part.positions?.length && part.indices?.length && part.id != null
  ));
  let minEdge = Infinity;
  const grouped = list.map((part) => {
    const built = facesOf(part, minEdge);
    minEdge = built.minEdge;
    return built.faces;
  });
  const tol = contactTolerance(Number.isFinite(minEdge) ? minEdge : 0, options.tolerance);
  const cell = Math.max(tol * 4, 1e-3);
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < grouped.length; i += 1) {
    for (let j = i + 1; j < grouped.length; j += 1) {
      const buckets = new Map();
      for (const face of grouped[i]) {
        for (const key of cellRange(face, tol, cell)) {
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
          }
          bucket.push(face);
        }
      }
      for (const face of grouped[j]) {
        const candidates = new Set();
        for (const key of cellRange(face, tol, cell)) {
          const bucket = buckets.get(key);
          if (!bucket) continue;
          for (let n = 0; n < bucket.length; n += 1) candidates.add(bucket[n]);
        }
        for (const other of candidates) {
          if (!boxesOverlap(other, face, tol)) continue;
          const id = pairKey(other, face);
          if (seen.has(id)) continue;
          if (!narrowHit(other, face, tol)) continue;
          seen.add(id);
          pairs.push(orderedPair(other, face));
        }
      }
    }
  }
  pairs.sort((p, q) => pairKey(p.a, p.b).localeCompare(pairKey(q.a, q.b)));
  return { pairs, tolerance: tol, minEdge: Number.isFinite(minEdge) ? minEdge : 0 };
}

function sameEnds(a, b) {
  if (!a || !b) return false;
  return String(a.part) === String(b.part) && Number(a.faceID) === Number(b.faceID);
}

function samePair(left, right) {
  return (sameEnds(left.a, right.a) && sameEnds(left.b, right.b))
    || (sameEnds(left.a, right.b) && sameEnds(left.b, right.a));
}

/** Keep a disabled pair, and keep a friction law the user already chose. */
export function mergeContactPairs(detected, previous) {
  const prior = Array.isArray(previous) ? previous : [];
  return (detected || []).map((pair) => {
    const old = prior.find((row) => samePair(row, pair));
    const kind = old && (old.kind === 'frictionless' || old.kind === 'frictional')
      ? old.kind
      : 'bonded';
    const next = { a: pair.a, b: pair.b, kind };
    if (kind === 'frictional') {
      const mu = old && typeof old.mu === 'number' && Number.isFinite(old.mu) && old.mu >= 0
        ? old.mu
        : DEFAULT_FRICTION;
      next.mu = mu;
    }
    if (old && old.enabled === false) next.enabled = false;
    return next;
  });
}
