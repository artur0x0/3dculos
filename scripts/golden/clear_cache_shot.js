/**
 * Clear-local-cache confirm popup, for the golden screenshots.
 * The page supplies the width. The warning is the unpushed-outbox + unsynced-part case.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import ClearCacheDialog from '../../src/components/ClearCacheDialog.jsx';

export function renderClearCacheDialog(el) {
  createRoot(el).render(React.createElement(
    'div',
    {
      'data-clear-cache-shot': '',
      style: {
        position: 'relative',
        width: '100%',
        height: '100vh',
        background: '#1e1e1e',
        overflow: 'hidden',
      },
    },
    React.createElement(ClearCacheDialog, {
      open: true,
      outbox: 2,
      unsynced: 1,
      offerPush: true,
      busy: false,
      error: '',
      onCancel: () => {},
      onConfirm: () => {},
      onPushFirst: () => {},
    }),
  ));
}
