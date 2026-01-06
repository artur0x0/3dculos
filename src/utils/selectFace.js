import { Vector3 } from 'three';

const NORMAL_THRESHOLD = 0.001; // Element-wise tolerance for normal comparison

/**
 * Check if two normals are the same (element-wise)
 */
function normalsMatch(n1, n2) {
  return Math.abs(n1.x - n2.x) < NORMAL_THRESHOLD &&
         Math.abs(n1.y - n2.y) < NORMAL_THRESHOLD &&
         Math.abs(n1.z - n2.z) < NORMAL_THRESHOLD;
}

/**
 * Get normal for a triangle (compute from vertices, same as raycaster)
 */
function getFaceNormal(geometry, faceIdx) {
  const positions = geometry.attributes.position;
  const index = geometry.index.array;
  
  const i0 = index[faceIdx * 3];
  const i1 = index[faceIdx * 3 + 1];
  const i2 = index[faceIdx * 3 + 2];
  
  const v0 = new Vector3().fromBufferAttribute(positions, i0);
  const v1 = new Vector3().fromBufferAttribute(positions, i1);
  const v2 = new Vector3().fromBufferAttribute(positions, i2);
  
  // Calculate face normal from cross product (same as raycaster does)
  const edge1 = new Vector3().subVectors(v1, v0);
  const edge2 = new Vector3().subVectors(v2, v0);
  const normal = new Vector3().crossVectors(edge1, edge2).normalize();
  
  return normal;
}

/**
 * Build edge-to-triangle map for a geometry group
 */
function buildEdgeMap(geometry, targetGroup) {
  const edgeToTriangles = new Map();
  const numTriangles = geometry.index.count / 3;
  const index = geometry.index.array;
  
  for (let triIdx = 0; triIdx < numTriangles; triIdx++) {
    const triIndexInBuffer = triIdx * 3;
    if (targetGroup) {
      if (triIndexInBuffer < targetGroup.start || 
          triIndexInBuffer >= targetGroup.start + targetGroup.count) {
        continue;
      }
    }
    
    const i0 = index[triIdx * 3];
    const i1 = index[triIdx * 3 + 1];
    const i2 = index[triIdx * 3 + 2];
    
    const edges = [
      [Math.min(i0, i1), Math.max(i0, i1)],
      [Math.min(i1, i2), Math.max(i1, i2)],
      [Math.min(i2, i0), Math.max(i2, i0)]
    ];
    
    edges.forEach(([v1, v2]) => {
      const key = `${v1}-${v2}`;
      if (!edgeToTriangles.has(key)) {
        edgeToTriangles.set(key, []);
      }
      edgeToTriangles.get(key).push(triIdx);
    });
  }
  
  return edgeToTriangles;
}

/**
 * Get all adjacent triangles to a set of triangles
 */
function getAdjacentTriangles(triangles, edgeToTriangles, geometry) {
  const adjacent = new Set();
  const index = geometry.index.array;
  
  for (const triIdx of triangles) {
    const i0 = index[triIdx * 3];
    const i1 = index[triIdx * 3 + 1];
    const i2 = index[triIdx * 3 + 2];
    
    const edges = [
      [Math.min(i0, i1), Math.max(i0, i1)],
      [Math.min(i1, i2), Math.max(i1, i2)],
      [Math.min(i2, i0), Math.max(i2, i0)]
    ];
    
    edges.forEach(([v1, v2]) => {
      const key = `${v1}-${v2}`;
      const adjacentTris = edgeToTriangles.get(key) || [];
      adjacentTris.forEach(adjIdx => adjacent.add(adjIdx));
    });
  }
  
  return Array.from(adjacent);
}

/**
 * Select all triangles with same faceID and recursively expand to coplanar adjacent faceIDs
 * @param {BufferGeometry} geometry - The geometry to select from
 * @param {number} seedFaceIndex - Index of the initially clicked triangle
 * @param {Object} faceData - Face data containing normal information
 * @returns {Array<number>} Array of selected triangle indices
 */
