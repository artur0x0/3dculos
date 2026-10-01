import React from 'react';
import {
  Circle,
  Square,
  Hexagon,
  Spline,
  X,
} from 'lucide-react';
import { CONTOUR_TOOLS } from '../utils/contourMode';
import {
  RAIL_PAIR_HEIGHT_CLASS,
  RAIL_PAIR_WIDTH_CLASS,
  RAIL_SCROLL_CLASS,
  RAIL_PAIR_HEIGHT_ATTR,
} from '../utils/railPair';

const ICONS = {
  circle: Circle,
  rectangle: Square,
  polygon: Hexagon,
  polyline: Spline,
};

/**
 * Slice 24 — left rail while contour mode is active.
 * Replaces the FEAT palette: contour tools + grey X dismiss (cancel, no solid commit).
 * Mobile-first: same chrome/width as HelperInsertPalette (compact on phone).
 */
const ContourModeRail = ({
  tool = 'circle',
  entry = 'crossSection',
  onSelectTool,
  onBack,
  compact = false,
}) => {
  // Same exact height as CrossSectionPanel via RAIL_PAIR_HEIGHT_CLASS.
  const iconSize = 20;
  const pad = 'p-2';
  const workplaneOnly = entry === 'workplane';

  return (
    <div
      className={`absolute left-2 lg:left-4 bottom-2.5 z-10 flex flex-col gap-1
        bg-white/60 backdrop-blur-sm rounded-lg shadow-lg
        ${RAIL_PAIR_WIDTH_CLASS} ${RAIL_PAIR_HEIGHT_CLASS} ${RAIL_SCROLL_CLASS}
        p-2`}
      role="group"
      aria-label={workplaneOnly ? 'Workplane tools' : 'Contour tools'}
      data-rail-pair="left"
      data-rail-height={RAIL_PAIR_HEIGHT_ATTR}
    >
      <div
        className={`text-[9px] font-semibold uppercase tracking-wide text-cyan-800 px-1 truncate ${
          compact ? 'leading-3' : 'leading-4'
        }`}
      >
        {workplaneOnly ? 'Plane' : 'Contour'}
      </div>
      {!workplaneOnly && CONTOUR_TOOLS.map((item) => {
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
      {!workplaneOnly && (
        <div className="border-t border-gray-300/70 my-0.5 mx-0.5" aria-hidden />
      )}
      <button
        type="button"
        onClick={() => onBack?.()}
        title={workplaneOnly
          ? 'Dismiss — exit workplane mode without writing'
          : 'Dismiss — exit contour mode (no additional solid write)'}
        aria-label={workplaneOnly
          ? 'Dismiss workplane mode without committing'
          : 'Dismiss contour mode without committing a solid'}
        className={`${pad} rounded text-gray-700 hover:bg-gray-200 active:bg-gray-300
          flex items-center justify-center transition-colors`}
      >
        <X size={iconSize} strokeWidth={2} />
      </button>
    </div>
  );
};

export default ContourModeRail;
