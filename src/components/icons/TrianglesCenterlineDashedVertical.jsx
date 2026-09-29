// components/icons/TrianglesCenterlineDashedVertical.jsx — lucide's
// `triangles-centerline-dashed-vertical`, vendored.
//
// Third vendored glyph, same reason as [SquareRoundCorner] and [Angle]: it
// postdates lucide 0.469, which this project pins. Two arrowheads meeting a
// dashed centreline is exactly a section cut, so it beats a generic chevron on
// the button that opens the cross-section options.
//
// Paths copied from lucide-static v1.48.0 (ISC). Delete this file and import
// from `lucide-react` once the dependency carries it.
import React from 'react';

const TrianglesCenterlineDashedVertical = ({ size = 24, strokeWidth = 2, ...props }) => (
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
    className="lucide lucide-triangles-centerline-dashed-vertical"
    aria-hidden="true"
    {...props}
  >
    <path d="M12 14v2" />
    <path d="M12 20v2" />
    <path d="M12 2v2" />
    <path d="M12 8v2" />
    <path d="M20.288 16.703A1 1 0 0022 16V8a1 1 0 00-1.712-.703l-3.99 3.991a1 1 0 00-.001 1.424z" />
    <path d="M3.712 16.703A1 1 0 012 16V8a1 1 0 011.712-.703l3.99 3.991a1 1 0 01.001 1.424z" />
  </svg>
);

export default TrianglesCenterlineDashedVertical;
