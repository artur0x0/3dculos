/**
 * Place the sheet-metal mode chip in the gap between the side rails.
 * Width comes from the rails' measured boxes, not a guessed phone width.
 * `container`, `leftRail`, and `rightRail` are rect-like `{ left, right, width }`.
 * Desktop passes `maxWidth` (the existing 22rem cap) and stays centered in
 * that gap. Mobile omits it and uses the whole gap.
 */

/** Same 0.5rem as the rail inset (`left-2` / `right-2`). Clearance, not a width. */
export const SHEET_RAIL_CLEARANCE_PX = 8;

/** Desktop chip cap, matching `w-[22rem]` on SheetMetalModeChip. */
export const SHEET_CHIP_DESKTOP_REM = 22;

export function sheetChipBetweenRails(container, leftRail, rightRail, {
  maxWidth = null,
  clearance = SHEET_RAIL_CLEARANCE_PX,
} = {}) {
  if (!container || !leftRail || !rightRail) return null;
  const width = Number(container.width);
  const cLeft = Number(container.left);
  const cRight = Number(container.right);
  const railLeft = Number(leftRail.right);
  const railRight = Number(rightRail.left);
  if (![width, cLeft, cRight, railLeft, railRight].every(Number.isFinite) || !(width > 0)) {
    return null;
  }
  const gapLeft = (railLeft - cLeft) + clearance;
  const gapRight = (cRight - railRight) + clearance;
  const available = width - gapLeft - gapRight;
  if (!(available >= 32)) return null;
  const cap = Number(maxWidth);
  const chipWidth = Number.isFinite(cap) && cap > 0 ? Math.min(cap, available) : available;
  if (!(chipWidth > 0)) return null;
  return {
    left: gapLeft + (available - chipWidth) / 2,
    width: chipWidth,
  };
}
