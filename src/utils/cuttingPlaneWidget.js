// utils/cuttingPlaneWidget.js
import {
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  DoubleSide,
  LineSegments,
  EdgesGeometry,
  LineBasicMaterial,
  BufferGeometry,
  BufferAttribute,
  Group,
  Vector3
} from 'three';

/**
 * Create a visual cutting plane widget for the viewport
 * @param {Object} options - Plane configuration
 * @param {Array<number>} options.normal - Normal vector [x, y, z]
 * @param {number} options.originOffset - Distance from origin
 * @param {number} options.size - Size of the plane widget (default: 200)
 * @param {number} options.color - Plane color (default: 0x00ff00)
 * @param {number} options.opacity - Plane opacity (default: 0.3)
 * @returns {Group} Three.js group containing the plane widget
 */
export function createCuttingPlaneWidget(options = {}) {
  const {
    normal = [0, 0, 1],
    originOffset = 0,
    size = 200,
    color = 0x00ff00,
    opacity = 0.3
  } = options;

  const group = new Group();
  group.name = 'CuttingPlaneWidget';

  // Create the plane mesh
  const geometry = new PlaneGeometry(size, size);
  const material = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false
  });

  const planeMesh = new Mesh(geometry, material);

  // Add grid lines on the plane
  const edges = new EdgesGeometry(geometry);
  const lineMaterial = new LineBasicMaterial({
    color,
    transparent: true,
    opacity: opacity + 0.3,
    depthTest: false
  });
  const lineSegments = new LineSegments(edges, lineMaterial);
  planeMesh.add(lineSegments);

  // Position and orient the plane
  const normalVec = new Vector3(...normal).normalize();
  
  // Calculate rotation to align plane with normal
  const up = new Vector3(0, 0, 1);
  const quaternion = new Mesh().quaternion;
  if (Math.abs(normalVec.dot(up)) < 0.9999) {
    quaternion.setFromUnitVectors(up, normalVec);
  } else if (normalVec.dot(up) < 0) {
    quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  }
  
  planeMesh.quaternion.copy(quaternion);
  
  // Position along normal
  const position = normalVec.multiplyScalar(originOffset);
  planeMesh.position.copy(position);

  group.add(planeMesh);

  // Store plane data on the group for easy access
  group.userData = {
    normal: [...normal],
    originOffset,
    size,
    color
  };

  return group;
}

/**
 * Update an existing cutting plane widget
 * @param {Group} widget - The cutting plane widget group
 * @param {Object} options - Updated plane configuration
 * @param {Array<number>} options.normal - Normal vector
 * @param {number} options.originOffset - Distance from origin
 */
export function updateCuttingPlaneWidget(widget, options = {}) {
  const {
    normal = widget.userData.normal,
    originOffset = widget.userData.originOffset
  } = options;

  const normalVec = new Vector3(...normal).normalize();
  
  // Find the plane mesh (first child)
  const planeMesh = widget.children[0];
  
  // Update rotation
  const up = new Vector3(0, 0, 1);
  const quaternion = new Mesh().quaternion;
  if (Math.abs(normalVec.dot(up)) < 0.9999) {
    quaternion.setFromUnitVectors(up, normalVec);
  } else if (normalVec.dot(up) < 0) {
    quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  }
  
  planeMesh.quaternion.copy(quaternion);
  
  // Update position
  const position = normalVec.clone().multiplyScalar(originOffset);
  planeMesh.position.copy(position);

  // Update userData
  widget.userData.normal = [...normal];
  widget.userData.originOffset = originOffset;
}