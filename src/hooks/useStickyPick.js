import { useCallback, useState } from 'react';
import { stickyPickRemove, stickyPickToggle } from '../utils/stickyPick';

/**
 * Pick list for a card that owns it. Joints should use this: tap a face
 * or a point, then apply a property through `StickyPickApply`. Contour
 * mode does not use the hook. Its canvas and its card share
 * `contourMode.picks` and call `stickyPickToggle` on that list.
 */
export function useStickyPick({ max = 2 } = {}) {
  const [picks, setPicks] = useState([]);
  const toggle = useCallback((item) => {
    setPicks((prev) => stickyPickToggle(prev, item, max));
  }, [max]);
  const remove = useCallback((item) => {
    setPicks((prev) => stickyPickRemove(prev, item));
  }, []);
  const clear = useCallback(() => setPicks([]), []);
  return { picks, toggle, remove, clear, setPicks, max };
}
