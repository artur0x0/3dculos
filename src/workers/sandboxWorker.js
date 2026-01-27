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
