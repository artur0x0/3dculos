/**
 * Edges plan PR 2 — Layer 1 patch segmentation (EDGES.md §3 / §5).
 *
 * Atoms = Manifold faceID connected components (over-split, never under-split).
 *
 * Merge rule (curvature class, not fixed dihedral alone — the tangent-junction
 * trap):
 *
 *   1. Coplanar flood — union atoms across dihedral ≤ PLANAR_DEG. Locals that
 *      are just one fillet facet stay tiny; true flat faces grow large.
 *   2. Lock large coplanar groups as flat (area ≥ FRAC × largest coplanar
 *      group). Curvature-class stand-in for κ≈0; survives coarse G1 junctions
 *      (roundedBox ~11°) that inflate mean-κ on perimeter tris.
 *   3. Curved flood — among non-locked atoms, merge across dihedral ≤ SMOOTH
 *      when κ rate agrees. Never merge a locked flat into a curved atom.
 *
 * Pure mesh math. Built lazily on the main thread when the patch-colour
 * debug overlay is requested (never on the worker serialize/postMessage
 * critical path — that caused iOS Safari OOM / black viewport in #88/#89).
 * Face pick reads one patch: the graph component for that face (flat or curved).
 * After the curved merge, triangles that still lie on a locked flat's plane
 * are pulled back onto that face, even when a fillet sits between them and
 * the face ids differ. Vertices within SEAM_VERTEX_MM count as touching, so
 * a duplicate-vertex seam on that plane is the same face. The curved blend
 * stays its own patch.
 * Edge propagation must NOT read patches yet.
 * No visibility BVH (PR 6).
 */

/** Soft cap: skip main-thread build above this triangle count (UI jank). */
export const PARTGRAPH_MAX_TRIANGLES = 250000;

/** Pass 1: dihedral at/below this merges as coplanar. */
export const PATCH_PLANAR_DEG = 0.5;
/**
 * Pass 3: dihedral gate for curved↔curved. Clears cylinder facets on
 * roundedBox seg=16 (~5.6°) and coarse G1 (~11°) tries — flats stay locked.
 */
export const PATCH_SMOOTH_DEG = 15;
/** Relative |κA−κB|/max(κA,κB) for curved↔curved. */
export const PATCH_CURVED_RATE_TOL = 0.55;
/** Dihedrals at/above this are ignored for the curved κ proxy. */
export const PATCH_K_FEATURE_DEG = 25;
/**
 * Coplanar group area ≥ this × median group area → locked flat.
 * Keeps blend shreds (tiny) unlocked so pass 3 can unite them.
 */
/** Coplanar group area ≥ this × the largest coplanar group → locked flat. */
export const PATCH_FLAT_AREA_FRAC_OF_MAX = 0.15;
/** A triangle is on a flat's plane when its offset matches within this many mm. */
const PLANE_OFFSET_MM = 0.05;
/**
 * A fillet between two pieces of one plane leaves the mesh by about the
 * fillet radius. Triangles within this distance may be crossed so those
 * pieces become one face. On the shelled L the separate coplanar arms are
 * 16mm apart and stay separate at this distance.
 */
const PLANE_BRIDGE_MM = 8;
/**
 * A fillet boolean can leave two copies of a cap vertex about 0.001mm apart.
 * They do not share an index, so an edge walk stops. This is the gap that
 * still counts as the same face. It is far inside the 16mm arm split.
 */
const SEAM_VERTEX_MM = 0.02;

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function degBetween(a, b) {
  const d = dot(a, b) / ((len(a) || 1) * (len(b) || 1));
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
}
function edgeKey(u, w) {
  return u < w ? u * 1e9 + w : w * 1e9 + u;
}

/** Vertex-connected component id per triangle. Bodies that share no vertex stay apart. */
function triangleBodyIds(indices, numTri) {
  const parent = new Uint32Array(numTri);
  for (let i = 0; i < numTri; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    let x = a;
    while (parent[x] !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const vertToTri = new Map();
  for (let t = 0; t < numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      const prev = vertToTri.get(v);
      if (prev === undefined) vertToTri.set(v, t);
      else unite(prev, t);
    }
  }
  const rootToId = new Map();
  const ids = new Int32Array(numTri);
  let next = 0;
  for (let t = 0; t < numTri; t++) {
    const r = find(t);
    let id = rootToId.get(r);
    if (id == null) {
      id = next++;
      rootToId.set(r, id);
    }
    ids[t] = id;
  }
  return ids;
}

function makeUF(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    let x = i;
    while (x !== r) {
      const nxt = parent[x];
      parent[x] = r;
      x = nxt;
    }
    return r;
  };
  const unite = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  return { find, unite };
}

