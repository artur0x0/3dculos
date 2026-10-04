/**
 * Closed surface for one piece of the Pieces preview.
 *
 * listCutPieces still buckets the original triangles (that is what a tap
 * means). Drawing those triangles paints the uncut solid: a triangle that
 * crosses the plane is kept whole, so both colors occupy the same volume,
 * and a double-sided draw shows the inside of the shell. This clips each
 * triangle to the piece's half-space and caps the cut, so the preview is
 * that piece's body.
 */
import { Earcut } from 'three/src/extras/Earcut.js';
import { CUT_PLANE_EPS } from './cutMode.js';

const QUANT = 1e5;

function readPos(positions, i) {
  if (positions && typeof positions.getX === 'function') {
    return [positions.getX(i), positions.getY(i), positions.getZ(i)];
  }
  const arr = positions?.array || positions;
  if (!arr) return [0, 0, 0];
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

function readIndex(index) {
  if (!index) return null;
  return index.array || index;
}

function distToPlane(p, plane) {
  return p[0] * plane.normal[0] + p[1] * plane.normal[1] + p[2] * plane.normal[2] - plane.originOffset;
}

function sideOf(d) {
  if (d > CUT_PLANE_EPS) return 1;
  if (d < -CUT_PLANE_EPS) return -1;
  return 0;
}

function lerpPoint(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function crossPoint(a, b, da, db) {
  const denom = da - db;
  const t = Math.abs(denom) < 1e-20 ? 0 : da / denom;
  return lerpPoint(a, b, Math.min(1, Math.max(0, t)));
}

function onPlane(p, plane) {
  return Math.abs(distToPlane(p, plane)) <= CUT_PLANE_EPS * 10;
}

function projectToPlane(p, plane) {
  const d = distToPlane(p, plane);
  return [
    p[0] - plane.normal[0] * d,
    p[1] - plane.normal[1] * d,
    p[2] - plane.normal[2] * d,
  ];
}

function triArea2(a, b, c) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return cx * cx + cy * cy + cz * cz;
}

function pushTri(out, a, b, c) {
  if (triArea2(a, b, c) < 1e-16) return;
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function fan(out, poly) {
  for (let i = 1; i + 1 < poly.length; i++) pushTri(out, poly[0], poly[i], poly[i + 1]);
}

/** Keep the half-space. `side` is '+' (d >= 0) or '-' (d <= 0). */
function clipPolygon(poly, plane, side) {
  const keepPos = side !== '-';
  const inside = (d) => (keepPos ? d >= -CUT_PLANE_EPS : d <= CUT_PLANE_EPS);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const s = poly[i];
    const e = poly[(i + 1) % poly.length];
    const ds = distToPlane(s, plane);
    const de = distToPlane(e, plane);
    const sin = inside(ds);
    const ein = inside(de);
    if (sin && ein) out.push(e);
    else if (sin && !ein) out.push(crossPoint(s, e, ds, de));
    else if (!sin && ein) {
      out.push(crossPoint(s, e, ds, de));
      out.push(e);
    }
  }
  return dedupePoly(out);
}

function dedupePoly(poly) {
  const out = [];
  for (const p of poly) {
    const prev = out[out.length - 1];
    if (prev && triArea2(prev, p, p) === 0 && Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) < 1e-8) {
      continue;
    }
    out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-8) out.pop();
  }
  return out;
}

function qkey(p) {
  return `${Math.round(p[0] * QUANT)},${Math.round(p[1] * QUANT)},${Math.round(p[2] * QUANT)}`;
}

function planeBasis(normal) {
  const n = normal;
  const h = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const cx = h[1] * n[2] - h[2] * n[1];
  const cy = h[2] * n[0] - h[0] * n[2];
  const cz = h[0] * n[1] - h[1] * n[0];
  const cl = Math.hypot(cx, cy, cz) || 1;
  const x = [cx / cl, cy / cl, cz / cl];
  const y = [
    n[1] * x[2] - n[2] * x[1],
    n[2] * x[0] - n[0] * x[2],
    n[0] * x[1] - n[1] * x[0],
  ];
  return { x, y };
}

