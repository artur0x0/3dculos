/**
 * Occupancy grid for a closed triangle solid, plus a faceID on each
 * exposed cell side. Fixtures and loads picked by faceID land on those
 * sides. The grid is aligned to the mesh bounding box. Cell counts come
 * from `axisCounts`: N along the longest axis, even counts on the others.
 */

import { axisCounts } from './resolution.js';

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

function planeBox(normal, vert, half) {
  let vmin0;
  let vmin1;
  let vmin2;
  let vmax0;
  let vmax1;
  let vmax2;
  if (normal[0] > 0) {
    vmin0 = -half[0] - vert[0];
    vmax0 = half[0] - vert[0];
  } else {
    vmin0 = half[0] - vert[0];
    vmax0 = -half[0] - vert[0];
  }
  if (normal[1] > 0) {
    vmin1 = -half[1] - vert[1];
    vmax1 = half[1] - vert[1];
  } else {
    vmin1 = half[1] - vert[1];
    vmax1 = -half[1] - vert[1];
  }
  if (normal[2] > 0) {
    vmin2 = -half[2] - vert[2];
    vmax2 = half[2] - vert[2];
  } else {
    vmin2 = half[2] - vert[2];
    vmax2 = -half[2] - vert[2];
  }
  if (normal[0] * vmin0 + normal[1] * vmin1 + normal[2] * vmin2 > 0) return false;
  if (normal[0] * vmax0 + normal[1] * vmax1 + normal[2] * vmax2 >= 0) return true;
  return false;
}

/**
 * Separating-axis triangle/box test. `half` is the box half-size and the
 * triangle is already translated so the box centre is the origin.
 */
export function triangleBoxOverlap(v0, v1, v2, half) {
  const e0 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e1 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
  const e2 = [v0[0] - v2[0], v0[1] - v2[1], v0[2] - v2[2]];
  const edges = [e0, e1, e2];
  const verts = [v0, v1, v2];
  for (let i = 0; i < 3; i += 1) {
    const e = edges[i];
    const abs = [Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])];
    for (let axis = 0; axis < 3; axis += 1) {
      const a = (axis + 1) % 3;
      const b = (axis + 2) % 3;
      const p = [
        e[a] * verts[0][b] - e[b] * verts[0][a],
        e[a] * verts[1][b] - e[b] * verts[1][a],
        e[a] * verts[2][b] - e[b] * verts[2][a],
      ];
      let min = p[0];
      let max = p[0];
      if (p[1] < min) min = p[1];
      if (p[1] > max) max = p[1];
      if (p[2] < min) min = p[2];
      if (p[2] > max) max = p[2];
      const rad = abs[a] * half[b] + abs[b] * half[a];
      if (min > rad || max < -rad) return false;
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    let min = verts[0][axis];
    let max = min;
    if (verts[1][axis] < min) min = verts[1][axis];
    if (verts[1][axis] > max) max = verts[1][axis];
    if (verts[2][axis] < min) min = verts[2][axis];
    if (verts[2][axis] > max) max = verts[2][axis];
    if (min > half[axis] || max < -half[axis]) return false;
  }
  const normal = cross(e0, [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]]);
  return planeBox(normal, v0, half);
}

function rayHit(orig, dir, v0, v1, v2) {
  const eps = 1e-10;
  const e1 = sub(v1, v0);
  const e2 = sub(v2, v0);
  const pvec = cross(dir, e2);
  const det = dot(e1, pvec);
  if (Math.abs(det) < eps) return false;
  const inv = 1 / det;
  const tvec = sub(orig, v0);
  const u = dot(tvec, pvec) * inv;
  if (u < -1e-8 || u > 1 + 1e-8) return false;
  const qvec = cross(tvec, e1);
  const v = dot(dir, qvec) * inv;
  if (v < -1e-8 || u + v > 1 + 1e-8) return false;
  const t = dot(e2, qvec) * inv;
  return t > 1e-8;
}

function dominantSide(normal) {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  if (ax >= ay && ax >= az) return normal[0] >= 0 ? 1 : 0;
  if (ay >= az) return normal[1] >= 0 ? 3 : 2;
  return normal[2] >= 0 ? 5 : 4;
}

function boundsOf(positions) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const n = cross([bx - ax, by - ay, bz - az], [cx - ax, cy - ay, cz - az]);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 0)) return [0, 0, 1];
  return [n[0] / len, n[1] / len, n[2] / len];
}

/**
 * `positions` / `indices` / `faceIDs` are the render solid. `resolution`
 * is the cell count along the longest axis.
 */
