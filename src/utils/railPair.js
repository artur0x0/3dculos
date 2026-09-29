/**
 * Left + right CAD viewport rails share one height so they match pixel-perfect
 * (not max-h approximate). Both use `h-[…]` against the same containing block.
 */
export const RAIL_PAIR_HEIGHT_CLASS =
  'h-[min(26rem,calc(100%-5.5rem))] overflow-y-auto overflow-x-hidden rail-scroll';

/** data-rail-height value goldens / playtest assert. */
export const RAIL_PAIR_HEIGHT_ATTR = 'paired';
