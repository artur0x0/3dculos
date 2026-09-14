import React from 'react';
import {
  Box,
  Cylinder,
  Circle,
  Donut,
  Hexagon,
  Squircle,
  Radius,
  Triangle,
  CircleDot,
  Grid3x3,
  Bolt,
  Drill,
  Cone,
  BoxSelect,
  MoveVertical,
  Focus,
  AlignVerticalJustifyCenter,
  FlipHorizontal2,
  Copy,
  RotateCw,
  Frame,
  ArrowUpFromLine,
  Rotate3d,
} from 'lucide-react';
import { HELPER_PALETTE_GROUPS, itemsByGroup } from '../utils/helperPaletteSnippets';

const ICONS = {
  cube: Box,
  cylinder: Cylinder,
  sphere: Circle,
  tube: Donut,
  hexPrism: Hexagon,
  roundedBox: Squircle,
  filletEdges: Radius,
  chamferEdges: Triangle,
  hole: CircleDot,
  holePattern: Grid3x3,
  clearanceHole: Bolt,
  tapDrillHole: Drill,
  cboreHole: Cone,
  cskHole: Cone,
  shell: BoxSelect,
  addDraft: MoveVertical,
  center: Focus,
  align: AlignVerticalJustifyCenter,
  mirror: FlipHorizontal2,
  array3D: Copy,
  polarArray: RotateCw,
  workplane: Frame,
  makeExtrude: ArrowUpFromLine,
  makeRevolve: Rotate3d,
};

/**
 * Slice 09 — left vertical helper insert palette (game mode).
 * Symmetric to the right viewport tool rail (CrossSectionPanel verticalRail).
 * Tap inserts a named-param snippet into Monaco via onInsert(id).
 */
const HelperInsertPalette = ({ onInsert, compact = false }) => {
  const grouped = itemsByGroup();
  const iconSize = compact ? 16 : 18;
  const pad = compact ? 'p-1.5' : 'p-2';

  return (
    <div
      className={`absolute left-2 lg:left-4 bottom-4 z-10 flex flex-col gap-1
        bg-white/60 backdrop-blur-sm rounded-lg shadow-lg
        max-h-[min(72%,calc(100%-5.5rem))] overflow-y-auto overflow-x-hidden
        ${compact ? 'p-1' : 'p-1.5'}`}
      role="toolbar"
      aria-label="Helper insert palette"
    >
      {HELPER_PALETTE_GROUPS.map((group, gi) => (
        <div key={group} className="flex flex-col gap-0.5">
          {gi > 0 && (
            <div className="border-t border-gray-300/70 my-0.5 mx-0.5" aria-hidden />
          )}
          <div
            className={`text-[9px] font-semibold uppercase tracking-wide text-gray-500 px-1 ${
              compact ? 'leading-3' : 'leading-4'
            }`}
          >
            {group === 'Primitives' ? 'Prim' : group === 'Features' ? 'Feat' : 'Xform'}
          </div>
          {(grouped[group] || []).map((item) => {
            const Icon = ICONS[item.id] || Box;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onInsert?.(item.id)}
                title={item.title}
                aria-label={`Insert ${item.label}: ${item.title}`}
                className={`${pad} rounded text-blue-700 hover:bg-blue-100 active:bg-blue-200
                  flex items-center justify-center transition-colors`}
              >
                <Icon size={iconSize} strokeWidth={2} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export default HelperInsertPalette;
