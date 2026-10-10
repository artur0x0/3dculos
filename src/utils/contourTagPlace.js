/**
 * Which perpendicular (+) tags to hide this frame.
 *
 * A plus is a 44px circle. A dimension chip is at least that wide and sits
 * on the dimension line. On a phone the plus lands on the chip, and a
 * repeated perpendicular draws a second plus on the same anchor. Hide a
 * plus that covers a dimension chip, then collapse pluses that cover a
 * plus already kept. Horizontal and vertical icons are not pluses and
 * stay tappable when they share an edge with a length.
 *
 * `items` are `{ id, plus, chip, box }` with box `{ left, top, right, bottom }`.
 * Touching edges do not count.
 */

const EDGE_SLOP = 0.5;

function overlaps(a, b) {
  return a.left < b.right - EDGE_SLOP
    && b.left < a.right - EDGE_SLOP
    && a.top < b.bottom - EDGE_SLOP
    && b.top < a.bottom - EDGE_SLOP;
}

export function plusTagsToHide(items) {
  const hide = new Set();
  const chips = [];
  const pluses = [];
  for (const item of items || []) {
    if (!item?.box || item.id == null) continue;
    if (item.plus) pluses.push(item);
    else if (item.chip) chips.push(item);
  }
  const kept = [];
  for (const plus of pluses) {
    const covered = chips.some((chip) => overlaps(plus.box, chip.box))
      || kept.some((other) => overlaps(plus.box, other.box));
    if (covered) hide.add(plus.id);
    else kept.push(plus);
  }
  return hide;
}
