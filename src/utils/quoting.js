// utils/quoting.js
import manifoldContext from './ManifoldWorker';
import { quoteFromGeometry } from './quoteMath.js';

/**
 * Calculate manufacturing quote for a Manifold model
 * @param {string} currentScript - The Manifold script to execute
 * @param {Object} options - Quote options
 * @param {string} options.process - Manufacturing process (FDM, SLA, SLS, MP)
 * @param {string} options.material - Material type
 * @param {number} options.infill - Infill percentage (0-100)
 * @returns {Promise<Object>} Quote details including costs, time, and material usage
 */
export async function calculateQuote(currentScript, options) {
  const { process, material, infill, quantity = 1 } = options;
  
  if (!currentScript) {
    throw new Error('No model to quote');
  }

  if (!manifoldContext.isReady) {
    throw new Error('Manifold worker not initialized');
  }

  // Execute script to get fresh result with volume and bounding box
  const result = await manifoldContext.executeScript(currentScript);
  
  const { volume, boundingBox } = result;
  
  if (volume === undefined || !boundingBox) {
    throw new Error('Invalid manifold result');
  }

  // Get bounding box dimensions
  const width = boundingBox.max[0] - boundingBox.min[0];
  const height = boundingBox.max[1] - boundingBox.min[1];
  const depth = boundingBox.max[2] - boundingBox.min[2];

  const surfaceArea = 2 * (width * height + width * depth + height * depth);
  console.log('[Quote] Volume:', volume, 'mm³');
  console.log('[Quote] Bounding box:', { width, height, depth });
  console.log('[Quote] Estimated surface area:', surfaceArea, 'mm²');

  return quoteFromGeometry({
    volume,
    boundingBox: {
      width,
      height,
      depth,
      min: boundingBox.min,
      max: boundingBox.max,
    },
    process,
    material,
    infill,
    quantity,
  });
}

/**
 * Process configuration and limits
 */
export const PROCESSES = {
  FDM: {
    name: 'FDM (Fused Deposition Modeling)',
    maxSize: { x: 256, y: 256, z: 256 },
    materials: ['PLA', 'PETG', 'ABS', 'TPU', 'Nylon']
  },
  SLA: {
    name: 'SLA (Stereolithography)',
    maxSize: { x: 145, y: 145, z: 175 },
    materials: ['Standard Resin', 'Tough Resin', 'Flexible Resin'],
    disabled: true
  },
  SLS: {
    name: 'SLS (Selective Laser Sintering)',
    maxSize: { x: 300, y: 300, z: 300 },
    materials: ['Nylon PA12', 'Nylon PA11', 'TPU'],
    disabled: true
  },
  MP: {
    name: 'Metal Printing',
    maxSize: { x: 250, y: 250, z: 250 },
    materials: ['Stainless Steel 316L', 'Aluminum AlSi10Mg', 'Titanium Ti6Al4V'],
    disabled: true
  }
};