/**
 * Combined UPS box for one order.
 *
 * Each line is one brick: copies of that part stacked on the shortest side
 * (width wins a tie). One box is then:
 *   length  = max of each brick's longest side
 *   width   = max of each brick's middle side
 *   height  = sum of each brick's shortest side
 * then the existing inch conversion and padding (+1 in, minimum 6×4×1).
 *
 * Weight is the sum of the line's extended grams plus 100 g of packaging
 * once per box (not once per line).
 *
 * When that box would pass a UPS limit, a simple greedy packer (first-fit,
 * largest brick first) splits the order into more boxes. Each box is rated
 * and the rates are summed. A single brick that is already over the limit
 * still ships in its own box — size or weight never blocks the purchase.
 *
 * Future packing optimization: replace `packOrderBoxes` only. The rating
 * sum and the "never refuse the order" rule stay.
 */
import { stackAlongShortestSide } from '../../src/utils/packageSize.js';
import { calculatePackageDimensions, calculatePackageWeight } from './ups.js';

export const UPS_MAX_SIDE_IN = 108;
export const UPS_MAX_LENGTH_PLUS_GIRTH_IN = 165;
/** UPS domestic max per package. A heavier order is split, not rejected. */
export const UPS_MAX_WEIGHT_LBS = 150;

export function packageExceedsUpsLimits(dimensions, weightLbs) {
  const sides = [dimensions?.length, dimensions?.width, dimensions?.height]
    .map((n) => Number(n) || 0)
    .sort((a, b) => b - a);
  const longest = sides[0];
  const girth = 2 * (sides[1] + sides[2]);
  if (longest > UPS_MAX_SIDE_IN) return true;
  if (longest + girth > UPS_MAX_LENGTH_PLUS_GIRTH_IN) return true;
  if (Number(weightLbs) > UPS_MAX_WEIGHT_LBS) return true;
  return false;
}

/**
 * @param {Array<{ boundingBox, quantity, grams }>} lines
 *   `grams` is already extended (unit × qty). Do not multiply again.
 */
export function packOrderBoxes(lines) {
  const items = (lines || []).map((line, index) => ({
    index,
    brick: stackAlongShortestSide(line.boundingBox, line.quantity),
    grams: Number(line.grams) || 0,
  }));

  const sorted = [...items].sort((a, b) => brickVolume(b.brick) - brickVolume(a.brick));
  const groups = [];

  for (const item of sorted) {
    let placed = false;
    for (const group of groups) {
      const trial = packageForItems(group.items.concat(item));
      if (!packageExceedsUpsLimits(trial.dimensions, trial.weight)) {
        group.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ items: [item] });
    }
  }

  return groups.map((group) => {
    const packed = packageForItems(group.items);
    return {
      ...packed,
      lineIndexes: group.items.map((item) => item.index).sort((a, b) => a - b),
      overLimit: packageExceedsUpsLimits(packed.dimensions, packed.weight),
    };
  });
}

export function previewPackages(lines) {
  const boxes = packOrderBoxes(lines);
  const info = {
    boxCount: boxes.length,
    boxes: boxes.map((box) => ({
      dimensions: box.dimensions,
      weight: box.weight,
      overLimit: box.overLimit,
    })),
  };
  if (boxes.length === 1) {
    info.dimensions = boxes[0].dimensions;
    info.weight = boxes[0].weight;
  }
  return info;
}

function packageForItems(items) {
  const mm = combineBricks(items.map((item) => item.brick));
  const dimensions = calculatePackageDimensions(mm, 1, 1);
  const grams = items.reduce((sum, item) => sum + item.grams, 0);
  const weight = calculatePackageWeight(grams);
  return { dimensions, weight, grams };
}

function combineBricks(bricks) {
  let longest = 0;
  let middle = 0;
  let shortestSum = 0;
  for (const brick of bricks) {
    const sides = sortedSides(brick);
    longest = Math.max(longest, sides[0]);
    middle = Math.max(middle, sides[1]);
    shortestSum += sides[2];
  }
  // calculatePackageDimensions maps width → length, height → width, depth → height.
  return { width: longest, height: middle, depth: shortestSum };
}

function sortedSides(box) {
  return [box?.width, box?.height, box?.depth]
    .map((n) => Number(n) || 0)
    .sort((a, b) => b - a);
}

function brickVolume(brick) {
  const [a, b, c] = sortedSides(brick);
  return a * b * c;
}
