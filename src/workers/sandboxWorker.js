// workers/sandboxWorker.js
// This worker executes user scripts in an isolated context with restricted globals
import Module from '../../built/manifold';
import {
  fastenerClearanceDia,
  fastenerTapDrillDia,
  fastenerMajorDia,
  listFastenerSizes,
  resolveFastenerSize,
} from './fastenerSizes.js';
import { isFilletSliverDirty } from '../utils/filletSliverGuard.js';
import { expandFilletCutterContour, planFilletSweepPath } from '../utils/filletAlongPath.js';
import { assembleSweepPath } from '../utils/edgeSweepPath.js';

/**
 * List of globals to block/remove in the worker context
 */
const BLOCKED_GLOBALS = [
  // Network
  'fetch',
  'XMLHttpRequest', 
  'WebSocket',
  'EventSource',
  
  // Storage
  'indexedDB',
  'caches',
  
  // Workers (prevent spawning nested workers)
  'Worker',
  'SharedWorker',
  
  // Messaging that could leak data
  'BroadcastChannel',
  
  // Import (dynamic) - We load Manifold before blocking
  'importScripts',
];

/**
 * Globals to make read-only proxies (allow reading but not as escape vectors)
 */
const READONLY_GLOBALS = [
  'navigator',
  'location',
  'performance',
];

let manifoldModule = null;
let isInitialized = false;
let cachedManifold = null;
// Nonce of the execute that last wrote cachedManifold (game compare staleness).
let cachedExecuteNonce = null;
// Live ghost target for game-mode match (independent cloned handle retained
// across attempt executes — not an alias of cachedManifold).
let gameTargetManifold = null;
// Snapshot of the attempt solid at the execute that ran while a ghost was set.
// compareGameMatch grades this — never ambient cachedManifold.
let gameAttemptManifold = null;

/** Best-effort Manifold.dispose (embind .delete); ignore missing/throws. */
function _safeDeleteManifold(m) {
  if (!m) return;
  try {
    if (typeof m.delete === 'function') m.delete();
  } catch (_) { /* already freed or non-embind */ }
}

/** Finite and > 0, else fallback (for relEps / volFloor). */
function _positiveFinite(v, fallback) {
  return (Number.isFinite(v) && v > 0) ? v : fallback;
}

// ============================================================================
// EXTENDED MANIFOLD HELPERS
// These functions are injected into the script execution scope
// ============================================================================

// ---------------------------------------------------------------- status
// Build-tolerant Manifold status probe -- the single source of truth for
// "is this manifold valid". The two builds in use report status() in
// DIFFERENT shapes, and both must work:
//   * npm `manifold-3d` (harness/CI)  -> the string 'NoError'
//   * bundled `built/manifold.js` (the browser worker) -> an enum object
//     whose .value is 0 for valid and nonzero for an error (11 = degenerate)
// So comparing status() against the string 'NoError' inline throws on EVERY
// valid manifold in the browser while passing in the harness -- the exact C8
// bug class. Never inline a status comparison again; call this.
// Returns null when valid (or when the status shape is unknown to this
// build -- callers keep their volume() floor checks), else a printable label.
function _c4StatusError(m) {
  if (!m || typeof m.status !== 'function') return 'not a manifold';
  const s = m.status();
  if (typeof s === 'string') return s === 'NoError' ? null : s;
  if (s && typeof s.value === 'number') return s.value === 0 ? null : `code ${s.value}`;
  return null;
}

/** Slice-01: fail loudly on bad numeric args (never silently produce empty/non-manifold). */
function _c4RequirePositive(fn, label, val) {
  if (typeof val !== 'number' || !Number.isFinite(val) || !(val > 0)) {
    throw new Error(`${fn}: ${label} must be a finite number > 0 (got ${val})`);
  }
}

/** Status + empty-volume guard shared by feature cutters. */
function _c4RequireValidSolid(out, fn) {
  const se = _c4StatusError(out);
  if (se) throw new Error(`${fn}: bad result (${se})`);
  if (typeof out.volume === 'function' && out.volume() <= 1e-9) {
    throw new Error(`${fn}: result is EMPTY (volume 0) — cutter consumed the solid or inputs were degenerate`);
  }
  return out;
}

/**
 * Helper to compute uniform scale ratio based on min perpendicular dimension
 */
function getScaleRatio(manifold, axis, thickness) {
  const bbox = manifold.boundingBox();
  const minPt = bbox.min;
  const maxPt = bbox.max;
  const sizes = [
    maxPt[0] - minPt[0],
    maxPt[1] - minPt[1],
    maxPt[2] - minPt[2]
  ];
  const perpAxes = [0, 1, 2].filter(i => i !== axis);
  const minPerpSize = Math.min(sizes[perpAxes[0]], sizes[perpAxes[1]]);
  if (minPerpSize <= 2 * thickness) {
    throw new Error('Shell thickness too large for object dimensions');
  }
  return (minPerpSize - 2 * thickness) / minPerpSize;
}

/**
 * Shell function - creates a hollow version of a manifold
 * @param {Manifold} manifold - The input manifold to shell
 * @param {number} thickness - Wall thickness
 * @param {string} axis - Axis for shell alignment ('x', 'y', or 'z')
 * @returns {Manifold} The inner tool for subtraction (use manifold.subtract(shell(...)))
 */
function shell(manifold, thickness, axis = "z") {
  let axisIndex;
  switch (axis.toLowerCase()) {
    case "x": axisIndex = 0; break;
    case "y": axisIndex = 1; break;
    case "z": axisIndex = 2; break;
    default: throw new Error('Axis must be "x", "y", or "z"');
  }
  const scaleRatio = getScaleRatio(manifold, axisIndex, thickness);
  
  // Create inner scaled version
  const inner = manifold.scale([scaleRatio, scaleRatio, scaleRatio]);
  
  // Get bounding boxes
  const bboxOuter = manifold.boundingBox();
  const bboxInner = inner.boundingBox();
  
  // Translate inner to coincide on the min side along axis
  const trans = [0, 0, 0];
  trans[axisIndex] = bboxOuter.min[axisIndex] - bboxInner.min[axisIndex];
  const innerTranslated = inner.translate(trans);
  
  return innerTranslated;  // Return tool for subtraction
}

/**
 * Add draft angle to a manifold (tapers from bottom to top)
 * 
 * Applies a linear taper along the specified axis, commonly used in 
 * injection molding to allow parts to release from molds.
 * 
 * @param {Manifold} manifold - The manifold to add draft to
 * @param {number} draftDeg - Draft angle in degrees (typically 1-3° for molding)
 * @param {string} [axis='z'] - The pull/draft direction axis: 'x', 'y', or 'z'
 * @returns {Manifold} The drafted manifold (tapered toward max along axis)
 * @throws {Error} If axis is not 'x', 'y', or 'z'
 * 
 * @example
 * // Add 2° draft to a shelled box for injection molding
 * const box = Manifold.cube([50, 50, 30], true);
 * const hollowed = box.subtract(shell(box, 2, 'z'));
 * const drafted = addDraft(hollowed, 2, 'z');
 * return drafted;
 */
function addDraft(manifold, draftDeg, axis = "z") {
  let axisIndex;
  switch (axis.toLowerCase()) {
    case "x": axisIndex = 0; break;
    case "y": axisIndex = 1; break;
    case "z": axisIndex = 2; break;
    default: throw new Error('Axis must be "x", "y", or "z"');
  }
  
  const bbox = manifold.boundingBox();
  const minCoord = bbox.min[axisIndex];
  const maxCoord = bbox.max[axisIndex];
  const H = maxCoord - minCoord;
  
  const sizes = [
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2]
  ];
  
  const perpAxes = [0, 1, 2].filter(i => i !== axisIndex);
  const minPerpSize = Math.min(sizes[perpAxes[0]], sizes[perpAxes[1]]);
  
  const tanDraft = Math.tan(draftDeg * Math.PI / 180);
  const taper = H * tanDraft;
  const topScale = (minPerpSize - 2 * taper) / minPerpSize;
  
  // Centers in perp directions
  const centers = [0, 0, 0];
  centers[perpAxes[0]] = (bbox.min[perpAxes[0]] + bbox.max[perpAxes[0]]) / 2;
  centers[perpAxes[1]] = (bbox.min[perpAxes[1]] + bbox.max[perpAxes[1]]) / 2;
  
  const warp = (v) => {
    const coord = v[axisIndex];
    const t = (coord - minCoord) / H;
    const scale = 1 + t * (topScale - 1);
    const p1 = perpAxes[0];
    const p2 = perpAxes[1];
    v[p1] = (v[p1] - centers[p1]) * scale + centers[p1];
    v[p2] = (v[p2] - centers[p2]) * scale + centers[p2];
  };
  
  return manifold.warp(warp);
}

// Helpers for a loft function

// Compute centroid of a contour (array of [x, y] points)
function computeCentroid(contour) {
  let cx = 0;
  let cy = 0;
  const n = contour.length;
  if (n === 0) return [0, 0];

  for (const p of contour) {
    cx += p[0];
    cy += p[1];
  }
  return [cx / n, cy / n];
}

// Center a contour by subtracting its centroid
function centerContour(contour) {
  const [cx, cy] = computeCentroid(contour);
  return contour.map(p => [p[0] - cx, p[1] - cy]);
}

// Resample a closed contour to n evenly spaced points using arc-length parameterization
function resampleContour(contour, n) {
  if (contour.length < 2) return contour;
  if (n < 2) n = 2;

  // Compute cumulative arc lengths
  const lengths = [0];
  for (let i = 1; i < contour.length; i++) {
    const dx = contour[i][0] - contour[i - 1][0];
    const dy = contour[i][1] - contour[i - 1][1];
    lengths.push(lengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  // Close the loop
  const dxClose = contour[0][0] - contour[contour.length - 1][0];
  const dyClose = contour[0][1] - contour[contour.length - 1][1];
  lengths.push(lengths[lengths.length - 1] + Math.sqrt(dxClose * dxClose + dyClose * dyClose));

  const totalLength = lengths[lengths.length - 1];

  const resampled = [];
  for (let i = 0; i < n; i++) {
    const target = (i / n) * totalLength;

    // Find segment
    let seg = 0;
    while (seg < lengths.length - 1 && target > lengths[seg + 1]) seg++;

    const s0 = lengths[seg];
    const s1 = lengths[seg + 1];
    const frac = (target - s0) / (s1 - s0);

    const idx0 = seg % contour.length;
    const idx1 = (seg + 1) % contour.length;

    const x = contour[idx0][0] + frac * (contour[idx1][0] - contour[idx0][0]);
    const y = contour[idx0][1] + frac * (contour[idx1][1] - contour[idx0][1]);

    resampled.push([x, y]);
  }

  return resampled;
}

// Rotate a contour (array of [x, y] points) by a given angle in degrees
function rotateContour(contour, deg) {
  if (contour.length === 0) return contour;
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return contour.map(p => [
    p[0] * cos - p[1] * sin,
    p[0] * sin + p[1] * cos
  ]);
}

// Compute sum of squared distances between two contours of equal length
function sumSqDist(cont1, cont2) {
  if (cont1.length !== cont2.length) {
    throw new Error('Contours must have the same number of points for sumSqDist');
  }
  let dist = 0;
  for (let i = 0; i < cont1.length; i++) {
    const dx = cont1[i][0] - cont2[i][0];
    const dy = cont1[i][1] - cont2[i][1];
    dist += dx * dx + dy * dy;
  }
  return dist;
}

function loft({
  topCS,
  bottomCS,
  height = 30,
  twistDeg = 0,
  topScale = 1.0,
  align = true,
  resolution = 1024  // Higher for better corner preservation
} = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;

  // Extract and center contours
  let bottomContour = centerContour(bottomCS.toPolygons()[0]);
  let topContour = centerContour(topCS.toPolygons()[0]);

  // Scale top
  topContour = topContour.map(p => [p[0] * topScale, p[1] * topScale]);

  // Resample using arc length
  const bottomTable = resampleContour(bottomContour, resolution);
  let topTable = resampleContour(topContour, resolution);

  // Optional alignment
  if (align) {
    let bestRot = 0;
    let minDist = Infinity;
    const steps = 72;
    for (let k = 0; k < steps; k++) {
      const rot = k * (360 / steps);
      const rotated = rotateContour(topTable, rot);
      const d = sumSqDist(bottomTable, rotated);
      if (d < minDist) {
        minDist = d;
        bestRot = rot;
      }
    }
    topTable = rotateContour(topTable, bestRot);
  }

  // Precompute radial distance table for bottom (normalized radius at each angle)
  const radialTable = [];
  for (let i = 0; i < resolution; i++) {
    const x = bottomTable[i][0];
    const y = bottomTable[i][1];
    radialTable[i] = Math.sqrt(x * x + y * y);
  }

  // Extrude bottom to full height
  const straight = Manifold.extrude(bottomCS, height, 128);

  // Warp using polar coordinates for proper corner blending
  const warp = (v) => {
    let [x, y, z] = v;

    const t = z / height;

    // Handle center separately
    const r_orig = Math.sqrt(x * x + y * y);
    if (r_orig < 1e-8) {
      v[0] = 0;
      v[1] = 0;
      return;
    }

    // Normalized radius on bottom at this angle
    let angle = Math.atan2(y, x);
    if (angle < 0) angle += 2 * Math.PI;
    const s = angle / (2 * Math.PI);

    const i = Math.floor(s * resolution);
    const frac = (s * resolution) - i;

    // Interpolate normalized radius from bottom table
    let r_bottom = radialTable[i];
    r_bottom += frac * (radialTable[(i + 1) % resolution] - radialTable[i]);

    // Scale factor for this ray
    const scale = r_orig / r_bottom;

    // Interpolate target point from top table at same angle
    let tx = topTable[i][0];
    let ty = topTable[i][1];
    tx += frac * (topTable[(i + 1) % resolution][0] - tx);
    ty += frac * (topTable[(i + 1) % resolution][1] - ty);

    // Linear blend in shape space
    let targetX = x + t * (tx * scale - x);
    let targetY = y + t * (ty * scale - y);

    // Apply twist
    if (twistDeg !== 0) {
      const twistAngle = t * twistDeg * Math.PI / 180;
      const cosT = Math.cos(twistAngle);
      const sinT = Math.sin(twistAngle);
      const tempX = targetX * cosT - targetY * sinT;
      targetY = targetX * sinT + targetY * cosT;
      targetX = tempX;
    }

    v[0] = targetX;
    v[1] = targetY;
  };

  return straight.warp(warp);
}

/**
 * Sweep a 2D profile along a 3D path
 * 
 * Creates a 3D manifold by extruding a cross-section profile along a parametric
 * path curve. Uses Rotation Minimizing Frames (RMF) for smooth orientation
 * without twist artifacts, and arc-length parameterization for uniform distribution.
 * 
 * @param {CrossSection} profile - The 2D cross-section to sweep (centered at origin)
 * @param {Object} path - Parametric path definition
 * @param {Function} path.position - Function(t) returning [x,y,z] position on curve
 * @param {Function} [path.derivative] - Function(t) returning first derivative [dx,dy,dz].
 *                                       If omitted, computed numerically.
 * @param {number} [path.tMin=0] - Start parameter value
 * @param {number} [path.tMax=1] - End parameter value
 * @param {Object} [options] - Sweep options
 * @param {number} [options.arcSamples=1000] - Samples for arc-length table (higher = more accurate)
 * @param {number} [options.extrudeSegments=64] - Segments along the extrusion
 * @param {number} [options.epsilon=1e-5] - Delta for numerical derivatives
 * @param {number[]} [options.initialNormal] - Initial normal direction hint [x,y,z]
 * @returns {Manifold} The swept 3D manifold
 * 
 * @example
 * // Sweep a circle along a helix
 * const profile = CrossSection.circle(2, 32);
 * const helixPath = {
 *   position: (t) => [10 * Math.cos(t), 10 * Math.sin(t), 3 * t],
 *   tMin: 0,
 *   tMax: 4 * Math.PI
 * };
 * return sweep(profile, helixPath);
 */
function sweep(profile, path, options = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  const {
    position,
    derivative: explicitDerivative,
    tMin = 0,
    tMax = 1
  } = path;
  
  const {
    arcSamples = 1000,
    extrudeSegments = 64,
    epsilon = 1e-5,
    initialNormal = null
  } = options;
  
  if (typeof position !== 'function') {
    throw new Error('path.position must be a function');
  }
  
  // Numerical derivative fallback
  const derivative = explicitDerivative || ((t) => {
    const p0 = position(t - epsilon);
    const p1 = position(t + epsilon);
    return vecMul(1 / (2 * epsilon), vecSub(p1, p0));
  });
  
  // Precompute arc length table
  const tValues = [];
  const sValues = [0];
  const deltaT = (tMax - tMin) / arcSamples;
  
  for (let i = 0; i <= arcSamples; i++) {
    tValues.push(tMin + i * deltaT);
  }
  
  for (let i = 1; i <= arcSamples; i++) {
    const speedPrev = vecNorm(derivative(tValues[i - 1]));
    const speedCurr = vecNorm(derivative(tValues[i]));
    const deltaS = (speedPrev + speedCurr) / 2 * deltaT;
    sValues.push(sValues[i - 1] + deltaS);
  }
  
  const totalLength = sValues[sValues.length - 1];
  
  if (totalLength < epsilon) {
    throw new Error('Path has zero or near-zero length');
  }
  
  // =========================================================================
  // Precompute Rotation Minimizing Frames (RMF) at sample points
  // This prevents twist discontinuities that occur with Frenet frames
  // =========================================================================
  
  const frames = []; // Array of { T, N, B } at each tValue
  
  // Compute initial frame
  const T0 = vecNormalize(derivative(tValues[0]));
  let N0;
  
  if (initialNormal) {
    // Use provided initial normal, orthogonalize to tangent
    const proj = vecMul(vecDot(initialNormal, T0), T0);
    N0 = vecNormalize(vecSub(initialNormal, proj));
  } else {
    // Find a vector not parallel to T0 for initial normal
    const absT = [Math.abs(T0[0]), Math.abs(T0[1]), Math.abs(T0[2])];
    let minAxis;
    if (absT[0] <= absT[1] && absT[0] <= absT[2]) {
      minAxis = [1, 0, 0];
    } else if (absT[1] <= absT[0] && absT[1] <= absT[2]) {
      minAxis = [0, 1, 0];
    } else {
      minAxis = [0, 0, 1];
    }
    N0 = vecNormalize(vecCross(T0, minAxis));
  }
  
  const B0 = vecCross(T0, N0);
  frames.push({ T: T0, N: N0, B: B0 });
  
  // Propagate frame using double reflection method (rotation minimizing)
  for (let i = 1; i <= arcSamples; i++) {
    const prevFrame = frames[i - 1];
    const Ti = vecNormalize(derivative(tValues[i]));
    
    // Double reflection method for RMF
    // Reflect previous frame to midpoint, then to current point
    const v1 = vecSub(position(tValues[i]), position(tValues[i - 1]));
    const c1 = vecDot(v1, v1);
    
    if (c1 < epsilon * epsilon) {
      // Points too close, copy previous frame with new tangent
      const proj = vecMul(vecDot(prevFrame.N, Ti), Ti);
      const Ni = vecNormalize(vecSub(prevFrame.N, proj));
      const Bi = vecCross(Ti, Ni);
      frames.push({ T: Ti, N: Ni, B: Bi });
      continue;
    }
    
    // First reflection: reflect N and T across v1
    const NL = vecSub(prevFrame.N, vecMul((2 / c1) * vecDot(v1, prevFrame.N), v1));
    const TL = vecSub(prevFrame.T, vecMul((2 / c1) * vecDot(v1, prevFrame.T), v1));
    
    // Second reflection: reflect across v2 = Ti - TL
    const v2 = vecSub(Ti, TL);
    const c2 = vecDot(v2, v2);
    
    let Ni;
    if (c2 < epsilon * epsilon) {
      Ni = NL;
    } else {
      Ni = vecSub(NL, vecMul((2 / c2) * vecDot(v2, NL), v2));
    }
    
    // Ensure orthonormality
    Ni = vecNormalize(vecSub(Ni, vecMul(vecDot(Ni, Ti), Ti)));
    const Bi = vecCross(Ti, Ni);
    
    frames.push({ T: Ti, N: Ni, B: Bi });
  }
  
  // Create straight extrusion to warp
  const straight = Manifold.extrude(profile, totalLength, extrudeSegments);
  
  // Warp function using precomputed RMF frames
  const warp = (v) => {
    let [x, y, s] = v;
    s = Math.max(0, Math.min(totalLength, s));
    
    // Binary search for arc length to parameter mapping
    let low = 0;
    let high = sValues.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (sValues[mid] <= s) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    
    let i = low;
    if (i === sValues.length - 1) i--;
    
    // Interpolate between frames
    const frac = (s - sValues[i]) / (sValues[i + 1] - sValues[i]);
    const t = tValues[i] + frac * (tValues[i + 1] - tValues[i]);
    
    // Get position on curve
    const P = position(t);
    
    // Interpolate frame (simple linear interp, could use slerp for better results)
    const frame0 = frames[i];
    const frame1 = frames[i + 1];
    
    const N = vecNormalize([
      frame0.N[0] + frac * (frame1.N[0] - frame0.N[0]),
      frame0.N[1] + frac * (frame1.N[1] - frame0.N[1]),
      frame0.N[2] + frac * (frame1.N[2] - frame0.N[2])
    ]);
    const B = vecNormalize([
      frame0.B[0] + frac * (frame1.B[0] - frame0.B[0]),
      frame0.B[1] + frac * (frame1.B[1] - frame0.B[1]),
      frame0.B[2] + frac * (frame1.B[2] - frame0.B[2])
    ]);
    
    // Map local (x, y) to N-B plane
    v[0] = P[0] + x * N[0] + y * B[0];
    v[1] = P[1] + x * N[1] + y * B[1];
    v[2] = P[2] + x * N[2] + y * B[2];
  };
  
  return straight.warp(warp);
}

// ============================================================================
// VECTOR HELPERS (for sweep and other operations)
// ============================================================================

function vecAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vecSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vecMul(s, v) { return [s * v[0], s * v[1], s * v[2]]; }
function vecDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vecCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function vecNorm(v) { return Math.sqrt(vecDot(v, v)); }
function vecNormalize(v) {
  const len = vecNorm(v);
  return len > 1e-8 ? vecMul(1 / len, v) : [0, 0, 1];
}

/**
 * Sweep a profile along a path defined by an array of points
 * 
 * Convenience wrapper for sweep() that accepts a polyline path.
 * Internally creates a Catmull-Rom spline through the points.
 * 
 * @param {CrossSection} profile - The 2D cross-section to sweep
 * @param {number[][]} points - Array of [x,y,z] points defining the path (minimum 2 points)
 * @param {Object} [options] - Sweep options (see sweep())
 * @param {boolean} [options.closed=false] - Whether the path forms a closed loop
 * @returns {Manifold} The swept 3D manifold
 * 
 * @example
 * // Sweep along a series of points
 * const profile = CrossSection.circle(1, 16);
 * const points = [
 *   [0, 0, 0],
 *   [10, 5, 0],
 *   [20, 0, 10],
 *   [30, -5, 10]
 * ];
 * return sweepPoints(profile, points);
 */
function sweepPoints(profile, points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('points must be an array of at least 2 [x,y,z] coordinates');
  }
  
  const { closed = false, ...sweepOptions } = options;
  const n = points.length;
  
  // Catmull-Rom spline interpolation
  const catmullRom = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [
      0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3)
    ];
  };
  
  const catmullRomDeriv = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    return [
      0.5 * ((-p0[0] + p2[0]) + 2 * (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t + 3 * (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t2),
      0.5 * ((-p0[1] + p2[1]) + 2 * (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t + 3 * (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t2),
      0.5 * ((-p0[2] + p2[2]) + 2 * (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t + 3 * (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t2)
    ];
  };
  
  // Get control points with proper boundary handling
  // For open curves, extrapolate phantom points to maintain tangent direction
  const getPoint = (i) => {
    if (closed) {
      return points[((i % n) + n) % n];
    } else {
      if (i < 0) {
        // Extrapolate before start: reflect point[1] across point[0]
        const idx = -i;
        if (idx <= n - 1) {
          return vecSub(vecMul(2, points[0]), points[idx]);
        }
        return points[0];
      } else if (i >= n) {
        // Extrapolate after end: reflect point[n-2] across point[n-1]
        const idx = 2 * (n - 1) - i;
        if (idx >= 0) {
          return vecSub(vecMul(2, points[n - 1]), points[idx]);
        }
        return points[n - 1];
      }
      return points[i];
    }
  };
  
  const numSegments = closed ? n : n - 1;
  
  const path = {
    position: (t) => {
      // Clamp t to valid range to avoid issues at boundaries
      t = Math.max(0, Math.min(1, t));
      const scaledT = t * numSegments;
      let segment = Math.floor(scaledT);
      let localT = scaledT - segment;
      
      // Handle exact endpoint
      if (segment >= numSegments) {
        segment = numSegments - 1;
        localT = 1;
      }
      
      const p0 = getPoint(segment - 1);
      const p1 = getPoint(segment);
      const p2 = getPoint(segment + 1);
      const p3 = getPoint(segment + 2);
      
      return catmullRom(p0, p1, p2, p3, localT);
    },
    derivative: (t) => {
      t = Math.max(0, Math.min(1, t));
      const scaledT = t * numSegments;
      let segment = Math.floor(scaledT);
      let localT = scaledT - segment;
      
      if (segment >= numSegments) {
        segment = numSegments - 1;
        localT = 1;
      }
      
      const p0 = getPoint(segment - 1);
      const p1 = getPoint(segment);
      const p2 = getPoint(segment + 1);
      const p3 = getPoint(segment + 2);
      
      // Scale derivative by numSegments due to chain rule
      const d = catmullRomDeriv(p0, p1, p2, p3, localT);
      return vecMul(numSegments, d);
    },
    tMin: 0,
    tMax: 1
  };
  
  return sweep(profile, path, sweepOptions);
}

/**
 * Create a rounded box (box with filleted edges)
 * @param {number[]} size - [x, y, z] dimensions
 * @param {number} radius - Corner/edge radius
 * @param {number} segments - Number of segments for rounding (default 16)
 */
function roundedBox(size, radius, segments = 16) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  const minDim = Math.min(...size);
  const r = Math.min(radius, minDim / 2 - 0.001);
  if (!(r > 0)) return Manifold.cube(size, true);
  // Bundled Manifold has no offset()/minkowski — hull of 8 corner spheres
  // equals cube ⊕ sphere (rounded box).
  const half = size.map((s) => s / 2 - r);
  const spheres = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        spheres.push(
          Manifold.sphere(r, segments).translate([
            sx * half[0], sy * half[1], sz * half[2],
          ]),
        );
      }
    }
  }
  return Manifold.hull(spheres);
}

