/**
 * Face / boundary-edge ids for Fillet mode (edge-spec A).
 *
 * Ids are assigned from the current mesh:
 * - A face id is the minimum Manifold `faceID` in a coplanar connected
 *   group (0.1° / same plane — same gate as c4MeshData's planar merge).
 * - A boundary-edge id groups triangle segments that share one unordered
 *   face pair and connect through vertices. Collinear tessellation of one
 *   CAD edge is one id; a curved rim (each facet its own face) stays many.
 *
 * Manifold faceID is provenance, not an eternal CAD edge. Booleans can
 * merge or split faces, so a later script run that no longer has the same
 * ids fails loud ("re-pick edges") instead of guessing.
 *
 * Pick / overlay candidates are design edges only. A boundary is dropped when
 * the dihedral is shallower than BOUNDARY_SHALLOW_DEG (fillet-arc steps,
 * smooth loft seams) or the smaller face is below BOUNDARY_SMALL_FACE_FRAC
 * of the largest face (blend facets and their end-cap chords). Sharp edges
 * between substantial faces stay, and ids are assigned only to that set.
 */

const PLANAR_COS = Math.cos((0.1 * Math.PI) / 180);
const FEATURE_COS = Math.cos((2 * Math.PI) / 180);

/** Tessellation seam / fillet-arc step. 90° box corners stay; ~4–11° facets do not. */
export const BOUNDARY_SHALLOW_DEG = 15;
/**
 * Smaller adjacent face vs the largest face on the solid.
 * A 12-seg fillet facet on a 40×30 box is ~3% of the big face; loft wall
 * facets on a circle–circle loft are ~13%. 5% drops the blend, keeps the rim.
 */
