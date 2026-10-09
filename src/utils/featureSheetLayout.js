// Width of the feature card: the measured gap between the side rails,
// the same helper the sheet-metal chip uses, with a 10px side gap and
// a 22rem cap. Before the first measure, CSS uses the fallback width.
import { sheetChipBetweenRails } from './sheetMetal/sheetChipLayout.js';

export const FEATURE_SHEET_MAX_REM = 22;
export const FEATURE_SHEET_SIDE_GAP_PX = 10;

/** Phone: 10px above the 30px home pill, including its safe-area padding. */
export const FEATURE_SHEET_BOTTOM_PHONE =
  'calc(30px + max(8px, env(safe-area-inset-bottom, 0px)) + 10px)';

/** Desktop: no pill. 10px, or the safe area when that is larger. */
export const FEATURE_SHEET_BOTTOM_DESKTOP =
  'max(10px, env(safe-area-inset-bottom, 0px))';

export function featureSheetBottom(compact) {
  return compact ? FEATURE_SHEET_BOTTOM_PHONE : FEATURE_SHEET_BOTTOM_DESKTOP;
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