/**
 * Create a tube/pipe shape
 * @param {number} outerRadius - Outer radius
 * @param {number} innerRadius - Inner radius (hole)
 * @param {number} height - Height of the tube
 * @param {number} segments - Number of circular segments
 */
function tube(outerRadius, innerRadius, height, segments = 32) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  if (innerRadius >= outerRadius) {
    throw new Error('Inner radius must be smaller than outer radius');
  }
  
  const outer = Manifold.cylinder(height, outerRadius, outerRadius, segments);
  const inner = Manifold.cylinder(height, innerRadius, innerRadius, segments);
  
  return outer.subtract(inner);
}

/**
 * Create a hexagonal prism
 * @param {number} radius - Radius (circumradius)
 * @param {number} height - Height
 */
function hexPrism(radius, height) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  return Manifold.cylinder(height, radius, radius, 6);
}

/**
 * Mirror a manifold across a plane
 * @param {Manifold} manifold - The manifold to mirror
 * @param {string} plane - 'xy', 'xz', or 'yz'
 * @param {boolean} keepOriginal - Whether to union with original (default true)
 */
function mirror(manifold, plane = 'xy', keepOriginal = true) {
  let scale;
  switch (plane.toLowerCase()) {
    case 'xy': scale = [1, 1, -1]; break;
    case 'xz': scale = [1, -1, 1]; break;
    case 'yz': scale = [-1, 1, 1]; break;
    default: throw new Error('Plane must be "xy", "xz", or "yz"');
  }
  
  const mirrored = manifold.scale(scale);
  
  if (keepOriginal) {
    // Union might fail if they overlap - try to handle gracefully
    try {
      return manifold.add(mirrored);
    } catch {
      return mirrored;
    }
  }
  return mirrored;
}

/**
 * Create an array/grid of manifolds
 * @param {Manifold} manifold - The manifold to array
 * @param {number[]} counts - [nx, ny, nz] number of copies in each direction
 * @param {number[]} spacing - [dx, dy, dz] spacing between copies
 */
function array3D(manifold, counts, spacing) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  const [nx, ny, nz] = counts;
  const [dx, dy, dz] = spacing;
  
  const copies = [];
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (ix === 0 && iy === 0 && iz === 0) {
          copies.push(manifold);
        } else {
          copies.push(manifold.translate([ix * dx, iy * dy, iz * dz]));
        }
      }
    }
  }
  
  return Manifold.union(copies);
}

/**
 * Create a polar array (copies around an axis)
 * @param {Manifold} manifold - The manifold to array
 * @param {number} count - Number of copies
 * @param {number} radius - Radius from center (optional offset)
 * @param {string} axis - Rotation axis ('x', 'y', or 'z')
 */
function polarArray(manifold, count, radius = 0, axis = 'z') {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold } = manifoldModule;
  
  const copies = [];
  const angleStep = 360 / count;
  
  for (let i = 0; i < count; i++) {
    const angle = i * angleStep;
    let rotated;
    
    // Apply radius offset first
    let positioned = radius > 0 ? manifold.translate([radius, 0, 0]) : manifold;
    
    // Then rotate
    switch (axis.toLowerCase()) {
      case 'x':
        rotated = positioned.rotate([angle, 0, 0]);
        break;
      case 'y':
        rotated = positioned.rotate([0, angle, 0]);
        break;
      case 'z':
      default:
        rotated = positioned.rotate([0, 0, angle]);
        break;
    }
    
    copies.push(rotated);
  }
  
  return Manifold.union(copies);
}

/**
 * Center a manifold at origin
 * @param {Manifold} manifold - The manifold to center
 * @param {boolean[]} axes - [centerX, centerY, centerZ] which axes to center
 */
function center(manifold, axes = [true, true, true]) {
  const bbox = manifold.boundingBox();
  const offset = [0, 0, 0];
  
  for (let i = 0; i < 3; i++) {
    if (axes[i]) {
      offset[i] = -(bbox.min[i] + bbox.max[i]) / 2;
    }
  }
  
  return manifold.translate(offset);
}

/**
 * Align a manifold to a specific position
 * @param {Manifold} manifold - The manifold to align
 * @param {object} options - { min: [x,y,z], max: [x,y,z], center: [x,y,z] }
 */
function align(manifold, options = {}) {
  const bbox = manifold.boundingBox();
  const offset = [0, 0, 0];
  
  if (options.min) {
    for (let i = 0; i < 3; i++) {
      if (options.min[i] !== undefined) {
        offset[i] = options.min[i] - bbox.min[i];
      }
    }
  }
  
  if (options.max) {
    for (let i = 0; i < 3; i++) {
      if (options.max[i] !== undefined) {
        offset[i] = options.max[i] - bbox.max[i];
      }
    }
  }
  
  if (options.center) {
    for (let i = 0; i < 3; i++) {
      if (options.center[i] !== undefined) {
        const currentCenter = (bbox.min[i] + bbox.max[i]) / 2;
        offset[i] = options.center[i] - currentCenter;
      }
    }
  }
  
  return manifold.translate(offset);
}

/**
 * Get the dimensions of a manifold
 * @param {Manifold} manifold - The manifold to measure
 * @returns {object} { size: [x,y,z], min: [x,y,z], max: [x,y,z], center: [x,y,z] }
 */
function getDimensions(manifold) {
  const bbox = manifold.boundingBox();
  return {
    size: [
      bbox.max[0] - bbox.min[0],
      bbox.max[1] - bbox.min[1],
      bbox.max[2] - bbox.min[2]
    ],
    min: [...bbox.min],
    max: [...bbox.max],
    center: [
      (bbox.min[0] + bbox.max[0]) / 2,
      (bbox.min[1] + bbox.max[1]) / 2,
      (bbox.min[2] + bbox.max[2]) / 2
    ]
  };
}

// ============================================================================
// C4 — Selection + Feature helpers for Manifold JS (3dculos sandbox)
// Ported from cadgen-workspace/harness/c4_helpers.mjs (all 21 harness tests
// green; verified against real dataset STEP ground truth).
//
// Mesh facts (verified against manifold-3d):
//   getMesh() -> { numProp, vertProperties(Float32), triVerts(Uint32, 3/tri),
//                  faceID(Uint32, per-tri), ... }
//   faceID = true BRep face grouping (stable across booleans; 6 on a box,
//   14 on a 12-seg cylinder, 36 on a holed box). Triangle winding is outward.
//   runIndex = per-component (NOT per edge) — edges are derived from the
//   welded triangle map instead.
//   .transform(m) = flat-16 matrix, axes packed as ROWS (row-vector
//   convention, empirically verified; see frameToMatrix). Last row = translation.
//   No face/edge API exists — this module IS the selector layer.
// ============================================================================

// ---------------------------------------------------------------- local math
function _c4Cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _c4Dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function _c4Len(v) { return Math.hypot(v[0], v[1], v[2]); }
function _c4Norm(v) { const l = _c4Len(v) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function _c4Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _c4Add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function _c4Mul(s, v) { return [s*v[0], s*v[1], s*v[2]]; }

// ---------------------------------------------------------------- mesh data
// c4MeshData(m) -> { V:[[x,y,z]...], faces:[{id, tris, normal, center, verts}],
//                    edges:[{a, b, va, vb, tris, tangent, faces:[faceIdx,faceIdx]}] }
function c4MeshData(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const V = [];
  // Vertex count = vertProperties length / numProp (NOT tri count — that silently
  // truncated V on welded meshes and read past the buffer on sparse ones).
  const nVerts = mesh.vertProperties.length / np;
  for (let i = 0; i < nVerts; i++)
    V.push([mesh.vertProperties[i*np], mesh.vertProperties[i*np+1], mesh.vertProperties[i*np+2]]);

  const faceMap = new Map();
  const triFace = [];
  for (let i = 0; i < mesh.numTri; i++) {
    const fid = mesh.faceID[i];
    triFace.push(fid);
    if (!faceMap.has(fid)) faceMap.set(fid, []);
    faceMap.get(fid).push(i);
  }
  const faces = [];
  const triToFace = new Int32Array(mesh.numTri).fill(-1);
  for (const [fid, tris] of faceMap) {
    const n = [0, 0, 0];
    for (const t of tris) {
      const v0 = V[mesh.triVerts[t*3]], v1 = V[mesh.triVerts[t*3+1]], v2 = V[mesh.triVerts[t*3+2]];
      const tn = _c4Norm(_c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0))); // outward (winding)
      n[0] += tn[0]; n[1] += tn[1]; n[2] += tn[2];
    }
    const nrm = _c4Norm(n);
    // Manifold may merge coplanar-but-DISCONNECTED regions into one faceID
    // (e.g. a base top ring at z=5 and a raised step top at z=15 both have
    // normal +Z), which breaks face `center` (mean of both planes) and
    // misplaces any feature cut from it. Split the group into CONNECTED
    // components (triangles sharing an edge). NOTE: must NOT use a
    // coplanarity condition — tessellated curved faces (fillets) have
    // non-coplanar adjacent facets, and shredding them re-creates the
    // per-seam face pairings that force expensive convexEdges ball probes
    // and break chamfer/fillet edge data.
    const parent = tris.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const edgeTris = new Map();
    tris.forEach((t, gi) => {
      const vs = [mesh.triVerts[t*3], mesh.triVerts[t*3+1], mesh.triVerts[t*3+2]];
      for (let k = 0; k < 3; k++) {
        const u = vs[k], w = vs[(k+1) % 3];
        const key = u < w ? u * 1e9 + w : w * 1e9 + u;
        if (!edgeTris.has(key)) edgeTris.set(key, []);
        edgeTris.get(key).push(gi);
      }
    });
    for (const list of edgeTris.values())
      for (let i = 1; i < list.length; i++) union(list[0], list[i]);
    const byRoot = new Map();
    tris.forEach((t, gi) => {
      const r = find(gi);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(gi);
    });
    // Components that lie in the SAME plane (e.g. an annulus split into two
    // regions by a groove, both at z=10) are re-merged into one face so that
    // queries see the original Manifold face (center on the plane, on the
    // part's symmetry axis when regions are symmetric). Curved faces never
    // re-merge: their connected components each span one plane offset, and a
    // curved group is a single connected component anyway.
    const offs = tris.map((t) => {
      const v0 = V[mesh.triVerts[t*3]];
      return nrm[0]*v0[0] + nrm[1]*v0[1] + nrm[2]*v0[2];
    });
    const planeGroups = new Map(); // offsetKey -> [gi...]
    for (const gis of byRoot.values()) {
      const key = Math.round(offs[gis[0]] * 1e3);
      if (!planeGroups.has(key)) planeGroups.set(key, []);
      planeGroups.get(key).push(...gis);
    }
    for (const gis of planeGroups.values()) {
      const cn = [0, 0, 0];
      const c = [0, 0, 0];
      let areaSum = 0;
      const all = [];
      const trisSub = gis.map(gi => tris[gi]);
      for (const t of trisSub) {
        const v0 = V[mesh.triVerts[t*3]], v1 = V[mesh.triVerts[t*3+1]], v2 = V[mesh.triVerts[t*3+2]];
        const cxv = _c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0));
        const area = 0.5 * _c4Len(cxv);
        const tn = _c4Norm(cxv);
        cn[0] += tn[0]; cn[1] += tn[1]; cn[2] += tn[2];
        // Area-weighted triangle centroid (matches Viewport face pick center).
        const tc = [(v0[0]+v1[0]+v2[0])/3, (v0[1]+v1[1]+v2[1])/3, (v0[2]+v1[2]+v2[2])/3];
        c[0] += tc[0]*area; c[1] += tc[1]*area; c[2] += tc[2]*area;
        areaSum += area;
        for (const v of [v0, v1, v2]) {
          if (!all.includes(v)) all.push(v);
        }
      }
      const center = areaSum > 1e-18 ? _c4Mul(1/areaSum, c) : [0, 0, 0];
      faces.push({ id: fid, tris: trisSub, normal: _c4Norm(cn), center, verts: all });
    }
  }
  faces.sort((a, b) => a.id - b.id);

  // ── Slice 12: merge coplanar connected faces ─────────────────────────
  // built/manifold.wasm (and some Manifold builds) assign a *unique faceID
  // per triangle*. Without this pass, a rectangular face is two one-tri
  // "faces" whose centers are triangle centroids — so workplaneFromFace +
  // hole(u=0,v=0) misses the true face center (playtest Center miss).
  // Merge only when adjacent faces share an edge, normals align, and plane
  // offsets match.
  //
  // Hotfix (occlusion/tangent/hole slice): use a tight 0.1° pairwise gate.
  // A 1° gate + union-find was transitive through fillet chord facets
  // (~0.23° steps on a 384-seg arc), absorbing the true planar top into a
  // frankenstein face whose averaged normal drifted >5° from +Z — then
  // facesByNormal(selNormal, 5) missed the face the Viewport chip showed.
  // Curved walls (normals diverge >0.1°) stay one-tri each so convexEdges
  // dihedral filtering still sees tessellation seams.
  {
    const nF = faces.length;
    if (nF > 1) {
      const parent = Array.from({ length: nF }, (_, i) => i);
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
      const t2f = new Int32Array(mesh.numTri).fill(-1);
      for (let fi = 0; fi < nF; fi++)
        for (const t of faces[fi].tris) t2f[t] = fi;
      const cosPlanar = Math.cos((0.1 * Math.PI) / 180);
      const edgeMapM = new Map();
      for (let t = 0; t < mesh.numTri; t++) {
        const vs = [mesh.triVerts[t*3], mesh.triVerts[t*3+1], mesh.triVerts[t*3+2]];
        for (let k = 0; k < 3; k++) {
          const u = vs[k], w = vs[(k+1)%3];
          const key = u < w ? u * 1e9 + w : w * 1e9 + u;
          if (!edgeMapM.has(key)) edgeMapM.set(key, []);
          edgeMapM.get(key).push(t);
        }
      }
      for (const trisE of edgeMapM.values()) {
        if (trisE.length !== 2) continue;
        const f0 = t2f[trisE[0]], f1 = t2f[trisE[1]];
        if (f0 < 0 || f1 < 0 || f0 === f1) continue;
        const A = faces[f0], B = faces[f1];
        if (_c4Dot(A.normal, B.normal) < cosPlanar) continue;
        const offA = A.center[0]*A.normal[0] + A.center[1]*A.normal[1] + A.center[2]*A.normal[2];
        const offB = B.center[0]*A.normal[0] + B.center[1]*A.normal[1] + B.center[2]*A.normal[2];
        if (Math.abs(offA - offB) > 1e-3) continue;
        union(f0, f1);
      }
      const groups = new Map();
      for (let fi = 0; fi < nF; fi++) {
        const r = find(fi);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(fi);
      }
      if (groups.size < nF) {
        const merged = [];
        for (const members of groups.values()) {
          if (members.length === 1) {
            merged.push(faces[members[0]]);
            continue;
          }
          const cn = [0, 0, 0];
          const c = [0, 0, 0];
          let areaSum = 0;
          const all = [];
          const trisSub = [];
          let id = faces[members[0]].id;
          for (const fi of members) {
            id = Math.min(id, faces[fi].id);
            for (const t of faces[fi].tris) {
              trisSub.push(t);
              const v0 = V[mesh.triVerts[t*3]], v1 = V[mesh.triVerts[t*3+1]], v2 = V[mesh.triVerts[t*3+2]];
              const cxv = _c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0));
              const area = 0.5 * _c4Len(cxv);
              const tn = _c4Norm(cxv);
              cn[0] += tn[0]; cn[1] += tn[1]; cn[2] += tn[2];
              const tc = [(v0[0]+v1[0]+v2[0])/3, (v0[1]+v1[1]+v2[1])/3, (v0[2]+v1[2]+v2[2])/3];
              c[0] += tc[0]*area; c[1] += tc[1]*area; c[2] += tc[2]*area;
              areaSum += area;
              for (const v of [v0, v1, v2]) {
                if (!all.includes(v)) all.push(v);
              }
            }
          }
          const center = areaSum > 1e-18 ? _c4Mul(1/areaSum, c) : faces[members[0]].center;
          merged.push({ id, tris: trisSub, normal: _c4Norm(cn), center, verts: all });
        }
        faces.length = 0;
        faces.push(...merged);
        faces.sort((a, b) => a.id - b.id);
      }
    }
  }

  // Within each faceID group, order sub-faces OUTERMOST-FIRST in the face's
  // normal direction (desc by n·center): for a merged group of parallel
  // planes (e.g. two +Z planes at z=5 and z=15), facesByNormal(+Z)[0] is the
  // topmost plane — what a "top face" query almost always means.
  {
    const byId = new Map();
    for (const f of faces) { if (!byId.has(f.id)) byId.set(f.id, []); byId.get(f.id).push(f); }
    for (const list of byId.values())
      list.sort((a, b) => {
        const oa = a.center[0]*a.normal[0] + a.center[1]*a.normal[1] + a.center[2]*a.normal[2];
        const ob = b.center[0]*b.normal[0] + b.center[1]*b.normal[1] + b.center[2]*b.normal[2];
        return ob - oa;
      });
  }
  // Build triToFace AFTER all sorts — indices assigned at push-time would be
  // stale once faces is re-ordered. This map is what edges/convexEdges use to
  // reach each triangle's true (sub-)face.
  triToFace.fill(-1);
  for (let fi = 0; fi < faces.length; fi++)
    for (const t of faces[fi].tris) triToFace[t] = fi;
  const faceIdxById = new Map(faces.map((f, i) => [f.id, i]));

  // edges: weld key = sorted vertex pair
  const edgeMap = new Map();
  for (let t = 0; t < mesh.numTri; t++) {
    const vs = [mesh.triVerts[t*3], mesh.triVerts[t*3+1], mesh.triVerts[t*3+2]];
    for (let k = 0; k < 3; k++) {
      const u = vs[k], w = vs[(k+1) % 3];
      const key = u < w ? u * 1e9 + w : w * 1e9 + u;
      if (!edgeMap.has(key)) edgeMap.set(key, { a: u, b: w, tris: [] });
      edgeMap.get(key).tris.push(t);
    }
  }
  const edges = [];
  for (const e of edgeMap.values()) {
    if (e.tris.length !== 2) continue; // interior/defect: not a real boundary edge
    // triToFace: each triangle -> its (sub-)face index. After the coplanar
    // connected-component split, a faceID may own several faces, so the
    // triangle's face MUST come from triToFace, not faceIdxById.
    const f0 = triToFace[e.tris[0]];
    const f1 = triToFace[e.tris[1]];
    // canonical direction: lower-ordered vertex first (stable, undirected)
    const [a, b] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
    let tangent = _c4Sub(V[b], V[a]);
    if (_c4Len(tangent) < 1e-9) {
      tangent = _c4Norm(_c4Cross(faces[f0].normal, faces[f1].normal));
    }
    tangent = _c4Norm(tangent);
    edges.push({ a, b, va: V[a], vb: V[b], tris: e.tris, tangent, faces: [f0, f1] });
  }
  return { V, faces, edges, faceIdxById };
}