function to2(p, origin, basis) {
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];
  const dz = p[2] - origin[2];
  return [
    dx * basis.x[0] + dy * basis.x[1] + dz * basis.x[2],
    dx * basis.y[0] + dy * basis.y[1] + dz * basis.y[2],
  ];
}

function signedArea2(loop) {
  let a = 0;
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1];
    const yj = poly[j][1];
    const xi = poly[i][0];
    const xj = poly[j][0];
    const hit = ((yi > pt[1]) !== (yj > pt[1]))
      && (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-20) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function centroid2(loop) {
  let x = 0;
  let y = 0;
  for (const p of loop) {
    x += p[0];
    y += p[1];
  }
  const n = loop.length || 1;
  return [x / n, y / n];
}

/**
 * Boundary edges of the clip, with opposite pairs cancelled so a shared
 * on-plane edge between two kept triangles is not a cut.
 */
function capLoops(edges) {
  const pts = new Map();
  const nexts = new Map();
  const pending = new Map();
  for (const [a, b] of edges) {
    const ka = qkey(a);
    const kb = qkey(b);
    if (ka === kb) continue;
    const rev = `${kb}>${ka}`;
    if (pending.has(rev)) {
      pending.delete(rev);
      continue;
    }
    pending.set(`${ka}>${kb}`, [a, b]);
    if (!pts.has(ka)) pts.set(ka, a);
    if (!pts.has(kb)) pts.set(kb, b);
  }
  for (const [id, [a]] of pending) {
    const ka = id.slice(0, id.indexOf('>'));
    const kb = id.slice(id.indexOf('>') + 1);
    if (!pts.has(ka)) pts.set(ka, a);
    const list = nexts.get(ka);
    if (list) list.push(kb);
    else nexts.set(ka, [kb]);
  }

  const used = new Set();
  const loops = [];
  for (const [ka, outs] of nexts) {
    for (const kb0 of outs) {
      const startId = `${ka}>${kb0}`;
      if (used.has(startId)) continue;
      const loop = [pts.get(ka)];
      let cur = ka;
      let nxt = kb0;
      let guard = 0;
      let closed = false;
      while (guard++ < 100000) {
        const id = `${cur}>${nxt}`;
        if (used.has(id)) break;
        used.add(id);
        loop.push(pts.get(nxt));
        if (nxt === ka) {
          closed = true;
          break;
        }
        const opts = (nexts.get(nxt) || []).filter((n) => !used.has(`${nxt}>${n}`));
        if (!opts.length) break;
        cur = nxt;
        nxt = opts[0];
      }
      if (closed && loop.length >= 4) {
        loop.pop();
        loops.push(loop);
      }
    }
  }
  return loops;
}

function triangulateCaps(out, loops, plane) {
  if (!loops.length) return;
  const origin = loops[0][0];
  const basis = planeBasis(plane.normal);
  const flat = loops.map((loop) => ({
    loop,
    uv: loop.map((p) => to2(p, origin, basis)),
  }));
  const depth = flat.map((item) => {
    const c = centroid2(item.uv);
    const area = Math.abs(signedArea2(item.uv));
    let n = 0;
    for (let i = 0; i < flat.length; i++) {
      if (flat[i] === item) continue;
      // A centered hole contains the outer loop's centroid. Only a larger
      // loop can be a container, so that pair does not count both ways.
      if (Math.abs(signedArea2(flat[i].uv)) <= area) continue;
      if (pointInPoly(c, flat[i].uv)) n++;
    }
    return n;
  });
  for (let i = 0; i < flat.length; i++) {
    if (depth[i] % 2 !== 0) continue;
    const holes = [];
    for (let h = 0; h < flat.length; h++) {
      if (depth[h] !== depth[i] + 1) continue;
      if (pointInPoly(centroid2(flat[h].uv), flat[i].uv)) holes.push(flat[h]);
    }
    const data = [];
    const verts = [];
    const holeIndices = [];
    for (const uv of flat[i].uv) {
      data.push(uv[0], uv[1]);
    }
    verts.push(...flat[i].loop);
    for (const hole of holes) {
      holeIndices.push(verts.length);
      for (let k = 0; k < hole.uv.length; k++) {
        data.push(hole.uv[k][0], hole.uv[k][1]);
        verts.push(hole.loop[k]);
      }
    }
    const idx = Earcut.triangulate(data, holeIndices, 2);
    for (let t = 0; t + 2 < idx.length; t += 3) {
      pushTri(out, verts[idx[t]], verts[idx[t + 1]], verts[idx[t + 2]]);
    }
  }
}

