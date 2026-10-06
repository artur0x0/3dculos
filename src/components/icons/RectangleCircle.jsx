// components/icons/RectangleCircle.jsx — lucide's `rectangle-circle`, vendored.
//
// Same reason as SquareRoundCorner: the glyph is not in lucide-react 0.469,
// which this project is pinned to. A rectangle overlapping a circle reads as
// a body boolean (two solids combined), so Boolean wears it on the Build
// rail, the feature strip, and the feature sheet.
//
// Paths copied from lucide-static v1.52.0 (ISC). Drop this file and switch the
// import to `lucide-react` the day the dependency ships `RectangleCircle`.
import React from 'react';

const RectangleCircle = ({ size = 24, strokeWidth = 2, ...props }) => (
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
    className="lucide lucide-rectangle-circle"
    aria-hidden="true"
    {...props}
  >
    <path d="M14 4v16H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <circle cx="14" cy="12" r="8" />
  </svg>
);

export default RectangleCircle;
