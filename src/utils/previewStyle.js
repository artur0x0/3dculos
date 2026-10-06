/**
 * previewStyle — one recipe for every in-viewport preview skin and outline.
 *
 * Every contour-mode preview (Extrude / Revolve / Loft / Sweep), the Block
 * solid preview (Add and Subtract) and the fillet blend preview paint the
 * same way, so a preview always reads as "not committed
 * geometry yet" no matter which tool drew it:
 *
 *   skin    unlit translucent cyan, both sides, no depth write
 *   outline brighter cyan line, drawn on top (depthTest off)
 *
 * **Unlit is the whole point.** A lit material (MeshLambert/MeshStandard) takes
 * the scene lights, so a preview face pointing away from them goes dark and
 * muddy — which is exactly how the Extrude preview used to look next to Loft's.
 * MeshBasicMaterial ignores lighting, so the colour on screen is the colour
 * here, at every orientation. Add a preview → use these factories, don't
 * hand-roll a material.
 */
import { MeshBasicMaterial, LineBasicMaterial, DoubleSide } from 'three';

/** Cyan for geometry a Confirm would create; amber for a blend/cut preview. */
export const PREVIEW_COLORS = {
  skin: 0x22d3ee,      // cyan-400
  outline: 0x67e8f9,   // cyan-300 — reads as a highlight over the skin
  blendSkin: 0xfbbf24, // amber-400, fillet blend only
  blendOutline: 0xfcd34d,
  selected: 0xf59e0b, // amber-500 — the active construction plane
};

/** Translucent surface. `ghost` is the fainter pass used behind a sweep. */
export const PREVIEW_OPACITY = { skin: 0.38, outline: 0.95, ghost: 0.18, selected: 0.32 };

/**
 * Unlit preview surface. Never swap this for a lit material — see the note above.
 */
export function makePreviewSkinMaterial({
  color = PREVIEW_COLORS.skin,
  opacity = PREVIEW_OPACITY.skin,
} = {}) {
  return new MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: DoubleSide,
  });
}

/**
 * Block pop preview skin (Add and Subtract): the same cyan skin as Loft.
 * Subtract also skips the depth test, so a cutter buried in the host still
 * shows through it. Add keeps the depth test, like the contour previews.
 */
export function makeBlockPreviewSkinMaterial({ subtract = false } = {}) {
  const mat = makePreviewSkinMaterial();
  if (subtract) mat.depthTest = false;
  return mat;
}

/** Crease angle (deg) for the Block preview outline: box / prism edges, not the facets of a sphere. */
export const BLOCK_PREVIEW_EDGE_ANGLE = 20;

/** Profile/station outline. Drawn over the skin, so depthTest stays off. */
export function makePreviewOutlineMaterial({
  color = PREVIEW_COLORS.outline,
  opacity = PREVIEW_OPACITY.outline,
} = {}) {
  return new LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
  });
}

/** Shared render order: skin under, outline over. */
export const PREVIEW_RENDER_ORDER = { skin: 8, outline: 11 };