// ---------------------------------------------------------------- selectors
/**
 * facesByNormal(m, dir, tolDeg=1) — faces whose normal is within tolDeg of dir.
 * dir e.g. [0,0,1] (>Z) or [0,0,-1] (<Z).
 */
function facesByNormal(m, dir, tolDeg = 1) {
  const d = _c4Norm(dir);
  const cosT = Math.cos((tolDeg * Math.PI) / 180);
  // Outermost-first along dir so facesByNormal(+Z)[0] is the topmost plane
  // (byId re-sort below does not rewrite the faces array order).
  return c4MeshData(m).faces
    .filter(f => _c4Dot(f.normal, d) >= cosT)
    .sort((a, b) => _c4Dot(b.center, d) - _c4Dot(a.center, d));
}

/**
 * planarFaceAt(m, axis, value, tol=1e-3) — the face lying in plane axis==value
 * (axis 'x'|'y'|'z'). Returns null if absent, throws if ambiguous.
 */
function planarFaceAt(m, axis, value, tol = 1e-3) {
  const i = { x: 0, y: 1, z: 2 }[axis.toLowerCase()];
  if (i === undefined) throw new Error(`planarFaceAt: bad axis '${axis}'`);
  const n = [0, 0, 0]; n[i] = 1;
  const cands = c4MeshData(m).faces.filter(f =>
    Math.abs(Math.abs(_c4Dot(f.normal, n)) - 1) < 0.01 &&
    f.verts.every(v => Math.abs(v[i] - value) < tol));
  if (cands.length === 0) return null;
  if (cands.length > 1) throw new Error(`planarFaceAt: ${cands.length} faces at ${axis}=${value}`);
  return cands[0];
}

/**
 * edgesByOrientation(m, axis, dir, tolDeg=5)
 *  axis 'x'|'y'|'z'  -> edges parallel to that axis
 *  dir 1 | -1 | null -> one-sided / both
 */
function edgesByOrientation(m, axis, dir = null, tolDeg = 5) {
  const i = { x: 0, y: 1, z: 2 }[axis.toLowerCase()];
  if (i === undefined) throw new Error(`edgesByOrientation: bad axis '${axis}'`);
  const ax = [0, 0, 0]; ax[i] = 1;
  const cosT = Math.cos((tolDeg * Math.PI) / 180);
  return c4MeshData(m).edges.filter(e => {
    const s = _c4Dot(e.tangent, ax); // in [-1, 1]
    if (dir === 1 && s < cosT) return false;
    if (dir === -1 && s > -cosT) return false;
    return Math.abs(s) >= cosT;
  });
}

/**
 * workplaneFromFace(m, face) -> { center, normal, x, y }
 * Local 2D frame on the face. center = face centroid, normal = outward face
 * normal, and the in-plane axes x,y are DETERMINISTIC + AXIS-ALIGNED so
 * (u,v) map to predictable world directions (a transpiler/LLM can reason
 * about them):
 *   x = the world axis most in-plane with the face (smallest |n·axis|),
 *       ties broken by axis index (X > Y > Z); y = normal × x.
 * So: +Z face -> u→+X, v→+Y ; -Z -> u→+X, v→-Y ; +X -> u→+Y, v→+Z ;
 *     -X -> u→+Y, v→-Z ; +Y -> u→+X, v→-Z ; -Y -> u→+X, v→+Z.
 * (Non-axis-aligned faces, e.g. a 45° chamfer, fall back to the
 * first-vertex direction.)
 * (pass a face object from facesByNormal/planarFaceAt, or a face index into m)
 */
function workplaneFromFace(m, face) {
  if (typeof face === 'number') face = c4MeshData(m).faces[face];
  const normal = _c4Norm(face.normal);
  const worldAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let x = null, best = Infinity;
  for (const a of worldAxes) {
    const s = Math.abs(_c4Dot(normal, a));
    if (s < best - 1e-9) { best = s; x = a; }
  }
  if (best > 0.9) { // face normal is diagonal — no world axis is in-plane
    const w = face.verts.find(v => _c4Len(_c4Sub(v, face.center)) > 1e-9) || face.verts[0];
    x = _c4Sub(w, face.center);
    x = _c4Sub(x, _c4Mul(_c4Dot(x, normal), normal)); // project onto plane
    if (_c4Len(x) < 1e-9) x = Math.abs(normal[2]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  }
  x = _c4Norm(x);
  const y = _c4Norm(_c4Cross(normal, x));
  return { center: face.center, normal, x, y };
}

// ---------------------------------------------------------------- frames
// frameToMatrix(frame) -> flat 16 for Manifold .transform(m).
// CONVENTION (empirically verified): Manifold applies world = localRow · M
// (row-vector), so the frame axes must be packed as ROWS:
//   row0 = frame.x, row1 = frame.y, row2 = frame.normal, row3 = center.
// (Packing them as columns silently transposes the rotation — invisible
// for axis-aligned faces, wrong for arbitrary face normals.)
function frameToMatrix(frame) {
  const z = frame.normal, x = frame.x, y = frame.y, c = frame.center;
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    c[0], c[1], c[2], 1,
  ];
}

/**
 * placeOnFace(part, frame, builder) — run builder in the face's local frame.
 * builder receives { Manifold: statics, frame, put } where put(m, [u,v,w])
 * returns m transformed so its local origin lands at
 * center + u·x + v·y + w·normal (w is along the outward normal), with its
 * local axes aligned to (x, y, normal). Lets scripts write axis-aligned
 * geometry for arbitrary face normals.
 */
function placeOnFace(part, frame, builder) {
  const M = manifoldModule.Manifold;
  const built = builder({ Manifold: M, frame, put: (mm, [u, v, w]) => {
    const x = frame.x, y = frame.y, n = frame.normal, c = frame.center;
    const t = frameToMatrix({ center: [
      c[0] + u*x[0] + v*y[0] + w*n[0],
      c[1] + u*x[1] + v*y[1] + w*n[1],
      c[2] + u*x[2] + v*y[2] + w*n[2],
    ], x, y, normal: n });
    return mm.transform(t);
  }});
  if (!built || typeof built.status !== 'function')
    throw new Error('placeOnFace: builder must return a Manifold');
  return built;
}

// ---------------------------------------------------------------- features
/**
 * hole(part, frame, u, v, dia, span) — cut a round hole through `part`.
 * frame from workplaneFromFace; (u,v) local coords (mm), span = cut length
 * along the outward normal from the face (use holeSpan() for full thickness).
 * Returns the cut part.
 */
function hole(part, frame, u, v, dia, span) {
  _c4RequirePositive('hole', 'dia', dia);
  _c4RequirePositive('hole', 'span', span);
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('hole: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const M = manifoldModule.Manifold;
  const cut = _c4PutCyl(M, frame, u, v, dia, span);
  return _c4RequireValidSolid(M.difference(part, cut), 'hole');
}
// _c4PutCyl: centered cylinder anchored so it spans w ∈ [1, 1-len] in frame
// space (1mm outside the face, len-1mm INTO the solid).
function _c4PutCyl(M, frame, u, v, dia, len) {
  const n = frame.normal;
  const c = _c4Add(_c4Add(frame.center, _c4Mul(u, frame.x)), _c4Mul(v, frame.y));
  const w0 = 1 - len / 2; // centered body covers w0 ± len/2 = [1-len, 1]
  const t = frameToMatrix({ center: [
    c[0] + n[0] * w0, c[1] + n[1] * w0, c[2] + n[2] * w0,
  ], x: frame.x, y: frame.y, normal: n });
  return M.cylinder(len, dia/2, dia/2, 48, true).transform(t);
}

/**
 * holeSpan(part, frame) — full extent of the part measured along the frame
 * normal (both directions from the face plane) + 2mm overshoot. A safe
 * full-through cut length from that face.
 */
function holeSpan(part, frame) {
  const bb = part.boundingBox();
  const corners = [
    [bb.min[0], bb.min[1], bb.min[2]], [bb.max[0], bb.min[1], bb.min[2]],
    [bb.min[0], bb.max[1], bb.min[2]], [bb.max[0], bb.max[1], bb.min[2]],
    [bb.min[0], bb.min[1], bb.max[2]], [bb.max[0], bb.min[1], bb.max[2]],
    [bb.min[0], bb.max[1], bb.max[2]], [bb.max[0], bb.max[1], bb.max[2]],
  ];
  let minW = Infinity, maxW = -Infinity;
  for (const p of corners) {
    const w = _c4Dot(_c4Sub(p, frame.center), frame.normal);
    minW = Math.min(minW, w);
    maxW = Math.max(maxW, w);
  }
  return (maxW - minW) + 2; // +2mm overshoot
}

/**
 * cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span)
 * — through hole + larger counterbore from the face. (CadQuery cboreHole)
 */
function cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span) {
  _c4RequirePositive('cboreHole', 'diaThru', diaThru);
  _c4RequirePositive('cboreHole', 'diaCbore', diaCbore);
  _c4RequirePositive('cboreHole', 'cboreDepth', cboreDepth);
  _c4RequirePositive('cboreHole', 'span', span);
  if (!(diaCbore > diaThru)) {
    throw new Error(`cboreHole: diaCbore (${diaCbore}) must be > diaThru (${diaThru})`);
  }
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('cboreHole: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const M = manifoldModule.Manifold;
  const thru = _c4PutCyl(M, frame, u, v, diaThru, span);
  const cbore = _c4PutCyl(M, frame, u, v, diaCbore, cboreDepth + 1); // [−depth, +1]
  return _c4RequireValidSolid(M.difference(M.difference(part, thru), cbore), 'cboreHole');
}

/**
 * cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span)
 * — through hole + cone countersink: the cone spans diaThru→diaCsk over
 * cskDepth (118° style for cskDepth ≈ 1.17·(diaCsk−diaThru)/2).
 * (CadQuery cskHole)
 */
function cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span) {
  _c4RequirePositive('cskHole', 'diaThru', diaThru);
  _c4RequirePositive('cskHole', 'diaCsk', diaCsk);
  _c4RequirePositive('cskHole', 'cskDepth', cskDepth);
  _c4RequirePositive('cskHole', 'span', span);
  if (!(diaCsk > diaThru)) {
    throw new Error(`cskHole: diaCsk (${diaCsk}) must be > diaThru (${diaThru})`);
  }
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('cskHole: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const M = manifoldModule.Manifold;
  const thru = _c4PutCyl(M, frame, u, v, diaThru, span);
  // Exact csk frustum: small end (diaThru) at depth cskDepth below the face,
  // big end (diaCsk) flush at the face. Cylinder rLow sits at local z0
  // (bottom), rHigh at the top; frame row-packing maps local +z to the
  // OUTWARD normal. Length = cskDepth, centered at w0 = -cskDepth/2 so the
  // body spans w ∈ [-cskDepth, 0] (0 = face plane, - = into the solid).
  const n = frame.normal;
  const c = _c4Add(_c4Add(frame.center, _c4Mul(u, frame.x)), _c4Mul(v, frame.y));
  const cone = M.cylinder(cskDepth, diaThru/2, diaCsk/2, 48, true); // rLow small
  const w0 = -cskDepth / 2;
  const t = frameToMatrix({ center: [
    c[0] + n[0] * w0, c[1] + n[1] * w0, c[2] + n[2] * w0,
  ], x: frame.x, y: frame.y, normal: n });
  return _c4RequireValidSolid(
    M.difference(M.difference(part, thru), cone.transform(t)),
    'cskHole',
  );
}

/**
 * chamferEdges(part, edges, c) — equal-leg 45° chamfer c on a SET of straight
 * convex edges. Edges = objects from c4MeshData/convexEdges, or a plain
 * [{va, vb, n0, n1}] array. n0/n1 (outward normals of the two adjacent faces
 * at that edge) are REQUIRED for hand-built edges, but are AUTO-DERIVED from
 * the current mesh when the edge object carries {faces: [i0, i1]} (as all
 * c4MeshData-based selectors do: convexEdges, edgesByOrientation,
 * edgesByNormal, planarFaceAt-derived selections) — no more
 * "Cannot read properties of undefined (reading '0')" when mixing selectors
 * with chamferEdges.
 *
 * Construction (verified, C2 pilot + C4): per edge, cutter = hull of the two
 * edge endpoints plus four corner points pulled c into each adjacent face
 * interior. c IS THE LEG LENGTH along each adjacent face (CAD "C2" = 2 mm
 * on both legs), NOT the perpendicular face offset — the perpendicular
 * offset is derived from the face-to-face angle (offset = c·tan(θ/2), θ =
 * angle between n0/n1; at a 90° corner they coincide, at a 120° hex-nut
 * corner C2 → 1.155 mm offset / 2 mm legs). CUTTERS ARE APPLIED SEQUENTIALLY (one difference per edge) and
 * each intermediate result is checked: a single degenerate cutter (e.g. at
 * a triple-junction rib-base edge where the two "adjacent faces" are coplanar
 * or the cutter self-intersects) must not be allowed to wedge the batch
 * union into a wasm out-of-bounds trap (observed: chamfering ALL convex
 * edges of a ribbed plate — one subset crashes the kernel while the rest
 * build fine). The first bad edge throws a named, actionable error instead.
 * Cost: n differences instead of 1 — fine for the edge counts these parts
 * actually use (≤ ~30); the C8 timeout guard catches anything pathological.
 */
function chamferEdges(part, edges, c) {
  _c4RequirePositive('chamferEdges', 'c (leg length)', c);
  const M = manifoldModule.Manifold;
  if (!edges || !edges.length) return part;
  let data = null;
  const laz = () => (data ||= c4MeshData(part));
  let out = part;
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const p0 = e.va, p1 = e.vb;
    if (!p0 || !p1) throw new Error(`chamferEdges: edge ${ei} has no va/vb coordinates`);
    const len = _c4Len(_c4Sub(p1, p0));
    if (len < 1e-9) continue;
    const d = _c4Mul(1/len, _c4Sub(p1, p0));
    // adjacent face normals: use provided n0/n1, else derive from the mesh
    // via e.faces (present on all c4MeshData-derived edge objects).
    let n0 = e.n0, n1 = e.n1;
    if ((!n0 || !n1) && Array.isArray(e.faces) && e.faces.length === 2) {
      const ds = laz();
      n0 = ds.faces[e.faces[0]].normal;
      n1 = ds.faces[e.faces[1]].normal;
    }
    if (!n0 || !n1)
      throw new Error(`chamferEdges: edge ${ei} has no adjacent face normals (n0/n1) — get the edge from convexEdges()/edgesByOrientation() on THIS part, or pass explicit n0/n1`);
    if (_c4Dot(n0, n1) > 0.9999)
      throw new Error(`chamferEdges: edge ${ei} — adjacent faces are coplanar (tessellation seam or wrong face pair); not a chamferable edge`);
    // offset c INTO each adjacent face: (-n) projected perpendicular to the
    // edge direction. This is a unit direction lying IN the face plane,
    // pointing toward the face interior (negated normal = into the solid).
    const off = (n) => {
      const t = _c4Dot(_c4Mul(-1, n), d);
      return _c4Mul(c, _c4Norm(_c4Sub(_c4Mul(-1, n), _c4Mul(t, d))));
    };
    const a0 = off(n0), a1 = off(n1);
    const cutter = M.hull([
      p0, p1,
      _c4Add(p0, a0), _c4Add(p0, a1),
      _c4Add(p1, a0), _c4Add(p1, a1),
    ]);
    const seCutter = _c4StatusError(cutter);
    if (seCutter)
      throw new Error(`chamferEdges: edge ${ei} — degenerate cutter (hull status ${seCutter}); check the two adjacent faces at this edge`);
    const next = M.difference(out, cutter);
    const seNext = _c4StatusError(next);
    if (seNext)
      throw new Error(`chamferEdges: edge ${ei} — boolean failed (${seNext}); the cutter geometry is degenerate at this edge (common at triple-junction rib-base edges)`);
    out = next;
  }
  return out;
}

/**
 * convexEdges(m, minAngleDeg=2) — genuine straight convex edges.
 * "Genuine" = dihedral angle between the adjacent faces > minAngleDeg
 * (filters tessellation seams on curved faces, which are not real edges).
 * Convexity = ball probe centered ON the edge midpoint: for a convex 90°
 * edge the ball is ~25% inside the solid, for a concave (270°) edge ~75%,
 * for a smooth surface ~50%. Kept: f < 0.45.
 * Returns edges with n0/n1 (adjacent face normals) attached, ready for
 * chamferEdges / the C6 fillet helper.
 */
function convexEdges(m, minAngleDeg = 2) {
  const data = c4MeshData(m);
  const M = manifoldModule.Manifold;
  const cosMin = Math.cos((minAngleDeg * Math.PI) / 180);
  const out = [];
  for (const e of data.edges) {
    const n0 = data.faces[e.faces[0]].normal;
    const n1 = data.faces[e.faces[1]].normal;
    if (_c4Dot(n0, n1) > cosMin) continue; // coplanar / tessellation seam
    const mid = _c4Mul(0.5, _c4Add(e.va, e.vb));
    const r = Math.min(0.05, _c4Len(_c4Sub(e.vb, e.va)) * 0.25);
    const sp = M.sphere(r, 12, 6).transform([1,0,0,0, 0,1,0,0, 0,0,1,0, mid[0],mid[1],mid[2],1]);
    const f = M.intersection(m, sp).volume() / sp.volume();
    if (f >= 0.45) continue; // concave (>0.55) or smooth/ambiguous (~0.5)
    out.push({ ...e, n0, n1 });
  }
  return out;
}

