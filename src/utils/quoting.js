// utils/quoting.js
import manifoldContext from './ManifoldWorker';

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
  const { process, material, infill } = options;
  
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

  // Define max build volumes for each process
  const processLimits = {
    'FDM': { x: 256, y: 256, z: 256 },
    'SLA': { x: 145, y: 145, z: 175 },
    'SLS': { x: 300, y: 300, z: 300 },
    'MP': { x: 250, y: 250, z: 250 }
  };

  const limits = processLimits[process] || processLimits['FDM'];
  
  // Check if part fits within build volume
  if (width > limits.x || height > limits.y || depth > limits.z) {
    throw new Error(
      `Part is too large for ${process} process. ` +
      `Part size: ${width.toFixed(0)} × ${height.toFixed(0)} × ${depth.toFixed(0)} mm. ` +
      `Max printable size: ${limits.x} × ${limits.y} × ${limits.z} mm.`
    );
  }
  
  // Estimate surface area (rough approximation for a box-like shape)
  const surfaceArea = 2 * (width * height + width * depth + height * depth);

  console.log('[Quote] Volume:', volume, 'mm³');
  console.log('[Quote] Bounding box:', { width, height, depth });
  console.log('[Quote] Estimated surface area:', surfaceArea, 'mm²');

  // Material properties
  const materialData = {
    'PLA': { density: 1.24, costPerKg: 20, printSpeed: 60 },
    'PETG': { density: 1.27, costPerKg: 25, printSpeed: 45 },
    'ABS': { density: 1.04, costPerKg: 22, printSpeed: 45 },
    'TPU': { density: 1.21, costPerKg: 40, printSpeed: 25 },
    'Nylon': { density: 1.14, costPerKg: 45, printSpeed: 35 }
  };

  const matData = materialData[material] || materialData['PLA'];
  
  // Calculate material usage
  const infillRatio = infill / 100;
  const wallThickness = 1.2; // mm (3 perimeters at 0.4mm)
  
  // Estimate solid volume (walls + infill)
  const shellVolume = surfaceArea * wallThickness;
  const infillVolume = volume * infillRatio;
  const totalSolidVolume = Math.min(shellVolume + infillVolume, volume);
  
  // Convert to grams
  const volumeCm3 = totalSolidVolume / 1000;
  const materialGrams = volumeCm3 * matData.density;
  
  // Estimate print time
  const printSpeed = matData.printSpeed;
  const layerHeight = 0.2;
  const numLayers = height / layerHeight;

  const perimeterLength = surfaceArea * 2;
  const infillPathLength = (volume / layerHeight) * infillRatio * 0.5;
  const totalPathLength = perimeterLength + infillPathLength;
  const printTimeHours = (totalPathLength / printSpeed / 3600) + (numLayers * 5 / 3600);
  
  // Calculate costs
  const materialCost = (materialGrams / 1000) * matData.costPerKg;
  const machineCost = printTimeHours * 5;
  const totalCost = materialCost + machineCost;
  
  return {
    materialUsage: {
      grams: parseFloat(materialGrams.toFixed(1)),
      meters: 0
    },
    materialGrams: parseFloat(materialGrams.toFixed(1)),
    printTime: parseFloat(printTimeHours.toFixed(1)),
    costs: {
      material: parseFloat(materialCost.toFixed(2)),
      machine: parseFloat(machineCost.toFixed(2)),
      total: parseFloat(totalCost.toFixed(2))
    },
    material: parseFloat(materialCost.toFixed(2)),
    machine: parseFloat(machineCost.toFixed(2)),
    subtotal: parseFloat(totalCost.toFixed(2)),
    infill,
    materialName: material,
    process,
    volume: parseFloat(volume.toFixed(1)),
    surfaceArea: parseFloat(surfaceArea.toFixed(1)),
    boundingBox: {
      width: parseFloat(width.toFixed(1)),
      height: parseFloat(height.toFixed(1)),
      depth: parseFloat(depth.toFixed(1)),
    },
    bounds: {
      min: boundingBox.min,
      max: boundingBox.max,
      size: [width, height, depth],
    },
  };
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