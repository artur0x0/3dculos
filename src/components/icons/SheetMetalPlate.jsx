// components/icons/SheetMetalPlate.jsx — sheet-metal plate with a bent flange.
//
// Shared by the left-rail Shape button and by sheet-metal feature badges
// (feature strip and feature sheet). Not a lucide glyph: lucide's FoldVertical
// was the old badge and does not read as a bent plate.
import React from 'react';

const SheetMetalPlate = ({ size = 24, strokeWidth = 2, className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={['lucide', 'lucide-sheet-metal-plate', className].filter(Boolean).join(' ')}
    aria-hidden="true"
    data-sheet-metal-icon=""
    {...props}
  >
    <path d="M4 10h11l5-4v10l-5 4H4z" />
    <path d="M12 10v10" />
  </svg>
);

export default SheetMetalPlate;