export const BOUNDARY_SMALL_FACE_FRAC = 0.05;
/** Hard cap so Fillet mode cannot allocate a sprite per micro-triangle. */
export const FILLET_OVERLAY_LABEL_CAP = 240;

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
function len(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
function norm(v) {
  const L = len(v) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

function findOf(parent) {
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  return { find, union };
}

/**
 * @param {{ positions: ArrayLike<number>, indices: ArrayLike<number>, faceIDs: ArrayLike<number> }} mesh
 * @returns {{ faces: object[], edges: object[] }}
 */
export function indexBoundaryEdges(mesh) {
  const positions = mesh?.positions;
  const indices = mesh?.indices;
  const faceIDs = mesh?.faceIDs;
  if (!positions || !indices || !faceIDs) return { faces: [], edges: [] };
  const numTri = Math.floor(indices.length / 3);
  if (faceIDs.length < numTri || numTri < 1) return { faces: [], edges: [] };

  const posAt = (i) => {
    const o = i * 3;
    return [positions[o], positions[o + 1], positions[o + 2]];
  };

  const tris = [];
  for (let t = 0; t < numTri; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const v0 = posAt(a);
    const v1 = posAt(b);
    const v2 = posAt(c);
    const cr = cross(sub(v1, v0), sub(v2, v0));
    const area = 0.5 * len(cr);
    const n = area > 1e-18 ? norm(cr) : [0, 0, 1];
    const raw = Number(faceIDs[t]);
    tris.push({
      a, b, c, v0, v1, v2, n, area,
      raw: Number.isFinite(raw) ? raw : t,
      centroid: [
        (v0[0] + v1[0] + v2[0]) / 3,
        (v0[1] + v1[1] + v2[1]) / 3,
        (v0[2] + v1[2] + v2[2]) / 3,
      ],
    });
  }

  const parent = tris.map((_, i) => i);
  const { find, union } = findOf(parent);
  const edgeTris = new Map();
  const addE = (u, w, t) => {
    const key = u < w ? `${u}-${w}` : `${w}-${u}`;
    if (!edgeTris.has(key)) edgeTris.set(key, []);
    edgeTris.get(key).push(t);
  };
  tris.forEach((tri, i) => {
    addE(tri.a, tri.b, i);
    addE(tri.b, tri.c, i);
    addE(tri.c, tri.a, i);
  });
  for (const list of edgeTris.values()) {
    if (list.length !== 2) continue;
    const i0 = list[0];
    const i1 = list[1];
    const A = tris[i0];
    const B = tris[i1];
    if (dot(A.n, B.n) < PLANAR_COS) continue;
    const offA = dot(A.v0, A.n);
    const offB = dot(B.v0, A.n);
    if (Math.abs(offA - offB) > 1e-3) continue;
    union(i0, i1);
  }

  const groups = new Map();
  tris.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  const faceOfTri = new Array(numTri);
  const faces = [];
  for (const members of groups.values()) {
    let id = Infinity;
    let areaSum = 0;
    const c = [0, 0, 0];
    const nsum = [0, 0, 0];
    for (const i of members) {
      const tri = tris[i];
      if (tri.raw < id) id = tri.raw;
      areaSum += tri.area;
      c[0] += tri.centroid[0] * tri.area;
      c[1] += tri.centroid[1] * tri.area;
      c[2] += tri.centroid[2] * tri.area;
      nsum[0] += tri.n[0] * tri.area;
      nsum[1] += tri.n[1] * tri.area;
      nsum[2] += tri.n[2] * tri.area;
    }
    const face = {
      id: Number.isFinite(id) ? id : 0,
      area: areaSum,
      center: areaSum > 1e-18
        ? [c[0] / areaSum, c[1] / areaSum, c[2] / areaSum]
        : tris[members[0]].centroid.slice(),
      normal: norm(nsum),
    };
    const fi = faces.length;
    faces.push(face);
    for (const i of members) faceOfTri[i] = fi;
  }

  const segments = [];
  for (const [key, list] of edgeTris) {
    if (list.length !== 2) continue;
    const i0 = list[0];
    const i1 = list[1];
    const f0 = faceOfTri[i0];
    const f1 = faceOfTri[i1];
    if (f0 === f1) continue;
    const A = tris[i0];
    const B = tris[i1];
    if (dot(A.n, B.n) > FEATURE_COS) continue;
    const parts = key.split('-');
    const ia = Number(parts[0]);
    const ib = Number(parts[1]);
    const va = posAt(ia);
    const vb = posAt(ib);
    const L = Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]);
    if (!(L > 1e-9)) continue;
    const faceA = faces[f0].id;
    const faceB = faces[f1].id;
    const nA = faces[f0].normal;
    const nB = faces[f1].normal;
    const dihedralDeg = Math.acos(Math.min(1, Math.max(-1, dot(nA, nB)))) * 180 / Math.PI;
    segments.push({
      key,
      a: ia,
      b: ib,
      va,
      vb,
      length: L,
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      faceA,
      faceB,
      pairKey: faceA < faceB ? `${faceA}:${faceB}` : `${faceB}:${faceA}`,
      dihedralDeg,
      minFaceArea: Math.min(faces[f0].area || 0, faces[f1].area || 0),
      n0: nA.slice(),
      n1: nB.slice(),
    });
  }

  const byPair = new Map();
  for (const seg of segments) {
    if (!byPair.has(seg.pairKey)) byPair.set(seg.pairKey, []);
    byPair.get(seg.pairKey).push(seg);
  }

  const boundaries = [];
  for (const group of byPair.values()) {
    const p = group.map((_, i) => i);
    const uf = findOf(p);
    const vertTo = new Map();
    group.forEach((seg, i) => {
      for (const v of [seg.a, seg.b]) {
        if (!vertTo.has(v)) vertTo.set(v, []);
        vertTo.get(v).push(i);
      }
    });
    for (const list of vertTo.values()) {
      for (let k = 1; k < list.length; k++) uf.union(list[0], list[k]);
    }
    const comps = new Map();
    group.forEach((seg, i) => {
      const r = uf.find(i);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(seg);
    });
    for (const segs of comps.values()) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let total = 0;
      for (const seg of segs) {
        cx += seg.mid[0] * seg.length;
        cy += seg.mid[1] * seg.length;
        cz += seg.mid[2] * seg.length;
        total += seg.length;
      }
      boundaries.push({
        faceA: segs[0].faceA,
        faceB: segs[0].faceB,
        length: total,
        dihedralDeg: segs[0].dihedralDeg,
        minFaceArea: segs[0].minFaceArea,
        n0: segs[0].n0,
        n1: segs[0].n1,
        mid: total > 0
          ? [cx / total, cy / total, cz / total]
          : segs[0].mid.slice(),
        segments: segs.map((seg) => ({
          key: seg.key,
          a: seg.a,
          b: seg.b,
          va: seg.va.slice(),
          vb: seg.vb.slice(),
          length: seg.length,
          mid: seg.mid.slice(),
        })),
      });
    }
  }

  const maxArea = faces.reduce((m, f) => Math.max(m, Number(f.area) || 0), 0);
  const smallLimit = BOUNDARY_SMALL_FACE_FRAC * maxArea;
  const eligible = boundaries.filter((edge) => {
    if (!(edge.dihedralDeg >= BOUNDARY_SHALLOW_DEG)) return false;
    if (!(maxArea > 0)) return true;
    return edge.minFaceArea >= smallLimit;
  });

  eligible.sort((a, b) => {
    const a0 = Math.min(a.faceA, a.faceB);
    const b0 = Math.min(b.faceA, b.faceB);
    if (a0 !== b0) return a0 - b0;
    const a1 = Math.max(a.faceA, a.faceB);
    const b1 = Math.max(b.faceA, b.faceB);
    if (a1 !== b1) return a1 - b1;
    for (let k = 0; k < 3; k++) {
      const d = a.mid[k] - b.mid[k];
      if (Math.abs(d) > 1e-6) return d;
    }
    return 0;
  });
  eligible.forEach((edge, i) => {
    edge.id = i;
  });

  const pairCounts = new Map();
  for (const edge of eligible) {
    const pk = edge.faceA < edge.faceB
      ? `${edge.faceA}:${edge.faceB}`
      : `${edge.faceB}:${edge.faceA}`;
    pairCounts.set(pk, (pairCounts.get(pk) || 0) + 1);
    edge.pairCount = 0;
    edge._pairKey = pk;
  }
  for (const edge of eligible) {
    edge.pairCount = pairCounts.get(edge._pairKey) || 1;
    delete edge._pairKey;
  }

  return { faces, edges: eligible };
}

