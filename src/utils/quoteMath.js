/**
 * Pure FDM quote math. No Manifold, no mongoose.
 * Frontend `calculateQuote` and `POST /api/orders/create` both call this
 * so a tampered client price cannot become the charge.
 *
 * Quantity multiplies once: unit figures are computed for a single part,
 * then subtotal, material, machine, grams, and print time become unit × qty.
 * The bounding box stays one part. Omitted quantity is 1.
 */

export const QTY_MIN = 1;
export const QTY_MAX = 999;

export const PROCESS_LIMITS = {
  FDM: { x: 256, y: 256, z: 256 },
  SLA: { x: 145, y: 145, z: 175 },
  SLS: { x: 300, y: 300, z: 300 },
  MP: { x: 250, y: 250, z: 250 },
  MJF: { x: 256, y: 256, z: 256 },
};

export const MATERIAL_DATA = {
  PLA: { density: 1.24, costPerKg: 20, printSpeed: 60 },
  PETG: { density: 1.27, costPerKg: 25, printSpeed: 45 },
  ABS: { density: 1.04, costPerKg: 22, printSpeed: 45 },
  TPU: { density: 1.21, costPerKg: 40, printSpeed: 25 },
  Nylon: { density: 1.14, costPerKg: 45, printSpeed: 35 },
};

export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * More than one cent apart. A one-cent gap is rounding, not a price change.
 */
export function moneyDiffers(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) > 1;
}

/**
 * Integer 1..999. `null` / `undefined` / `''` become `missing` (default 1).
 * Any other invalid value returns null so the caller can reject it.
 */
export function clampQuantity(value, { missing = 1 } = {}) {
  if (value === undefined || value === null || value === '') return missing;
  if (typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < QTY_MIN || n > QTY_MAX) return null;
  return n;
}

