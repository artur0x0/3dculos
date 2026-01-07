// utils/crossSection.js
import { Vector3 } from 'three';

/**
 * Plane presets for common orientations
 */
export const PLANE_PRESETS = {
  XY: {
    name: 'XY Plane (Top)',
    normal: [0, 0, 1],
    defaultOffset: 0
  },
  XZ: {
    name: 'XZ Plane (Front)',
    normal: [0, 1, 0],
    defaultOffset: 0
  },
  YZ: {
    name: 'YZ Plane (Side)',
    normal: [1, 0, 0],
    defaultOffset: 0
  }
};

/**
 * Create a cross-section using Manifold's trimByPlane
 * @param {string} currentScript - The Manifold script to execute
 * @param {Object} plane - Plane definition
 * @param {Array<number>} plane.normal - Normal vector [x, y, z]
 * @param {number} plane.originOffset - Distance from origin along normal
 * @returns {Object} Cross-section result with original and trimmed manifolds
 */
export async function createCrossSection(currentScript, plane) {
  if (!currentScript) {
    throw new Error('No script provided');
  }

  if (!window.Manifold) {
    throw new Error('Manifold WASM not loaded');
  }
  
  const wasm = window.Manifold;

  // Execute script to get the manifold
  const wasmKeys = Object.keys(wasm);
  const wasmValues = Object.values(wasm);
  const scriptFn = new Function(...wasmKeys, currentScript);
  const originalManifold = scriptFn(...wasmValues);

  if (!originalManifold || typeof originalManifold.trimByPlane !== 'function') {
    throw new Error('Invalid manifold result - trimByPlane not available');
  }

  // Normalize the normal vector
  const normal = new Vector3(...plane.normal);
  normal.normalize();
  const normalArray = [normal.x, normal.y, normal.z];

  console.log('[CrossSection] Trimming by plane:', {
    normal: normalArray,
    originOffset: plane.originOffset
  });

  // Apply the trim
  const trimmedManifold = originalManifold.trimByPlane(normalArray, plane.originOffset);

  return {
    original: originalManifold,
    trimmed: trimmedManifold,
    plane: {
      normal: normalArray,
      originOffset: plane.originOffset
    }
  };
}

/**
 * Get the bounding box of a manifold to help with plane positioning
 * @param {string} currentScript - The Manifold script to execute
 * @returns {Object} Bounding box with min/max coordinates and center
 */
export function getManifoldBounds(currentScript) {
  if (!window.Manifold) {
    throw new Error('Manifold WASM not loaded');
  }
  
  const wasm = window.Manifold;
  const wasmKeys = Object.keys(wasm);
  const wasmValues = Object.values(wasm);
  const scriptFn = new Function(...wasmKeys, currentScript);
  const manifold = scriptFn(...wasmValues);

  if (!manifold || typeof manifold.boundingBox !== 'function') {
    throw new Error('Invalid manifold result');
  }

  const bbox = manifold.boundingBox();
  const center = [
    (bbox.min[0] + bbox.max[0]) / 2,
    (bbox.min[1] + bbox.max[1]) / 2,
    (bbox.min[2] + bbox.max[2]) / 2
  ];

  const size = [
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2]
  ];

  return {
    min: bbox.min,
    max: bbox.max,
    center,
    size
  };
}

/**
 * Calculate the range of valid offset values for a plane
 * @param {string} currentScript - The Manifold script
 * @param {Array<number>} normal - Plane normal vector
 * @returns {Object} Min and max offset values
 */
export function getPlaneOffsetRange(currentScript, normal) {
  const bounds = getManifoldBounds(currentScript);
  
  // Project bounding box corners onto the normal to find range
  const normalVec = new Vector3(...normal).normalize();
  
  const corners = [
    new Vector3(bounds.min[0], bounds.min[1], bounds.min[2]),
    new Vector3(bounds.max[0], bounds.min[1], bounds.min[2]),
    new Vector3(bounds.min[0], bounds.max[1], bounds.min[2]),
    new Vector3(bounds.max[0], bounds.max[1], bounds.min[2]),
    new Vector3(bounds.min[0], bounds.min[1], bounds.max[2]),
    new Vector3(bounds.max[0], bounds.min[1], bounds.max[2]),
    new Vector3(bounds.min[0], bounds.max[1], bounds.max[2]),
    new Vector3(bounds.max[0], bounds.max[1], bounds.max[2])
  ];

  const projections = corners.map(corner => corner.dot(normalVec));
  
  return {
    min: Math.min(...projections),
    max: Math.max(...projections),
    center: (Math.min(...projections) + Math.max(...projections)) / 2
  };
}

/**
 * Get the cut edges from comparing original and trimmed manifolds
 * This extracts the boundary edges created by the trim operation
 * @param {Object} original - Original manifold
 * @param {Object} trimmed - Trimmed manifold  
 * @returns {Array} Array of edge line segments
 */
export function getCutEdges(original, trimmed) {
  // Get meshes
  const originalMesh = original.getMesh();
  const trimmedMesh = trimmed.getMesh();
  
  // The cut edges are the new boundary edges in the trimmed mesh
  // We can identify them by finding edges that only appear in one triangle
  
  const edges = [];
  const edgeCount = new Map();
  
  // Count edge occurrences in trimmed mesh
  for (let i = 0; i < trimmedMesh.triVerts.length; i += 3) {
    const v0 = trimmedMesh.triVerts[i];
    const v1 = trimmedMesh.triVerts[i + 1];
    const v2 = trimmedMesh.triVerts[i + 2];
    
    const edgeKeys = [
      `${Math.min(v0, v1)}-${Math.max(v0, v1)}`,
      `${Math.min(v1, v2)}-${Math.max(v1, v2)}`,
      `${Math.min(v2, v0)}-${Math.max(v2, v0)}`
    ];
    
    edgeKeys.forEach(key => {
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    });
  }
  
  // Boundary edges (cut edges) appear only once
  const positions = trimmedMesh.vertProperties;
  edgeCount.forEach((count, key) => {
    if (count === 1) {
      const [v1, v2] = key.split('-').map(Number);
      
      // Get vertex positions
      const p1 = [
        positions[v1 * 3],
        positions[v1 * 3 + 1],
        positions[v1 * 3 + 2]
      ];
      const p2 = [
        positions[v2 * 3],
        positions[v2 * 3 + 1],
        positions[v2 * 3 + 2]
      ];
      
      edges.push({ p1, p2 });
    }
  });
  
  return edges;
}

/**
 * Create multiple parallel cross-sections
 * @param {string} currentScript - The Manifold script
 * @param {Array<number>} normal - Plane normal
 * @param {number} startOffset - Starting offset
 * @param {number} endOffset - Ending offset
 * @param {number} count - Number of sections
 * @returns {Array} Array of cross-section results
 */
export function createParallelSections(currentScript, normal, startOffset, endOffset, count) {
  const sections = [];
  const step = (endOffset - startOffset) / (count - 1);
  
  for (let i = 0; i < count; i++) {
    const offset = startOffset + (step * i);
    const section = createCrossSection(currentScript, {
      normal,
      originOffset: offset
    });
    sections.push(section);
  }
  
  return sections;
}