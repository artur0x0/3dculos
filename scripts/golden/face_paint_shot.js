/**
 * Paint chip and open popup, for the face-paint golden.
 * The page supplies the ground (dark viewport or light) and the width.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PAINT_SWATCHES } from '../../src/utils/facePaint.js';
import { PaintModeChip, PaintModeToggle } from '../../src/components/PaintModeChip.jsx';

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
    React.createElement(PaintModeToggle, { pressed: true, onToggle: () => {} }),
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