/**
 * @param {{
 *   positions: ArrayLike<number>,
 *   indices: ArrayLike<number>,
 *   faceIDs: ArrayLike<number>|null|undefined,
 * }} mesh
 * @param {object} [opts]
 */
export function buildPartGraphPatches(mesh, opts = {}) {
  const positions = mesh?.positions;
  const indices = mesh?.indices;
  const faceIDs = mesh?.faceIDs;
  const planarDeg = opts.planarDeg ?? PATCH_PLANAR_DEG;
  const smoothDeg = opts.smoothDeg ?? PATCH_SMOOTH_DEG;
  const curvedRateTol = opts.curvedRateTol ?? PATCH_CURVED_RATE_TOL;
  const kFeatureDeg = opts.kFeatureDeg ?? PATCH_K_FEATURE_DEG;
  const flatAreaFracOfMax = opts.flatAreaFracOfMax ?? PATCH_FLAT_AREA_FRAC_OF_MAX;

  if (!positions || !indices) return emptyResult();
  const numTri = Math.floor(indices.length / 3);
  if (numTri < 1) return emptyResult();

  const triN = new Array(numTri);
  const triArea = new Float64Array(numTri);
  const triCent = new Array(numTri);
  for (let t = 0; t < numTri; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const v0 = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
    const v1 = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
    const v2 = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];
    const cxv = cross(sub(v1, v0), sub(v2, v0));
    const a = 0.5 * len(cxv);
    triArea[t] = a;
    triN[t] = norm(cxv);
    triCent[t] = [
      (v0[0] + v1[0] + v2[0]) / 3,
      (v0[1] + v1[1] + v2[1]) / 3,
      (v0[2] + v1[2] + v2[2]) / 3,
    ];
  }

  const edgeMap = new Map();
  for (let t = 0; t < numTri; t++) {
    const vs = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(vs[k], vs[(k + 1) % 3]);
      let list = edgeMap.get(key);
      if (!list) {
        list = [];
        edgeMap.set(key, list);
      }
      list.push(t);
    }
  }

  const dihedral = new Map();
  for (const [key, tris] of edgeMap) {
    if (tris.length !== 2) continue;
    dihedral.set(key, degBetween(triN[tris[0]], triN[tris[1]]));
  }

  const rawFid = new Int32Array(numTri);
  for (let t = 0; t < numTri; t++) {
    rawFid[t] = faceIDs && faceIDs.length > t ? Number(faceIDs[t]) | 0 : t;
  }

  // Vertex-connected body of each triangle. A keep-both cut does not share
  // vertices, so a coplanar flood must not unite those faces even when a
  // faceID is reused across the cut.
  const bodyOf = triangleBodyIds(indices, numTri);
  let multiBody = false;
  for (let t = 1; t < numTri; t++) {
    if (bodyOf[t] !== bodyOf[0]) { multiBody = true; break; }
  }
  const sameBody = (t0, t1) => !multiBody || bodyOf[t0] === bodyOf[t1];

  // --- Atoms: faceID connected components ---------------------------------
  const atomUF = makeUF(numTri);
  for (const tris of edgeMap.values()) {
    if (tris.length !== 2) continue;
    if (!sameBody(tris[0], tris[1])) continue;
    if (rawFid[tris[0]] === rawFid[tris[1]]) atomUF.unite(tris[0], tris[1]);
  }

  const atomRootToIdx = new Map();
  const triAtom = new Int32Array(numTri);
  let atomCount = 0;
  for (let t = 0; t < numTri; t++) {
    const r = atomUF.find(t);
    let ai = atomRootToIdx.get(r);
    if (ai == null) {
      ai = atomCount++;
      atomRootToIdx.set(r, ai);
    }
    triAtom[t] = ai;
  }

  const atomTris = Array.from({ length: atomCount }, () => []);
  for (let t = 0; t < numTri; t++) atomTris[triAtom[t]].push(t);

  const atomArea = new Float64Array(atomCount);
  for (let a = 0; a < atomCount; a++) {
    let area = 0;
    for (const t of atomTris[a]) area += triArea[t];
    atomArea[a] = area;
  }

  // Atom adjacency with dihedral stats.
  const atomAdj = [];
  const adjIndex = new Map();
  const pack = (a, b) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return lo * 0x100000000 + hi;
  };
  for (const [key, tris] of edgeMap) {
    if (tris.length !== 2) continue;
    if (!sameBody(tris[0], tris[1])) continue;
    const a0 = triAtom[tris[0]];
    const a1 = triAtom[tris[1]];
    if (a0 === a1) continue;
    const d = dihedral.get(key);
    if (d == null) continue;
    const pk = pack(a0, a1);
    let rec = adjIndex.get(pk);
    if (!rec) {
      rec = { a: a0, b: a1, sum: 0, n: 0, max: 0 };
      adjIndex.set(pk, rec);
      atomAdj.push(rec);
    }
    rec.sum += d;
    rec.n++;
    if (d > rec.max) rec.max = d;
  }

  // --- Pass 1: coplanar flood --------------------------------------------
  const patchUF = makeUF(atomCount);
  for (const rec of atomAdj) {
    if (rec.max <= planarDeg) patchUF.unite(rec.a, rec.b);
  }

  // Area per coplanar component (rooted).
  const rootArea = new Float64Array(atomCount);
  for (let a = 0; a < atomCount; a++) rootArea[patchUF.find(a)] += atomArea[a];

  let maxRootArea = 0;
  for (let a = 0; a < atomCount; a++) {
    if (patchUF.find(a) !== a) continue;
    if (rootArea[a] > maxRootArea) maxRootArea = rootArea[a];
  }
  // Fraction of the largest coplanar group — flats on roundedBox are hundreds
  // of units; cylinder/sphere shreds stay ~30–70 and must remain unlocked so
  // the curved pass can unite them. Median×factor wrongly locked those shreds.
  const flatAreaGate = Math.max(maxRootArea * flatAreaFracOfMax, 1e-6);

  // Also lock islands that only meet the mesh across sharp creases (box face
  // with unique faceID, no coplanar partner) — they are flats even if small.
  const atomLockedFlat = new Uint8Array(atomCount);
  for (let a = 0; a < atomCount; a++) {
    const r = patchUF.find(a);
    if (rootArea[r] >= flatAreaGate) atomLockedFlat[a] = 1;
  }
  // Sharp-only islands (every neighbour dihedral > smoothDeg) used to be
  // locked flat here so a lone box faceID stayed planar. That also froze
  // roundedBox sphere-corner shreds whose facet turns sit at 18–22°, so
  // they never joined their blend. Cube faces already coplanar-merge in
  // pass 1; leftover sharp islands stay singleton patches — fine.

  // κ for unlocked (curved-candidate) atoms: mean smooth dihedral to other
  // unlocked atoms. Locked flats do not inflate the proxy.
  const atomK = new Float64Array(atomCount);
  for (let a = 0; a < atomCount; a++) {
    if (atomLockedFlat[a]) {
      atomK[a] = 0;
      continue;
    }
    let sum = 0;
    let n = 0;
    for (const rec of atomAdj) {
      if (rec.a !== a && rec.b !== a) continue;
      const other = rec.a === a ? rec.b : rec.a;
      if (atomLockedFlat[other]) continue;
      if (rec.max >= kFeatureDeg) continue;
      sum += rec.sum / rec.n;
      n++;
    }
    // Fall back to any smooth boundary (incl. to flats) so isolated shreds
    // still get a rate signal relative to their blend neighbours.
    if (n === 0) {
      for (const rec of atomAdj) {
        if (rec.a !== a && rec.b !== a) continue;
        if (rec.max >= kFeatureDeg) continue;
        sum += rec.sum / rec.n;
        n++;
      }
    }
    atomK[a] = n > 0 ? sum / n : 0;
  }

  // --- Pass 3: curvature-consistent merge among non-flats ----------------
  for (const rec of atomAdj) {
    if (atomLockedFlat[rec.a] || atomLockedFlat[rec.b]) continue;
    if (rec.max > smoothDeg) continue;
    const ka = atomK[rec.a];
    const kb = atomK[rec.b];
    if (ka > 1e-6 || kb > 1e-6) {
      const denom = Math.max(ka, kb, 1e-6);
      if (Math.abs(ka - kb) / denom > curvedRateTol) continue;
    }
    patchUF.unite(rec.a, rec.b);
  }

  // --- Emit --------------------------------------------------------------
  const rootToPid = new Map();
  const atomPatch = new Int32Array(atomCount);
  let patchCount = 0;
  for (let a = 0; a < atomCount; a++) {
    const r = patchUF.find(a);
    let pid = rootToPid.get(r);
    if (pid == null) {
      pid = patchCount++;
      rootToPid.set(r, pid);
    }
    atomPatch[a] = pid;
  }

  const patchTris = Array.from({ length: patchCount }, () => []);
  const patchAtomCount = new Int32Array(patchCount);
  const patchFaceIds = Array.from({ length: patchCount }, () => new Set());
  const patchLocked = new Uint8Array(patchCount);
  for (let a = 0; a < atomCount; a++) {
    const pid = atomPatch[a];
    patchAtomCount[pid]++;
    if (atomLockedFlat[a]) patchLocked[pid] = 1;
    for (const t of atomTris[a]) {
      patchTris[pid].push(t);
      patchFaceIds[pid].add(rawFid[t]);
    }
  }

  const triPatch = new Int32Array(numTri);
  const patches = [];
  for (let pid = 0; pid < patchCount; pid++) {
    const tris = patchTris[pid];
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let area = 0;
    let kSum = 0;
    let kSumSq = 0;
    let kArea = 0;
    const seenAtom = new Set();
    for (const t of tris) {
      triPatch[t] = pid;
      const ar = triArea[t];
      const nrmT = triN[t];
      nx += nrmT[0] * ar;
      ny += nrmT[1] * ar;
      nz += nrmT[2] * ar;
      const c = triCent[t];
      cx += c[0] * ar;
      cy += c[1] * ar;
      cz += c[2] * ar;
      area += ar;
      const a = triAtom[t];
      if (!seenAtom.has(a)) {
        seenAtom.add(a);
        kSum += atomK[a] * atomArea[a];
        kSumSq += atomK[a] * atomK[a] * atomArea[a];
        kArea += atomArea[a];
      }
    }
    const meanK = kArea > 1e-18 ? kSum / kArea : 0;
    const meanK2 = kArea > 1e-18 ? kSumSq / kArea : 0;
    const variance = Math.max(0, meanK2 - meanK * meanK);
    const nrm = norm([nx, ny, nz]);
    const center =
      area > 1e-18 ? [cx / area, cy / area, cz / area] : [0, 0, 0];
    let kind = 'general';
    if (patchLocked[pid] || meanK < 1e-6) kind = 'planar';
    else if (variance < (meanK * 0.4) ** 2 + 0.5) kind = 'blend';
    patches.push({
      id: pid,
      tris,
      normal: nrm,
      center,
      area,
      kind,
      curvature: { mean: meanK, variance },
      atomCount: patchAtomCount[pid],
      faceIds: [...patchFaceIds[pid]].sort((x, y) => x - y),
    });
  }

  // A fillet can leave the rest of a cap on the same plane, past the blend,
  // still wearing the other body's face id. Pass 1 stops at the blend, and
  // pass 3 then swallows the smaller piece. Cross triangles that stay near
  // the plane and pull the on-plane ones back onto the larger flat. Curved
  // triangles are crossed, not collected. A coplanar wall whose path leaves
  // the plane stays its own face.
  const neighbors = Array.from({ length: numTri }, () => []);
  for (const edgeTris of edgeMap.values()) {
    if (edgeTris.length !== 2) continue;
    if (!sameBody(edgeTris[0], edgeTris[1])) continue;
    neighbors[edgeTris[0]].push(edgeTris[1]);
    neighbors[edgeTris[1]].push(edgeTris[0]);
  }
  // Duplicate vertices across a fillet seam are not an edge. Record coplanar
  // same-body triangles whose vertices are within SEAM_VERTEX_MM. The walk
  // below claims across that gap and then stays on the plane. It does not
  // enter the blend, so coplanar arms whose path leaves the plane stay apart.
  const seamTouch = Array.from({ length: numTri }, () => []);
  {
    const seam2 = SEAM_VERTEX_MM * SEAM_VERTEX_MM;
    const inv = 1 / SEAM_VERTEX_MM;
    const cosSeam = Math.cos((PATCH_PLANAR_DEG * Math.PI) / 180);
    const buckets = new Map();
    for (let t = 0; t < numTri; t++) {
      if (triArea[t] < 1e-8) continue;
      for (let k = 0; k < 3; k++) {
        const i = indices[t * 3 + k];
        const key = `${Math.floor(positions[i * 3] * inv)}|${Math.floor(positions[i * 3 + 1] * inv)}|${Math.floor(positions[i * 3 + 2] * inv)}`;
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(t);
      }
    }
    const linked = seamTouch.map(() => new Set());
    for (let t = 0; t < numTri; t++) {
      if (triArea[t] < 1e-8) continue;
      const n = triN[t];
      const c = triCent[t];
      const off = c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
      const seen = new Set();
      for (let k = 0; k < 3; k++) {
        const i = indices[t * 3 + k];
        const cx = Math.floor(positions[i * 3] * inv);
        const cy = Math.floor(positions[i * 3 + 1] * inv);
        const cz = Math.floor(positions[i * 3 + 2] * inv);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const list = buckets.get(`${cx + dx}|${cy + dy}|${cz + dz}`);
              if (!list) continue;
              for (let li = 0; li < list.length; li++) {
                const nb = list[li];
                if (nb === t || seen.has(nb) || linked[t].has(nb)) continue;
                seen.add(nb);
                if (triArea[nb] < 1e-8 || !sameBody(t, nb)) continue;
                const nd = n[0] * triN[nb][0] + n[1] * triN[nb][1] + n[2] * triN[nb][2];
                if (nd < cosSeam) continue;
                const o = triCent[nb];
                const offO = o[0] * n[0] + o[1] * n[1] + o[2] * n[2];
                if (Math.abs(offO - off) > PLANE_OFFSET_MM) continue;
                let close = false;
                for (let a = 0; a < 3 && !close; a++) {
                  const ia = indices[nb * 3 + a];
                  const ax = positions[ia * 3];
                  const ay = positions[ia * 3 + 1];
                  const az = positions[ia * 3 + 2];
                  for (let b = 0; b < 3; b++) {
                    const ib = indices[t * 3 + b];
                    const ex = ax - positions[ib * 3];
                    const ey = ay - positions[ib * 3 + 1];
                    const ez = az - positions[ib * 3 + 2];
                    if (ex * ex + ey * ey + ez * ez <= seam2) { close = true; break; }
                  }
                }
                if (!close) continue;
                seamTouch[t].push(nb);
                linked[t].add(nb);
              }
            }
          }
        }
      }
    }
  }
  const cosPlanar = Math.cos((planarDeg * Math.PI) / 180);
  const planeOffset = (patch) => patch.center[0] * patch.normal[0]
    + patch.center[1] * patch.normal[1]
    + patch.center[2] * patch.normal[2];
  const onPlane = (t, patch, offP) => {
    if (triArea[t] < 1e-8) return false;
    const n = triN[t];
    const nd = n[0] * patch.normal[0] + n[1] * patch.normal[1] + n[2] * patch.normal[2];
    if (nd < cosPlanar) return false;
    const c = triCent[t];
    const offT = c[0] * patch.normal[0] + c[1] * patch.normal[1] + c[2] * patch.normal[2];
    return Math.abs(offP - offT) <= PLANE_OFFSET_MM;
  };
  const bridgeOff = (t, normal, offP) => {
    let max = 0;
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k];
      const d = positions[i * 3] * normal[0]
        + positions[i * 3 + 1] * normal[1]
        + positions[i * 3 + 2] * normal[2];
      const off = Math.abs(d - offP);
      if (off > max) max = off;
    }
    return max;
  };
  const planarOrder = patches
    .filter((p) => p.kind === 'planar' && p.tris.length)
    .sort((a, b) => b.area - a.area);
  for (const p of planarOrder) {
    const seed = p.tris.filter((t) => triPatch[t] === p.id);
    if (!seed.length) continue;
    const offP = planeOffset(p);
    const stack = seed.slice();
    const seen = new Uint8Array(numTri);
    for (const t of stack) seen[t] = 1;
    while (stack.length) {
      const t = stack.pop();
      const nbs = neighbors[t];
      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        if (seen[nb]) continue;
        seen[nb] = 1;
        if (bridgeOff(nb, p.normal, offP) > PLANE_BRIDGE_MM) continue;
        stack.push(nb);
        if (!onPlane(nb, p, offP) || triPatch[nb] === p.id) continue;
        const owner = patches[triPatch[nb]];
        if (owner && owner.kind === 'planar' && owner.area > p.area) continue;
        triPatch[nb] = p.id;
      }
    }
    // The needle between two copies of a cap vertex is not an edge, and it
    // is dropped from the draw. Step across that gap, then keep walking
    // only on this plane so the rest of the cap comes along. A blend
    // triangle fails onPlane, so this does not reach a coplanar arm whose
    // path leaves the plane.
    const seamStack = [];
    const seamSeen = new Uint8Array(numTri);
    for (let t = 0; t < numTri; t++) {
      if (triPatch[t] !== p.id) continue;
      seamSeen[t] = 1;
      seamStack.push(t);
    }
    const claimOnPlane = (nb) => {
      if (seamSeen[nb] || !onPlane(nb, p, offP)) return;
      const owner = patches[triPatch[nb]];
      if (triPatch[nb] !== p.id && owner && owner.kind === 'planar' && owner.area > p.area) return;
      seamSeen[nb] = 1;
      triPatch[nb] = p.id;
      seamStack.push(nb);
    };
    while (seamStack.length) {
      const t = seamStack.pop();
      const touch = seamTouch[t];
      for (let i = 0; i < touch.length; i++) claimOnPlane(touch[i]);
      const nbs = neighbors[t];
      for (let i = 0; i < nbs.length; i++) claimOnPlane(nbs[i]);
    }
  }
  for (const p of patches) p.tris = [];
  for (let t = 0; t < numTri; t++) patches[triPatch[t]].tris.push(t);
  for (const p of patches) {
    let area = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const fids = new Set();
    for (const t of p.tris) {
      const ar = triArea[t];
      area += ar;
      const c = triCent[t];
      cx += c[0] * ar;
      cy += c[1] * ar;
      cz += c[2] * ar;
      fids.add(rawFid[t]);
    }
    p.area = area;
    if (area > 1e-18) p.center = [cx / area, cy / area, cz / area];
    p.faceIds = [...fids].sort((a, b) => a - b);
  }
  const remap = new Int32Array(patches.length);
  let kept = 0;
  for (let i = 0; i < patches.length; i++) {
    if (!patches[i].tris.length) {
      remap[i] = -1;
      continue;
    }
    remap[i] = kept;
    patches[i].id = kept;
    patches[kept] = patches[i];
    kept++;
  }
  patches.length = kept;
  for (let t = 0; t < numTri; t++) triPatch[t] = remap[triPatch[t]];
  patchCount = kept;

  let hash = numTri * 2654435761;
  hash = (hash ^ (atomCount * 97531)) >>> 0;
  hash = (hash ^ (patchCount * 50311)) >>> 0;
  if (faceIDs && faceIDs.length) {
    hash = (hash ^ (Number(faceIDs[0]) | 0)) >>> 0;
    hash = (hash ^ (Number(faceIDs[numTri - 1]) | 0)) >>> 0;
  }
  const nVert = Math.floor(positions.length / 3);
  hash = (hash ^ nVert) >>> 0;

  return {
    patches,
    triPatch,
    atomCount,
    version: `pg-${nVert}-${numTri}-${patchCount}-${hash.toString(16)}`,
  };
}

