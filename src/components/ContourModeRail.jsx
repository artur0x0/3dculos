import React from 'react';
import {
  Circle,
  Square,
  Hexagon,
  Spline,
  ArrowLeft,
} from 'lucide-react';
import { CONTOUR_TOOLS } from '../utils/contourMode';

const ICONS = {
  circle: Circle,
  rectangle: Square,
  polygon: Hexagon,
  polyline: Spline,
};

/**
 * Slice 24 — left rail while contour mode is active.
 * Replaces the FEAT palette: contour tools + Back (cancel, no solid commit).
 * Mobile-first: same chrome as HelperInsertPalette (compact on phone).
 */
const ContourModeRail = ({
  tool = 'circle',
  onSelectTool,
  onBack,
  compact = false,
}) => {
  // Both viewport rails (this one and CrossSectionPanel) share one size so they
  // read as a matched pair — the larger of the two former sizes, phone included.
  const iconSize = 20;
  const pad = 'p-2';

  return (
    <div
      className={`absolute left-2 lg:left-4 bottom-4 z-10 flex flex-col gap-1
        bg-white/60 backdrop-blur-sm rounded-lg shadow-lg
        max-h-[min(72%,calc(100%-5.5rem))] overflow-y-auto overflow-x-hidden
        p-2`}
      role="group"
      aria-label="Contour tools"
    >
      <div
        className={`text-[9px] font-semibold uppercase tracking-wide text-cyan-800 px-1 ${
          compact ? 'leading-3' : 'leading-4'
        }`}
      >
        Contour
      </div>
      {CONTOUR_TOOLS.map((item) => {
        const Icon = ICONS[item.id] || Circle;
        const active = tool === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectTool?.(item.id)}
            title={item.title}
            aria-label={item.title}
            aria-pressed={active}
            className={`${pad} rounded flex items-center justify-center transition-colors
              ${active
                ? 'bg-cyan-200 text-cyan-900'
                : 'text-cyan-800 hover:bg-cyan-100 active:bg-cyan-200'}`}
          >
            <Icon size={iconSize} strokeWidth={2} />
          </button>
        );
      })}
      <div className="border-t border-gray-300/70 my-0.5 mx-0.5" aria-hidden />
      <button
        type="button"
        onClick={() => onBack?.()}
        title="Back — exit contour mode (no additional solid write)"
        aria-label="Back — exit contour mode without committing a solid"
        className={`${pad} rounded text-gray-700 hover:bg-gray-200 active:bg-gray-300
          flex items-center justify-center transition-colors`}
      >
        <ArrowLeft size={iconSize} strokeWidth={2} />
      </button>
    </div>
  );
};

export default ContourModeRail;
