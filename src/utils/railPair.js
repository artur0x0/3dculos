/**
 * Left + right CAD viewport rails share one height so they match pixel-perfect
 * (not max-h approximate). Both use `h-[…]` against the same containing block.
 *
 * **Height and scrolling are separate on purpose.** They used to be one class,
 * which made the RIGHT rail a scroll container too — and that broke two things
 * at once: it grew a scrollbar it never needed, and, because the view-snap
 * flyout is positioned OUTSIDE the rail box (`absolute right-full`), the
 * overflow clipped the flyout away entirely. Only rails that actually overflow
 * (the left tool palettes) may take RAIL_SCROLL_CLASS; the right rail stays
 * `overflow-visible` so the flyout can escape.
 */
export const RAIL_PAIR_HEIGHT_CLASS = 'h-[min(26rem,calc(100%-5.5rem))]';

/** Left rails only — they hold the whole tool list and genuinely overflow. */
export const RAIL_SCROLL_CLASS = 'overflow-y-auto overflow-x-hidden rail-scroll';

/** Right rail: same height, but nothing may clip the view-snap flyout. */
export const RAIL_NO_CLIP_CLASS = 'overflow-visible';

/** data-rail-height value goldens / playtest assert. */
export const RAIL_PAIR_HEIGHT_ATTR = 'paired';
