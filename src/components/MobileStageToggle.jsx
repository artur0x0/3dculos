import React from 'react';

/**
 * Mobile CAD ↔ Script stage switcher (Slice Mobile A).
 * One-thumb segmented control; session-sticky via the caller.
 * Desktop never mounts this. Renders inline in the mobile CAD top chrome
 * so it never covers the Script mid-strip or the CAD title chip.
 */
export default function MobileStageToggle({ stage = 'cad', onChange }) {
  const isCad = stage === 'cad';
  const isScript = stage === 'script';

  return (
    <div
      className="pointer-events-auto"
      data-mobile-stage-toggle=""
      role="group"
      aria-label="CAD or Script stage"
    >
      <div className="flex items-center rounded-lg shadow border border-gray-500/50 bg-gray-900/80 surface-glass-chip p-0.5">
        <button
          type="button"
          data-stage-btn="cad"
          aria-pressed={isCad}
          onClick={() => onChange?.('cad')}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold tracking-wide transition-colors active:opacity-80 ${
            isCad
              ? 'bg-cyan-600 text-white shadow'
              : 'text-gray-300 hover:text-white'
          }`}
        >
          CAD
        </button>
        <button
          type="button"
          data-stage-btn="script"
          aria-pressed={isScript}
          onClick={() => onChange?.('script')}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold tracking-wide transition-colors active:opacity-80 ${
            isScript
              ? 'bg-cyan-600 text-white shadow'
              : 'text-gray-300 hover:text-white'
          }`}
        >
          Script
        </button>
      </div>
    </div>
  );
}
