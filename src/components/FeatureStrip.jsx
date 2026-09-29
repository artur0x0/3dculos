import React, { useMemo } from 'react';
import {
  ArrowUpFromLine,
  Rotate3d,
  Pyramid,
  Route,
  NotebookPen,
  TriangleRight,
} from 'lucide-react';
import SquareRoundCorner from './icons/SquareRoundCorner';
import { parseFeatureMarkers } from '../utils/featureMarkers';

/**
 * Slice Mobile B.1 — Script-stage feature strip (vertical + toolbar icons).
 *
 * Vertical rail of icon chips over marked Contour / Extrude / Fillet / …
 * blocks. Icons match the CAD toolbar tools that create those features
 * (HelperInsertPalette). Tap jumps Monaco caret + selection to that block.
 * Progressive scrub / viewport geometry highlight remain deferred.
 *
 * Script-stage only. Desktop and CAD stage never mount this.
 */

/** Same glyphs as HelperInsertPalette for Contour/Extrude/…/Fillet/Chamfer. */
const FEATURE_ICONS = Object.freeze({
  profile: NotebookPen,       // Create contour / crossSection
  extrude: ArrowUpFromLine,   // makeExtrude
  revolve: Rotate3d,          // makeRevolve
  loft: Pyramid,              // makeLoft
  sweep: Route,               // makeSweep
  fillet: SquareRoundCorner,  // filletEdges
  chamfer: TriangleRight,     // chamferEdges
});

export default function FeatureStrip({ script = '', activeId = null, onJump, hideWhenEmpty = false }) {
  const features = useMemo(() => parseFeatureMarkers(script), [script]);

  if (features.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <div
        className="shrink-0 flex flex-col items-center justify-start gap-1
          border-r border-gray-700/40 bg-gray-900/70 surface-glass-chip
          px-1.5 py-2 w-11
          pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
        data-feature-strip=""
        data-feature-strip-empty=""
        data-feature-strip-orientation="vertical"
        title="No marked features yet"
      >
        <div
          className="text-[9px] text-gray-400 font-sans leading-tight text-center writing-mode-vertical"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          No features
        </div>
      </div>
    );
  }

  return (
    <div
      className="shrink-0 flex flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden
        border-r border-gray-700/40 bg-gray-900/70 surface-glass-chip
        px-1.5 pt-2 w-11 no-scrollbar
        pb-[max(3.5rem,calc(env(safe-area-inset-bottom,0px)+3.25rem))]"
      data-feature-strip=""
      data-feature-strip-orientation="vertical"
      role="navigation"
      aria-label="Modeling features"
    >
      {features.map((f) => {
        const active = activeId === f.id;
        const Icon = FEATURE_ICONS[f.kind] || NotebookPen;
        return (
          <button
            key={f.id}
            type="button"
            data-feature-chip={f.kind}
            data-feature-id={f.id}
            aria-pressed={active}
            aria-label={f.chipLabel}
            title={f.chipLabel}
            onClick={() => onJump?.(f)}
            className={`shrink-0 rounded-lg p-1.5 flex items-center justify-center
              border transition-colors active:opacity-80 ${
              active
                ? 'bg-cyan-600 text-white border-cyan-400/70 shadow'
                : 'bg-gray-800/70 text-gray-200 border-gray-500/40 hover:text-white'
            }`}
          >
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
