/**
 * Stack copies of one part along its shortest side, in millimetres,
 * before any inch conversion. Width wins a tie, then height, then depth.
 * Quantity 1 returns the one-part box. Packaging padding is not applied here.
 */
import { clampQuantity } from './quoteMath.js';

export function stackAlongShortestSide(boundingBox, quantity = 1) {
  const qty = clampQuantity(quantity, { missing: 1 }) || 1;
  let width = Number(boundingBox?.width) || 0;
  let height = Number(boundingBox?.height) || 0;
  let depth = Number(boundingBox?.depth) || 0;

  if (qty > 1) {
    const axes = [
      { key: 'width', value: width },
      { key: 'height', value: height },
      { key: 'depth', value: depth },
    ];
    let shortest = axes[0];
    for (const axis of axes) {
      if (axis.value < shortest.value) shortest = axis;
    }
    if (shortest.key === 'width') width *= qty;
    else if (shortest.key === 'height') height *= qty;
    else depth *= qty;
  }

  return { width, height, depth };
}
