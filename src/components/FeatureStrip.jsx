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
 * Slice Mobile B.1 → C.1 — feature strip (vertical + toolbar icons + per-type badges).
 *
 * Vertical rail of icon chips over marked Contour / Extrude / Fillet / …
 * blocks. Icons match the CAD toolbar tools. C.1: per-type index badges
 * (1, 2, 3… per icon kind) bottom-right; strip mounts on the **right**,
 * starting below the top ribbon. Script: jump caret. CAD: open feature sheet.
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

function TypeBadge({ index }) {
  if (!index) return null;
  return (
    <span
      className="absolute -bottom-0.5 -right-0.5 min-w-[0.85rem] h-[0.85rem] px-0.5
        rounded-full bg-cyan-500 text-[8px] leading-[0.85rem] text-center
        font-bold text-white pointer-events-none shadow"
      data-feature-type-badge={index}
      aria-hidden="true"
    >
      {index}
    </span>
  );
}

export default function FeatureStrip({ script = '', activeId = null, onJump, hideWhenEmpty = false }) {
  const features = useMemo(() => parseFeatureMarkers(script), [script]);

  if (features.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <div
        className="shrink-0 flex flex-col items-center justify-start gap-1
          border-l border-gray-700/40 bg-gray-900/70 surface-glass-chip
          px-1.5 py-2 w-11
          pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
        data-feature-strip=""
        data-feature-strip-empty=""
        data-feature-strip-orientation="vertical"
        data-feature-strip-side="right"
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
        border-l border-gray-700/40 bg-gray-900/70 surface-glass-chip
        px-1.5 pt-2 w-11 no-scrollbar
        pb-[max(3.5rem,calc(env(safe-area-inset-bottom,0px)+3.25rem))]"
      data-feature-strip=""
      data-feature-strip-orientation="vertical"
      data-feature-strip-side="right"
      role="navigation"
      aria-label="Modeling features"
    >
      {features.map((f) => {
        const active = activeId === f.id;
        const Icon = FEATURE_ICONS[f.kind] || NotebookPen;
        const typeIndex = f.typeIndex || 1;
        return (
          <button
            key={f.id}
            type="button"
            data-feature-chip={f.kind}
            data-feature-id={f.id}
            data-feature-type-index={typeIndex}
            aria-pressed={active}
            aria-label={f.chipLabel}
            title={f.chipLabel}
            onClick={() => onJump?.(f)}
            className={`relative shrink-0 rounded-lg p-1.5 flex items-center justify-center
              border transition-colors active:opacity-80 ${
              active
                ? 'bg-cyan-600 text-white border-cyan-400/70 shadow'
                : 'bg-gray-800/70 text-gray-200 border-gray-500/40 hover:text-white'
            }`}
          >
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
            <TypeBadge index={typeIndex} />
          </button>
        );
      })}
    </div>
  );
}