/**
 * Read a three.js BufferGeometry (position + index) plus a per-triangle faceID list.
 * @param {object} geometry
 * @param {ArrayLike<number>|null} faceIDs
 */
export function indexBoundaryEdgesFromGeometry(geometry, faceIDs) {
  const pos = geometry?.attributes?.position?.array;
  const index = geometry?.index?.array;
  if (!pos || !index || !faceIDs) return { faces: [], edges: [] };
  return indexBoundaryEdges({ positions: pos, indices: index, faceIDs });
}

/**
 * Attach boundaryId / faceA / faceB / pairCount onto feature edges (same vertex keys).
 * @param {object[]} featureEdges
 * @param {{ edges: object[] }} topo
 */
export function annotateFeatureEdges(featureEdges, topo) {
  const byKey = new Map();
  for (const edge of topo?.edges || []) {
    for (const seg of edge.segments) {
      byKey.set(seg.key, {
        boundaryId: edge.id,
        faceA: edge.faceA,
        faceB: edge.faceB,
        pairCount: edge.pairCount,
      });
    }
  }
  return (featureEdges || []).map((edge) => {
    const a = edge.a;
    const b = edge.b;
    const key = edge.key || (a < b ? `${a}-${b}` : `${b}-${a}`);
    const info = byKey.get(key);
    return info ? { ...edge, ...info } : edge;
  });
}

/**
 * Copy boundary ids from freshly annotated feature edges onto a selection.
 * Returns the same array when nothing changed.
 * @param {object[]} selected
 * @param {object[]} featureEdges
 */
