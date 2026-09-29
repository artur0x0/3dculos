import React, { useMemo } from 'react';
import { parseFeatureMarkers } from '../utils/featureMarkers';

/**
 * Slice Mobile B — Script-stage feature strip (minimal).
 *
 * Horizontal chips over marked Contour / Extrude / Fillet / … blocks.
 * Tap jumps Monaco caret + selection to that block. Progressive scrub /
 * viewport geometry highlight are deferred; chips alone are the MVP nav.
 *
 * Script-stage only. Desktop and CAD stage never mount this.
 */
export default function FeatureStrip({ script = '', activeId = null, onJump }) {
  const features = useMemo(() => parseFeatureMarkers(script), [script]);

  if (features.length === 0) {
    return (
      <div
        className="shrink-0 border-b border-gray-700/40 bg-gray-900/70 surface-glass-chip px-2 py-1.5"
        data-feature-strip=""
        data-feature-strip-empty=""
      >
        <div className="text-[11px] text-gray-400 font-sans truncate">
          No marked features yet — Extrude / Fillet / … show up here
        </div>
      </div>
    );
  }

  return (
    <div
      className="shrink-0 border-b border-gray-700/40 bg-gray-900/70 surface-glass-chip"
      data-feature-strip=""
      role="navigation"
      aria-label="Modeling features"
    >
      <div className="flex items-center gap-1.5 overflow-x-auto px-2 py-1.5 no-scrollbar">
        {features.map((f) => {
          const active = activeId === f.id;
          return (
            <button
              key={f.id}
              type="button"
              data-feature-chip={f.kind}
              data-feature-id={f.id}
              aria-pressed={active}
              onClick={() => onJump?.(f)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold font-sans tracking-wide border transition-colors active:opacity-80 ${
                active
                  ? 'bg-cyan-600 text-white border-cyan-400/70 shadow'
                  : 'bg-gray-800/70 text-gray-200 border-gray-500/40 hover:text-white'
              }`}
            >
              {f.chipLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}
