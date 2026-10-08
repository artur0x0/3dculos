/**
 * Paint button on the right rail, the open popup, and the feature-strip
 * count badges. The page supplies the ground (dark viewport or light) and
 * the width. compact matches the phone popup and the under-ribbon strip.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PAINT_SWATCHES } from '../../src/utils/facePaint.js';
import { PaintModeChip } from '../../src/components/PaintModeChip.jsx';
import CrossSectionPanel from '../../src/components/CrossSectionPanel.jsx';
import FeatureStrip from '../../src/components/FeatureStrip.jsx';

const CUBES = [1, 2, 3, 4]
  .map(() => '// --- cube begin ---\nlet part = 1;\n// --- cube end ---')
  .join('\n');

export function renderPaintChrome(el, { theme = 'dark', compact = false } = {}) {
  const bg = theme === 'light' ? '#f4f4f5' : '#1e1e1e';
  createRoot(el).render(React.createElement(
    'div',
    {
      'data-paint-shot': theme,
      'data-paint-shot-compact': compact ? '1' : '0',
      style: {
        position: 'relative',
        width: '100%',
        height: '100vh',
        background: bg,
        overflow: 'hidden',
      },
    },
    React.createElement('div', {
      'data-profile-standin': '1',
      'aria-hidden': 'true',
      style: {
        position: 'absolute',
        top: 16,
        right: 16,
        width: 36,
        height: 36,
        borderRadius: 9999,
        background: 'rgba(17,24,39,0.55)',
        border: '1px solid rgba(255,255,255,0.2)',
      },
    }),
    React.createElement(
      'div',
      {
        'data-shot-feature-row': '1',
        style: { position: 'absolute', left: 0, right: 0, top: compact ? 80 : 56 },
      },
      React.createElement(FeatureStrip, {
        orientation: 'horizontal',
        script: CUBES,
        onUndo: () => {},
        onRedo: () => {},
        canUndo: true,
        canRedo: true,
      }),
    ),
    React.createElement(CrossSectionPanel, {
      verticalRail: true,
      showPaint: true,
      paintActive: true,
      onPaintToggle: () => {},
      onOpenSheetMetal: () => {},
      sheetMetalActive: false,
      onPickModeChange: () => {},
      onZoomToFit: () => {},
      onSnapView: () => {},
    }),
    React.createElement(PaintModeChip, {
      compact,
      faceCount: 2,
      color: PAINT_SWATCHES[0],
      custom: '',
      part: false,
      canUndo: true,
      canClear: true,
      canConfirm: true,
      unmatched: 1,
      onSwatch: () => {},
      onCustom: () => {},
      onPart: () => {},
      onUndo: () => {},
      onClear: () => {},
      onConfirm: () => {},
      onDismiss: () => {},
      onRemoveUnmatched: () => {},
    }),
  ));
}