export function stampBoundaryOnSelection(selected, featureEdges) {
  const list = Array.isArray(selected) ? selected : [];
  if (!list.length || !featureEdges?.length) return list;
  const byKey = new Map();
  for (const edge of featureEdges) {
    if (!Number.isFinite(edge.boundaryId)) continue;
    const a = edge.a;
    const b = edge.b;
    const key = edge.key || (a < b ? `${a}-${b}` : `${b}-${a}`);
    byKey.set(key, edge);
  }
  let changed = false;
  const next = list.map((edge) => {
    const a = edge.a;
    const b = edge.b;
    const key = edge.key || (Number.isFinite(a) && Number.isFinite(b)
      ? (a < b ? `${a}-${b}` : `${b}-${a}`)
      : '');
    const src = byKey.get(key);
    if (!src) return edge;
    if (edge.boundaryId === src.boundaryId
      && edge.faceA === src.faceA
      && edge.faceB === src.faceB
      && edge.pairCount === src.pairCount) {
      return edge;
    }
    changed = true;
    return {
      ...edge,
      boundaryId: src.boundaryId,
      faceA: src.faceA,
      faceB: src.faceB,
      pairCount: src.pairCount,
    };
  });
  return changed ? next : list;
}

/**
 * Pickable feature edges for Fillet mode: one entry per candidate boundary
 * segment, carrying the boundary id so Accept can emit edge() / edgesBetween.
 * Blend strips are already absent from topo.edges.
 * @param {{ faces?: object[], edges?: object[] }} topo
 */
export function featureEdgesFromBoundary(topo) {
  const out = [];
  for (const edge of topo?.edges || []) {
    const n0 = Array.isArray(edge.n0) ? edge.n0 : null;
    const n1 = Array.isArray(edge.n1) ? edge.n1 : null;
    for (const seg of edge.segments || []) {
      if (!Array.isArray(seg.va) || !Array.isArray(seg.vb)) continue;
      const delta = sub(seg.vb, seg.va);
      if (!(Math.hypot(delta[0], delta[1], delta[2]) > 1e-9)) continue;
      out.push({
        key: seg.key,
        a: seg.a,
        b: seg.b,
        va: seg.va.slice(),
        vb: seg.vb.slice(),
        mid: seg.mid.slice(),
        length: seg.length,
        tangent: norm(delta),
        n0: n0 ? n0.slice() : undefined,
        n1: n1 ? n1.slice() : undefined,
        faceA: edge.faceA,
        faceB: edge.faceB,
        boundaryId: edge.id,
        pairCount: edge.pairCount,
      });
    }
  }
  return out;
}

/**
 * Faces and edges worth a Fillet-mode label. Small faces (blend facets,
 * loft micro-triangles) are omitted. The label count is capped so a dense
 * mesh cannot allocate thousands of canvases.
 * @param {{ faces?: object[], edges?: object[] }} topo
 * @param {{ maxLabels?: number }} [opts]
 * @returns {{ faces: object[], edges: object[], truncated: boolean }}
 */
export function filletOverlayTargets(topo, opts = {}) {
  const cap = Number.isFinite(opts.maxLabels) && opts.maxLabels > 0
    ? Math.round(opts.maxLabels)
    : FILLET_OVERLAY_LABEL_CAP;
  const faces = Array.isArray(topo?.faces) ? topo.faces : [];
  const edges = Array.isArray(topo?.edges) ? topo.edges : [];
  const maxArea = faces.reduce((m, f) => Math.max(m, Number(f.area) || 0), 0);
  const floor = BOUNDARY_SMALL_FACE_FRAC * maxArea;
  const labelFaces = maxArea > 0
    ? faces.filter((f) => (Number(f.area) || 0) >= floor)
    : [];
  if (labelFaces.length + edges.length <= cap) {
    return { faces: labelFaces, edges, truncated: false };
  }
  const edgeBudget = Math.min(edges.length, Math.max(1, cap - 8));
  const faceBudget = Math.max(0, cap - edgeBudget);
  const biggest = labelFaces.slice().sort((a, b) => (b.area || 0) - (a.area || 0));
  return {
    faces: biggest.slice(0, faceBudget),
    edges: edges.slice(0, edgeBudget),
    truncated: true,
  };
}
