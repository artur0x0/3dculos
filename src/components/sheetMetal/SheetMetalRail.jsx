import React from 'react';
import { Circle, Cone, Drill, FoldVertical, PanelTop, X } from 'lucide-react';
import {
  RAIL_PAIR_HEIGHT_CLASS,
  RAIL_SCROLL_CLASS,
  RAIL_PAIR_HEIGHT_ATTR,
  useLeftRailFit,
} from '../../utils/railPair';

/**
 * Left rail while sheet-metal mode is active (swaps out the FEAT palette,
 * like ContourModeRail for loft/sweep). ✕ leaves the flow without writing.
 */
const TOOL_ICONS = { tab: PanelTop, bend: FoldVertical, hole: Circle, countersink: Cone, tapped: Drill };

/**
 * tools = sheetToolsFor(spec): only features SendCutSend makes on this SKU,
 * Tab first. Empty before the base flange exists.
 */
const SheetMetalRail = ({ onExit, tools = [], tool = null, onSelectTool, children }) => {
  const { railRef, fits, widthClass } = useLeftRailFit();
  return (
    <div
      ref={railRef}
      className={`absolute left-2 lg:left-4 bottom-2.5 z-10 flex flex-col gap-1
        bg-white/60 backdrop-blur-sm rounded-lg shadow-lg
        ${widthClass} ${RAIL_PAIR_HEIGHT_CLASS} ${RAIL_SCROLL_CLASS} p-2`}
      role="group"
      aria-label="Sheet metal tools"
      data-rail-pair="left"
      data-rail-height={RAIL_PAIR_HEIGHT_ATTR}
      data-rail-fit={fits ? 'fits' : 'scroll'}
      data-sheet-metal-rail="1"
    >
      <div className="text-[9px] font-semibold uppercase tracking-wide text-orange-700 px-1 truncate leading-4">
        Sheet
      </div>
      {tools.map((item) => {
        const Icon = TOOL_ICONS[item.id] || Circle;
        const active = tool === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectTool?.(item.id)}
            title={item.title}
            aria-label={item.title}
            aria-pressed={active}
            data-sheet-tool={item.id}
            className={`p-2 min-h-[44px] rounded flex flex-col items-center justify-center gap-0.5 transition-colors
              ${active ? 'bg-orange-200 text-orange-900' : 'text-orange-800 hover:bg-orange-100 active:bg-orange-200'}`}
          >
            <Icon size={20} strokeWidth={2} />
            <span className="text-[9px] font-semibold leading-none">{item.label}</span>
          </button>
        );
      })}
      {children}
      <div className="border-t border-gray-300/70 my-0.5 mx-0.5" aria-hidden />
      <button
        type="button"
        onClick={() => onExit?.()}
        title="Exit sheet metal"
        aria-label="Exit sheet metal mode"
        className="p-2 min-h-[44px] rounded text-gray-700 hover:bg-gray-200 active:bg-gray-300 flex items-center justify-center"
      >
        <X size={20} strokeWidth={2} />
      </button>
    </div>
  );
};

export default SheetMetalRail;