export function quoteFromGeometry({
  volume,
  boundingBox,
  process,
  material,
  infill,
  quantity = 1,
}) {
  const qty = clampQuantity(quantity, { missing: 1 });
  if (!qty) {
    throw new Error('Quantity must be an integer from 1 to 999');
  }

  const width = Number(boundingBox?.width);
  const height = Number(boundingBox?.height);
  const depth = Number(boundingBox?.depth);
  const vol = Number(volume);

  if (![width, height, depth, vol].every((n) => Number.isFinite(n))) {
    throw new Error('Invalid manifold result');
  }

  const limits = PROCESS_LIMITS[process] || PROCESS_LIMITS.FDM;
  if (width > limits.x || height > limits.y || depth > limits.z) {
    throw new Error(
      `Part is too large for ${process} process. ` +
      `Part size: ${width.toFixed(0)} × ${height.toFixed(0)} × ${depth.toFixed(0)} mm. ` +
      `Max printable size: ${limits.x} × ${limits.y} × ${limits.z} mm.`
    );
  }

  const surfaceArea = 2 * (width * height + width * depth + height * depth);
  const matData = MATERIAL_DATA[material] || MATERIAL_DATA.PLA;
  const infillRatio = Number(infill) / 100;
  const wallThickness = 1.2;

  const shellVolume = surfaceArea * wallThickness;
  const infillVolume = vol * infillRatio;
  const totalSolidVolume = Math.min(shellVolume + infillVolume, vol);

  const volumeCm3 = totalSolidVolume / 1000;
  const materialGrams = volumeCm3 * matData.density;

  const printSpeed = matData.printSpeed;
  const layerHeight = 0.2;
  const numLayers = height / layerHeight;
  const perimeterLength = surfaceArea * 2;
  const infillPathLength = (vol / layerHeight) * infillRatio * 0.5;
  const totalPathLength = perimeterLength + infillPathLength;
  const printTimeHours = (totalPathLength / printSpeed / 3600) + (numLayers * 5 / 3600);

  const materialCost = (materialGrams / 1000) * matData.costPerKg;
  const machineCost = printTimeHours * 5;
  const totalCost = materialCost + machineCost;

  const unitMaterial = parseFloat(materialCost.toFixed(2));
  const unitMachine = parseFloat(machineCost.toFixed(2));
  const unitSubtotal = parseFloat(totalCost.toFixed(2));
  const unitGrams = parseFloat(materialGrams.toFixed(1));
  const unitPrintTime = parseFloat(printTimeHours.toFixed(1));

  const materialExt = parseFloat((unitMaterial * qty).toFixed(2));
  const machineExt = parseFloat((unitMachine * qty).toFixed(2));
  const subtotal = parseFloat((unitSubtotal * qty).toFixed(2));
  const gramsExt = parseFloat((unitGrams * qty).toFixed(1));
  const printExt = parseFloat((unitPrintTime * qty).toFixed(1));

  return {
    materialUsage: {
      grams: gramsExt,
      meters: 0,
    },
    materialGrams: gramsExt,
    printTime: printExt,
    costs: {
      material: materialExt,
      machine: machineExt,
      total: subtotal,
    },
    material: materialExt,
    machine: machineExt,
    subtotal,
    quantity: qty,
    unitSubtotal,
    unitMaterial,
    unitMachine,
    unitGrams,
    unitPrintTime,
    infill,
    materialName: material,
    process,
    volume: parseFloat(vol.toFixed(1)),
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
 * Re-extend a quote the modal already has, without running Manifold again.
 * Unit fields win. If they are absent (qty was 1), the current money fields
 * are the unit price.
 */
export function applyClientQuantity(quote, quantity) {
  const qty = clampQuantity(quantity, { missing: 1 });
  if (!quote || !qty) return quote;
  const unitSubtotal = finite(quote.unitSubtotal, quote.subtotal);
  const unitMaterial = finite(quote.unitMaterial, quote.materialCost);
  const unitMachine = finite(quote.unitMachine, quote.machineCost);
  const unitGrams = finite(quote.unitGrams, quote.materialGrams);
  const unitPrintTime = finite(quote.unitPrintTime, quote.printTime);
  const subtotal = parseFloat((unitSubtotal * qty).toFixed(2));
  const materialCost = parseFloat((unitMaterial * qty).toFixed(2));
  const machineCost = parseFloat((unitMachine * qty).toFixed(2));
  const materialGrams = parseFloat((unitGrams * qty).toFixed(1));
  const printTime = parseFloat((unitPrintTime * qty).toFixed(1));
  return {
    ...quote,
    quantity: qty,
    unitSubtotal,
    unitMaterial,
    unitMachine,
    unitGrams,
    unitPrintTime,
    subtotal,
    materialCost,
    machineCost,
    materialGrams,
    printTime,
    costs: quote.costs ? {
      ...quote.costs,
      material: materialCost,
      machine: machineCost,
      total: subtotal,
    } : quote.costs,
    materialUsage: quote.materialUsage ? {
      ...quote.materialUsage,
      grams: materialGrams,
    } : quote.materialUsage,
  };
}

function finite(primary, fallback) {
  const a = Number(primary);
  if (Number.isFinite(a)) return a;
  const b = Number(fallback);
  return Number.isFinite(b) ? b : 0;
}

/**
 * Body fragment for `POST /api/orders/create`.
 *
 * `subtotal` / `material` / `machine` are already extended (unit × qty).
 * An old server ignores `quantity` and charges `subtotal` once, so the
 * client must not leave the unit price in `subtotal` or the customer
 * underpays, and must not multiply again on top of a server that also
 * multiplies. The new server ignores these money fields and recomputes.
 * `unitSubtotal` is comparison-only.
 */
export function clientOrderQuote(quote, shippingPrice) {
  return {
    material: quote.materialCost,
    machine: quote.machineCost,
    subtotal: quote.subtotal,
    shipping: shippingPrice,
    unitSubtotal: quote.unitSubtotal,
    unitMaterial: quote.unitMaterial,
    unitMachine: quote.unitMachine,
    unitGrams: quote.unitGrams,
  };
}

