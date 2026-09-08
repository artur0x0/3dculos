// workers/sandboxWorker.js
// This worker executes user scripts in an isolated context with restricted globals
import Module from '../../built/manifold';

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

// ============================================================================
// EXTENDED MANIFOLD HELPERS
// These functions are injected into the script execution scope
// ============================================================================

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
 * Sweep a 2D profile along a 3D path
 * 
 * Creates a 3D manifold by extruding a cross-section profile along a parametric
 * path curve. Uses Frenet-Serret frames for orientation and arc-length 
 * parameterization for uniform distribution.
 * 
 * @param {CrossSection} profile - The 2D cross-section to sweep (centered at origin)
 * @param {Object} path - Parametric path definition
 * @param {Function} path.position - Function(t) returning [x,y,z] position on curve
 * @param {Function} [path.derivative] - Function(t) returning first derivative [dx,dy,dz].
 *                                       If omitted, computed numerically.
 * @param {Function} [path.secondDerivative] - Function(t) returning second derivative.
 *                                             If omitted, computed numerically.
 * @param {number} [path.tMin=0] - Start parameter value
 * @param {number} [path.tMax=1] - End parameter value
 * @param {Object} [options] - Sweep options
 * @param {number} [options.arcSamples=1000] - Samples for arc-length table (higher = more accurate)
 * @param {number} [options.extrudeSegments=64] - Segments along the extrusion
 * @param {number} [options.epsilon=1e-5] - Delta for numerical derivatives
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
 * return sweep2(profile, helixPath);
 * 
 * @example
 * // Sweep a square along a bezier-like curve with explicit derivatives
 * const profile = CrossSection.square([4, 4], true);
 * const curvePath = {
 *   position: (t) => [t * 50, 20 * Math.sin(t * Math.PI), 0],
 *   derivative: (t) => [50, 20 * Math.PI * Math.cos(t * Math.PI), 0],
 *   tMin: 0,
 *   tMax: 1
 * };
 * return sweep2(profile, curvePath, { extrudeSegments: 100 });
 */
function sweep2(profile, path, options = {}) {
  if (!manifoldModule) throw new Error('Manifold not initialized');
  const { Manifold, CrossSection } = manifoldModule;
  
  // Extract path config with defaults
  const {
    position,
    derivative: explicitDerivative,
    secondDerivative: explicitSecondDerivative,
    tMin = 0,
    tMax = 1
  } = path;
  
  // Extract options with defaults
  const {
    arcSamples = 1000,
    extrudeSegments = 64,
    epsilon = 1e-5
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
  
  const secondDerivative = explicitSecondDerivative || ((t) => {
    const d0 = derivative(t - epsilon);
    const d1 = derivative(t + epsilon);
    return vecMul(1 / (2 * epsilon), vecSub(d1, d0));
  });
  
  // Precompute arc length table using trapezoidal rule
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
  
  // Create straight extrusion to warp
  const straight = Manifold.extrude(profile, totalLength, extrudeSegments);
  
  // Warp function using Frenet-Serret frame
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
    
    // Interpolate t value
    const frac = (s - sValues[i]) / (sValues[i + 1] - sValues[i]);
    const t = tValues[i] + frac * (tValues[i + 1] - tValues[i]);
    
    // Compute Frenet-Serret frame
    const P = position(t);
    const TPrime = derivative(t);
    const speed = vecNorm(TPrime);
    const T = vecMul(1 / speed, TPrime);
    
    // Curvature vector for normal
    const A = secondDerivative(t);
    const TDotA = vecDot(T, A);
    const TDeriv = vecMul(1 / speed, vecSub(A, vecMul(TDotA, T)));
    const curv = vecNorm(TDeriv);
    
    // Normal and binormal
    let N = curv > 1e-8 ? vecMul(1 / curv, TDeriv) : [1, 0, 0];
    let B = vecNormalize(vecCross(T, N));
    
    // Map local (x, y) to N-B plane
    const offsetX = x * N[0] + y * B[0];
    const offsetY = x * N[1] + y * B[1];
    const offsetZ = x * N[2] + y * B[2];
    
    // Assign in-place
    v[0] = P[0] + offsetX;
    v[1] = P[1] + offsetY;
    v[2] = P[2] + offsetZ;
  };
  
  return straight.warp(warp);
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
  
  // Clamp radius to half the smallest dimension
  const minDim = Math.min(...size);
  const r = Math.min(radius, minDim / 2 - 0.001);
  
  // Create inner box
  const innerSize = size.map(s => s - 2 * r);
  const innerBox = Manifold.cube(innerSize, true);
  
  // Offset the box (Minkowski sum with a sphere)
  return innerBox.offset(r, segments);
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
  for (let i = 0; i < mesh.triVerts.length / 3; i++)
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
      const all = [];
      const trisSub = gis.map(gi => tris[gi]);
      for (const t of trisSub) {
        const v0 = V[mesh.triVerts[t*3]], v1 = V[mesh.triVerts[t*3+1]], v2 = V[mesh.triVerts[t*3+2]];
        const tn = _c4Norm(_c4Cross(_c4Sub(v1, v0), _c4Sub(v2, v0)));
        cn[0] += tn[0]; cn[1] += tn[1]; cn[2] += tn[2];
        for (const v of [v0, v1, v2]) {
          c[0] += v[0]; c[1] += v[1]; c[2] += v[2];
          if (!all.includes(v)) all.push(v);
        }
      }
      const cnt = gis.length * 3;
      faces.push({ id: fid, tris: trisSub, normal: _c4Norm(cn), center: _c4Mul(1/cnt, c), verts: all });
    }
  }
  faces.sort((a, b) => a.id - b.id);
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
  return c4MeshData(m).faces.filter(f => _c4Dot(f.normal, d) >= cosT);
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
  const M = manifoldModule.Manifold;
  const cut = _c4PutCyl(M, frame, u, v, dia, span);
  const out = M.difference(part, cut);
  if (out.status() !== 'NoError') throw new Error(`hole: bad result (${out.status()})`);
  return out;
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
  const M = manifoldModule.Manifold;
  const thru = _c4PutCyl(M, frame, u, v, diaThru, span);
  const cbore = _c4PutCyl(M, frame, u, v, diaCbore, cboreDepth + 1); // [−depth, +1]
  const out = M.difference(M.difference(part, thru), cbore);
  if (out.status() !== 'NoError') throw new Error(`cboreHole: bad result (${out.status()})`);
  return out;
}