export function voxelizeSolid(positions, indices, faceIDs, resolution) {
  const box = boundsOf(positions);
  const dx = box.maxX - box.minX;
  const dy = box.maxY - box.minY;
  const dz = box.maxZ - box.minZ;
  if (!(dx > 0) || !(dy > 0) || !(dz > 0)) {
    throw new Error('The part has no volume to voxelize.');
  }
  const counts = axisCounts(dx, dy, dz, resolution);
  const { nx, ny, nz } = counts;
  const hx = dx / nx;
  const hy = dy / ny;
  const hz = dz / nz;
  const cellCount = nx * ny * nz;
  const occupancy = new Uint8Array(cellCount);
  const faceSide = new Int32Array(cellCount * 6);
  faceSide.fill(-1);

  const triangles = Math.floor(indices.length / 3);
  const dir = [1, 0.00123, 0.00087];
  const dirLen = Math.hypot(dir[0], dir[1], dir[2]);
  dir[0] /= dirLen;
  dir[1] /= dirLen;
  dir[2] /= dirLen;

  const tris = [];
  for (let t = 0; t < triangles; t += 1) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    const a = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
    const b = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
    const c = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];
    const face = faceIDs && faceIDs.length > t ? Number(faceIDs[t]) : t;
    tris.push({
      a,
      b,
      c,
      face: Number.isInteger(face) && face >= 0 ? face : 0,
      normal: triangleNormal(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]),
    });
  }

  for (let k = 0; k < nz; k += 1) {
    const cz = box.minZ + (k + 0.5) * hz;
    for (let j = 0; j < ny; j += 1) {
      const cy = box.minY + (j + 0.5) * hy;
      for (let i = 0; i < nx; i += 1) {
        const cx = box.minX + (i + 0.5) * hx;
        const origin = [cx, cy, cz];
        let hits = 0;
        for (let t = 0; t < tris.length; t += 1) {
          const tri = tris[t];
          if (rayHit(origin, dir, tri.a, tri.b, tri.c)) hits += 1;
        }
        if (hits % 2 === 1) occupancy[i + nx * (j + ny * k)] = 1;
      }
    }
  }

  const halfPad = 1e-7;
  for (let t = 0; t < tris.length; t += 1) {
    const tri = tris[t];
    const side = dominantSide(tri.normal);
    let minX = Math.min(tri.a[0], tri.b[0], tri.c[0]);
    let minY = Math.min(tri.a[1], tri.b[1], tri.c[1]);
    let minZ = Math.min(tri.a[2], tri.b[2], tri.c[2]);
    let maxX = Math.max(tri.a[0], tri.b[0], tri.c[0]);
    let maxY = Math.max(tri.a[1], tri.b[1], tri.c[1]);
    let maxZ = Math.max(tri.a[2], tri.b[2], tri.c[2]);
    const i0 = Math.max(0, Math.floor((minX - box.minX) / hx) - 1);
    const j0 = Math.max(0, Math.floor((minY - box.minY) / hy) - 1);
    const k0 = Math.max(0, Math.floor((minZ - box.minZ) / hz) - 1);
    const i1 = Math.min(nx - 1, Math.floor((maxX - box.minX) / hx) + 1);
    const j1 = Math.min(ny - 1, Math.floor((maxY - box.minY) / hy) + 1);
    const k1 = Math.min(nz - 1, Math.floor((maxZ - box.minZ) / hz) + 1);
    for (let k = k0; k <= k1; k += 1) {
      for (let j = j0; j <= j1; j += 1) {
        for (let i = i0; i <= i1; i += 1) {
          const cell = i + nx * (j + ny * k);
          if (!occupancy[cell]) continue;
          const center = [
            box.minX + (i + 0.5) * hx,
            box.minY + (j + 0.5) * hy,
            box.minZ + (k + 0.5) * hz,
          ];
          const half = [hx * 0.5 + halfPad, hy * 0.5 + halfPad, hz * 0.5 + halfPad];
          const v0 = sub(tri.a, center);
          const v1 = sub(tri.b, center);
          const v2 = sub(tri.c, center);
          if (!triangleBoxOverlap(v0, v1, v2, half)) continue;
          const slot = cell * 6 + side;
          if (faceSide[slot] < 0) faceSide[slot] = tri.face;
        }
      }
    }
  }

  let solidCount = 0;
  for (let i = 0; i < occupancy.length; i += 1) solidCount += occupancy[i];
  if (!solidCount) throw new Error('The voxel grid missed the solid.');

  return {
    nx,
    ny,
    nz,
    boxNx: nx,
    boxNy: ny,
    boxNz: nz,
    hx,
    hy,
    hz,
    origin: [box.minX, box.minY, box.minZ],
    occupancy,
    faceSide,
    solidCount,
    resolution,
  };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Empty cells past the solid bbox so every axis is a power of two.
 * Cell size does not change. Multigrid can halve the index space and
 * still land on the solid's far face, which sits on an even node.
 */
export function padGrid(grid) {
  const nx = nextPow2(grid.nx);
  const ny = nextPow2(grid.ny);
  const nz = nextPow2(grid.nz);
  if (nx === grid.nx && ny === grid.ny && nz === grid.nz) return grid;
  const occupancy = new Uint8Array(nx * ny * nz);
  const faceSide = new Int32Array(nx * ny * nz * 6);
  faceSide.fill(-1);
  const boxNx = grid.boxNx || grid.nx;
  const boxNy = grid.boxNy || grid.ny;
  const boxNz = grid.boxNz || grid.nz;
  for (let k = 0; k < boxNz; k += 1) {
    for (let j = 0; j < boxNy; j += 1) {
      for (let i = 0; i < boxNx; i += 1) {
        const src = i + grid.nx * (j + grid.ny * k);
        const dst = i + nx * (j + ny * k);
        occupancy[dst] = grid.occupancy[src];
        const from = src * 6;
        const to = dst * 6;
        for (let s = 0; s < 6; s += 1) faceSide[to + s] = grid.faceSide[from + s];
      }
    }
  }
  return {
    ...grid,
    nx,
    ny,
    nz,
    boxNx,
    boxNy,
    boxNz,
    occupancy,
    faceSide,
  };
}
