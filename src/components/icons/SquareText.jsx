// components/icons/SquareText.jsx — lucide's `square-text`, vendored.
//
// The Script pager glyph. It landed after lucide-react 0.469, which this
// project pins, same as SquareRoundCorner. Paths copied from lucide-static
// v1.52.0 (ISC). Drop this file and import from `lucide-react` once the
// dependency includes `SquareText`.
import React from 'react';

const SquareText = ({ size = 24, strokeWidth = 2, ...props }) => (
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
    className="lucide lucide-square-text"
    aria-hidden="true"
    {...props}
  >
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M7 8h8" />
    <path d="M7 12h10" />
    <path d="M7 16h6" />
  </svg>
);

export default SquareText;