/**
 * cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span)
 * — through hole + cone countersink: the cone spans diaThru→diaCsk over
 * cskDepth (118° style for cskDepth ≈ 1.17·(diaCsk−diaThru)/2).
 * (CadQuery cskHole)
 */
function cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span) {
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
  const out = M.difference(M.difference(part, thru), cone.transform(t));
  if (out.status() !== 'NoError') throw new Error(`cskHole: bad result (${out.status()})`);
  return out;
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
  const M = manifoldModule.Manifold;
  if (!edges.length) return part;
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
    if (cutter.status() !== 'NoError')
      throw new Error(`chamferEdges: edge ${ei} — degenerate cutter (hull status ${cutter.status()}); check the two adjacent faces at this edge`);
    const next = M.difference(out, cutter);
    if (next.status() !== 'NoError')
      throw new Error(`chamferEdges: edge ${ei} — boolean failed (${next.status()}); the cutter geometry is degenerate at this edge (common at triple-junction rib-base edges)`);
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

// ============================================================================
// C6 — Fillet helper (Manifold JS has no native fillet; this is the v1
// geometric construction). Ported from cadgen-workspace/harness/c6_fillet.mjs
// (8 harness tests green, 08-25).
//
// Per edge (both adjacent faces planar, edge convex):
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
// Constraints (v1): planar faces at the edge (checked: all same-face
// neighbor triangles coplanar within 1e-3; curved-face fillets throw);
// convex edges only (ball probe, same criterion as convexEdges — concave
// rounding is material ADD and out of scope); radius = number (all edges)
// or number[] parallel to the edge list (per-edge radii); r must satisfy
// t < 0.45·edge length (larger r runs off the face — the boolean clips it,
// documented lower fidelity). Arc tessellated at 96 segments: results sit
// ≤ L·(π−(n/2)sin(2π/n))·r² ABOVE the circle-exact volume per edge.
//
// opts.sphericalCorners: at every vertex where THREE filleted edges meet
// (~90° corners, equal radii only — v1 scope), the three fillet sails
// converge to a sharp cusp. The option cuts that cusp pocket with a ball
// of radius r centered on the trihedral incenter (equidistant r from all
// three faces and ON all three sail axes) — the result is a spherical
// corner patch tangent to each sail along a circle (C1) and to each face
// at one point, i.e. the true CAD corner for an r/r/r box corner.
// ============================================================================
function _c6Norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function _c6Cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _c6Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _c6Len(v) { return Math.hypot(v[0], v[1], v[2]); }

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
 * Returns the filleted part.
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
  for (const e of edges) _c6AssertPlanarAtEdge(mesh, e);

  const cutters = [];
  const edgeGeom = []; // per edge: { kA, kB, V0, V1, r, theta, cyl }
  const skippedShort = []; // {L, t} per edge skipped as a tessellation sliver
  for (const e of edges) {
    const r = radii.get(e);
    const P0 = e.va, P1 = e.vb;
    const L = Math.hypot(P1[0]-P0[0], P1[1]-P0[1], P1[2]-P0[2]);
    if (L < 1e-9) continue;
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
    if (t > 0.45 * L) {
      // SKIP, don't throw: short edges are tessellation slivers of a curved
      // arc (96/384-seg fillet/chamfer seams) that a filtered edge list
      // picks up alongside the real edge. Filing one sliver off would only
      // add noise, and one bad sliver must not kill the whole part — the
      // C8 parts f394288e/b0c16861/95d717e6 died this way for 4 iters.
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
    if (cutter.status() !== 'NoError')
      throw new Error(`filletEdges: bad cutter (${cutter.status()})`);
    cutters.push(cutter);
    edgeGeom.push({ kA: e.a, kB: e.b, V0: P0, V1: P1, r, theta, cyl });
  }
  if (!cutters.length) {
    // Every edge was skipped (tessellation slivers) — nothing to do.
    if (skippedShort.length)
      console.warn(`filletEdges: skipped all ${skippedShort.length} edges (too short for r — tessellation slivers); part unchanged`);
    return part;
  }
  // Union cutters, subtract once: shared-corner overlaps counted once
  // (matches analytic inclusion-exclusion — see block header).
  let tool = cutters[0];
  for (let i = 1; i < cutters.length; i++) tool = M.union([tool, cutters[i]]);
  let out = M.difference(part, tool);
  if (out.status() !== 'NoError') throw new Error(`filletEdges: bad result (${out.status()})`);

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
      if (cap.status() !== 'NoError' || cap.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner material (${cap.status()}, vol ${cap.volume()})`);
      const octant = M.intersection(ball, cornerBox);
      if (octant.status() !== 'NoError' || octant.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner octant (${octant.status()})`);
      cap = M.difference(cap, octant);
      if (cap.status() !== 'NoError' || cap.volume() < 1e-9)
        throw new Error(`filletEdges: bad corner cap (${cap.status()}, vol ${cap.volume()})`);
      caps.push(cap);
    }
    if (caps.length) {
      let capTool = caps[0];
      for (let i = 1; i < caps.length; i++) capTool = M.union([capTool, caps[i]]);
      out = M.difference(out, capTool);
      if (out.status() !== 'NoError')
        throw new Error(`filletEdges: bad corner-cap result (${out.status()})`);
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
  const s = m.status();
  if (typeof s === 'string' && s !== 'NoError')
    throw new Error(`${what}: invalid result (status ${s}) — the profile must be a closed polygon; for revolve: x >= 0 (radial), y = height around the axis`);
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
  // C6 fillet (see block above)
  filletEdges,
  // C8 revolve/extrude with safe winding (see block above)
  makeRevolve,
  makeExtrude,
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
        
        const { script, importedModels, memoryLimitMB } = payload;
        
        // Check memory before execution
        checkMemoryUsage(memoryLimitMB || 512);
        
        // Execute the script
        const result = executeScript(script, importedModels);
        
        // Cache the manifold for cross-section operations
        cachedManifold = result;
        
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
            boundingBox: {
              min: [...bbox.min],
              max: [...bbox.max]
            }
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
        const status = manifold.status();
        if (status.value !== 0) {
          // More descriptive error message
          throw new Error(`Invalid mesh: status code ${status.value}. The mesh may not be watertight.`);
        }
        
        // Cache for script access
        cachedManifold = manifold;
        
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
