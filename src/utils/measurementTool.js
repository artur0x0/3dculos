// utils/measurementTool.js
import { Vector3 } from 'three';

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