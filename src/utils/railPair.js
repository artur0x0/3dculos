/**
 * Left CAD viewport rails (helper palette + contour mode) share one max-height
 * so they stop just below the part-name title chip. Height is **content-sized**
 * (`max-h` only): the rail is only as tall as its buttons need, and yields the
 * rest of the viewport. When the window is too short, the rail scrolls.
 *
 * **Height and scrolling are separate on purpose.** They used to be one class,
 * which made the RIGHT rail a scroll container too — and that broke two things
 * at once: it grew a scrollbar it never needed, and, because the view-snap
 * flyout is positioned OUTSIDE the rail box (`absolute right-full`), the
 * overflow clipped the flyout away entirely. Only rails that actually overflow
 * (the left tool palettes) may take RAIL_SCROLL_CLASS; the right rail stays
 * `overflow-visible` so the flyout can escape.
 */
import { useLayoutEffect, useRef, useState } from 'react';

/** Cap: up to just below the part-name chip; content shorter → rail shrinks. */
export const RAIL_PAIR_HEIGHT_CLASS = 'max-h-[min(26rem,calc(100%-5.5rem))]';

/**
 * Desktop left rail: full length instead of a 26rem block floating at the
 * bottom. Anchored top AND bottom, so the height is whatever is left between
 * them — it stops just under the part-name chip (which sits at top-4 and is
 * ~30px tall) and 10px off the bottom edge, matching the other viewport
 * chrome. Phones keep RAIL_PAIR_HEIGHT_CLASS: there the viewport is short and
 * a full-length rail would swallow the model.
 */
export const RAIL_FULL_LENGTH_CLASS = 'top-14 bottom-2.5';

/**
 * Left rails share one width so ContourModeRail matches HelperInsertPalette
 * (the Contour caption is longer than Block/Model/Polish/Move and used to
 * widen the contour rail past the parent). When buttons fit without scroll,
 * use the slightly narrower FIT width to yield space back to the viewport.
 */
export const RAIL_PAIR_WIDTH_CLASS = 'w-16';
export const RAIL_PAIR_WIDTH_FIT_CLASS = 'w-14';

/** Left rails only — they hold the whole tool list and genuinely overflow. */
export const RAIL_SCROLL_CLASS = 'overflow-y-auto overflow-x-hidden rail-scroll';

/** Right rail: same height, but nothing may clip the view-snap flyout. */
export const RAIL_NO_CLIP_CLASS = 'overflow-visible';

/** data-rail-height value goldens / playtest assert (content-sized max-h). */
export const RAIL_PAIR_HEIGHT_ATTR = 'content-max';

/**
 * Measure whether a left rail's buttons fit inside its max-height box.
 * When they fit (no scroll), return the narrower FIT width class.
 */
export function useLeftRailFit() {
  const railRef = useRef(null);
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return undefined;
    const sync = () => {
      setFits(el.scrollHeight <= el.clientHeight + 1);
    };
    sync();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync);
      return () => window.removeEventListener('resize', sync);
    }
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return {
    railRef,
    fits,
    widthClass: fits ? RAIL_PAIR_WIDTH_FIT_CLASS : RAIL_PAIR_WIDTH_CLASS,
  };
}