/**
 * Triangle positions (flat xyz, outward winding) for one piece.
 * A body that does not cross the plane is copied. A crossing body is clipped
 * and capped on the plane.
 * @param {'+'|'-'} side
 * @returns {number[]}
 */
export function buildCutPiecePositions(positions, index, triangles, plane, side) {
  const idx = readIndex(index);
  const tris = Array.isArray(triangles) ? triangles : [];
  const out = [];
  if (!idx || !plane?.normal || !tris.length) return out;
  const keep = side === '-' ? '-' : '+';
  let crosses = false;
  for (const t of tris) {
    const a = readPos(positions, idx[t * 3]);
    const b = readPos(positions, idx[t * 3 + 1]);
    const c = readPos(positions, idx[t * 3 + 2]);
    const sa = sideOf(distToPlane(a, plane));
    const sb = sideOf(distToPlane(b, plane));
    const sc = sideOf(distToPlane(c, plane));
    if ((sa > 0 || sb > 0 || sc > 0) && (sa < 0 || sb < 0 || sc < 0)) {
      crosses = true;
      break;
    }
  }
  if (!crosses) {
    const want = keep === '+' ? 1 : -1;
    for (const t of tris) {
      const a = readPos(positions, idx[t * 3]);
      const b = readPos(positions, idx[t * 3 + 1]);
      const c = readPos(positions, idx[t * 3 + 2]);
      const s = sideOf(distToPlane(a, plane)) || sideOf(distToPlane(b, plane)) || sideOf(distToPlane(c, plane));
      if (s === 0 || s === want) pushTri(out, a, b, c);
    }
    return out;
  }

  const capEdges = [];
  for (const t of tris) {
    const poly0 = [
      readPos(positions, idx[t * 3]),
      readPos(positions, idx[t * 3 + 1]),
      readPos(positions, idx[t * 3 + 2]),
    ];
    const s0 = sideOf(distToPlane(poly0[0], plane));
    const s1 = sideOf(distToPlane(poly0[1], plane));
    const s2 = sideOf(distToPlane(poly0[2], plane));
    if (s0 === 0 && s1 === 0 && s2 === 0) continue;
    const entirely = (s0 <= 0 && s1 <= 0 && s2 <= 0) || (s0 >= 0 && s1 >= 0 && s2 >= 0);
    const onWantedSide = keep === '+'
      ? (s0 >= 0 && s1 >= 0 && s2 >= 0)
      : (s0 <= 0 && s1 <= 0 && s2 <= 0);
    if (entirely) {
      if (onWantedSide && (s0 !== 0 || s1 !== 0 || s2 !== 0)) pushTri(out, poly0[0], poly0[1], poly0[2]);
      continue;
    }
    const poly = clipPolygon(poly0, plane, keep);
    if (poly.length < 3) continue;
    fan(out, poly);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (!onPlane(a, plane) || !onPlane(b, plane)) continue;
      // Opposite the clipped face, so the cap and the wall share the edge
      // with opposite winding.
      capEdges.push([projectToPlane(b, plane), projectToPlane(a, plane)]);
    }
  }
  triangulateCaps(out, capLoops(capEdges), plane);
  return out;
}
