/**
 * Phone versus desktop for a TET10 or shell study.
 *
 * A phone is a touch device that also has a small screen or a small
 * deviceMemory. Thin solids use supernodal Cholesky. Compact solids use
 * Jacobi PCG. A pure sheet-metal part uses the MITC6 shell when the study
 * model is "auto" or "shell". "solid" stays on TET10.
 *
 * General thin solids still have no midsurface. That heuristic is deferred
 * (`SHELL_HEURISTIC` in sheetMidsurface.js). A shell study on a non-sheet
 * part falls back to TET10.
 */

export const SHELLS_AVAILABLE = true;

/** Degrees of freedom measured on an 18 mm cube: about 66 per (volume / edge³). */
export const DOFS_PER_CELL = 66;

/** Elements to place through a thin wall when the DOF budget allows it. */
export const THIN_ELEMENTS_THROUGH = 2;

/**
 * Desktop budget for that wall edge. A 3.175 mm bracket (volume about
 * 48 000 mm³) needs an edge near 1.5 mm for two elements through the gauge,
 * which estimates about 960 000 degrees of freedom. Supernodal Cholesky does
 * not finish in memory at that size. The phone cap is tighter and is applied
 * first. An edge the budget pushes into the band between gauge/2 and the
 * gauge itself is not used: on this bracket a 3.16 mm target (the 100k
 * phone edge) meshed with aspect ratio about 30, while the bbox default
 * stays near 8 and still puts one layer through the wall.
 */
export const THIN_WALL_DOF_BUDGET = 180_000;

export const PHONE_DOF_CAPS = Object.freeze({
  tet10Thin: 100_000,
  tet10CompactCholesky: 40_000,
  tet10CompactPcg: 100_000,
  // Native Cholesky peaks from benches/scale.rs (this machine, 2026-10-09):
  // 120k DOF 459.6 MiB, 90k DOF 343.6 MiB, 70k DOF 259.2 MiB. The phone wasm
  // heap stops at 512 MiB, so 120k is too close. 90k is the largest measured
  // size whose native peak stays under about 360 MiB.
  shell: 90_000,
});

/**
 * Phone caps for a frictionless or frictional pair. The active-set loop
 * refactorizes when the contact set changes, so these sit about 4× under
 * the bonded caps: thin 25k (bonded thin is 100k) and compact 10k (bonded
 * compact Cholesky is 40k).
 */
