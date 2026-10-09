// Width of the feature card: the measured gap between the side rails,
// the same helper the sheet-metal chip uses, with a 10px side gap and
// a 22rem cap. Before the first measure, CSS uses the fallback width.
// `fullLeft` ignores the left rail and pins the left edge to that inset.
import { sheetChipBetweenRails } from './sheetMetal/sheetChipLayout.js';

export const FEATURE_SHEET_MAX_REM = 22;
export const FEATURE_SHEET_SIDE_GAP_PX = 10;

/**
 * Home-pill stack: 30px pill, its safe-area padding, and the old 10px gap.
 * The open feature card does not use this. The home-indicator golden still
 * names the formula. Fillet, chamfer, and the edge card dock with the shell.
 */
export const FEATURE_SHEET_BOTTOM_PHONE =
  'calc(30px + max(8px, env(safe-area-inset-bottom, 0px)) + 10px)';

/**
 * Phone, while the card is open. The stage switcher is hidden and the card's
 * bottom edge sits on the switcher's bottom edge. That edge is the pane
 * bottom: both are anchored there.
 */
export const FEATURE_SHEET_BOTTOM_PHONE_DOCKED = '0px';

/** Desktop: no bottom switcher. 10px, or the safe area when that is larger. */
export const FEATURE_SHEET_BOTTOM_DESKTOP =
  'max(10px, env(safe-area-inset-bottom, 0px))';

export function featureSheetBottom(compact) {
  return compact ? FEATURE_SHEET_BOTTOM_PHONE_DOCKED : FEATURE_SHEET_BOTTOM_DESKTOP;
}

/**
 * @param {Element} pane  the viewport shell
 * @param {number} [rootPx]  computed root font size, for the 22rem cap
 * @param {{ fullLeft?: boolean }} [options]
 *   `fullLeft` skips the left rail. The left edge is the 10px pane inset.
 *   The right edge stays 10px clear of the right rail. Width still caps at 22rem.
 * @returns {{ left: number, width: number }|null}
 */
export function measureFeatureSheetWidth(pane, rootPx = 16, { fullLeft = false } = {}) {
  if (!pane || typeof pane.getBoundingClientRect !== 'function') return null;
  const right = pane.querySelector?.('[data-rail-pair="right"]');
  if (!right || typeof right.getBoundingClientRect !== 'function') return null;
  const paneBox = pane.getBoundingClientRect();
  let leftBox;
  if (fullLeft) {
    leftBox = { left: paneBox.left, right: paneBox.left, width: 0 };
  } else {
    const left = pane.querySelector?.('[data-rail-pair="left"]');
    if (!left || typeof left.getBoundingClientRect !== 'function') return null;
    leftBox = left.getBoundingClientRect();
  }
  const root = Number(rootPx);
  const maxWidth = (Number.isFinite(root) && root > 0 ? root : 16) * FEATURE_SHEET_MAX_REM;
  const placed = sheetChipBetweenRails(
    paneBox,
    leftBox,
    right.getBoundingClientRect(),
    { maxWidth, clearance: FEATURE_SHEET_SIDE_GAP_PX },
  );
  if (!placed || !fullLeft) return placed;
  // The gap is already capped, so pinning the left edge keeps the right
  // edge at least FEATURE_SHEET_SIDE_GAP_PX clear of the right rail.
  return { left: FEATURE_SHEET_SIDE_GAP_PX, width: placed.width };
}
