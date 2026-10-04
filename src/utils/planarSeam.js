/**
 * A fillet boolean can leave a needle between two copies of a cap vertex.
 * The needle is about 0.001mm tall, its normal is sideways, and flat shading
 * draws it as a seam through the face. It is not the curved blend.
 *
 * Drop it from the drawn mesh only when every vertex already lies on another
 * triangle of that face. A thin fillet facet is the only cover of its own
 * surface, so it stays.
 */

const FIN_HEIGHT_MM = 0.002;
const FIN_MIN_EDGE_MM = 1;
const COVER_MM = 0.02;
const COVER_AREA = 0.05;

function triSpan(positions, indices, t) {
  const i0 = indices[t * 3];
  const i1 = indices[t * 3 + 1];
  const i2 = indices[t * 3 + 2];
  const ax = positions[i1 * 3] - positions[i0 * 3];
  const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
  const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
  const bx = positions[i2 * 3] - positions[i0 * 3];
  const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
  const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const area = 0.5 * Math.hypot(cx, cy, cz);
  const e12x = positions[i2 * 3] - positions[i1 * 3];
  const e12y = positions[i2 * 3 + 1] - positions[i1 * 3 + 1];
  const e12z = positions[i2 * 3 + 2] - positions[i1 * 3 + 2];
  const longest = Math.sqrt(Math.max(
    ax * ax + ay * ay + az * az,
    bx * bx + by * by + bz * bz,
    e12x * e12x + e12y * e12y + e12z * e12z,
  ));
  return { area, longest, i0, i1, i2 };
}

/** Long triangle shorter than FIN_HEIGHT_MM. The curved fillet is taller. */
export function isPlanarFin(positions, indices, t) {
  const span = triSpan(positions, indices, t);
  if (!(span.longest > FIN_MIN_EDGE_MM)) return false;
  const height = (2 * span.area) / span.longest;
  return height < FIN_HEIGHT_MM;
}

function distPointTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(ax + v * abx - px, ay + v * aby - py, az + v * abz - pz);
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(ax + w * acx - px, ay + w * acy - py, az + w * acz - pz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(
      bx + w * (cx - bx) - px,
      by + w * (cy - by) - py,
      bz + w * (cz - bz) - pz,
    );
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return Math.hypot(
    ax + abx * v + acx * w - px,
    ay + aby * v + acy * w - py,
    az + abz * v + acz * w - pz,
  );
}

function coverBuckets(covers) {
  const cell = 4;
  const inv = 1 / cell;
  const buckets = new Map();
  for (let i = 0; i < covers.length; i++) {
    const c = covers[i];
    const x0 = Math.floor(c.minX * inv);
    const x1 = Math.floor(c.maxX * inv);
    const y0 = Math.floor(c.minY * inv);
    const y1 = Math.floor(c.maxY * inv);
    const z0 = Math.floor(c.minZ * inv);
    const z1 = Math.floor(c.maxZ * inv);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x}|${y}|${z}`;
          let list = buckets.get(key);
          if (!list) {
            list = [];
            buckets.set(key, list);
          }
          list.push(c);
        }
      }
    }
  }
  return { buckets, inv };
}

function vertexOnCover(positions, buckets, inv, vi) {
  const px = positions[vi * 3];
  const py = positions[vi * 3 + 1];
  const pz = positions[vi * 3 + 2];
  const list = buckets.get(`${Math.floor(px * inv)}|${Math.floor(py * inv)}|${Math.floor(pz * inv)}`);
  if (!list) return false;
  const cover2 = COVER_MM * COVER_MM;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (px < c.minX || px > c.maxX || py < c.minY || py > c.maxY || pz < c.minZ || pz > c.maxZ) continue;
    const d = distPointTri(px, py, pz, c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.cx, c.cy, c.cz);
    if (d * d <= cover2) return true;
  }
  return false;
}

/**
 * Drop planar-seam fins from a drawn mesh. `positions` is tightly packed xyz.
 * A fin is dropped only when each vertex already lies on another triangle of
 * real area, so the face under it is unchanged. Face ids stay aligned with
 * the kept triangles. Returns the same index array when there is nothing to drop.
 */
export function dropPlanarFins(positions, indices, faceIDs = null) {
  const nTri = Math.floor(indices.length / 3);
  const spans = new Array(nTri);
  const fin = new Uint8Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const span = triSpan(positions, indices, t);
    spans[t] = span;
    if (span.longest > FIN_MIN_EDGE_MM && (2 * span.area) / span.longest < FIN_HEIGHT_MM) fin[t] = 1;
  }
  let nFin = 0;
  for (let t = 0; t < nTri; t++) if (fin[t]) nFin++;
  if (!nFin) return { indices, faceIDs, dropped: 0 };

  const pad = COVER_MM;
  const covers = [];
  for (let t = 0; t < nTri; t++) {
    if (fin[t] || spans[t].area <= COVER_AREA) continue;
    const i0 = spans[t].i0;
    const i1 = spans[t].i1;
    const i2 = spans[t].i2;
    const ax = positions[i0 * 3];
    const ay = positions[i0 * 3 + 1];
    const az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3];
    const by = positions[i1 * 3 + 1];
    const bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3];
    const cy = positions[i2 * 3 + 1];
    const cz = positions[i2 * 3 + 2];
    covers.push({
      ax, ay, az, bx, by, bz, cx, cy, cz,
      minX: Math.min(ax, bx, cx) - pad,
      maxX: Math.max(ax, bx, cx) + pad,
      minY: Math.min(ay, by, cy) - pad,
      maxY: Math.max(ay, by, cy) + pad,
      minZ: Math.min(az, bz, cz) - pad,
      maxZ: Math.max(az, bz, cz) + pad,
    });
  }

  const grid = coverBuckets(covers);
  const keep = [];
  for (let t = 0; t < nTri; t++) {
    if (!fin[t]) {
      keep.push(t);
      continue;
    }
    const span = spans[t];
    const covered = vertexOnCover(positions, grid.buckets, grid.inv, span.i0)
      && vertexOnCover(positions, grid.buckets, grid.inv, span.i1)
      && vertexOnCover(positions, grid.buckets, grid.inv, span.i2);
    if (!covered) keep.push(t);
  }
  if (keep.length === nTri) return { indices, faceIDs, dropped: 0 };
  const next = new Uint32Array(keep.length * 3);
  const fids = faceIDs && faceIDs.length ? new Array(keep.length) : null;
  for (let i = 0; i < keep.length; i++) {
    const t = keep[i];
    next[i * 3] = indices[t * 3];
    next[i * 3 + 1] = indices[t * 3 + 1];
    next[i * 3 + 2] = indices[t * 3 + 2];
    if (fids) fids[i] = faceIDs[t];
  }
  return { indices: next, faceIDs: fids, dropped: nTri - keep.length };
}