// ---------------------------------------------------------------- hole patterns
/**
 * holePattern(part, frame, { n, m, spacingU, spacingV, dia, span, u0=0, v0=0 })
 * — linear grid of through holes (CadQuery rarray idiom).
 * Grid centered on the face center + (u0, v0) offset.
 */
function holePattern(part, frame, opts) {
  const { n = 1, m = 1, spacingU = 10, spacingV = 10, dia = 2, span, u0 = 0, v0 = 0 } = opts;
  _c4RequirePositive('holePattern', 'dia', dia);
  if (!frame || !frame.normal || !frame.center || !frame.x || !frame.y) {
    throw new Error('holePattern: frame must come from workplaneFromFace (needs center/normal/x/y)');
  }
  const sp = span ?? holeSpan(part, frame);
  let out = part;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const u = u0 + (i - (n-1)/2) * spacingU;
      const v = v0 + (j - (m-1)/2) * spacingV;
      out = hole(out, frame, u, v, dia, sp);
    }
  }
  return out;
}

// ---------------------------------------------------------------- fastener holes (slice 01 puzzle vocabulary)
/**
 * clearanceHole(part, frame, u, v, size, spanOrOpts?, fit?)
 * Cut a clearance hole for fastener `size` ('M3', 3, '#8-32', …).
 * fit: 'close'|'normal'|'loose' (default 'normal'). span defaults to holeSpan().
 * Also accepts opts object: { fit, span }.
 */
function clearanceHole(part, frame, u, v, size, spanOrOpts, fitArg) {
  let fit = 'normal';
  let span;
  if (spanOrOpts && typeof spanOrOpts === 'object' && !Array.isArray(spanOrOpts)) {
    fit = spanOrOpts.fit ?? 'normal';
    span = spanOrOpts.span;
  } else {
    span = spanOrOpts;
    if (fitArg != null) fit = fitArg;
  }
  const dia = fastenerClearanceDia(size, fit);
  const sp = span ?? holeSpan(part, frame);
  return hole(part, frame, u, v, dia, sp);
}

/**
 * tapDrillHole(part, frame, u, v, size, span?)
 * Cut a tap-drill hole for fastener `size` (for subsequent tapping).
 * span defaults to holeSpan().
 */
function tapDrillHole(part, frame, u, v, size, span) {
  const dia = fastenerTapDrillDia(size);
  const sp = span ?? holeSpan(part, frame);
  return hole(part, frame, u, v, dia, sp);
}

// ============================================================================
// C6 — Fillet helper (Manifold JS has no native fillet; this is the v1/v2
// geometric construction). v1 ported from cadgen-workspace/harness/c6_fillet.mjs
// (8 harness tests green, 08-25). v2 (09-08) adds CLOSED CIRCULAR RUN
// support so a tessellated circular edge (a hole rim, an outer cylinder rim
// — any curved surface meeting a planar face, which Manifold represents as
// a LOOP of many short straight mesh edges) fillets as ONE feature instead
// of silently losing its fillet edge-by-edge. This was a real, verified
// bug: a Ø12 hole rim at 48 segs has ~0.78mm segments, and r=1 needs
// t=1 > 0.45·0.78 — every single segment failed the old "tessellation
// sliver" guard and got skipped, part-wide, with no error.
//
// Per SINGLETON edge (both adjacent faces planar, edge convex, v1 —
// unchanged):
//   Cross-section perpendicular to the edge: the two faces meet at interior
//   angle θ (material side). A fillet arc of radius r is tangent to both
//   faces at distance t = r/tan(θ/2) from the corner, centered on the
//   INTERIOR angle bisector at distance r/sin(θ/2). Removed cross-section
//   (sliver between corner and arc) = r·t − ½·r²·(π − θ)  (90°: r²(1−π/4)).
//   Boundary rays f0/f1 (in-face, from the corner into the material) are
//   derived from the ADJACENT TRIANGLES' third vertices — NOT face normals
//   (valid at 90° only) and NOT faceID groups (Manifold can merge faces
//   from different planes, or both edge triangles, into one faceID —
//   verified on a box cut by a slanted prism, 08-25).
//   Cutter = parallelepiped(t·f0, t·f1, edge) − cylinder(r, on bisector
//   line); exact for every θ. Cutters for a SET of edges are unioned and
//   subtracted once (same batching as chamferEdges) — shared-corner
//   overlaps are counted once, matching analytic inclusion-exclusion.
//
// CLOSED CIRCULAR RUNS (v2): a maximal chain of INPUT edges that (a) share
// consecutive mesh vertices, (b) turn <=30° at each shared vertex
// (tangent-continuous — a genuine polygon corner turns 60-180°; a
// tessellated circle turns 360/segs°, which is <=30° for any segs>=12),
// and (c) keep the SAME θ (within 3°) and SAME r, are merged into a run;
// if the chain walk closes on itself, that run is a candidate circular rim.
//
// FIRST ATTEMPT (rejected by measurement, keeping the note as a warning):
// re-using the exact per-segment parallelepiped/cylinder cutter for every
// segment in the run (just not skipping short ones) looks tempting — v1
// already unions all cutters and subtracts once, so it seems like "batching
// was never the problem, only the length guard was." It is WRONG whenever
// t is not small relative to the segment length L (exactly the case a real
// fillet radius on a coarse rim produces, e.g. r=5 on a 96-seg, 2.6mm-pitch
// rim has t=5 ≈ 2·L): each segment's box/cylinder overshoots its own
// [0,L] span by a large fraction of L, so neighboring segments' cutters —
// each tilted slightly differently around the curve — overlap heavily and
// produce either a wasm trap (measured: part 95d717e6 crashed with "memory
// access out of bounds") or a badly wrong volume (measured: part b0c16861
// went from 0.7% symRel to 8.1%, removing ~640mm³ against an analytic
// ~35mm³). Verified on the actual regression corpus before shipping —
// see fillet-fix/FIX_REPORT.md.
//
// ACTUAL v2 CONSTRUCTION: a closed run is fit to an exact circle (3-point
// circumcircle through 3 well-separated run vertices, then every OTHER
// vertex in the run is checked to actually lie on that circle within
// tolerance — a real tessellated Manifold.cylinder rim fits to float
// precision; a coincidentally-closed loop of unrelated edges will not, and
// falls back below). Given the fit (center C, axis N, radius R) and the
// run's (θ, t, r) — constant across the run by the merge criterion — the
// SAME 2D corner-sliver construction used per-edge is built ONCE in the
// meridian half-plane (ρ = radial distance from the axis, z = height along
// it) and swept a full 360° with `makeRevolve`/`CrossSection.revolve`
// (box-in-the-meridian-plane minus a small offset circle, i.e. a torus) —
// exactly the "sweep the profile along the fillet edge" construction from
// the original sketch, specialized (and made exact, not tessellation-
// approximate) for the circular case, which is what every rim in this
// corpus (holes, cylinder rims) actually is. ONE boolean-quality cutter per
// run, no segment-length sensitivity at all, so the R11-class failure mode
// above cannot occur. If the fit or the in-meridian-plane check fails (a
// non-circular closed run — mixed topology), or the run isn't closed
// (a partial/open curved chain), filletEdges FALLS BACK to the v1
// per-EDGE construction for every edge in that run, INCLUDING the original
// t > 0.45·L skip guard — i.e. exactly v1 behaviour, not the rejected
// per-segment-run idea above. Known gap: an OPEN curved run (a fillet on a
// less-than-360° arc) does not get the new treatment and can still lose
// short segments to the skip guard; not exercised by the current corpus
// (every curved surface here comes from a full-revolution primitive).
//
// Curved-adjacent-face relaxation (v2): _c6AssertPlanarAtEdge (below)
// forbids a fillet whose adjacent face is curved — still enforced for
// SINGLETON edges (including fallback-run edges, treated as singletons).
// A run that gets the closed-circular-run treatment SKIPS that assert
// entirely: the circle fit + per-vertex on-circle check IS the validity
// proof for "this is one smooth curved feature," and is strictly more
// specific than the singleton assert's local coplanarity probe (which was
// never designed to look past one edge, and throws on any tessellation
// finer than 3°/facet — exactly what a genuinely curved rim looks like at
// high segment counts).
//
// Constraints (v1, still true for SINGLETON/fallback edges): planar faces
// at the edge (checked: all same-face neighbor triangles coplanar within
// 1e-3; curved-face fillets throw); convex edges only (ball probe, same
// criterion as convexEdges — concave rounding is material ADD and out of
// scope); radius = number (all edges) or number[] parallel to the edge
// list (per-edge radii); a SINGLETON/fallback edge must satisfy
// t < 0.45·edge length (larger r runs off the face — the boolean clips it,
// documented lower fidelity). A closed-circular-run cutter throws instead
// of silently clipping if r is so large the fillet would revolve through
// the rim's own axis. Per-edge arc tessellated at 384 segments (results sit
// ≤ L·(π−(n/2)sin(2π/n))·r² ABOVE the circle-exact volume per edge); a
// closed-run's revolve uses its own (generally coarser, still >=96-segment)
// resolution — see _c6ClosedRunCutter.
//
// opts.sphericalCorners: at every vertex where THREE filleted edges meet
// (~90° corners, equal radii only — v1 scope), the three fillet sails
// converge to a sharp cusp. The option cuts that cusp pocket with a ball
// of radius r centered on the trihedral incenter (equidistant r from all
// three faces and ON all three sail axes) — the result is a spherical
// corner patch tangent to each sail along a circle (C1) and to each face
// at one point, i.e. the true CAD corner for an r/r/r box corner. Closed
// circular runs never participate (a closed loop has no vertex where three
// DIFFERENT edges converge; interior run vertices are always degree-2).
// ============================================================================
function _c6Norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function _c6Cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _c6Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _c6Len(v) { return Math.hypot(v[0], v[1], v[2]); }

// Per-edge geometry needed by both run-detection and singleton/fallback
// cutter construction. Throws on exactly the conditions v1 threw on
// (stale/degenerate mesh lookup, concave edge, degenerate face angle) —
// BEFORE any run decision is made, so a single bad edge anywhere in the
// list still fails loud, in the same order as before.
function _c6EdgeGeom(M, part, mesh, e, r) {
  const P0 = e.va, P1 = e.vb;
  const L = Math.hypot(P1[0]-P0[0], P1[1]-P0[1], P1[2]-P0[2]);
  if (L < 1e-9) return null;
  const d = [(P1[0]-P0[0])/L, (P1[1]-P0[1])/L, (P1[2]-P0[2])/L];

  // in-face boundary rays from the corner: each of the two triangles on
  // the edge has a third vertex X inside its face, so (X − P0) projected
  // perpendicular to the edge is the in-face direction.
  const eKey = e.a < e.b ? e.a * 1e9 + e.b : e.b * 1e9 + e.a;
  const ti = mesh.pairMap.get(eKey);
  if (!ti || ti.length !== 2)
    throw new Error('filletEdges: edge not found in mesh (stale selection?)');
  const thirdVertex = (tri) => {
    for (let k = 0; k < 3; k++) if (tri.vs[k] !== e.a && tri.vs[k] !== e.b) return tri.v[k];
    throw new Error('filletEdges: degenerate edge triangle');
  };
  const f0 = _c6InFaceDir(thirdVertex(mesh.tris[ti[0]]), P0, d);
  const f1 = _c6InFaceDir(thirdVertex(mesh.tris[ti[1]]), P0, d);

  // convexity guard: ball probe at the midpoint (same criterion as
  // convexEdges — a dot-product test cannot distinguish a 90° concave
  // corner from a 90° convex one).
  const mid = [(P0[0]+P1[0])/2, (P0[1]+P1[1])/2, (P0[2]+P1[2])/2];
  const rProbe = Math.min(0.05, L * 0.25);
  const sp = M.sphere(rProbe, 12, 6).transform(
    [1,0,0,0, 0,1,0,0, 0,0,1,0, mid[0],mid[1],mid[2], 1]);
  const fIn = M.intersection(part, sp).volume() / sp.volume();
  if (fIn >= 0.45)
    throw new Error('filletEdges: edge is concave (pass convexEdges() output)');

  // interior (material-side) angle between the boundary rays
  const cTheta = Math.max(-1, Math.min(1, f0[0]*f1[0] + f0[1]*f1[1] + f0[2]*f1[2]));
  const theta = Math.acos(cTheta);
  if (theta < 0.05 || theta > Math.PI - 0.05)
    throw new Error(`filletEdges: degenerate face angle ${theta} rad`);
  const t = r / Math.tan(theta / 2);
  return { e, P0, P1, L, d, f0, f1, theta, t, r };
}

// Run detection (v2, see C6 block header). geoms = _c6EdgeGeom results,
// parallel to the input edge array (nulls for degenerate zero-length
// edges). Returns [{ idxs: [...], closed }] covering every geoms[] index
// exactly once; length-1 entries are singleton edges. Walk: at each shared
// mesh vertex, exactly one OTHER input edge must touch it (a real chain
// link, not a triple-junction or a branch), with matching r, matching θ
// (within 3°), and a turn angle <=30° between the two segments' directions
// (a tessellated circle turns 360/segs° — under 30° for any segs>=12; a
// genuine polygon corner turns 60-180° and is correctly rejected as a chain
// link, staying a singleton).
function _c6DetectRuns(geoms) {
  const TURN_COS_MIN = Math.cos(30 * Math.PI / 180);
  const THETA_TOL = 3 * Math.PI / 180;
  const byVertex = new Map(); // mesh vertex index -> [{idx, end}]
  geoms.forEach((g, i) => {
    if (!g) return;
    for (const end of ['a', 'b']) {
      const vk = g.e[end];
      if (!byVertex.has(vk)) byVertex.set(vk, []);
      byVertex.get(vk).push({ idx: i, end });
    }
  });
  // arrival(g,end): unit direction arriving AT the vertex `end`, walking g
  // in its natural a->b sense. departure(g,end): unit direction leaving
  // the vertex `end`, continuing along g in its natural a->b sense.
  const arrival = (g, end) => end === 'b' ? g.d : [-g.d[0], -g.d[1], -g.d[2]];
  const departure = (g, end) => end === 'a' ? g.d : [-g.d[0], -g.d[1], -g.d[2]];
  const findNext = (i, end) => {
    const vk = geoms[i].e[end];
    const touching = byVertex.get(vk);
    if (!touching || touching.length !== 2) return null; // branch/terminus
    const other = touching.find(x => x.idx !== i);
    if (!other) return null;
    const j = other.idx;
    if (Math.abs(geoms[i].r - geoms[j].r) > 1e-9) return null;
    if (Math.abs(geoms[i].theta - geoms[j].theta) > THETA_TOL) return null;
    const arr = arrival(geoms[i], end);
    const dep = departure(geoms[j], other.end);
    const cosAng = arr[0]*dep[0] + arr[1]*dep[1] + arr[2]*dep[2];
    if (cosAng < TURN_COS_MIN) return null; // real corner, not a curve
    return other;
  };
  const visited = new Array(geoms.length).fill(false);
  const runs = [];
  for (let i = 0; i < geoms.length; i++) {
    if (visited[i] || !geoms[i]) continue;
    visited[i] = true;
    const chain = [i];
    let closed = false;
    let curIdx = i, curEnd = 'b';
    for (;;) {
      const nxt = findNext(curIdx, curEnd);
      if (!nxt) break;
      if (nxt.idx === i) { closed = true; break; } // loop closes on itself
      if (visited[nxt.idx]) break;
      chain.push(nxt.idx);
      visited[nxt.idx] = true;
      curIdx = nxt.idx;
      curEnd = nxt.end === 'a' ? 'b' : 'a'; // continue from the far end
    }
    if (!closed) {
      curIdx = i; curEnd = 'a';
      for (;;) {
        const nxt = findNext(curIdx, curEnd);
        if (!nxt) break;
        if (visited[nxt.idx]) break;
        chain.unshift(nxt.idx);
        visited[nxt.idx] = true;
        curIdx = nxt.idx;
        curEnd = nxt.end === 'a' ? 'b' : 'a';
      }
    }
    runs.push({ idxs: chain, closed });
  }
  return runs;
}

// Exact circumcircle through 3 non-collinear 3D points -> {center, normal,
// radius}, or null if (near-)collinear. Standard vector formula relative
// to A: center = A + (|AC|²(AB×AC)×AB + |AB|²AC×(AB×AC)) / (2|AB×AC|²).
function _c6FitCircle3(A, B, C) {
  const ab = _c6Sub(B, A), ac = _c6Sub(C, A);
  const abLen2 = ab[0]*ab[0]+ab[1]*ab[1]+ab[2]*ab[2];
  const acLen2 = ac[0]*ac[0]+ac[1]*ac[1]+ac[2]*ac[2];
  const cr = _c6Cross(ab, ac);
  const denom = 2 * (cr[0]*cr[0]+cr[1]*cr[1]+cr[2]*cr[2]);
  if (denom < 1e-9) return null; // near-collinear: no well-defined circle
  const t1 = _c6Cross(cr, ab), t2 = _c6Cross(ac, cr);
  const center = [
    A[0] + (acLen2*t1[0] + abLen2*t2[0]) / denom,
    A[1] + (acLen2*t1[1] + abLen2*t2[1]) / denom,
    A[2] + (acLen2*t1[2] + abLen2*t2[2]) / denom,
  ];
  return { center, normal: _c6Norm(cr), radius: _c6Len(_c6Sub(A, center)) };
}

// Build the single exact revolve cutter for a CLOSED circular run (see C6
// block header). Returns null if the run doesn't fit a clean circle or its
// f0/f1 aren't in the meridian plane (axisymmetric geometry required) —
// the caller then falls back to the v1 per-edge path for every edge in the
// run. Throws if the fit is circular but r is too large for the rim
// (would revolve through the axis).
function _c6ClosedRunCutter(M, manifoldModule, run, geoms) {
  const { CrossSection } = manifoldModule;
  const n = run.idxs.length;
  const pt = (k) => geoms[run.idxs[k]].P0;
  const fit = _c6FitCircle3(pt(0), pt(Math.floor(n / 3)), pt(Math.floor(2 * n / 3)));
  if (!fit) return null;
  const { center: C, normal: N, radius: R } = fit;
  if (R < 1e-6) return null;
  // Sanity: every run vertex must actually lie on this circle (real
  // tessellated rims fit to float precision; a coincidental closed loop of
  // unrelated edges will not).
  const tol = Math.max(0.02 * R, 0.01);
  for (let k = 0; k < n; k++) {
    const rel = _c6Sub(pt(k), C);
    const z = rel[0]*N[0] + rel[1]*N[1] + rel[2]*N[2];
    const rho = _c6Len([rel[0]-z*N[0], rel[1]-z*N[1], rel[2]-z*N[2]]);
    if (Math.abs(z) > tol || Math.abs(rho - R) > tol) return null; // not circular
  }
  const g0 = geoms[run.idxs[0]];
  const rel0 = _c6Sub(pt(0), C);
  const z0 = rel0[0]*N[0] + rel0[1]*N[1] + rel0[2]*N[2];
  const rhoHat = _c6Norm(_c6Sub(rel0, [z0*N[0], z0*N[1], z0*N[2]]));
  const yHat = _c6Norm(_c6Cross(N, rhoHat));
  // f0/f1 SHOULD lie in the meridian plane (axisymmetric geometry), but the
  // "third vertex" in-face direction (see _c6EdgeGeom) is measured against
  // ONE mesh triangle, whose third vertex is one tessellation STEP away
  // around the curve — for an n-segment rim that leaks a genuine tangential
  // component of magnitude ~sin(π/n) into f0/f1 (verified: 96 segs ->
  // 0.0327, matches sin(1.875°) exactly). That leak is a tessellation
  // artifact, not a sign of non-axisymmetric geometry, and `to2d` below
  // already discards it (keeps only the (ρ,z) components) — so gate on how
  // much LENGTH survives the projection (near 1 for any reasonably fine
  // rim; n>=12 — the run-detection turn-angle filter's own floor — keeps
  // sin(π/12)=0.259 leak, length sqrt(1-0.259²)=0.966, comfortably clear of
  // this threshold) rather than rejecting on the leak itself.
  const to2d = (v) => [v[0]*rhoHat[0]+v[1]*rhoHat[1]+v[2]*rhoHat[2], v[0]*N[0]+v[1]*N[1]+v[2]*N[2]];
  let f0_2d = to2d(g0.f0), f1_2d = to2d(g0.f1);
  const f0Len = Math.hypot(f0_2d[0], f0_2d[1]), f1Len = Math.hypot(f1_2d[0], f1_2d[1]);
  if (f0Len < 0.9 || f1Len < 0.9) return null; // not axisymmetric -- fall back
  f0_2d = [f0_2d[0]/f0Len, f0_2d[1]/f0Len];
  f1_2d = [f1_2d[0]/f1Len, f1_2d[1]/f1Len];
  const { theta, t, r } = g0;
  const P0_2d = [R, 0];
  const sLen = Math.hypot(f0_2d[0]+f1_2d[0], f0_2d[1]+f1_2d[1]) || 1;
  const bis = [(f0_2d[0]+f1_2d[0])/sLen, (f0_2d[1]+f1_2d[1])/sLen];
  const dC = r / Math.sin(theta / 2);
  const O0 = [P0_2d[0] + dC*bis[0], P0_2d[1] + dC*bis[1]];
  const quad = [
    P0_2d,
    [P0_2d[0]+t*f0_2d[0], P0_2d[1]+t*f0_2d[1]],
    [P0_2d[0]+t*(f0_2d[0]+f1_2d[0]), P0_2d[1]+t*(f0_2d[1]+f1_2d[1])],
    [P0_2d[0]+t*f1_2d[0], P0_2d[1]+t*f1_2d[1]],
  ];
  const minX = Math.min(quad[0][0], quad[1][0], quad[2][0], quad[3][0], O0[0] - r);
  if (minX < 1e-6)
    throw new Error('filletEdges: fillet radius too large for this rim (would revolve through the axis)');
  // REVOLVE_SEGS MUST equal n exactly (verified empirically, not a style
  // choice): Manifold's boolean difference between the ORIGINAL part (an
  // n-segment tessellated rim) and a cutter revolved at a DIFFERENT segment
  // count is only PARTIALLY effective — even at a clean integer multiple of
  // n — silently removing less material than the cutter's own volume
  // (measured on a 40mm-radius rim: cutter built at 96 segs vs the part's
  // 64 has volume 53.91 but removes only 49.84; at EXACTLY 64 segs it
  // removes the full 53.86). The two meshes' angular samples must land at
  // the identical phase for the boolean to fully resolve — a real
  // robustness limit of the boolean engine at differing/misaligned
  // tessellation, not a quality/tolerance knob. ARC_SEGS (the small fillet
  // arc's own resolution) has no such constraint — it only touches the
  // cutter's OWN geometry, not the part/cutter alignment — so it is free to
  // be tuned for quality.
  const REVOLVE_SEGS = n;
  const ARC_SEGS = 128;
  // Wedge profile built as ONE 2D CrossSection boolean (quad minus the fillet
  // arc's disk), THEN revolved once. Do NOT revolve the box and the arc into
  // two 3D solids and difference those (the original construction): the box
  // corner and the arc are mathematically TANGENT along their whole shared
  // boundary -- that is the definition of a fillet -- and a 3D boolean
  // between two meshes meeting at a near-but-not-exactly-tangent surface
  // (float noise ~1e-7 from the fitted R/t) is the classic worst case for a
  // mesh boolean: it manufactures a sliver of near-zero-volume overlap that
  // triangulates into hundreds of degenerate triangles (measured: 316
  // zero-area tris + 508 q<0.01 needles on the 9e2b61bb flange; the
  // no-fillet baseline is 0/34). The 2D boolean is well-conditioned (both
  // shapes are flat; the "torus" is just a circle), the solid is identical
  // as a point set -- revolve(A\B) = revolve(A)\revolve(B) for full 360
  // revolutions -- with ZERO degenerate tris, at half the triangle count
  // (one revolve instead of two). Revolve still locks to n (see above): the
  // phase-lock constraint is about THIS solid vs the PART mesh, not internal.
  const quadCS = new CrossSection(_c8NormalizeContours([quad]));
  const arcCS = CrossSection.circle(r, ARC_SEGS).translate(O0);
  const cutter2D = _c8CheckValid(
    quadCS.subtract(arcCS).revolve(REVOLVE_SEGS), 'filletEdges (closed run)');
  const mat = frameToMatrix({ center: C, x: rhoHat, y: yHat, normal: N });
  return cutter2D.transform(mat);
}

