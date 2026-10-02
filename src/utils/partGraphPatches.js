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
 * Face pick / edge propagation must NOT read patches yet (PR 3 / 5).
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

  // --- Atoms: faceID connected components ---------------------------------
  const atomUF = makeUF(numTri);
  for (const tris of edgeMap.values()) {
    if (tris.length !== 2) continue;
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
