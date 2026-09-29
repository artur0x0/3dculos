#!/usr/bin/env node
/**
 * UI polish: distinct selector icons, one orientation menu, quieter edge chip,
 * and a desktop that matches the phone shell.
 *
 * - Face / Plane / Sketch each own one icon: skinny rectangle, three planes,
 *   pencil-and-paper. No icon does double duty inside the right rail.
 * - Iso lives inside the view-snap popup; the trigger is a pure toggle and turns
 *   into an arrow pointing at the menu it just unfurled.
 * - The standalone edge chip waits for a real selection.
 * - CAD chrome is the editor mid-strip in BOTH shells, both viewport rails are
 *   vertical, and the two rails share one size — the larger of the old two.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('ui polish: icons, view snaps, edge chip, desktop shell');

const panel = read('../../src/components/CrossSectionPanel.jsx');
const snap = read('../../src/components/ViewSnapControl.jsx');
const view = read('../../src/components/Viewport.jsx');
const editor = read('../../src/components/CodeEditor.jsx');
const toolbar = read('../../src/components/Toolbar.jsx');
const palette = read('../../src/components/HelperInsertPalette.jsx');
const contourRail = read('../../src/components/ContourModeRail.jsx');

// ── AC1: one icon per selector, no duplicates in the rail ──
{
  check(
    'face pick uses the skinny rectangle',
    /aria-label="Face pick mode"[\s\S]{0,300}?<RectangleHorizontal size=\{20\} \/>/.test(panel),
  );
  check(
    'plane display uses the three-planes icon',
    /data-overlay-toggle="plane"[\s\S]{0,80}?<Layers3 size=\{20\} \/>/.test(panel),
  );
  check(
    'sketch display uses the pencil-and-paper icon',
    /data-overlay-toggle="contour"[\s\S]{0,80}?<NotebookPen size=\{20\} \/>/.test(panel),
  );
  check(
    'the retired duplicates are gone from the rail',
    !/BoxSelect/.test(panel) && !/SquareDashed/.test(panel),
  );
  // Every <Icon size={20} /> in the collapsed rail must be a different glyph.
  const railStart = panel.indexOf('if (isCollapsed || !enabled)');
  const railEnd = panel.indexOf('bg-white/50 backdrop-blur-sm rounded-lg shadow-lg p-3');
  const rail = panel.slice(railStart, railEnd > railStart ? railEnd : undefined);
  const glyphs = [...rail.matchAll(/<([A-Z][A-Za-z0-9]*) size=\{20\} \/>/g)].map((m) => m[1]);
  check(
    'no icon is used twice in the right rail',
    glyphs.length > 6 && new Set(glyphs).size === glyphs.length,
    glyphs.join(','),
  );
}

// ── AC2: iso moved into the popup; trigger became a labelled toggle ──
{
  check("iso is one of the popup's views", /key: 'iso'/.test(snap));
  check(
    "iso is not the trigger's hidden second tap",
    !/onSnap\?\.\('iso'\)/.test(snap),
  );
  check(
    'the trigger only opens and closes the menu',
    /onClick=\{\(\) => setOpen\(\(v\) => !v\)\}/.test(snap),
  );
  check(
    'the trigger becomes an arrow toward the open menu',
    /open \? <ArrowLeft size=\{20\} \/> : <Box size=\{20\} \/>/.test(snap),
  );
  check(
    'the popup unfurls leftwards, so the arrow points at it',
    /absolute right-full/.test(snap) && !/bottom-full/.test(snap),
  );
  check(
    'the leftwards popup is centred on its trigger',
    /top-1\/2 -translate-y-1\/2/.test(snap),
  );
  check('popup is addressable from tests', /data-view-snap-popup/.test(snap));
}

// ── AC3: edge chip needs a real selection ──
{
  check(
    'standalone edge chip requires at least one selected edge',
    /pickMode === 'edge' && !contourMode && !filletMode && selectedEdges\.length > 0 && \(/.test(view),
  );
  check('edge chip keeps its test hook', /data-edge-selector="standalone"/.test(view));
}

// ── AC4: desktop shell matches the phone shell ──
{
  check('no CAD overlay toolbar survives', !/variant="overlay"/.test(view));
  check('Toolbar has no collapse state left', !/isCollapsed/.test(toolbar));
  check(
    'CAD strip is portaled in both shells',
    /mode !== 'game' && cadToolbarHost && createPortal\(/.test(view),
  );
  check(
    'editor hosts the strip in both shells',
    /showCadStrip = !isGame && typeof onCadToolbarHost === 'function'/.test(editor),
  );
  check('right rail is vertical unconditionally', /\n\s+verticalRail\n/.test(view));
  check(
    'bottom-left readouts clear the wider left rail',
    !/left-16 lg:left-\[4\.75rem\]/.test(view)
      && /left-\[4\.5rem\] lg:left-\[5\.25rem\]/.test(view),
  );
}

// ── AC5: both viewport rails are one size, the larger one ──
{
  for (const [name, src] of [['helper rail', palette], ['contour rail', contourRail]]) {
    check(`${name} icon size matches the right rail (20)`, /const iconSize = 20;/.test(src));
    check(`${name} button padding matches the right rail (p-2)`, /const pad = 'p-2';/.test(src));
    check(`${name} shell padding matches the right rail (p-2)`, /\n\s+p-2`\}/.test(src));
    check(
      `${name} no longer shrinks on phones`,
      !/compact \? 'p-1/.test(src) && !/compact \? 16/.test(src),
    );
  }
  check(
    'right rail is still the 20px / p-2 reference the others copy',
    /size=\{20\}/.test(panel) && /p-2 rounded/.test(panel),
  );
}

// ── AC6: loft reads as a pyramid, and the left rail's scrollbar is rounded ──
{
  const css = read('../../src/index.css');
  check('loft uses the pyramid glyph', /makeLoft: Pyramid,/.test(palette));
  const filletIcon = read('../../src/components/icons/SquareRoundCorner.jsx');
  check('fillet uses the one-rounded-corner square', /filletEdges: SquareRoundCorner,/.test(palette));
  check(
    'the vendored fillet glyph carries lucide\'s own paths',
    /M21 11a8 8 0 0 0-8-8/.test(filletIcon)
      && /M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4/.test(filletIcon),
  );
  check('the vendored glyph takes lucide\'s size prop', /size = 24/.test(filletIcon));
  check('the retired stacked-layers glyph is gone', !/\bLayers\b/.test(palette));
  check(
    'Pyramid is imported and used once in the helper rail',
    (palette.match(/\bPyramid\b/g) || []).length === 2,
  );
  for (const [name, src] of [['helper rail', palette], ['contour rail', contourRail]]) {
    check(`${name} scroll gutter is the rounded one`, /overflow-y-auto overflow-x-hidden rail-scroll/.test(src));
  }
  check('rail-scroll gives the thumb a pill radius', /\.rail-scroll::-webkit-scrollbar-thumb[\s\S]{0,200}?border-radius: 9999px/.test(css));
  check('rail-scroll leaves the track transparent', /\.rail-scroll::-webkit-scrollbar-track[\s\S]{0,160}?background: transparent/.test(css));
  check('rail-scroll covers Firefox too', /\.rail-scroll \{[\s\S]{0,160}?scrollbar-width: thin/.test(css));
}

// ── AC7: one preview aesthetic, and it is unlit ──
{
  const style = read('../../src/utils/previewStyle.js');
  check('there is a shared preview recipe', /makePreviewSkinMaterial/.test(style)
    && /makePreviewOutlineMaterial/.test(style));
  check('the shared skin is unlit', /new MeshBasicMaterial\(/.test(style)
    && !/MeshLambertMaterial|MeshStandardMaterial|MeshPhongMaterial/.test(style));
  // The darkness bug: Extrude was the one preview painted with a lit material.
  const paints = view.slice(
    view.indexOf('const paintExtrudePreview'),
    view.indexOf('const clearFilletBlendPreview'),
  );
  check(
    'no preview paints with a lit material any more',
    !/MeshLambertMaterial|MeshStandardMaterial|MeshPhongMaterial/.test(paints),
  );
  // Skins are the DoubleSide translucent surfaces; point/marker materials are
  // a different thing and keep their own definitions.
  const handRolledSkin = /new MeshBasicMaterial\(\{[^}]*side: DoubleSide/.test(paints);
  check('no preview hand-rolls its own skin material', !handRolledSkin);
  for (const paint of ['Extrude', 'Revolve', 'Loft', 'Sweep']) {
    const body = paints.slice(paints.indexOf(`const paint${paint}Preview`));
    check(`${paint} preview uses the shared skin`, /makePreviewSkinMaterial\(/.test(
      body.slice(0, body.indexOf('const clear') > 0 ? body.indexOf('const clear') : undefined),
    ));
  }
  check('Extrude gained Loft-style outline rings', /Start and end loops/.test(paints)
    && /makePreviewOutlineMaterial\(/.test(paints));
}

// ── AC8: the param popup docks bottom-centre of the viewport, click-through ──
{
  const modal = read('../../src/components/HelperParamModal.jsx');
  check(
    'popup is positioned against the viewport, not the screen',
    /absolute inset-0 z-50 flex items-end justify-center/.test(modal)
      && !/fixed inset-0/.test(modal),
  );
  check('popup sits bottom-centre', !/sm:items-center/.test(modal));
  check('no dimming scrim over the viewport', !/bg-black\/\d+/.test(modal));
  check('overlay is click-through, panel is not', /pointer-events-none/.test(modal)
    && (modal.match(/pointer-events-auto/g) || []).length === 2);
  check(
    'the dead click-outside handler is gone with the scrim',
    !/onMouseDown/.test(modal),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll UI polish checks passed.');
