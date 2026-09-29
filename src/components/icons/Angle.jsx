// components/icons/Angle.jsx — lucide's `angle`, vendored.
//
// Second (and hopefully last) vendored glyph, for the same reason as
// [SquareRoundCorner]: `angle` postdates lucide 0.469, which this project pins.
// A corner with an arc across it is the draft-angle pictogram; nothing in 0.469
// says "angle" without borrowing a glyph another tool already owns.
//
// Path copied from lucide-static (ISC). Delete this file and import from
// `lucide-react` once the dependency moves past the release that adds it.
import React from 'react';

const Angle = ({ size = 24, strokeWidth = 2, ...props }) => (
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
    className="lucide lucide-angle"
    aria-hidden="true"
    {...props}
  >
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M3 11a10 10 0 0 1 10 10" />
  </svg>
);

export default Angle;