function emptyResult() {
  return {
    patches: [],
    triPatch: new Int32Array(0),
    atomCount: 0,
    version: 'pg-empty',
  };
}

export function patchDebugColor(patchId) {
  const id = Number(patchId) | 0;
  const hue = ((id * 0.618033988749895) % 1 + 1) % 1;
  const sat = 0.72 + (0.2 * ((id * 3) % 5)) / 4;
  const val = 0.78 + (0.18 * ((id * 5) % 3)) / 2;
  return hsvToRgb(hue, sat, val);
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r;
  let g;
  let b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [r, g, b];
}

export function buildPatchOverlayArrays(mesh, triPatch) {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const numTri = Math.floor(indices.length / 3);
  const outPos = new Float32Array(numTri * 9);
  const outCol = new Float32Array(numTri * 9);
  for (let t = 0; t < numTri; t++) {
    const pid = triPatch[t] ?? 0;
    const [cr, cg, cb] = patchDebugColor(pid);
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k];
      const o = t * 9 + k * 3;
      outPos[o] = positions[vi * 3];
      outPos[o + 1] = positions[vi * 3 + 1];
      outPos[o + 2] = positions[vi * 3 + 2];
      outCol[o] = cr;
      outCol[o + 1] = cg;
      outCol[o + 2] = cb;
    }
  }
  return { positions: outPos, colors: outCol };
}
