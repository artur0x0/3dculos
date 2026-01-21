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

  // Use global Manifold instance
  if (!window.Manifold) {
    throw new Error('Manifold WASM not loaded');
  }
  
  const wasm = window.Manifold;

  const wasmKeys = Object.keys(wasm);
  const wasmValues = Object.values(wasm);
  const scriptFn = new Function(...wasmKeys, currentScript);
  const result = scriptFn(...wasmValues);

  if (!result || typeof result.volume !== 'function') {
    throw new Error('Invalid manifold result');
  }

  // Get volume directly from Manifold
  const volume = result.volume(); // mm³
  
  // Get bounding box for surface area estimation
  const bbox = result.boundingBox();
  const width = bbox.max[0] - bbox.min[0];
  const height = bbox.max[1] - bbox.min[1];
  const depth = bbox.max[2] - bbox.min[2];

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
    'PLA': { density: 1.24, costPerKg: 20, printSpeed: 60 }, // mm/s
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
  const volumeCm3 = totalSolidVolume / 1000; // mm³ to cm³
  const materialGrams = volumeCm3 * matData.density;
  
  // Estimate print time - factor in infill
  const printSpeed = matData.printSpeed; // mm/s average
  const layerHeight = 0.2; // mm
  const numLayers = height / layerHeight;

  // Break down print time by component
  const perimeterLength = surfaceArea * 2; // Outer walls (constant regardless of infill)

  // Estimate infill path length based on volume and infill percentage
  const infillPathLength = (volume / layerHeight) * infillRatio * 0.5;

  // Total extrusion path
  const totalPathLength = perimeterLength + infillPathLength;

  // Calculate time (path time + layer change overhead)
  const printTimeHours = (totalPathLength / printSpeed / 3600) + (numLayers * 5 / 3600);
  
  // Calculate costs
  const materialCost = (materialGrams / 1000) * matData.costPerKg;
  const machineCost = printTimeHours * 5; // $5/hour
  const totalCost = materialCost + machineCost;
  
  return {
    // Material usage
    materialUsage: {
      grams: parseFloat(materialGrams.toFixed(1)),
      meters: 0
    },
    materialGrams: parseFloat(materialGrams.toFixed(1)), // Also at top level for easy access
    
    // Print time
    printTime: parseFloat(printTimeHours.toFixed(1)),
    
    // Costs - both nested and flat for convenience
    costs: {
      material: parseFloat(materialCost.toFixed(2)),
      machine: parseFloat(machineCost.toFixed(2)),
      total: parseFloat(totalCost.toFixed(2))
    },
    material: parseFloat(materialCost.toFixed(2)),  // Flat access
    machine: parseFloat(machineCost.toFixed(2)),    // Flat access
    subtotal: parseFloat(totalCost.toFixed(2)),     // Flat access
    
    // Settings used
    infill,
    materialName: material,
    process,
    
    // Model info
    volume: parseFloat(volume.toFixed(1)),
    surfaceArea: parseFloat(surfaceArea.toFixed(1)),
    
    // NEW: Bounding box for shipping calculations
    boundingBox: {
      width: parseFloat(width.toFixed(1)),   // mm
      height: parseFloat(height.toFixed(1)), // mm
      depth: parseFloat(depth.toFixed(1)),   // mm
    },
    
    // Also include raw bbox for compatibility
    bounds: {
      min: bbox.min,
      max: bbox.max,
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
    maxSize: { x: 256, y: 256, z: 256 }, // mm
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
