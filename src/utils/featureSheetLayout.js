// Width of the feature card: the measured gap between the side rails,
// the same helper the sheet-metal chip uses, with a 10px side gap and
// a 22rem cap. Before the first measure, CSS uses the fallback width.
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
 * @returns {{ left: number, width: number }|null}
 */
export function measureFeatureSheetWidth(pane, rootPx = 16) {
  if (!pane || typeof pane.getBoundingClientRect !== 'function') return null;
  const left = pane.querySelector?.('[data-rail-pair="left"]');
  const right = pane.querySelector?.('[data-rail-pair="right"]');
  if (!left || !right) return null;
  const root = Number(rootPx);
  const maxWidth = (Number.isFinite(root) && root > 0 ? root : 16) * FEATURE_SHEET_MAX_REM;
  return sheetChipBetweenRails(
    pane.getBoundingClientRect(),
    left.getBoundingClientRect(),
    right.getBoundingClientRect(),
    { maxWidth, clearance: FEATURE_SHEET_SIDE_GAP_PX },
  );
}
