// utils/measurementTool.js
import { Vector3, Group, CylinderGeometry, MeshBasicMaterial, Mesh, Quaternion } from 'three';

/**
 * Calculate measurements between two faces
 */
export function calculateMeasurements(face1, face2) {
  const center1 = new Vector3(...face1.center);
  const center2 = new Vector3(...face2.center);
  const normal1 = new Vector3(...face1.normal);
  
  // Vector from face1 to face2
  const delta = new Vector3().subVectors(center2, center1);
  
  // Normal distance (projection onto face1 normal)
  const normalDistance = Math.abs(delta.dot(normal1));
  
  // Component distances
  const xDistance = Math.abs(delta.x);
  const yDistance = Math.abs(delta.y);
  const zDistance = Math.abs(delta.z);
  
  // Total distance
  const totalDistance = delta.length();
  
  return {
    normal: normalDistance,
    x: xDistance,
    y: yDistance,
    z: zDistance,
    total: totalDistance
  };
}

// Colors matching the UI text (Tailwind colors approximated to hex)
const MEASUREMENT_COLORS = {
  normal: 0xd1d5db, // gray-300
  x: 0xef4444,      // red-500
  y: 0x22c55e,      // green-500
  z: 0x3b82f6       // blue-500
};

/**
 * Create a cylinder "line" between two points
 * @param {Vector3} start - Start point
 * @param {Vector3} end - End point
 * @param {number} color - Hex color
 * @param {number} radius - Cylinder radius (thickness)
 * @param {number} opacity - Material opacity
 * @returns {Mesh|null} Three.js Mesh object or null if length is too small
 */
function createLine(start, end, color, radius = 0.25, opacity = 1.0) {
  const direction = new Vector3().subVectors(end, start);
  const length = direction.length();
  
  // Don't create zero-length cylinders
  if (length < 0.001) return null;
  
  const geometry = new CylinderGeometry(radius, radius, length, 8);
  const material = new MeshBasicMaterial({ 
    color,
    transparent: true,
    opacity,
    depthTest: false
  });
  
  const cylinder = new Mesh(geometry, material);
  
  // Position at midpoint
  const midpoint = new Vector3().addVectors(start, end).multiplyScalar(0.5);
  cylinder.position.copy(midpoint);
  
  // Orient cylinder to point from start to end
  // Cylinder's default orientation is along Y axis
  const yAxis = new Vector3(0, 1, 0);
  const quaternion = new Quaternion().setFromUnitVectors(yAxis, direction.clone().normalize());
  cylinder.quaternion.copy(quaternion);
  
  return cylinder;
}

/**
 * Create measurement visualization lines between two face centers
 * Shows X, Y, Z components as a "staircase" path and normal projection
 * 
 * @param {Object} face1 - First face data with center and normal
 * @param {Object} face2 - Second face data with center
 * @returns {Group} Three.js Group containing all measurement lines
 */
export function createMeasurementLines(face1, face2) {
  const group = new Group();
  group.name = 'measurement-lines';
  
  const center1 = new Vector3(...face1.center);
  const center2 = new Vector3(...face2.center);
  const normal1 = new Vector3(...face1.normal).normalize();
  
  // Calculate the delta vector
  const delta = new Vector3().subVectors(center2, center1);
  
  // Create staircase path: X -> Y -> Z
  // This shows each axis component as a separate colored line
  
  // Point after X movement
  const afterX = new Vector3(
    center1.x + delta.x,
    center1.y,
    center1.z
  );
  
  // Point after X and Y movement
  const afterXY = new Vector3(
    center1.x + delta.x,
    center1.y + delta.y,
    center1.z
  );
  
  // Final point (after X, Y, and Z) should be center2
  const afterXYZ = center2.clone();
  
  // Create X line (red) - only if there's X movement
  if (Math.abs(delta.x) > 0.001) {
    const xLine = createLine(center1, afterX, MEASUREMENT_COLORS.x);
    if (xLine) {
      xLine.name = 'measurement-x';
      group.add(xLine);
    }
  }
  
  // Create Y line (green) - only if there's Y movement
  if (Math.abs(delta.y) > 0.001) {
    const yLine = createLine(afterX, afterXY, MEASUREMENT_COLORS.y);
    if (yLine) {
      yLine.name = 'measurement-y';
      group.add(yLine);
    }
  }
  
  // Create Z line (blue) - only if there's Z movement
  if (Math.abs(delta.z) > 0.001) {
    const zLine = createLine(afterXY, afterXYZ, MEASUREMENT_COLORS.z);
    if (zLine) {
      zLine.name = 'measurement-z';
      group.add(zLine);
    }
  }
  
  // Create normal projection line (gray)
  // This shows the distance along the first face's normal direction
  const normalProjectionLength = delta.dot(normal1);
  const normalEnd = new Vector3().addVectors(
    center1,
    normal1.clone().multiplyScalar(normalProjectionLength)
  );
  
  if (Math.abs(normalProjectionLength) > 0.001) {
    const normalLine = createLine(center1, normalEnd, MEASUREMENT_COLORS.normal);
    if (normalLine) {
      normalLine.name = 'measurement-normal';
      group.add(normalLine);
    }
    
    // Add a connecting line from normal end to center2 (subtle, to show the relationship)
    const connectingLine = createLine(normalEnd, center2, 0xe0e0e0e, 0.3, 0.3);
    if (connectingLine) {
      connectingLine.name = 'measurement-connecting';
      group.add(connectingLine);
    }
  }
  
  return group;
}

/**
 * Dispose of measurement lines group and all its children
 * @param {Group} group - The measurement lines group to dispose
 */
export function disposeMeasurementLines(group) {
  if (!group) return;
  
  group.children.forEach(child => {
    if (child.geometry) {
      child.geometry.dispose();
    }
    if (child.material) {
      child.material.dispose();
    }
  });
  
  group.clear();
}
