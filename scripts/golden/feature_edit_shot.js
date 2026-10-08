/**
 * Dark-theme shots of a fillet feature before edit and while the creation
 * dialog is open with the stored edge highlighted.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Viewport from '../../src/components/Viewport.jsx';
import FeatureStrip from '../../src/components/FeatureStrip.jsx';
import { AuthProvider } from '../../src/hooks/useAuth.jsx';
import { parseFeatureMarkers } from '../../src/utils/featureMarkers.js';
import manifoldContext from '../../src/utils/ManifoldWorker.js';

const SCRIPT = `let part = Manifold.cube([40, 30, 20], true);
// --- fillet-mode begin ---
const selEdges = edgesBetween(part, 0, 2); // boundary edge 1
const path = makeSweepPath(selEdges); // edge→sweep path
part = filletAlongPath(part, path, 2); // sweep fillet wedge
// --- fillet-mode end ---
return part;
`;

export function renderFeatureEditShot(el, { compact = false } = {}) {
  createRoot(el).render(
    React.createElement(AuthProvider, null, React.createElement(Shot, { compact })),
  );
}

function Shot({ compact }) {
  const viewRef = useRef(null);
  const [session, setSession] = useState(false);
  useEffect(() => {
    let stop = false;
    window.__EDIT__ = () => {
      const feature = parseFeatureMarkers(SCRIPT).find((item) => item.kind === 'fillet');
      const opened = viewRef.current?.beginFeatureEdit?.(feature, SCRIPT) === true;
      return opened;
    };
    (async () => {
      await manifoldContext.init();
      if (stop) return;
      let ran = false;
      for (let i = 0; i < 20 && !ran && !stop; i += 1) {
        ran = await viewRef.current?.executeScript?.(SCRIPT);
        if (!ran) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (stop) return;
      window.__MESH__ = !!ran;
      if (!ran) window.__MESH_ERROR__ = 'executeScript did not return a mesh';
    })().catch((err) => {
      window.__MESH_ERROR__ = err?.message || String(err);
      window.__MESH__ = false;
    });
    return () => { stop = true; };
  }, []);

  return React.createElement(
    'div',
    {
      'data-feature-edit-shot': compact ? 'mobile' : 'desktop',
      style: { position: 'relative', width: '100%', height: '100vh', background: '#1e1e1e' },
    },
    React.createElement(Viewport, {
      ref: viewRef,
      mode: 'cad',
      isMobile: compact,
      currentScript: SCRIPT,
      currentFilename: 'Part (1)',
      assemblyName: 'Bracket',
      getHelperBuffer: () => SCRIPT,
      onInsertHelper: () => {},
      onFeatureSessionChange: setSession,
      canUndo: true,
      canRedo: false,
    }),
    session ? null : React.createElement(
      'div',
      {
        'data-shot-feature-row': '1',
        style: { position: 'absolute', left: 0, right: 0, top: compact ? 56 : 56, zIndex: 15 },
      },
      React.createElement(FeatureStrip, {
        orientation: 'horizontal',
        side: 'top',
        script: SCRIPT,
        activeId: null,
        onJump: () => window.__EDIT__?.(),
        onUndo: () => {},
        onRedo: () => {},
        canUndo: true,
        canRedo: false,
      }),
    ),
  );
}
