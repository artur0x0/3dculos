/**
 * Preview grid size.
 *
 * The resolution is the cell count along the longest bounding-box axis.
 * The other axes keep the same cell size, rounded to an even count so
 * geometric multigrid can drop every other node. A cube is exactly N³.
 * Dragging uses 64. Pointer-up uses 96, or 128 on desktop only.
 */

export function axisCounts(dx, dy, dz, resolution) {
  const longest = Math.max(dx, dy, dz, 1e-9);
  const count = (len) => {
    let n = Math.round((resolution * Math.max(len, 0)) / longest);
    if (n < 2) n = 2;
    if (n % 2 === 1) n += 1;
    return n;
  };
  return { nx: count(dx), ny: count(dy), nz: count(dz), longest };
}

/**
 * `phase` is `drag` or `release`. `profile` is `phone` or `desktop`.
 * `fits` is false when the desktop release grid would exceed the device
 * buffer limit; the preview then stays at 96.
 */
export function previewResolution({ phase = 'drag', profile = 'desktop', fits = true } = {}) {
  if (phase !== 'release') return 64;
  if (profile === 'phone') return 96;
  if (!fits) return 96;
  return 128;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Desktop release may use 128 only when the padded node vectors fit the
 * device buffer limits. A missing limit does not fit.
 */
export function previewFits(dx, dy, dz, resolution, limits) {
  const counts = axisCounts(dx, dy, dz, resolution);
  const nx = nextPow2(counts.nx);
  const ny = nextPow2(counts.ny);
  const nz = nextPow2(counts.nz);
  const nodes = (nx + 1) * (ny + 1) * (nz + 1);
  const vec = nodes * 12;
  const binding = Number(limits?.maxStorageBufferBindingSize) || 0;
  const buffer = Number(limits?.maxBufferSize) || 0;
  const cap = Math.min(binding || buffer, buffer || binding);
  if (!(cap > 0) || vec > cap) return false;
  return estimateGpuBytes(nx, ny, nz) <= cap * 6;
}

/** Bytes of the f32 workspace a GPU V-cycle keeps for this cell count. */
export function estimateGpuBytes(nx, ny, nz) {
  let bytes = 576 * 4;
  let x = nx;
  let y = ny;
  let z = nz;
  let finest = true;
  for (let level = 0; level < 16; level += 1) {
    const nodes = (x + 1) * (y + 1) * (z + 1);
    const cells = x * y * z;
    const vec = nodes * 3 * 4;
    bytes += vec * 4;
    bytes += cells * 4;
    bytes += nodes * 4;
    bytes += Math.min(cells, nodes) * 4;
    if (finest) {
      bytes += vec * 3;
      finest = false;
    }
    if (Math.max(x, y, z) <= 4) break;
    x = Math.max(1, x >> 1);
    y = Math.max(1, y >> 1);
    z = Math.max(1, z >> 1);
  }
  return bytes;
}
