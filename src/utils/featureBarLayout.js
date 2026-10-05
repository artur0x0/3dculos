/**
 * Mobile feature-bar window.
 *
 * `fit` — every chip fits in the middle section, so the row is centered.
 * `tail` — the list overflows, so the visible window is the end of the list
 * (the latest features). Earlier chips sit outside that window.
 *
 * A 1px slop avoids flipping on subpixel rounding.
 */
export function featureBarWindowMode(contentWidth, viewportWidth) {
  const content = Number(contentWidth);
  const viewport = Number(viewportWidth);
  if (!Number.isFinite(content) || !Number.isFinite(viewport) || viewport <= 0) {
    return 'fit';
  }
  return content - viewport > 1 ? 'tail' : 'fit';
}