export function selectFaceByID(geometry, seedFaceIndex, faceData) {
  console.log('[Face Selection] Selecting face by faceID from triangle', seedFaceIndex);
  
  const faceIDs = geometry.attributes.faceID;
  if (!faceIDs) {
    console.warn('[Face Selection] No faceID attribute found, selecting single triangle');
    return [seedFaceIndex];
  }
  
  // Find which group this triangle belongs to
  const groups = geometry.groups;
  let targetGroup = null;
  const indexInBuffer = seedFaceIndex * 3;
  
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (indexInBuffer >= group.start && indexInBuffer < group.start + group.count) {
      targetGroup = group;
      console.log('[Face Selection] Target group:', i, group);
      break;
    }
  }
  
  const targetNormal = new Vector3(faceData.normal[0], faceData.normal[1], faceData.normal[2]);
  console.log("[Face Selection] Target Normal is:", targetNormal);
  
  // Build edge-to-triangle map
  const edgeToTriangles = buildEdgeMap(geometry, targetGroup);
  
  // Recursive function to find all coplanar faceIDs
  const findCoplanarFaceIDs = (currentFaceID, visited) => {
    if (visited.has(currentFaceID)) return;
    visited.add(currentFaceID);
    
    // Get all triangles with this faceID in the group
    const trianglesWithID = [];
    for (let i = 0; i < faceIDs.count; i++) {
      if (faceIDs.array[i] !== currentFaceID) continue;
      
      const triIndexInBuffer = i * 3;
      if (targetGroup) {
        if (triIndexInBuffer >= targetGroup.start && 
            triIndexInBuffer < targetGroup.start + targetGroup.count) {
          trianglesWithID.push(i);
        }
      } else {
        trianglesWithID.push(i);
      }
    }
    
    if (trianglesWithID.length === 0) return;
    
    // Get adjacent triangles
    const adjacent = getAdjacentTriangles(trianglesWithID, edgeToTriangles, geometry);
    
    // Check each adjacent triangle's faceID and normal
    for (const adjIdx of adjacent) {
      const adjFaceID = faceIDs.array[adjIdx];
      
      // Skip if already visited
      if (visited.has(adjFaceID)) continue;
      
      // Check if normal matches
      const adjNormal = getFaceNormal(geometry, adjIdx);
      if (normalsMatch(targetNormal, adjNormal)) {
        // Recursively process this faceID
        findCoplanarFaceIDs(adjFaceID, visited);
      }
    }
  };
  
  // Start recursive search from seed faceID
  const seedFaceID = faceIDs.array[seedFaceIndex];
  const selectedFaceIDs = new Set();
  findCoplanarFaceIDs(seedFaceID, selectedFaceIDs);
  
  console.log('[Face Selection] Found coplanar faceIDs:', Array.from(selectedFaceIDs));
  
  // Collect all triangles with any of the selected faceIDs
  const result = [];
  for (let i = 0; i < faceIDs.count; i++) {
    if (!selectedFaceIDs.has(faceIDs.array[i])) continue;
    
    const triIndexInBuffer = i * 3;
    if (targetGroup) {
      if (triIndexInBuffer >= targetGroup.start && 
          triIndexInBuffer < targetGroup.start + targetGroup.count) {
        result.push(i);
      }
    } else {
      result.push(i);
    }
  }
  
  console.log(`[Face Selection] Selected ${result.length} triangles across ${selectedFaceIDs.size} faceIDs`);
  return result;
}

/**
 * Get all edges from a set of selected triangles
 * Returns unique edges (each edge appears once)
 * @param {Array<number>} triangleIndices - Array of triangle indices
 * @param {BufferGeometry} geometry - The geometry
 * @returns {Array<Array<number>>} Array of edges, each edge is [v1Index, v2Index]
 */
export function getEdgesFromTriangles(triangleIndices, geometry) {
  const edgeSet = new Set();
  const index = geometry.index.array;
  
  triangleIndices.forEach(triIdx => {
    const i0 = index[triIdx * 3];
    const i1 = index[triIdx * 3 + 1];
    const i2 = index[triIdx * 3 + 2];
    
    const edges = [
      [Math.min(i0, i1), Math.max(i0, i1)],
      [Math.min(i1, i2), Math.max(i1, i2)],
      [Math.min(i2, i0), Math.max(i2, i0)]
    ];
    
    edges.forEach(([v1, v2]) => {
      edgeSet.add(`${v1}-${v2}`);
    });
  });
  
  return Array.from(edgeSet).map(key => {
    const [v1, v2] = key.split('-').map(Number);
    return [v1, v2];
  });
}