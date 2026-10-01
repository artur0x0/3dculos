import React, { useMemo } from 'react';
import {
  ArrowUpFromLine,
  Rotate3d,
  Pyramid,
  Route,
  NotebookPen,
  TriangleRight,
  Box,
  Cylinder,
  Circle,
  Torus,
  Hexagon,
  Squircle,
  Drill,
  Grid3x3,
  Bolt,
  Cone,
  PackageOpen,
  Focus,
  AlignVerticalJustifyCenter,
  FlipHorizontal2,
  Boxes,
} from 'lucide-react';
import SquareRoundCorner from './icons/SquareRoundCorner';
import Angle from './icons/Angle';
import { parseFeatureMarkers } from '../utils/featureMarkers';

/**
 * Slice Mobile B.1 → C.2 — feature strip.
 *
 * C.2:
 *   - CAD: horizontal left-to-right under the top ribbon.
 *   - Script: vertical on the right, starting below the ribbon (no overlap).
 *
 * Icons match CAD toolbar tools. Per-type index badges (C.1). Script: jump
 * caret. CAD: open feature sheet.
 *
 * Slice A: strip covers every left-rail insertable that creates a feature
 * (Block / Model / Polish / Move), not only Contour/Fillet markers.
 */

/** Same glyphs as HelperInsertPalette for every left-rail insertable. */
const FEATURE_ICONS = Object.freeze({
  profile: NotebookPen,       // Create contour / crossSection
  extrude: ArrowUpFromLine,   // makeExtrude
  revolve: Rotate3d,          // makeRevolve
  loft: Pyramid,              // makeLoft
  sweep: Route,               // makeSweep
  fillet: SquareRoundCorner,  // filletEdges
  chamfer: TriangleRight,     // chamferEdges
  cube: Box,
  roundedBox: Squircle,
  cylinder: Cylinder,
  sphere: Circle,
  tube: Torus,
  hexPrism: Hexagon,
  hole: Drill,
  holePattern: Grid3x3,
  clearanceHole: Bolt,
  tapDrillHole: Drill,
  cboreHole: Cylinder,
  cskHole: Cone,
  shell: PackageOpen,
  draft: Angle,
  center: Focus,
  align: AlignVerticalJustifyCenter,
  mirror: FlipHorizontal2,
  array: Boxes,
  polarArray: Boxes,
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

export default function FeatureStrip({
  script = '',
  activeId = null,
  onJump,
  hideWhenEmpty = false,
  /** 'vertical' (Script right rail) | 'horizontal' (CAD under-ribbon). */
  orientation = 'vertical',
}) {
  const features = useMemo(() => parseFeatureMarkers(script), [script]);
  const horizontal = orientation === 'horizontal';

  if (features.length === 0) {
    if (hideWhenEmpty) return null;
    if (horizontal) {
      return (
        <div
          className="flex flex-row items-center gap-1.5 overflow-x-auto
            border border-gray-700/40 bg-gray-900/70 surface-glass-chip
            rounded-lg px-2 py-1.5 max-w-full"
          data-feature-strip=""
          data-feature-strip-empty=""
          data-feature-strip-orientation="horizontal"
          data-feature-strip-side="top"
          title="No marked features yet"
        >
          <div className="text-[9px] text-gray-400 font-sans whitespace-nowrap px-1">
            No features
          </div>
        </div>
      );
    }
    return (
      <div
        className="shrink-0 flex flex-col items-center justify-start gap-1
          border-l border-gray-700/40 bg-gray-900/70 surface-glass-chip
          px-1.5 py-2 w-11 flex-1 min-h-0
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

  if (horizontal) {
    return (
      <div
        className="flex flex-row items-center gap-1.5 overflow-x-auto no-scrollbar
          border border-gray-700/40 bg-gray-900/70 surface-glass-chip
          rounded-lg px-2 py-1.5 max-w-full"
        data-feature-strip=""
        data-feature-strip-orientation="horizontal"
        data-feature-strip-side="top"
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

  return (
    <div
      className="shrink-0 flex flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden
        border-l border-gray-700/40 bg-gray-900/70 surface-glass-chip
        px-1.5 pt-2 w-11 no-scrollbar flex-1 min-h-0
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