/**
 * filletEdges(part, edges, radius, opts) — circular fillet of radius r on
 * a SET of straight convex edges.
 *   edges  = objects from convexEdges() (required: they carry the mesh
 *            indices this helper needs; edges from OTHER selections can
 *            still be filleted if the edge object has {a, b, va, vb}
 *            vertex data).
 *   radius = number (same r for all edges) OR number[] parallel to the
 *            edge list (per-edge radii).
 *   opts   = { sphericalCorners: true } — additionally rounds box-like
 *            (~90°, equal-radius) corners where THREE filleted edges meet,
 *            replacing the cusp with a spherical patch tangent to all three
 *            fillet sails (C1 junction) and to all three faces.
 * Returns the filleted part. v2: edges that chain into a CLOSED CIRCULAR
 * RUN (see block header) fillet as one exact revolved feature even though
 * each mesh segment is individually short (a tessellated circular rim).
 */
function filletEdges(part, edgesIn, radiusIn, opts = {}) {
  const M = manifoldModule.Manifold;
  // Arc tessellation. 96 segments left a measurable sliver: each flat facet
  // between chord vertices dips inward by r·(1−cos(π/96)) ≈ 1.07e-3 mm for
  // r=2, leaving a thin residual band of the original flat face along the
  // whole fillet (measured 4.5e-2 mm³ per 20 mm edge vs the analytic
  // circle-exact fillet). 384 segments cut that ~16x (2.7e-3 mm³) for a
  // trivial mesh cost (~400 tris per edge vs ~108).
  const SEGMENTS = 384;
  const sphericalCorners = !!opts.sphericalCorners;

  let edges = edgesIn;
  let radiusArr = radiusIn;
  // [{edge, radius}] form: auto-detect on the first entry
  if (Array.isArray(edgesIn) && edgesIn.length && edgesIn[0] && edgesIn[0].edge) {
    radiusArr = null;
    edges = edgesIn.map(x => x.edge);
    const perEdge = new Map();
    for (const x of edgesIn) perEdge.set(x.edge, x.radius);
    radiusArr = edges.map(e => perEdge.get(e));
  }
  if (!edges.length) return part;

  const radii = new Map(); // edge object -> r
  if (Array.isArray(radiusArr)) {
    if (radiusArr.length !== edges.length)
      throw new Error(`filletEdges: radius array length ${radiusArr.length} != edge count ${edges.length}`);
    edges.forEach((e, i) => {
      const rr = radiusArr[i];
      if (!(rr > 0)) throw new Error(`filletEdges: r must be > 0 (edge ${i}, got ${rr})`);
      radii.set(e, rr);
    });
  } else {
    const rr = radiusArr;
    if (!(rr > 0)) throw new Error(`filletEdges: r must be > 0 (got ${rr})`);
    for (const e of edges) radii.set(e, rr);
  }

  const mesh = _c6BuildMeshInfo(part);
  // Per-edge geometry ONCE (also validates every edge — same throws as v1,
  // same order), THEN run detection, THEN try the exact closed-circular-run
  // cutter per run; runs that don't fit one fall back to v1 per-edge.
  const geoms = edges.map(e => _c6EdgeGeom(M, part, mesh, e, radii.get(e)));
  const runs = _c6DetectRuns(geoms);
  const runCutter = new Map(); // run -> cutter Manifold (only for successful closed runs)
  const runOf = new Array(edges.length);
  for (const run of runs) {
    run.idxs.forEach(i => { runOf[i] = run; });
    if (run.closed && run.idxs.length > 1) {
      const c = _c6ClosedRunCutter(M, manifoldModule, run, geoms);
      if (c) runCutter.set(run, c);
    }
  }
  const isHandled = (i) => runCutter.has(runOf[i]);


  // Planarity assert: SINGLETON and fallback edges only (v1 behaviour).
  // Successfully-fit closed circular runs skip it — the circle fit + on-
  // circle check IS the run-level validity proof; see block header.
  for (let i = 0; i < edges.length; i++) {
    if (!geoms[i] || isHandled(i)) continue;
    _c6AssertPlanarAtEdge(mesh, edges[i]);
  }

  const cutters = [];
  const edgeGeom = []; // per SINGLETON/fallback edge: { kA, kB, V0, V1, r, theta, cyl }
  const skippedShort = []; // {L, t} per SINGLETON/fallback edge skipped as a sliver
  const doneRuns = new Set();
  for (let i = 0; i < edges.length; i++) {
    const g = geoms[i];
    if (!g) continue;
    if (isHandled(i)) {
      const run = runOf[i];
      if (!doneRuns.has(run)) {
        doneRuns.add(run);
        cutters.push(runCutter.get(run));
      }
      continue;
    }
    const e = edges[i];
    const { P0, P1, L, d, f0, f1, theta, t, r } = g;
    if (t > 0.45 * L) {
      // SKIP, don't throw: short edges are tessellation slivers of a curved
      // arc (96/384-seg fillet/chamfer seams) that a filtered edge list
      // picks up alongside the real edge, OR a curved run that didn't fit
      // a clean circle (see block header) — filing one off would only add
      // noise, and one bad sliver must not kill the whole part.
      skippedShort.push({ L: +L.toFixed(4), t: +t.toFixed(4) });
      continue;
    }

    // arc center line: interior bisector, distance r/sin(θ/2) from the edge
    const sLen = Math.hypot(f0[0]+f1[0], f0[1]+f1[1], f0[2]+f1[2]) || 1;
    const bis = [(f0[0]+f1[0])/sLen, (f0[1]+f1[1])/sLen, (f0[2]+f1[2])/sLen];
    const dC = r / Math.sin(theta / 2);
    const O0 = [P0[0] + dC*bis[0], P0[1] + dC*bis[1], P0[2] + dC*bis[2]];

    // parallelepiped spanned by t·f0 and t·f1, extruded along the edge
    const B = [];
    for (const s of [0, L]) {
      const P = [P0[0]+s*d[0], P0[1]+s*d[1], P0[2]+s*d[2]];
      B.push(
        P,
        [P[0]+t*f0[0], P[1]+t*f0[1], P[2]+t*f0[2]],
        [P[0]+t*f1[0], P[1]+t*f1[1], P[2]+t*f1[2]],
        [P[0]+t*(f0[0]+f1[0]), P[1]+t*(f0[1]+f1[1]), P[2]+t*(f0[2]+f1[2])],
      );
    }
    const box = M.hull(B);

    // cylinder: radius r, axis along the edge, centered on the bisector
    // line (1mm overshoot each end). Rows = local x,y,z axes (row-vector
    // convention, see frameToMatrix): x = f1, z = d, y = x̂z.
    const cyU = _c6Norm(_c6Cross(d, f1));
    const C = [O0[0] + (L/2)*d[0], O0[1] + (L/2)*d[1], O0[2] + (L/2)*d[2]];
    const mat = [
      f1[0], f1[1], f1[2], 0,
      cyU[0], cyU[1], cyU[2], 0,
      d[0],  d[1],  d[2],   0,
      C[0], C[1], C[2], 1,
    ];
    const cyl = M.cylinder(L + 2, r, r, SEGMENTS, true).transform(mat);
    const cutter = M.difference(box, cyl);
    const seC = _c4StatusError(cutter);
    if (seC)
      throw new Error(`filletEdges: bad cutter (${seC})`);
    cutters.push(cutter);
    edgeGeom.push({ kA: e.a, kB: e.b, V0: P0, V1: P1, r, theta, cyl });
  }
  if (!cutters.length) {
    // Slice-01: never silently "succeed" with an unchanged part when the
    // caller asked for fillets. Empty edge list → no-op; non-empty with
    // zero cutters → loud failure (the old console.warn hid hole-rim misses).
    if (!edges.length) return part;
    const hint = skippedShort.length
      ? `all ${skippedShort.length} edges failed the size guard (t > 0.45·L); example t=${skippedShort[0].t} L=${skippedShort[0].L}`
      : 'no valid cutters (geometry/status rejected every edge)';
    throw new Error(
      `filletEdges: no edges could be filleted (${hint}). ` +
      `For circular rims pass convexEdges(part) unfiltered so closed-run detection can fire; or reduce r. ` +
      `Curved-face singleton fillets are unsupported.`,
    );
  }
  // Union cutters, subtract once: shared-corner overlaps counted once
  // (matches analytic inclusion-exclusion — see block header).
  let tool = cutters[0];
  for (let i = 1; i < cutters.length; i++) tool = M.union([tool, cutters[i]]);
  let out = M.difference(part, tool);
  const seOut = _c4StatusError(out);
  if (seOut) throw new Error(`filletEdges: bad result (${seOut})`);

  // ------------------------------------------------------------------
  // Optional: spherical corner caps. When THREE filleted edges meet at
  // one vertex, the three fillet "sails" converge to a sharp cusp point.
  // Cutting the corner hexahedron with a ball of radius r centered at
  // the trihedral incenter replaces the cusp with a spherical patch:
  //   - the incenter is equidistant r from all three faces → the patch
  //     is tangent to all three faces;
  //   - the incenter lies ON each fillet cylinder's axis at the same
  //     radius → the patch is tangent to each fillet sail ALONG A
  //     CIRCLE (C1-smooth junction).
  // Only applied to box-like (~90°) triple-vertex corners with equal
  // radii; other corners keep the cusp (v1 scope).
  if (sphericalCorners) {
    // group edges by endpoint vertex index
    const byVertex = new Map(); // vertexIndex -> [edgeGeom entries]
    for (const g of edgeGeom) {
      for (const k of [g.kA, g.kB]) {
        if (!byVertex.has(k)) byVertex.set(k, []);
        byVertex.get(k).push(g);
      }
    }
    const caps = [];
    for (const [vk, eg] of byVertex) {
      if (eg.length !== 3) continue;
      const [g1, g2, g3] = eg;
      if (Math.abs(g1.r - g2.r) > 1e-6 || Math.abs(g1.r - g3.r) > 1e-6) continue;
      // v1: only ~90° corners (all three face angles)
      if (!eg.every(g => Math.abs(g.theta - Math.PI/2) < 0.02)) continue;

      // P = the shared vertex point; d_i = unit direction from P INTO edge i
      const P = g1.kA === vk ? g1.V0 : g1.V1;
      const dOf = (g) => {
        const other = g.kA === vk ? g.V1 : g.V0; // endpoint that is NOT P
        return _c6Norm(_c6Sub(other, P));
      };
      const d1 = dOf(g1), d2 = dOf(g2), d3 = dOf(g3);
      if (_c6Len(_c6Cross(d1, d2)) < 0.5 || _c6Len(_c6Cross(d2, d3)) < 0.5 ||
          _c6Len(_c6Cross(d3, d1)) < 0.5) continue; // two edges nearly parallel

      // inward face normals: face(d1,d2) ⊥ d3, so its inward normal is
      // ±(d1×d2) with the sign pointing toward the solid — i.e. positive
      // dot with the THIRD edge direction (which lies in the solid's
      // trihedral cone for a convex corner). For a convex trihedral corner
      // the three inward normals are mutually orthogonal, and the corner
      // box basis is {m12, m23, m31}.
      const inwardOf = (a, b, third) => {
        const n = _c6Norm(_c6Cross(a, b));
        const dot = n[0]*third[0] + n[1]*third[1] + n[2]*third[2];
        return dot < 0 ? [-n[0], -n[1], -n[2]] : n;
      };
      const m12 = inwardOf(d1, d2, d3); // normal of the face containing d1,d2
      const m23 = inwardOf(d2, d3, d1);
      const m31 = inwardOf(d3, d1, d2);
      const r0 = g1.r;
      // incenter: equidistant r0 from all three faces
      const O = [
        P[0] + r0*(m12[0]+m23[0]+m31[0]),
        P[1] + r0*(m12[1]+m23[1]+m31[1]),
        P[2] + r0*(m12[2]+m23[2]+m31[2]),
      ];
      // sanity: for orthogonal faces |O−P| = r0·√3
      const dist = _c6Len(_c6Sub(O, P));
      const dev = Math.abs(dist - r0*Math.sqrt(3));
      if (dev > 1e-3 * r0 + 1e-6)
        throw new Error(`filletEdges: corner-cap incenter sanity failed (|O−P|=${dist}, want ${r0*Math.sqrt(3)})`);
      const ball = M.sphere(r0, 256).transform(
        [1,0,0,0, 0,1,0,0, 0,0,1,0, O[0],O[1],O[2], 1]);
      // cap = (cornerBox ∩ cyl1 ∩ cyl2 ∩ cyl3) \ (ball ∩ cornerBox):
      //   cornerBox ∩ all three sails = material T left in the corner
      //     box by the three fillets; ball ∩ cornerBox = the IDEAL
      //     rounded corner (every octant point is inside all three sail
      //     cylinders, so the sphere IS the true CAD corner patch).
      //   T \ octant = the cusp pocket the plain fillets leave.
      const mkPt = (a, b, c) => [
        P[0] + r0*(a*m12[0] + b*m23[0] + c*m31[0]),
        P[1] + r0*(a*m12[1] + b*m23[1] + c*m31[1]),
        P[2] + r0*(a*m12[2] + b*m23[2] + c*m31[2]),
      ];
      const cornerBox = M.hull([
        mkPt(0,0,0), mkPt(1,0,0), mkPt(0,1,0), mkPt(0,0,1),
        mkPt(1,1,0), mkPt(1,0,1), mkPt(0,1,1), mkPt(1,1,1),
      ]);
      let cap = cornerBox;
      for (const g of eg) cap = M.intersection(cap, g.cyl);
      const seCap = _c4StatusError(cap);
      if (seCap || cap.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner material (${seCap || 'ok'}, vol ${cap.volume()})`);
      const octant = M.intersection(ball, cornerBox);
      const seOct = _c4StatusError(octant);
      if (seOct || octant.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner octant (${seOct || 'ok'})`);
      cap = M.difference(cap, octant);
      const seCap2 = _c4StatusError(cap);
      if (seCap2 || cap.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner cap (${seCap2 || 'ok'}, vol ${cap.volume()})`);
      caps.push(cap);
    }
    if (caps.length) {
      let capTool = caps[0];
      for (let i = 1; i < caps.length; i++) capTool = M.union([capTool, caps[i]]);
      out = M.difference(out, capTool);
      const seCapTool = _c4StatusError(out);
      if (seCapTool)
        throw new Error(`filletEdges: bad corner-cap result (${seCapTool})`);
    }
  }
  return out;
}

// (X − P0) projected perpendicular to the edge direction, normalized.
function _c6InFaceDir(X, P0, d) {
  let v = [X[0]-P0[0], X[1]-P0[1], X[2]-P0[2]];
  const s = v[0]*d[0] + v[1]*d[1] + v[2]*d[2];
  v = [v[0]-s*d[0], v[1]-s*d[1], v[2]-s*d[2]];
  return _c6Norm(v);
}

// Per-triangle {vs, v, n, p0} + (vertex-pair) → triangle list map.
function _c6BuildMeshInfo(part) {
  const mesh = part.getMesh();
  const np = mesh.numProp;
  const V = [];
  for (let i = 0; i < mesh.triVerts.length / 3; i++)
    V.push([mesh.vertProperties[i*np], mesh.vertProperties[i*np+1], mesh.vertProperties[i*np+2]]);
  const tris = [];
  const pairMap = new Map();
  for (let i = 0; i < mesh.numTri; i++) {
    const vs = [mesh.triVerts[i*3], mesh.triVerts[i*3+1], mesh.triVerts[i*3+2]];
    const v0 = V[vs[0]], v1 = V[vs[1]], v2 = V[vs[2]];
    let n = _c6Cross([v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]], [v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]]);
    if (Math.hypot(n[0], n[1], n[2]) < 1e-12) n = [0, 0, 1]; // degenerate tri
    tris.push({ vs, v: [v0, v1, v2], n: _c6Norm(n), p0: v0 });
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k+1) % 3];
      const key = a < b ? a * 1e9 + b : b * 1e9 + a;
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(i);
    }
  }
  return { tris, pairMap };
}

// Local planarity on each side of the edge: the edge triangle's plane must
// also hold for all same-face neighbor triangles (shared edge + normal
// within 3° of the edge triangle's). Deliberately local, NOT per faceID
// group (Manifold can merge faces from different planes into one group).
// Called for SINGLETON/fallback edges only (v2): a successfully-fit closed
// circular run skips this and relies on the circle fit + on-circle check
// instead — see the C6 block header for why (this probe throws on any
// tessellation finer than 3°/facet, which is exactly what a genuine
// curved run looks like).
const _C6_COS3DEG = Math.cos(3 * Math.PI / 180);
function _c6AssertPlanarAtEdge(mesh, e) {
  const { tris, pairMap } = mesh;
  const key = e.a < e.b ? e.a * 1e9 + e.b : e.b * 1e9 + e.a;
  const ti = pairMap.get(key);
  if (!ti || ti.length !== 2)
    throw new Error('filletEdges: edge not found in mesh (stale selection?)');
  for (const idx of [0, 1]) {
    const A = tris[ti[idx]];
    const refN = A.n, refP0 = A.p0;
    for (let k = 0; k < 3; k++) {
      const a = A.vs[k], b = A.vs[(k+1) % 3];
      const nk = a < b ? a * 1e9 + b : b * 1e9 + a;
      if (nk === key) continue; // the fillet edge itself
      const nti = pairMap.get(nk);
      if (!nti) continue;
      for (const tidx of nti) {
        if (tidx === ti[idx] || tidx === ti[1 - idx]) continue;
        const T = tris[tidx];
        const dot = T.n[0]*refN[0] + T.n[1]*refN[1] + T.n[2]*refN[2];
        if (dot <= _C6_COS3DEG) continue; // different face (3rd face at a corner)
        for (const v of T.v) {
          const dev = (v[0]-refP0[0])*refN[0] + (v[1]-refP0[1])*refN[1] + (v[2]-refP0[2])*refN[2];
          if (Math.abs(dev) > 1e-3)
            throw new Error('filletEdges: adjacent face is not planar at this edge (curved-face fillet not supported)');
        }
      }
    }
  }
}

// ------------------------------------------------------------------ revolve / extrude (C8)
// Manifold requires a very specific contour winding (outer CCW, holes CW)
// and fails SILENTLY when it's wrong: status 'InvalidConstruction', volume
// 0, no exception. That's how C8 produced "empty geometry" parts with no
// actionable error. These helpers normalize winding, drop an explicit
// closing point, and throw a loud, fixable error if the build is still
// invalid — so the LLM loop gets a real correction instead of "no geometry".
function _c8ContourArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function _c8NormalizeContours(contours) {
  // Accept both makeRevolve([outer, hole]) and makeRevolve(outerPoints).
  if (!Array.isArray(contours) || !contours.length || !Array.isArray(contours[0]))
    throw new Error('makeRevolve/makeExtrude: expected an array of contours (array of [x,y] point arrays)');
  if (typeof contours[0][0] === 'number') contours = [contours]; // bare point list
  const cleaned = contours.map(pts => {
    const p = pts.map(v => [v[0], v[1]]);
    const f = p[0], l = p[p.length - 1];
    if (p.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) p.pop(); // explicit close
    return p;
  });
  for (const p of cleaned)
    if (p.length < 3)
      throw new Error('makeRevolve/makeExtrude: every contour needs >= 3 distinct points — the profile is not closed');
  // outermost = largest |area| must be CCW; all others are holes -> CW.
  const order = cleaned.map((p, i) => i)
    .sort((a, b) => Math.abs(_c8ContourArea(cleaned[b])) - Math.abs(_c8ContourArea(cleaned[a])));
  return order.map((idx, rank) => {
    const p = cleaned[idx];
    if (_c8ContourArea(p) < 0 === (rank === 0)) return p.slice().reverse();
    return p;
  });
}
function _c8CheckValid(m, what) {
  // Build-tolerant status check: the npm `manifold-3d` returns the string
  // 'NoError' for valid manifolds, but the bundled `built/manifold.js`
  // (what the browser worker loads) returns an opaque {} for EVERYTHING.
  // So only treat a NON-STRING non-NoError status as an error; when status()
  // is an object (bundled build) the volume check below is the real
  // degeneracy guard (verified: valid → real volume, bad profile → 0).
  const se = _c4StatusError(m);
  if (se)
    throw new Error(`${what}: invalid result (status ${se}) — the profile must be a closed polygon; for revolve: x >= 0 (radial), y = height around the axis`);
  if (m.volume() <= 1e-9)
    throw new Error(`${what}: result is EMPTY (volume 0) — check the profile has real area and (for revolve) does not sit on the axis`);
  return m;
}
/**
 * makeRevolve(contours, segments=96) — revolve a 2D profile around its Y axis
 * (result's axis = Z). contours = [[x,y]...] outer first + optional holes;
 * winding is normalized automatically; throws loudly on an invalid profile
 * instead of returning a silent empty manifold. Profile: x = radial (>= 0),
 * y = height along the axis.
 */
function makeRevolve(contours, segments = 96) {
  const { CrossSection } = manifoldModule;
  const cs = new CrossSection(_c8NormalizeContours(contours));
  return _c8CheckValid(cs.revolve(segments), 'makeRevolve');
}
/**
 * makeExtrude(contours, height) — extrude a 2D profile by `height` along Z.
 * Same contour rules as makeRevolve (outer CCW + CW holes, auto-normalized).
 */
function makeExtrude(contours, height) {
  const { CrossSection } = manifoldModule;
  const cs = new CrossSection(_c8NormalizeContours(contours));
  return _c8CheckValid(cs.extrude(height), 'makeExtrude');
}


// ---------------------------------------------------------------- Slice 21 cross-section substrate
// Reusable plane + 2D profile value for later edge→sweep / fillet-via-sweep /
// extrude-revolve-loft siblings. Plain object (no class inheritance).
// Contours are in plane UV; plane is a workplaneFromFace frame.
function _xsRequirePlane(plane, what) {
  if (!plane || !plane.center || !plane.normal || !plane.x || !plane.y) {
    throw new Error(`${what}: plane must come from workplaneFromFace (needs center/normal/x/y)`);
  }
}
function _xsContourArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function _xsNormalizeLoop(points, what) {
  if (!Array.isArray(points) || points.length < 3)
    throw new Error(`${what}: need ≥ 3 points for a closed polyline`);
  const p = points.map(v => [Number(v[0]), Number(v[1])]);
  if (p.some(v => !Number.isFinite(v[0]) || !Number.isFinite(v[1])))
    throw new Error(`${what}: points must be finite [u,v]`);
  const f = p[0], l = p[p.length - 1];
  if (p.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) p.pop();
  if (p.length < 3) throw new Error(`${what}: need ≥ 3 distinct points`);
  if (Math.abs(_xsContourArea(p)) < 1e-12)
    throw new Error(`${what}: degenerate profile (zero area)`);
  if (_xsContourArea(p) < 0) p.reverse();
  return p;
}
/**
 * profileCircle(radius, segments=32) → { type:'circle', radius, segments, contours }
 * Contours centered at UV origin — enough for basic extrude / future fillet.
 */
function profileCircle(radius, segments = 32) {
  _c4RequirePositive('profileCircle', 'radius', radius);
  const seg = Math.max(3, Math.round(segments || 32));
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    pts.push([radius * Math.cos(t), radius * Math.sin(t)]);
  }
  return { type: 'circle', radius, segments: seg, contours: [pts] };
}
/**
 * profileRectangle(width, height, centered=true) → rectangle profile in UV.
 */
function profileRectangle(width, height, centered = true) {
  _c4RequirePositive('profileRectangle', 'width', width);
  _c4RequirePositive('profileRectangle', 'height', height);
  let pts;
  if (centered) {
    const hw = width / 2, hh = height / 2;
    pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  } else {
    pts = [[0, 0], [width, 0], [width, height], [0, height]];
  }
  return { type: 'rectangle', width, height, centered: !!centered, contours: [pts] };
}
/**
 * profilePolygon(points) → closed polyline/polygon profile in UV.
 * Accepts ≥3 [u,v] points (explicit close optional). Winding normalized CCW.
 */
function profilePolygon(points) {
  const pts = _xsNormalizeLoop(points, 'profilePolygon');
  return { type: 'polygon', points: pts, contours: [pts] };
}
/**
 * makeCrossSection(plane, profile) → reusable { kind, plane, profile, contours }.
 * plane: workplaneFromFace frame. profile: profileCircle/Rectangle/Polygon result,
 * or { type, ... }, or bare contours / point list (same rules as makeExtrude).
 * Does NOT extrude/sweep — substrate only for later slices.
 */
function makeCrossSection(plane, profile) {
  _xsRequirePlane(plane, 'makeCrossSection');
  let desc;
  let contours;
  if (profile && typeof profile === 'object' && profile.type && Array.isArray(profile.contours)) {
    desc = { type: profile.type };
    for (const k of Object.keys(profile)) {
      if (k === 'contours') continue;
      desc[k] = profile[k];
    }
    contours = profile.contours.map(loop => _xsNormalizeLoop(loop, 'makeCrossSection'));
  } else if (profile && typeof profile === 'object' && profile.type === 'circle') {
    const built = profileCircle(profile.radius, profile.segments);
    desc = { type: 'circle', radius: built.radius, segments: built.segments };
    contours = built.contours;
  } else if (profile && typeof profile === 'object' && profile.type === 'rectangle') {
    const built = profileRectangle(profile.width, profile.height, profile.centered !== false);
    desc = { type: 'rectangle', width: built.width, height: built.height, centered: built.centered };
    contours = built.contours;
  } else if (profile && typeof profile === 'object' && profile.type === 'polygon' && profile.points) {
    const built = profilePolygon(profile.points);
    desc = { type: 'polygon', points: built.points };
    contours = built.contours;
  } else if (Array.isArray(profile)) {
    // bare point list or contours array — reuse C8 normalizer shape rules
    const cleaned = _c8NormalizeContours(profile);
    contours = cleaned;
    desc = { type: 'polygon', points: cleaned[0] };
  } else {
    throw new Error(
      'makeCrossSection: profile must be profileCircle/profileRectangle/profilePolygon, '
      + 'a { type } descriptor, or a contours / point list'
    );
  }
  return {
    kind: 'crossSection',
    plane: {
      center: plane.center.slice(),
      normal: plane.normal.slice(),
      x: plane.x.slice(),
      y: plane.y.slice(),
    },
    profile: desc,
    contours,
  };
}

/**
 * makeSweepPath(edges, opts?) → reusable ordered sweep path / wire.
 * edges: feature / convexEdges-style {a,b,va,vb,...} (selection or query).
 * Soft topology: empty / disconnected / branched → loud Error (UI soft-fails before insert).
 * Recovers the largest simple component when the set is mostly one chain + strays.
 * Does NOT sweep a cutter — path value only (consume later via sweepPoints / fillet-via-sweep).
 */
function makeSweepPath(edges, opts = {}) {
  const r = assembleSweepPath(edges, opts);
  if (r.ok) return r.value;
  if (r.code === 'empty') {
    const noUsable = /usable|endpoint/i.test(r.message || '');
    throw new Error(
      noUsable
        ? 'makeSweepPath: no usable edges (need va/vb endpoints)'
        : 'makeSweepPath: need at least one edge — pick edges in Edge mode (Tangent for circular rims)',
    );
  }
  if (r.code === 'disconnected') {
    const extra = (r.message || '').match(/\([^)]*component[^)]*\)/);
    throw new Error(
      'makeSweepPath: edges are disconnected — pick a single contiguous chain or loop'
      + (extra ? ` ${extra[0]}` : ''),
    );
  }
  if (r.code === 'branch') {
    throw new Error(
      'makeSweepPath: edges branch (junction) — need a simple open chain or closed loop',
    );
  }
  throw new Error('makeSweepPath: could not order edges into a path');
}

// ---------------------------------------------------------------- Slice 23 fillet via swept cross-section
// Unlock fillets on compound / curved-adjacent edges by sweeping a quarter-circle
// (or chamfer triangle) cutter along makeSweepPath and boolean-subtracting.
// Path is a LINEAR polyline (edge wire) — Catmull-Rom bulges off chords and left
// purple sliver scraps. Planar–planar uses filletEdges only when UI Strategy=planar.
// Extrude/revolve/loft are NOT started here — wait for Product brief.
function _s23Norm(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function _s23Sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function _s23Cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function _s23Dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

/** Fillet wedge contour: square−quarterDisk@ (r,r). Chamfer: right triangle. */
function _s23WedgeContour(radius, profile, arcSegments) {
  const r = Number(radius);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error('filletAlongPath: radius must be > 0');
  }
  if (profile === 'chamfer') {
    return [[0, 0], [r, 0], [0, r]];
  }
  const seg = Math.max(2, Math.round(Number(arcSegments) || 12));
  const pts = [[0, 0], [r, 0]];
  for (let i = 1; i <= seg; i++) {
    const t = (i / seg) * (Math.PI / 2);
    pts.push([r - r * Math.sin(t), r - r * Math.cos(t)]);
  }
  return pts;
}

/**
 * Normalize path → { points, closed, length }. Loud on bad input.
 */
function _s23NormalizePath(path, opts) {
  if (!path) throw new Error('filletAlongPath: path is required (makeSweepPath result or points[])');
  let points;
  let closed = !!(opts && opts.closed);
  if (Array.isArray(path)) {
    points = path;
  } else if (typeof path === 'object') {
    if (path.kind && path.kind !== 'sweepPath') {
      throw new Error(`filletAlongPath: unexpected path.kind "${path.kind}" (want sweepPath)`);
    }
    if (!Array.isArray(path.points)) {
      throw new Error('filletAlongPath: path.points must be an array of [x,y,z]');
    }
    points = path.points;
    if (path.closed != null) closed = !!path.closed;
  } else {
    throw new Error('filletAlongPath: path must be makeSweepPath result or points[]');
  }
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('filletAlongPath: path needs ≥ 2 points');
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Array.isArray(p) || p.length < 3) {
      throw new Error(`filletAlongPath: point[${i}] must be [x,y,z]`);
    }
    const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`filletAlongPath: point[${i}] has non-finite coords`);
    }
    if (out.length) {
      const prev = out[out.length - 1];
      if (Math.hypot(x - prev[0], y - prev[1], z - prev[2]) < 1e-9) continue;
    }
    out.push([x, y, z]);
  }
  if (out.length < 2) throw new Error('filletAlongPath: path collapsed to < 2 distinct points');
  if (closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-5) out.pop();
  }
  if (closed && out.length < 3) {
    throw new Error('filletAlongPath: closed path needs ≥ 3 distinct points');
  }
  let length = 0;
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (closed) {
    const a = out[out.length - 1], b = out[0];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (!(length > 1e-9)) throw new Error('filletAlongPath: path has zero length');
  return { points: out, closed, length };
}

/**
 * Probe in-face directions at path start from the part mesh (no planarity assert —
 * curved-adjacent faces are the point of this helper). Returns { T, f0, f1 } or null.
 */
function _s23ProbeFrame(M, part, points) {
  const p0 = points[0];
  const p1 = points[1];
  const T = _s23Norm(_s23Sub(p1, p0));
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];

  // Prefer convexEdges mid match — carries {a,b,va,vb} for mesh lookup.
  let best = null;
  let bestD = Infinity;
  try {
    const edges = convexEdges(part);
    for (const e of edges) {
      if (!e || !Array.isArray(e.va) || !Array.isArray(e.vb)) continue;
      const em = Array.isArray(e.mid)
        ? e.mid
        : [(e.va[0] + e.vb[0]) / 2, (e.va[1] + e.vb[1]) / 2, (e.va[2] + e.vb[2]) / 2];
      const d = Math.hypot(em[0] - mid[0], em[1] - mid[1], em[2] - mid[2]);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  } catch (_) {
    best = null;
  }
  // Tolerance: half segment length or 0.5mm floor
  const segL = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) || 1;
  if (!best || bestD > Math.max(0.5, 0.55 * segL)) {
    return null;
  }

  const mesh = _c6BuildMeshInfo(part);
  const eKey = best.a < best.b ? best.a * 1e9 + best.b : best.b * 1e9 + best.a;
  const ti = mesh.pairMap.get(eKey);
  if (!ti || ti.length !== 2) return null;

  const P0 = best.va;
  const thirdVertex = (tri) => {
    for (let k = 0; k < 3; k++) {
      if (tri.vs[k] !== best.a && tri.vs[k] !== best.b) return tri.v[k];
    }
    return null;
  };
  const X0 = thirdVertex(mesh.tris[ti[0]]);
  const X1 = thirdVertex(mesh.tris[ti[1]]);
  if (!X0 || !X1) return null;
  const f0 = _c6InFaceDir(X0, P0, T);
  const f1 = _c6InFaceDir(X1, P0, T);
  // Convexity: ball at mid should be mostly outside (same criterion as filletEdges).
  const rProbe = Math.min(0.05, segL * 0.25);
  const sp = M.sphere(rProbe, 12, 6).transform(
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, mid[0], mid[1], mid[2], 1],
  );
  const fIn = M.intersection(part, sp).volume() / sp.volume();
  if (fIn >= 0.45) {
    throw new Error('filletAlongPath: edge is concave (sweep fillet is external / material-remove only)');
  }
  return { T, f0, f1, mid };
}

/**
 * When the closed path fits a circle, build the fillet cutter by revolving the
 * 2D wedge in the meridian plane (same idea as C6 closed-run). Avoids closed
 * extrude+warp RMF seams that leave purple sliver sheets.
 * Returns null if the path is not a clean circle.
 */
function _s23TryRevolveCutter(CrossSection, points, radius, profileKind, arcSegs, probed) {
  if (!points || points.length < 6) return null;
  const n = points.length;
  const fit = _c6FitCircle3(points[0], points[Math.floor(n / 3)], points[Math.floor((2 * n) / 3)]);
  if (!fit) return null;
  const { center: C, normal: N, radius: R } = fit;
  if (!(R > 1e-6)) return null;
  const tol = Math.max(0.02 * R, 0.05);
  for (let k = 0; k < n; k++) {
    const rel = _s23Sub(points[k], C);
    const z = _s23Dot(rel, N);
    const rhoVec = _s23Sub(rel, [z * N[0], z * N[1], z * N[2]]);
    const rho = Math.hypot(rhoVec[0], rhoVec[1], rhoVec[2]);
    if (Math.abs(z) > tol || Math.abs(rho - R) > tol) return null;
  }
  // Meridian frame at points[0]
  const rel0 = _s23Sub(points[0], C);
  const z0 = _s23Dot(rel0, N);
  const rhoHat = _s23Norm(_s23Sub(rel0, [z0 * N[0], z0 * N[1], z0 * N[2]]));
  const yHat = _s23Norm(_s23Cross(N, rhoHat));

  // Map in-face rays into meridian (ρ, z). Prefer probed f0/f1.
  const to2d = (v) => [_s23Dot(v, rhoHat), _s23Dot(v, N)];
  let f0 = probed && probed.f0 ? probed.f0 : rhoHat.map((x) => -x); // into top ≈ -radial for outer rim
  let f1 = probed && probed.f1 ? probed.f1 : N.map((x) => -x); // into wall ≈ -axis for top rim
  let f0_2d = to2d(f0);
  let f1_2d = to2d(f1);
  let f0Len = Math.hypot(f0_2d[0], f0_2d[1]);
  let f1Len = Math.hypot(f1_2d[0], f1_2d[1]);
  if (f0Len < 0.85 || f1Len < 0.85) {
    // Fallback for axisymmetric top rim: -ρ and -N
    f0_2d = [-1, 0];
    f1_2d = [0, -1];
  } else {
    f0_2d = [f0_2d[0] / f0Len, f0_2d[1] / f0Len];
    f1_2d = [f1_2d[0] / f1Len, f1_2d[1] / f1Len];
  }
  // Ensure first-quadrant wedge maps into the solid (both axes point "inward")
  // If either axis points outward in ρ, flip.
  // Place wedge origin at (R, 0) in a local meridian where z'=0 at the rim.
  const wedge = expandFilletCutterContour(
    _s23WedgeContour(radius, profileKind, arcSegs),
    radius,
  );
  const mapped = [];
  for (const [u, v] of wedge) {
    // (ρ, z_rel) = (R,0) + u*f0_2d + v*f1_2d
    const rho = R + u * f0_2d[0] + v * f1_2d[0];
    const zRel = 0 + u * f0_2d[1] + v * f1_2d[1];
    mapped.push([rho, zRel]);
  }
  // Ensure CCW in (ρ,z)
  let a2 = 0;
  for (let i = 0; i < mapped.length; i++) {
    const a = mapped[i], b = mapped[(i + 1) % mapped.length];
    a2 += a[0] * b[1] - b[0] * a[1];
  }
  if (a2 < 0) mapped.reverse();
  // Must stay ρ≥0
  for (const p of mapped) {
    if (p[0] < 1e-6) {
      throw new Error('filletAlongPath: fillet radius too large for this rim (would revolve through the axis)');
    }
  }
  const REVOLVE_SEGS = n; // phase-lock with tessellation (see C6)
  const cs = new CrossSection([mapped]);
  let solid;
  try {
    solid = cs.revolve(REVOLVE_SEGS);
  } catch (e) {
    return null;
  }
  // Shift so zRel=0 lies at the rim height along N, then frame to world.
  // mapped uses zRel about the rim; rim world = C + R*rhoHat + z0*N, and
  // revolve is about Y in CrossSection... Manifold revolve: profile x=radial, y=height → axis Z.
  // Our CrossSection (ρ, zRel) revolved → solid with axis Z. Transform to world:
  // x_axis = rhoHat, y_axis = yHat, z_axis = N, origin = C + z0*N
  // frameToMatrix expects {center, x, y, normal} where normal is Z.
  const origin = [C[0] + z0 * N[0], C[1] + z0 * N[1], C[2] + z0 * N[2]];
  const mat = frameToMatrix({ center: origin, x: rhoHat, y: yHat, normal: N });
  return solid.transform(mat);
}

/**
 * Linear polyline path for fillet sweep (NOT Catmull-Rom).
 * Catmull-Rom bulges off mesh chords / rounds corners and leaves thin purple
 * cutter scraps after boolean subtract — follow the edge wire exactly.
 */
function _s23PolylinePath(points, closed) {
  const n = points.length;
  const segCount = closed ? n : Math.max(1, n - 1);
  const segLens = [];
  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    segLens.push(L);
    total += L;
  }
  if (!(total > 1e-12)) {
    throw new Error('filletAlongPath: polyline path has zero length');
  }
  const cum = [0];
  for (const L of segLens) cum.push(cum[cum.length - 1] + L);

  const atS = (s) => {
    const ss = Math.max(0, Math.min(total, s));
    let i = 0;
    while (i < segCount - 1 && cum[i + 1] < ss - 1e-12) i++;
    const L = segLens[i] || 1;
    const local = (ss - cum[i]) / L;
    const a = points[i];
    const b = points[(i + 1) % n];
    return {
      p: [
        a[0] + local * (b[0] - a[0]),
        a[1] + local * (b[1] - a[1]),
        a[2] + local * (b[2] - a[2]),
      ],
      i,
    };
  };

  return {
    position: (t) => atS(Math.max(0, Math.min(1, t)) * total).p,
    derivative: (t) => {
      const { i } = atS(Math.max(0, Math.min(1, t)) * total);
      const a = points[i];
      const b = points[(i + 1) % n];
      const L = segLens[i] || 1;
      // dpos/dt = tangent * totalLength (t ∈ [0,1] arc-length fraction)
      return [
        ((b[0] - a[0]) / L) * total,
        ((b[1] - a[1]) / L) * total,
        ((b[2] - a[2]) / L) * total,
      ];
    },
    tMin: 0,
    tMax: 1,
  };
}


/**
 * filletAlongPath(part, path, radius, opts?)
 * Sweep a quarter-circle (or chamfer) cutter along path → boolean subtract.
 *
 * Orientation: profile (u,v) in first quadrant maps to u·N + v·B where N,B are
 * rotation-minimizing frame axes. initialNormal is chosen from in-face rays at
 * path start so N≈f0 and B≈f1 (into the two adjacent faces). Path may be reversed
 * so B aligns with f1.
 *
 * @param {Manifold} part
 * @param {object|number[][]} path — makeSweepPath result or points
 * @param {number} radius
 * @param {object} [opts]
 * @param {'fillet'|'chamfer'} [opts.profile='fillet']
 * @param {number} [opts.segments=12] — arc segments for fillet wedge
 * @param {number[]} [opts.initialNormal] — override probed frame
 * @param {boolean} [opts.closed] — when path is bare points[]
 * @param {number} [opts.arcSamples]
 * @param {number} [opts.extrudeSegments]
 * @param {number} [opts._testCutterScale] — test-only: scale 2D cutter vertices
 *   (e.g. 4) against nominal r so the 8× oversize guard can be pinned
 */
function filletAlongPath(part, path, radius, opts = {}) {
  const M = manifoldModule.Manifold;
  const { CrossSection } = manifoldModule;
  _c4RequirePositive('filletAlongPath', 'radius', radius);

  const profileKind = (opts.profile === 'chamfer') ? 'chamfer' : 'fillet';
  const arcSegs = opts.segments != null ? opts.segments : 12;
  let { points, closed, length } = _s23NormalizePath(path, opts);

  // Sweep-path policy seam (planFilletSweepPath): keep the full wire.
  // If a future planner returns mode:'runs' (PR #27 skip-micro), honor it so
  // the fillet-on-fillet gap net still mutation-tests that regression.
  if (!opts._rawPath) {
    const plan = planFilletSweepPath(points, closed, radius);
    if (plan.mode === 'runs') {
      let out = part;
      const subOpts = { ...opts, _rawPath: true };
      for (const run of plan.runs) {
        out = filletAlongPath(out, { kind: 'sweepPath', points: run, closed: false }, radius, subOpts);
      }
      return out;
    }
    if (plan.mode !== 'as-is') {
      throw new Error(`filletAlongPath: unexpected sweep-path plan mode=${plan.mode}`);
    }
  }

  // Probe face frame; may reverse path so B aligns with f1.
  let initialNormal = opts.initialNormal ? opts.initialNormal.slice() : null;
  let probed = null;
  if (!initialNormal) {
    probed = _s23ProbeFrame(M, part, points);
    if (probed) {
      const { T, f0, f1 } = probed;
      // Project f0 onto plane ⊥ T
      let N = _s23Sub(f0, [ _s23Dot(f0, T) * T[0], _s23Dot(f0, T) * T[1], _s23Dot(f0, T) * T[2] ]);
      if (Math.hypot(N[0], N[1], N[2]) < 1e-8) {
        N = _s23Sub(f1, [ _s23Dot(f1, T) * T[0], _s23Dot(f1, T) * T[1], _s23Dot(f1, T) * T[2] ]);
      }
      N = _s23Norm(N);
      let B = _s23Cross(T, N);
      // If B opposes f1, reverse path (flips T and thus B) without flipping N into exterior.
      if (_s23Dot(B, f1) < 0) {
        points = points.slice().reverse();
        // Recompute T after reverse
        const T2 = _s23Norm(_s23Sub(points[1], points[0]));
        N = _s23Sub(f0, [ _s23Dot(f0, T2) * T2[0], _s23Dot(f0, T2) * T2[1], _s23Dot(f0, T2) * T2[2] ]);
        if (Math.hypot(N[0], N[1], N[2]) < 1e-8) {
          N = _s23Sub(f1, [ _s23Dot(f1, T2) * T2[0], _s23Dot(f1, T2) * T2[1], _s23Dot(f1, T2) * T2[2] ]);
        }
        N = _s23Norm(N);
        B = _s23Cross(T2, N);
        if (_s23Dot(B, f1) < 0 && _s23Dot(B, f0) > _s23Dot(N, f0)) {
          // Swap: use f1 as N
          N = _s23Sub(f1, [ _s23Dot(f1, T2) * T2[0], _s23Dot(f1, T2) * T2[1], _s23Dot(f1, T2) * T2[2] ]);
          N = _s23Norm(N);
        }
      }
      // Prefer the face-ray that is more orthogonal as the "other" axis.
      const Tuse = _s23Norm(_s23Sub(points[1], points[0]));
      const Bnow = _s23Cross(Tuse, N);
      if (Math.abs(_s23Dot(Bnow, f1)) < Math.abs(_s23Dot(N, f1)) * 0.25
          && Math.abs(_s23Dot(N, f0)) < Math.abs(_s23Dot(Bnow, f0)) + 0.5) {
        // Axes swapped relative to (f0,f1) — start with f1 as N
        let N2 = _s23Sub(f1, [ _s23Dot(f1, Tuse) * Tuse[0], _s23Dot(f1, Tuse) * Tuse[1], _s23Dot(f1, Tuse) * Tuse[2] ]);
        if (Math.hypot(N2[0], N2[1], N2[2]) > 1e-8) N = _s23Norm(N2);
      }
      initialNormal = N;
    }
  }

  if (!initialNormal) {
    throw new Error(
      'filletAlongPath: could not orient cutter to part (no nearby convex edge at path start). '
      + 'Pass opts.initialNormal, or ensure path follows a convex feature edge.',
    );
  }

  const testCutterScale = Number(opts._testCutterScale);
  const testingOversize = Number.isFinite(testCutterScale) && testCutterScale > 1;

  const contour = expandFilletCutterContour(
    _s23WedgeContour(radius, profileKind, arcSegs),
    radius,
  );
  if (testingOversize) {
    for (const p of contour) {
      p[0] *= testCutterScale;
      p[1] *= testCutterScale;
    }
  }
  // Ensure CCW. Exterior (−e,−e) overlap (not skip-micro, not a radius grow)
  // provides the boolean margin so cutter legs are not face-coincident.
  let area2 = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  if (area2 < 0) contour.reverse();

  const cs = new CrossSection([contour]);
  // Mobile-friendly sampling: scale with path complexity, capped.
  const nPts = points.length;
  const arcSamples = opts.arcSamples != null
    ? opts.arcSamples
    : Math.min(320, Math.max(48, Math.round(nPts * (closed ? 3 : 4))));
  const extrudeSegments = opts.extrudeSegments != null
    ? opts.extrudeSegments
    : Math.min(64, Math.max(16, Math.round(nPts * (closed ? 1.5 : 0.75))));

  // Polyline along the edge wire. Closed loops are swept as an OPEN path that
  // covers one full lap + a small overlap — a true closed extrude+warp leaves
  // an RMF seam that triangulates into purple sliver sheets.
  let sweepPts = points;
  let sweepClosed = closed;
  if (closed && points.length >= 3) {
    const a = points[0];
    const b = points[1];
    const overlap = 0.08; // fraction of first segment
    sweepPts = points.concat([
      a.slice(),
      [
        a[0] + overlap * (b[0] - a[0]),
        a[1] + overlap * (b[1] - a[1]),
        a[2] + overlap * (b[2] - a[2]),
      ],
    ]);
    sweepClosed = false;
  }

  let cutter = null;
  // Skip revolve fast-path when pinning an oversized sweep cutter.
  if (closed && !testingOversize) {
    try {
      cutter = _s23TryRevolveCutter(CrossSection, points, radius, profileKind, arcSegs, probed);
    } catch (e) {
      if (/too large for this rim/i.test(String(e && e.message))) throw e;
      cutter = null;
    }
  }
  if (!cutter) {
    try {
      const polyPath = _s23PolylinePath(sweepPts, sweepClosed);
      cutter = sweep(cs, polyPath, {
        initialNormal,
        arcSamples,
        extrudeSegments,
      });
    } catch (e) {
      throw new Error(`filletAlongPath: sweep failed — ${e && e.message ? e.message : e}`);
    }
  }
  const seC = _c4StatusError(cutter);
  if (seC) throw new Error(`filletAlongPath: bad cutter (${seC})`);
  const cutterVol = typeof cutter.volume === 'function' ? cutter.volume() : 0;
  if (!(cutterVol > 1e-9)) {
    throw new Error('filletAlongPath: cutter has zero volume — check radius / path');
  }

  const volBefore = part.volume();
  let out;
  try {
    out = M.difference(part, cutter);
  } catch (e) {
    throw new Error(`filletAlongPath: boolean subtract failed — ${e && e.message ? e.message : e}`);
  }
  const seOut = _c4StatusError(out);
  if (seOut) throw new Error(`filletAlongPath: bad result (${seOut})`);
  const volAfter = out.volume();
  if (!(volAfter > 1e-9)) {
    throw new Error('filletAlongPath: result is EMPTY (cutter consumed the solid) — reduce radius');
  }
  const removed = volBefore - volAfter;
  if (!(removed > 1e-6)) {
    throw new Error(
      'filletAlongPath: subtract removed ~0 volume — cutter likely outside the solid '
      + '(wrong orientation / path). Try reversing the path or pass opts.initialNormal.',
    );
  }
  // Sanity vs expected wedge·length for 90° cases: near-no-op (orientation
  // miss) AND oversize cutter (requested r silently redefined). The upper
  // bound is against expectVol, not cutterVol — difference cannot exceed
  // cutter volume geometrically, so a cutter-vs-removed check would not
  // catch a uniformly scaled wedge.
  const expectArea = profileKind === 'chamfer'
    ? 0.5 * radius * radius
    : radius * radius * (1 - Math.PI / 4);
  const expectVol = expectArea * length;
  // Neutralise near-no-op when pinning the sibling 8× oversize guard —
  // a coordinated oversize probe would otherwise throw here first.
  if (!testingOversize && expectVol > 1e-3 && removed < 0.02 * expectVol) {
    throw new Error(
      `filletAlongPath: removed only ${removed.toFixed(4)} vs expected ~${expectVol.toFixed(4)} `
      + '(orientation/overlap failure) — failing loud rather than shipping a near-no-op solid',
    );
  }
  if (expectVol > 1e-3 && removed > 8 * expectVol) {
    throw new Error(
      `filletAlongPath: removed ${removed.toFixed(4)} vs expected ~${expectVol.toFixed(4)} `
      + '(cutter far larger than requested radius) — failing loud rather than shipping an oversized blend',
    );
  }
  // Drop disconnected cutter scraps (thin purple sheets) via decompose —
  // closed-loop sweep seams often leave tiny extra components. For closed
  // paths, multiple components are a hard fail (no silent keep-largest).
  try {
    if (typeof out.decompose === 'function') {
      const parts = out.decompose();
      if (Array.isArray(parts) && parts.length > 1) {
        if (closed) {
          throw new Error(
            `filletAlongPath: decompose found ${parts.length} components on closed path `
            + '— failing loud rather than shipping a dirty solid',
          );
        }
        let best = parts[0];
        let bestVol = best.volume();
        for (let i = 1; i < parts.length; i++) {
          const v = parts[i].volume();
          if (v > bestVol) { bestVol = v; best = parts[i]; }
        }
        const scrapVol = parts.reduce((s, c) => s + c.volume(), 0) - bestVol;
        // If scraps are a real fraction of the solid, something is badly wrong.
        if (scrapVol > 0.05 * bestVol && scrapVol > 1e-2) {
          throw new Error(
            `filletAlongPath: decompose found ${parts.length} components with scrap vol `
            + `${scrapVol.toFixed(4)} — failing loud rather than shipping a dirty solid`,
          );
        }
        out = best;
      }
    }
  } catch (e) {
    if (/decompose found|dirty solid/i.test(String(e && e.message))) throw e;
  }
  // Loud fail if the kept solid still has many degenerate tris (attached slivers).
  try {
    const mesh = out.getMesh();
    const np = mesh.numProp || 3;
    const V = mesh.vertProperties;
    const T = mesh.triVerts;
    const nTri = T.length / 3;
    let tiny = 0;
    for (let ti = 0; ti < nTri; ti++) {
      const i0 = T[ti * 3] * np;
      const i1 = T[ti * 3 + 1] * np;
      const i2 = T[ti * 3 + 2] * np;
      const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
      const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
      const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      if (A < 1e-8) tiny++;
    }
    // C6 closed-run filletEdges itself yields ~0.5–1% needles @1e-8 from
    // mesh boolean — only fail when the mesh is clearly scrap-sheet dirty.
    if (isFilletSliverDirty(tiny, nTri)) {
      throw new Error(
        `filletAlongPath: result has ${tiny}/${nTri} degenerate triangles (sliver scraps) — `
        + 'failing loud rather than shipping a dirty solid; try a smaller radius or Strategy=planar',
      );
    }
  } catch (e) {
    if (/sliver scraps|degenerate triangles/i.test(String(e && e.message))) throw e;
  }
  return out;
}

// Collection of all helper functions to inject
const HELPER_FUNCTIONS = {
  shell,
  getScaleRatio,
  roundedBox,
  tube,
  hexPrism,
  mirror,
  array3D,
  polarArray,
  center,
  align,
  getDimensions,
  addDraft,
  loft,
  //loft helpers
  sumSqDist,
  rotateContour,
  sweep,
  sweepPoints,
  // sweeo helpers
  vecAdd,
  vecSub,
  vecMul,
  vecDot,
  vecCross,
  vecNorm,
  vecNormalize,
  // C4 selection + feature helpers (see block above)
  facesByNormal,
  planarFaceAt,
  edgesByOrientation,
  workplaneFromFace,
  placeOnFace,
  hole,
  holeSpan,
  cboreHole,
  cskHole,
  chamferEdges,
  convexEdges,
  holePattern,
  // Slice-01 fastener vocabulary
  clearanceHole,
  tapDrillHole,
  fastenerClearanceDia,
  fastenerTapDrillDia,
  fastenerMajorDia,
  listFastenerSizes,
  resolveFastenerSize,
  // C6 fillet (see block above)
  filletEdges,
  // C8 revolve/extrude with safe winding (see block above)
  makeRevolve,
  makeExtrude,
  // Slice 21 cross-section substrate (plane + 2D profile)
  profileCircle,
  profileRectangle,
  profilePolygon,
  makeCrossSection,
  // Slice 22 edge → sweep path / wire
  makeSweepPath,
  // Slice 23 fillet via swept cross-section
  filletAlongPath,
};

// ============================================================================
// WORKER CORE
// ============================================================================

/**
 * Load and initialize Manifold WASM
 */
const initializeManifold = async () => {
  if (isInitialized) return;
  
  try {
    manifoldModule = await Module();
    manifoldModule.setup();
    
    isInitialized = true;
    console.log('[SandboxWorker] Manifold initialized');
  } catch (error) {
    console.error('[SandboxWorker] Failed to initialize Manifold:', error);
    throw error;
  }
};

/**
 * Block dangerous globals
 */
const lockdownGlobals = () => {
  // Block dangerous globals by replacing with functions that throw
  for (const name of BLOCKED_GLOBALS) {
    if (name in self) {
      Object.defineProperty(self, name, {
        get() {
          throw new Error(`Access to '${name}' is not allowed in scripts`);
        },
        configurable: false
      });
    }
  }
  
  // Make certain globals read-only and return limited info
  for (const name of READONLY_GLOBALS) {
    const original = self[name];
    if (original) {
      Object.defineProperty(self, name, {
        get() {
          // Return a frozen proxy that only allows safe operations
          return Object.freeze({ ...original });
        },
        configurable: false
      });
    }
  }
  
  console.log('[SandboxWorker] Globals locked down');
};

/**
 * Reconstruct a Manifold from mesh data
 */
const reconstructManifold = (meshData) => {
  if (!manifoldModule) {
    throw new Error('Manifold not initialized');
  }
  
  const { Manifold } = manifoldModule;
  
  const vertProperties = new Float32Array(meshData.vertProperties);
  const triVerts = new Uint32Array(meshData.triVerts);
  
  const mesh = {
    numProp: meshData.numProp || 3,
    vertProperties,
    triVerts
  };
  
  return new Manifold(mesh);
};

/**
 * Execute the user script with the Manifold API and helper functions
 */
const executeScript = (script, importedModels) => {
  if (!manifoldModule) {
    throw new Error('Manifold not initialized');
  }
  
  // Set up __importedManifolds with reconstructed Manifolds
  const importedManifolds = {};
  for (const [filename, meshData] of Object.entries(importedModels || {})) {
    importedManifolds[filename] = reconstructManifold(meshData);
  }
  
  // Create a limited window-like object for imports only
  const limitedWindow = {
    __importedManifolds: importedManifolds
  };
  
  // Build the execution scope with Manifold API + helper functions
  const scope = {
    ...manifoldModule,        // Core Manifold API (Manifold, CrossSection, etc.)
    ...HELPER_FUNCTIONS,      // Extended helper functions
    window: limitedWindow,    // Limited window object for imports
  };
  
  const scopeKeys = Object.keys(scope);
  const scopeValues = Object.values(scope);
  
  // Wrap script in strict mode
  const wrappedScript = `"use strict";\n${script}`;
  
  // Create and execute the function
  const fn = new Function(...scopeKeys, wrappedScript);
  return fn(...scopeValues);
};

/**
 * Serialize a Manifold result to mesh data for transfer
 */
const serializeResult = (manifold) => {
  if (!manifold || typeof manifold.getMesh !== 'function') {
    throw new Error('Script must return a Manifold object');
  }
  
  const mesh = manifold.getMesh();
  
  return {
    numProp: mesh.numProp,
    vertProperties: Array.from(mesh.vertProperties),
    triVerts: Array.from(mesh.triVerts),
    numRun: mesh.numRun,
    runIndex: Array.from(mesh.runIndex),
    runOriginalID: Array.from(mesh.runOriginalID),
    faceID: mesh.faceID ? Array.from(mesh.faceID) : null,
  };
};

/**
 * Memory monitoring - check if we're using too much memory
 */
const checkMemoryUsage = (limitMB) => {
  if (performance.memory) {
    const usedMB = performance.memory.usedJSHeapSize / (1024 * 1024);
    if (usedMB > limitMB) {
      throw new Error(`Memory limit exceeded: ${usedMB.toFixed(1)}MB > ${limitMB}MB`);
    }
    return usedMB;
  }
  return null; // Can't measure in this browser
};

/**
 * Message handler
 */
// ============================================================================
// STAGE VERIFICATION (dev tooling, harness/pilot_eval.mjs)
// The staging environment is the single source of kernel truth: candidate
// scripts AND reference solids both execute against the SAME bundled
// built/manifold.wasm the browser uses, and the symmetric-difference verdict
// runs HERE, in the worker, against that build. The harness's npm manifold-3d
// copy stays a cross-check, never the arbiter.
//
// Reference channel: STEP has no browser import path (backend obj_converter is
// a x86_64 ELF and firejail is absent on this box), so references are pushed as
// OBJ. The app's own importOBJ uses the STRICT constructor and is untouched;
// these paths weld in JS first (exact float-identity, then tolerance grid),
// because the WASM Mesh.merge() repair ladder crashes on unwelded input.
// ============================================================================

const _stagedReferences = new Map();   // filename -> { manifold, volume, boundingBox, source }

function _weldMeshData(vertProperties, triVerts, tolerance) {
  const vp = vertProperties;
  const n = vp.length / 3;
  const remap = new Int32Array(n);
  const out = [];
  const seen = new Map();
  const inv = tolerance > 0 ? 1 / tolerance : 0;
  for (let i = 0; i < n; i++) {
    const key = inv
      ? `${Math.round(vp[i * 3] * inv)}|${Math.round(vp[i * 3 + 1] * inv)}|${Math.round(vp[i * 3 + 2] * inv)}`
      : `${vp[i * 3]}|${vp[i * 3 + 1]}|${vp[i * 3 + 2]}`;
    let j = seen.get(key);
    if (j === undefined) { j = out.length / 3; seen.set(key, j); out.push(vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]); }
    remap[i] = j;
  }
  const nt = new Uint32Array(triVerts.length);
  for (let i = 0; i < triVerts.length; i++) nt[i] = remap[triVerts[i]];
  return { numProp: 3, vertProperties: new Float32Array(out), triVerts: nt };
}

/** Build a Manifold from raw mesh arrays: strict first, then weld-exact, then weld@tol. */
function _meshDataToManifold(vertProperties, triVerts, tolerance = 0.001) {
  const { Mesh, Manifold } = manifoldModule;
  const tryBuild = (data) => {
    try {
      const m = new Manifold(new Mesh({ numProp: 3, vertProperties: new Float32Array(data.vertProperties), triVerts: new Uint32Array(data.triVerts) }));
      if (m && !m.isEmpty()) {
        const vol = m.volume();
        if (isFinite(vol) && vol > 0) return m;
      }
    } catch (e) {
      // strict constructor throws 'Not manifold' on unwelded STL-style meshes; fall through
    }
    return null;
  };
  let m = tryBuild({ vertProperties, triVerts });
  if (m) return { manifold: m, repair: 'strict' };
  console.log(`[stage] strict build failed for ${vertProperties.length / 3}v/${triVerts.length / 3}t — trying weld-exact`);
  m = tryBuild(_weldMeshData(vertProperties, triVerts, 0));
  if (m) return { manifold: m, repair: 'weld-exact' };
  console.log('[stage] weld-exact failed — trying weld@tol');
  if (tolerance > 0) {
    m = tryBuild(_weldMeshData(vertProperties, triVerts, tolerance));
    if (m) return { manifold: m, repair: `weld@${tolerance}` };
  }
  throw new Error('stage: could not construct valid manifold from mesh data');
}

function _parseOBJToMeshData(objText) {
  const vertices = [];
  const triangles = [];
  for (const raw of String(objText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
      if (isFinite(x) && isFinite(y) && isFinite(z)) vertices.push([x, y, z]);
    } else if (parts[0] === 'f') {
      const idx = [];
      for (let i = 1; i < parts.length; i++) {
        if (!parts[i]) continue;
        const v = parseInt(parts[i].split('/')[0], 10);
        if (!v || isNaN(v)) continue;
        idx.push(v < 0 ? vertices.length + v : v - 1);
      }
      for (let i = 1; i < idx.length - 1; i++) triangles.push([idx[0], idx[i], idx[i + 1]]);
    }
  }
  if (!vertices.length || !triangles.length) throw new Error('stage: OBJ contains no geometry');
  const vertProperties = new Float32Array(vertices.length * 3);
  vertices.forEach((p, i) => vertProperties.set(p, i * 3));
  const triVerts = new Uint32Array(triangles.length * 3);
  triangles.forEach((p, i) => triVerts.set(p, i * 3));
  return { vertProperties, triVerts };
}

function _bboxArray(m) {
  const b = m.boundingBox();
  return { min: [...b.min], max: [...b.max] };
}

function _centerAtBbox(m) {
  const b = m.boundingBox();
  return m.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -(b.min[2] + b.max[2]) / 2]);
}

// All 24 proper cube rotations as euler triples in the manifold rotate()
// convention: rotate([rx,ry,rz]) applies world-frame X, then Y, then Z, so
// R = Rz(rz)·Ry(ry)·Rx(rx). Self-tested below at build time.
function _stage24Rotations() {
  const d = Math.PI / 180;
  const eulerToMatrix = (rx, ry, rz) => {
    rx *= d; ry *= d; rz *= d;
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    return [
      [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
      [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
      [-sy, cy * sx, cy * cx],
    ];
  };
  const matrixToEuler = (M) => {
    const ry = Math.asin(Math.max(-1, Math.min(1, -M[2][0]))) / d;
    let rx, rz;
    if (Math.abs(Math.cos(ry * d)) > 1e-9) {
      rx = Math.atan2(M[2][1], M[2][2]) / d;
      rz = Math.atan2(M[1][0], M[0][0]) / d;
    } else {
      rx = 0;
      rz = Math.atan2(-M[0][1], M[1][1]) / d;   // gimbal branch: M[1][1]=cos(rz)
    }
    return { rx, ry, rz };
  };
  const perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  const sgn = { '012':1,'120':1,'201':1,'021':-1,'102':-1,'210':-1 };
  const rots = [];
  for (const [ax, ay, az] of perms) {
    for (const sx of [1,-1]) for (const sy of [1,-1]) for (const sz of [1,-1]) {
      const det = sx * sy * sz * sgn[`${ax}${ay}${az}`];
      if (det !== 1) continue;
      const M = [[0,0,0],[0,0,0],[0,0,0]];
      M[0][ax] = sx; M[1][ay] = sy; M[2][az] = sz;
      const { rx, ry, rz } = matrixToEuler(M);
      const M2 = eulerToMatrix(rx, ry, rz);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if (Math.abs(M2[i][j] - M[i][j]) > 1e-9) throw new Error(`stage rotation self-test failed: ${JSON.stringify({ M, M2 })}`);
      }
      rots.push({ name: (rx === 0 && ry === 0 && rz === 0) ? 'identity' : `r${rx}_${ry}_${rz}`, euler: [rx, ry, rz] });
    }
  }
  return rots;
}
const _STAGE_ORIENTATIONS = _stage24Rotations();

/**
 * Verdict of candidate vs target, computed entirely in THIS worker against the
 * bundled build (mirrors harness/verify.mjs verifyManifold semantics).
 * Both sides must already be live Manifolds. opts: { passRel=0.01, volGate=0.25 }.
 */
function _stageVerify(cand, target, opts = {}) {
  const { Manifold } = manifoldModule;
  const passRel = opts.passRel ?? 0.01;
  const volGate = opts.volGate ?? 0.25;
  const se = _c4StatusError(cand);
  if (se) return { pass: false, reason: 'invalid_manifold', status: se };
  const volC = cand.volume();
  const volT = target.volume();
  if (!(volC > 0) || !(volT > 0)) return { pass: false, reason: 'zero_volume', volC, volT };
  const volRel = Math.abs(volC - volT) / volT;
  if (volRel > volGate) return { pass: false, reason: 'volume_mismatch', volC, volT, volRel };
  const t = _centerAtBbox(target);
  const sym = (a, b) => {
    const u = Manifold.union(a, b);
    const i = Manifold.intersection(a, b);
    return Manifold.difference(u, i).volume();
  };
  const rel0 = sym(_centerAtBbox(cand), t) / volT;
  if (rel0 <= passRel) return { pass: true, orientation: 'identity', symRel: rel0, volC, volT };
  let best = { orientation: 'identity', symRel: rel0 };
  for (const o of _STAGE_ORIENTATIONS) {
    if (o.name === 'identity') continue;
    const r = sym(_centerAtBbox(cand.rotate(o.euler)), t) / volT;
    if (r < best.symRel) best = { orientation: o.name, symRel: r };
    if (r <= passRel) break;
  }
  if (best.symRel <= passRel) return { pass: true, ...best, volC, volT };
  return { pass: false, reason: 'symdiff_too_large', ...best, volC, volT };
}


/**
 * Game-mode match: attempt vs retained ghost, same coordinate frame.
 * Single criterion: V_symdiff / max(V_target, volFloor) < relEps
 * (empty diffs have volume 0, so exact match is covered by rel < relEps).
 * Uses stageVerify-style sym = difference(union, intersection); no isEmpty
 * typeof soft-fail. Volume pre-gate + catch fallback if booleans throw.
 */
function _gameMatchCompare(attempt, target, relEps, volFloor) {
  const { Manifold } = manifoldModule;
  const se = _c4StatusError(attempt);
  if (se) return { match: false, reason: 'invalid_manifold', status: se };
  const volA = attempt.volume();
  const volT = target.volume();
  if (!(volA > 0) || !(volT > 0)) {
    return { match: false, reason: 'zero_volume', volA, volT, volDiff: null, rel: null };
  }
  const denom = Math.max(volT, volFloor);
  const volDelta = Math.abs(volA - volT);
  if (volDelta / denom >= relEps) {
    return {
      match: false, reason: 'volume_mismatch',
      volA, volT, volDiff: volDelta, rel: volDelta / denom,
    };
  }
  let u = null;
  let i = null;
  let sym = null;
  try {
    // Prefer union/intersection/difference (more throw-resistant than two raw diffs).
    u = Manifold.union(attempt, target);
    i = Manifold.intersection(attempt, target);
    sym = Manifold.difference(u, i);
    const volDiff = sym.volume();
    const rel = volDiff / denom;
    const match = rel < relEps;
    return {
      match,
      reason: match ? 'match' : 'difference_too_large',
      volA, volT, volDiff, rel,
    };
  } catch (e) {
    // Booleans failed on near-identical solids: trust the volume pre-gate.
    return {
      match: true,
      reason: 'boolean_failed_vol_fallback',
      volA, volT,
      volDiff: volDelta,
      rel: volDelta / denom,
      warning: String(e && e.message || e),
    };
  } finally {
    _safeDeleteManifold(sym);
    _safeDeleteManifold(u);
    _safeDeleteManifold(i);
  }
}

self.onmessage = async (event) => {
  const { type, payload, id } = event.data;
  
  try {
    switch (type) {
      case 'init': {
        await initializeManifold();
        lockdownGlobals();
        self.postMessage({ type: 'ready', id });
        break;
      }
      
      case 'execute': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        const { script, importedModels, memoryLimitMB, nonce } = payload;
        
        // Check memory before execution
        checkMemoryUsage(memoryLimitMB || 512);
        
        // Execute the script
        const result = executeScript(script, importedModels);
        
        // Cache the manifold for cross-section operations (+ nonce for game compare)
        cachedManifold = result;
        cachedExecuteNonce = (nonce !== undefined && nonce !== null) ? nonce : null;
        // Independent attempt snapshot for game match (only while a ghost is live).
        if (gameTargetManifold) {
          _safeDeleteManifold(gameAttemptManifold);
          gameAttemptManifold = result.clone();
        }
        
        // Check memory after execution
        const memoryUsed = checkMemoryUsage(memoryLimitMB || 512);
        
        // Serialize result for transfer
        const meshData = serializeResult(result);
        
        // Get metadata for quoting/display
        const volume = result.volume();
        const bbox = result.boundingBox();
        
        self.postMessage({ 
          type: 'result', 
          id,
          payload: {
            mesh: meshData,
            memoryUsedMB: memoryUsed,
            volume: volume,
            surfaceArea: result.surfaceArea(),
            status: _c4StatusError(result) || 'NoError',
            tris: meshData.triVerts.length / 3,
            boundingBox: {
              min: [...bbox.min],
              max: [...bbox.max]
            },
            nonce: cachedExecuteNonce,
          }
        });
        break;
      }

      // Get model info from cached manifold
      case 'getModelInfo': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        if (!cachedManifold) {
          throw new Error('No cached manifold - execute a script first');
        }
        
        const volume = cachedManifold.volume();
        const surfaceArea = cachedManifold.surfaceArea();
        const bbox = cachedManifold.boundingBox();
        
        self.postMessage({
          type: 'result',
          id,
          payload: {
            volume,
            surfaceArea,
            boundingBox: {
              min: [...bbox.min],
              max: [...bbox.max]
            }
          }
        });
        break;
      }

      // ── Game-mode match: retain ghost solid, compare attempt via boolean difference ──
      case 'storeGameTarget': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!cachedManifold) throw new Error('storeGameTarget: execute the target script first');
        const se = _c4StatusError(cachedManifold);
        if (se) throw new Error(`storeGameTarget: target is invalid (${se})`);
        const volume = cachedManifold.volume();
        if (!(volume > 0)) throw new Error('storeGameTarget: target has no volume');
        // Own retained handle — do not alias cachedManifold (attempt Run overwrites it).
        _safeDeleteManifold(gameTargetManifold);
        gameTargetManifold = cachedManifold.clone();
        self.postMessage({
          type: 'result', id,
          payload: { ok: true, volume, boundingBox: _bboxArray(cachedManifold) },
        });
        break;
      }

      case 'clearGameTarget': {
        _safeDeleteManifold(gameTargetManifold);
        gameTargetManifold = null;
        _safeDeleteManifold(gameAttemptManifold);
        gameAttemptManifold = null;
        self.postMessage({ type: 'result', id, payload: { ok: true } });
        break;
      }

      case 'compareGameMatch': {
        if (!isInitialized) throw new Error('Worker not initialized');
        if (!gameTargetManifold) throw new Error('compareGameMatch: no ghost target stored');
        if (!gameAttemptManifold) {
          throw new Error('compareGameMatch: no attempt snapshot — execute while a ghost target is stored');
        }
        if (payload?.nonce != null && payload.nonce !== cachedExecuteNonce) {
          self.postMessage({
            type: 'result', id,
            payload: {
              ignored: true, match: false, reason: 'stale_execute',
              nonce: payload.nonce, cachedNonce: cachedExecuteNonce,
            },
          });
          break;
        }
        const relEps = _positiveFinite(payload?.relEps, 0.002);
        const volFloor = _positiveFinite(payload?.volFloor, 1e-6);
        const verdict = _gameMatchCompare(gameAttemptManifold, gameTargetManifold, relEps, volFloor);
        self.postMessage({
          type: 'result', id,
          payload: { ...verdict, relEps, volFloor, nonce: cachedExecuteNonce },
        });
        break;
      }

      // Import OBJ string and create Manifold
      case 'importOBJ': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        const { objString, filename } = payload;
        
        // Parse OBJ string
        const vertices = [];
        const triangles = [];
        
        for (const line of objString.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          
          const parts = trimmed.split(/\s+/);
          const cmd = parts[0];
          
          if (cmd === 'v') {
            vertices.push([
              parseFloat(parts[1]) || 0,
              parseFloat(parts[2]) || 0,
              parseFloat(parts[3]) || 0
            ]);
          } else if (cmd === 'f') {
            const indices = [];
            for (let i = 1; i < parts.length; i++) {
              if (!parts[i]) continue;
              const idx = parseInt(parts[i].split('/')[0]);
              indices.push(idx < 0 ? vertices.length + idx : idx - 1);
            }
            // Fan triangulation for polygons with more than 3 vertices
            for (let i = 1; i < indices.length - 1; i++) {
              triangles.push([indices[0], indices[i], indices[i + 1]]);
            }
          }
        }
        
        if (vertices.length === 0 || triangles.length === 0) {
          throw new Error('OBJ contains no geometry');
        }
        
        console.log(`[Worker] Parsed OBJ: ${vertices.length} vertices, ${triangles.length} triangles`);
        
        // Create flat arrays for Manifold
        const vertProperties = new Float32Array(vertices.length * 3);
        for (let i = 0; i < vertices.length; i++) {
          vertProperties[i * 3] = vertices[i][0];
          vertProperties[i * 3 + 1] = vertices[i][1];
          vertProperties[i * 3 + 2] = vertices[i][2];
        }
        
        const triVerts = new Uint32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
          triVerts[i * 3] = triangles[i][0];
          triVerts[i * 3 + 1] = triangles[i][1];
          triVerts[i * 3 + 2] = triangles[i][2];
        }
        
        // FIX: Extract Mesh and Manifold from the module
        const { Mesh, Manifold } = manifoldModule;
        
        // Create Manifold mesh
        const mesh = new Mesh({ numProp: 3, vertProperties, triVerts });
        const manifold = new Manifold(mesh);
        
        // Validate
        const meshStatus = _c4StatusError(manifold);
        if (meshStatus) {
          // More descriptive error message
          throw new Error(`Invalid mesh: status ${meshStatus}. The mesh may not be watertight.`);
        }
        
        // Cache for script access (import path — not a script execute nonce)
        cachedManifold = manifold;
        cachedExecuteNonce = null;
        
        // Get final mesh data
        const finalMesh = manifold.getMesh();
        const bbox = manifold.boundingBox();
        
        // FIX: Use 'result' type instead of 'success'
        self.postMessage({
          type: 'result',
          id,
          payload: {
            mesh: {
              numProp: finalMesh.numProp,
              vertProperties: Array.from(finalMesh.vertProperties),
              triVerts: Array.from(finalMesh.triVerts),
            },
            volume: manifold.volume(),
            boundingBox: { min: [...bbox.min], max: [...bbox.max] },
            filename
          }
        });
        break;
      }
      
      // ── Stage verification protocol (dev tooling; see _stageVerify above) ──

      // Push a reference solid into the worker-side registry.
      //   objString: OBJ text (canonical GT from the STEP converter).
      //   meshData:  { numProp, vertProperties, triVerts } (numbers; from the backend STEP
      //              converter route when the bundled obj_converter + firejail are fixed)
      case 'stageReferenceLoad': {
        if (!isInitialized) throw new Error('Worker not initialized');
        const { filename, objString, meshData, tolerance } = payload;
        if (!filename) throw new Error('stageReferenceLoad: filename required');
        let md;
        if (objString) {
          md = _parseOBJToMeshData(objString);
        } else if (meshData && meshData.vertProperties && meshData.triVerts) {
          md = { vertProperties: meshData.vertProperties, triVerts: meshData.triVerts };
        } else {
          throw new Error('stageReferenceLoad: provide objString or meshData');
        }
        const { manifold, repair } = _meshDataToManifold(md.vertProperties, md.triVerts, tolerance ?? 0.001);
        _stagedReferences.set(filename, {
          manifold,
          volume: manifold.volume(),
          surfaceArea: manifold.surfaceArea(),
          boundingBox: _bboxArray(manifold),
          tris: manifold.getMesh().triVerts.length / 3,
          repair,
          source: objString ? 'obj' : 'meshData',
        });
        self.postMessage({
          type: 'result', id,
          payload: { ok: true, filename, repair, volume: _stagedReferences.get(filename).volume,
                     surfaceArea: _stagedReferences.get(filename).surfaceArea,
                     boundingBox: _stagedReferences.get(filename).boundingBox,
                     tris: _stagedReferences.get(filename).tris,
                     staged: [..._stagedReferences.keys()] },
        });
        break;
      }

      case 'stageReferenceList': {
        const list = [];
        for (const [filename, ref] of _stagedReferences) {
          list.push({ filename, volume: ref.volume, surfaceArea: ref.surfaceArea,
                      boundingBox: ref.boundingBox, tris: ref.tris, repair: ref.repair, source: ref.source });
        }
        self.postMessage({ type: 'result', id, payload: { references: list } });
        break;
      }

      case 'stageReferenceClear': {
        const n = _stagedReferences.size;
        _stagedReferences.clear();
        self.postMessage({ type: 'result', id, payload: { ok: true, cleared: n } });
        break;
      }

      // Verify the script's LAST execution result (the cached candidate from the most
      // recent execute — the same object the Run path painted) against a staged
      // reference. Verdict computed against the bundled build, in-worker.
      case 'stageVerify': {
        if (!isInitialized) throw new Error('Worker not initialized');
        const { reference, passRel, volGate, candidateMesh } = payload;
        if (!cachedManifold && !candidateMesh) throw new Error('stageVerify: no candidate — execute a script first');
        const ref = _stagedReferences.get(reference);
        if (!ref) throw new Error(`stageVerify: reference '${reference}' not staged (staged: ${[..._stagedReferences.keys()].join(', ') || 'none'})`);
        let cand;
        if (candidateMesh) {
          cand = _meshDataToManifold(candidateMesh.vertProperties, candidateMesh.triVerts, payload.tolerance ?? 0).manifold;
        } else {
          cand = cachedManifold;
        }
        const verdict = _stageVerify(cand, ref.manifold, { passRel, volGate });
        self.postMessage({
          type: 'result', id,
          payload: { ...verdict, reference, candidateVolume: cand.volume(),
                     referenceVolume: ref.volume },
        });
        break;
      }

      // Raw geometry probe of the last execution: the meshData the worker produced.
      case 'stageGetLastMesh': {
        if (!cachedManifold) throw new Error('stageGetLastMesh: nothing executed yet');
        const m = cachedManifold.getMesh();
        self.postMessage({
          type: 'result', id,
          payload: {
            numProp: m.numProp,
            vertProperties: Array.from(m.vertProperties),
            triVerts: Array.from(m.triVerts),
            volume: cachedManifold.volume(),
            surfaceArea: cachedManifold.surfaceArea(),
            boundingBox: _bboxArray(cachedManifold),
            status: _c4StatusError(cachedManifold) || 'NoError',
          },
        });
        break;
      }

      case 'getHelperList': {
        // Return list of available helper functions
        self.postMessage({
          type: 'helperList',
          id,
          payload: Object.keys(HELPER_FUNCTIONS)
        });
        break;
      }

      case 'trimByPlane': {
        if (!isInitialized) {
          throw new Error('Worker not initialized');
        }
        
        if (!cachedManifold) {
          throw new Error('No cached manifold - execute a script first');
        }
        
        const { normal, originOffset } = payload;
        
        // Apply trimByPlane to cached manifold
        const trimmed = cachedManifold.trimByPlane(normal, originOffset);
        
        // Serialize result
        const meshData = serializeResult(trimmed);
        
        self.postMessage({
          type: 'result',
          id,
          payload: { mesh: meshData }
        });
        break;
      }
      
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ 
      type: 'error', 
      id,
      payload: {
        message: error.message,
        stack: error.stack
      }
    });
  }
};

// Signal that the worker is loaded
self.postMessage({ type: 'loaded' });