export const PHONE_FRICTION_DOF_CAPS = Object.freeze({
  tet10Thin: 25_000,
  tet10Compact: 10_000,
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

/** Phone DOF cap for frictionless or frictional contact. Desktop is memory only. */
export function frictionDofCap(profile, thin) {
  if (profile !== 'phone') return Infinity;
  return thin ? PHONE_FRICTION_DOF_CAPS.tet10Thin : PHONE_FRICTION_DOF_CAPS.tet10Compact;
}

/** Phone DOF cap for a shell. Desktop is limited only by memory. */
export function shellDofCap(profile) {
  if (profile !== 'phone') return Infinity;
  return PHONE_DOF_CAPS.shell;
}

/**
 * Practical desktop ceiling for an adaptive remesh. The product cap is
 * memory, which is too loose for a bracket that would otherwise chase a
 * singularity for three passes. Thin parts stay on the thin-wall budget.
 */
export const DESKTOP_REFINE_DOF_CAP = 200_000;

/** Explicit `mesh.refine` wins. An omitted study refines on phone and on desktop. */
export function refineMode(study, profile) {
  const stored = study && study.mesh ? study.mesh.refine : undefined;
  if (stored === 'off' || stored === 'auto') return stored;
  if (profile === 'phone') return 'auto';
  return 'auto';
}

/** Phone does two passes, desktop three, until Artur benches the phone path. */
export function refinePassLimit(profile) {
  return profile === 'phone' ? 2 : 3;
}

/**
 * Hot-spot remesh ceiling on a phone. The solid solve caps, the 90k shell
 * cap, and the friction caps are separate and are not this number.
 */
export const PHONE_REFINE_DOF_CAP = 40_000;

/** DOF ceiling for a hot-spot remesh. Phone stops at 40k. Desktop is unchanged. */
export function refineDofCap(profile, thin, _) {
  if (profile === 'phone') return PHONE_REFINE_DOF_CAP;
  if (thin) return THIN_WALL_DOF_BUDGET;
  return DESKTOP_REFINE_DOF_CAP;
}

/** Timing-line note when a phone remesh would pass the hot-spot cap. */
export function phoneRefineStopNote(cap = PHONE_REFINE_DOF_CAP) {
  const n = Math.max(0, Math.round(Number(cap) || 0));
  const label = n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n);
  return `Refinement stopped at phone limit (${label} DOF)`;
}

/**
 * Phone refuses a hot-spot mesh above `cap`. A count equal to the cap still
 * fits. Desktop always continues; its sizing field still scales to its own cap.
 * `nextDofs` is the sizing estimate before that scale, or the meshed count.
 */
export function refineStepAllowed(profile, nextDofs, cap = PHONE_REFINE_DOF_CAP) {
  if (profile !== 'phone') return true;
  const limit = Number.isFinite(cap) && cap > 0 ? cap : PHONE_REFINE_DOF_CAP;
  const dofs = Number(nextDofs);
  if (!Number.isFinite(dofs)) return true;
  return dofs <= limit;
}

/** Study mesh target, or fTetWild's default of 1/20 of the bbox diagonal. */
export function preferredEdgeLength(diagonal, target) {
  if (typeof target === 'number' && Number.isFinite(target) && target > 0) return target;
  if (!(diagonal > 0)) return 1;
  return diagonal / 20;
}

/**
 * Gauge estimate. Volume/area of a plate is about half the wall, so twice
 * that is the thickness a tet stack has to cross.
 */
export function wallThickness(shape) {
  if (!shape || !(shape.thickness > 0)) return 0;
  return 2 * shape.thickness;
}

/**
 * Edge length for a study.
 *
 * An explicit `mesh.target` is kept, then grown to the DOF cap. Auto on a
 * thin part requests the shorter of the bbox default and `wall / 2`. When
 * the phone cap or `THIN_WALL_DOF_BUDGET` cannot afford that edge, the mesh
 * keeps the bbox default instead of an intermediate length that slivers, and
 * `coarsened` is set so the study can warn.
 */
export function chooseEdgeLength(shape, target, cap) {
  const diagonal = shape && shape.diagonal > 0 ? shape.diagonal : 0;
  const volume = shape && shape.volume > 0 ? shape.volume : 0;
  const explicit = typeof target === 'number' && Number.isFinite(target) && target > 0;
  const preferred = preferredEdgeLength(diagonal, explicit ? target : 0);
  const wallMm = wallThickness(shape);
  if (explicit || !shape || !isThinPart(shape)) {
    const capped = edgeForCap(volume, preferred, cap);
    return {
      edgeLength: capped.edgeLength,
      coarsened: capped.coarsened,
      requested: preferred,
      wallMm,
      elementsThrough: wallMm > 0 ? wallMm / capped.edgeLength : null,
    };
  }
  const two = wallMm > 0 ? wallMm / THIN_ELEMENTS_THROUGH : 0;
  const requested = two > 0 ? Math.min(preferred, two) : preferred;
  const limit = Number.isFinite(cap) ? Math.min(cap, THIN_WALL_DOF_BUDGET) : THIN_WALL_DOF_BUDGET;
  const fitted = edgeForCap(volume, requested, limit);
  let edgeLength = fitted.edgeLength;
  let coarsened = fitted.coarsened;
  // An edge between gauge/2 and the gauge slivers (aspect about 30 at
  // 3.16 mm on this 3 mm wall). Keep the bbox default instead. fTetWild
  // still refines to the wall; on this bracket that is 3 elements through
  // 3.175 mm, so the fallback is not a one-element mesh and does not warn.
  if (wallMm > 0 && edgeLength > two * 1.05 && edgeLength < wallMm * 1.25) {
    edgeLength = preferred;
    coarsened = edgeLength > preferred * 1.02;
  }
  return {
    edgeLength,
    coarsened,
    requested,
    wallMm,
    elementsThrough: wallMm > 0 ? wallMm / edgeLength : null,
  };
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
  if (SHELLS_AVAILABLE) solvers.add('shell');
  return {
    ...wasmCaps,
    solvers: [...solvers],
    shells: SHELLS_AVAILABLE,
  };
}
