/**
 * Sheet-metal mode state (Viewport). Pure transitions so goldens can drive it.
 * S1: Start designing → stage 'plane' with the bound SKU record.
 */
export function enterSheetMetalMode(record, partId = null) {
  if (!record?.sku) return null;
  return { stage: 'plane', sku: record, partId: partId ?? null };
}
