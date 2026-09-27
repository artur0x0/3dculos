// components/icons/SquareRoundCorner.jsx — lucide's `square-round-corner`, vendored.
//
// Why this is not a plain `lucide-react` import (the only such exception in the
// app): the glyph landed in lucide 0.511 and this project is pinned to 0.469.
// A square with exactly one rounded corner is *the* fillet pictogram, and it
// also frees `Squircle` to mean roundedBox alone, so it is worth vendoring the
// two paths verbatim rather than bumping every icon in the set for one glyph.
//
// Paths copied from lucide-static v0.511.0 (ISC). Drop this file and switch the
// import to `lucide-react` the day the dependency clears 0.511.
import React from 'react';

const SquareRoundCorner = ({ size = 24, strokeWidth = 2, ...props }) => (
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
    className="lucide lucide-square-round-corner"
    aria-hidden="true"
    {...props}
  >
    <path d="M21 11a8 8 0 0 0-8-8" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  </svg>
);

export default SquareRoundCorner;
