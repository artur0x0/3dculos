/**
 * Phone versus desktop for a TET10 study.
 *
 * A phone is a touch device that also has a small screen or a small
 * deviceMemory. Thin solids use supernodal Cholesky. Compact solids use
 * Jacobi PCG. Shells are not selected here.
 *
 * TODO: shells need a midsurface extraction before solve_shell. Solids in
 * this build always use TET10, including when the study model is "shell".
 */

export const SHELLS_AVAILABLE = false;

/** Degrees of freedom measured on an 18 mm cube: about 66 per (volume / edge³). */
export const DOFS_PER_CELL = 66;

export const PHONE_DOF_CAPS = Object.freeze({
  tet10Thin: 100_000,
  tet10CompactCholesky: 40_000,
  tet10CompactPcg: 100_000,
});

const THIN_BBOX_RATIO = 0.25;
const THIN_THICKNESS_RATIO = 0.08;
const SMALL_SCREEN_PX = 768;
const LOW_DEVICE_MEMORY_GB = 4;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function boundingBox(positions) {
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
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const dims = [dx, dy, dz].filter((value) => finite(value) && value >= 0).sort((a, b) => a - b);
  const minDim = dims[0] ?? 0;
  const maxDim = dims[dims.length - 1] ?? 0;
  const diagonal = Math.hypot(dx, dy, dz);
  return { dx, dy, dz, minDim, maxDim, diagonal };
}

function surfaceArea(positions, indices) {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return area;
}

function signedVolume(positions, indices) {
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

/** Bounding box, volume, and the two thinness ratios. */
export function partShape(positions, indices) {
  const box = boundingBox(positions);
  const area = surfaceArea(positions, indices);
  const volume = Math.abs(signedVolume(positions, indices));
  const bboxRatio = box.maxDim > 0 ? box.minDim / box.maxDim : 1;
  const thickness = area > 0 ? volume / area : 0;
  const thicknessRatio = box.maxDim > 0 ? thickness / box.maxDim : 0;
  return { ...box, area, volume, bboxRatio, thickness, thicknessRatio };
}

/** A small bounding-box ratio or a small volume-to-surface thickness. */
export function isThinPart(shape) {
  return shape.bboxRatio <= THIN_BBOX_RATIO || shape.thicknessRatio <= THIN_THICKNESS_RATIO;
}

/** Cholesky on thin solids, PCG on compact solids. */
export function chooseSolver(shape) {
  return isThinPart(shape) ? 'cholesky' : 'pcg';
}

/**
 * Phone DOF cap for this solid and solver. Desktop returns Infinity: the only
 * limit there is memory.
 */
export function dofCap(profile, thin, solver) {
  if (profile !== 'phone') return Infinity;
  if (thin) return PHONE_DOF_CAPS.tet10Thin;
  if (solver === 'cholesky') return PHONE_DOF_CAPS.tet10CompactCholesky;
  return PHONE_DOF_CAPS.tet10CompactPcg;
}

/** Study mesh target, or fTetWild's default of 1/20 of the bbox diagonal. */
export function preferredEdgeLength(diagonal, target) {
  if (typeof target === 'number' && Number.isFinite(target) && target > 0) return target;
  if (!(diagonal > 0)) return 1;
  return diagonal / 20;
}

/**
 * Edge length that lands on the DOF cap when the preferred mesh would pass it.
 * `coarsened` is true when the cap forced a longer edge.
 */
export function edgeForCap(volume, preferredEdge, cap) {
  const preferred = preferredEdge > 0 ? preferredEdge : 1;
  if (!Number.isFinite(cap) || !(cap > 0) || !(volume > 0)) {
    return { edgeLength: preferred, coarsened: false };
  }
  const capped = Math.cbrt((DOFS_PER_CELL * volume) / cap);
  if (capped > preferred * 1.02) {
    return { edgeLength: capped, coarsened: true };
  }
  return { edgeLength: preferred, coarsened: false };
}

function smallScreen(win) {
  if (!win) return false;
  const width = Number(win.innerWidth) || 0;
  const screenWidth = Number(win.screen && win.screen.width) || 0;
  const screenHeight = Number(win.screen && win.screen.height) || 0;
  const shortSide = Math.min(screenWidth || Infinity, screenHeight || Infinity);
  if (width > 0 && width <= SMALL_SCREEN_PX) return true;
  if (Number.isFinite(shortSide) && shortSide <= SMALL_SCREEN_PX) return true;
  try {
    if (typeof win.matchMedia === 'function' && win.matchMedia(`(max-width: ${SMALL_SCREEN_PX}px)`).matches) {
      return true;
    }
  } catch {
    /* matchMedia can throw in a locked-down webview */
  }
  return false;
}

/**
 * `touch` plus a small screen, or touch plus a deviceMemory at or below 4 GB.
 * Pass `{ navigator, window }` in tests. The live page is the default.
 */
export function detectFeaProfile(env = {}) {
  const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  const win = env.window || (typeof window !== 'undefined' ? window : null);
  if (!nav) return 'desktop';
  const touch = (Number(nav.maxTouchPoints) || 0) > 0;
  const memory = nav.deviceMemory;
  const lowMemory = typeof memory === 'number' && memory > 0 && memory <= LOW_DEVICE_MEMORY_GB;
  if (touch && (smallScreen(win) || lowMemory)) return 'phone';
  return 'desktop';
}

/**
 * What `createFeaClient().capabilities()` reports. The wasm module still
 * lists the stub; the app adds TET10 and the shell flag.
 */
export function appCapabilities(wasmCaps = {}) {
  const solvers = new Set(Array.isArray(wasmCaps.solvers) ? wasmCaps.solvers : []);
  solvers.add('tet10');
  solvers.add('stub');
  return {
    ...wasmCaps,
    solvers: [...solvers],
    shells: SHELLS_AVAILABLE,
  };
}
