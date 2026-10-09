import React from 'react';
import { X } from 'lucide-react';
import { FeaRunBar, FeaStudyControls } from './FeaStudyControls';

/**
 * Analyze popup. Same card as Paint: between the rails, cyan glass, grey X
 * exits. The button that opens it lives on the right rail (`data-analyze-chip`).
 */
export function FeaStudyChip({ panel, compact = false }) {
  return (
    <div
      className={`pointer-events-auto absolute z-20 flex min-h-0 flex-col rounded-lg border border-cyan-400/70 bg-cyan-950/80 px-3 py-2 text-xs text-white shadow-lg surface-glass-chip ${
        compact
          ? 'bottom-14 left-1/2 max-h-[calc(100dvh-12rem)] max-w-[min(20rem,calc(100%-9rem))] -translate-x-1/2'
          : 'bottom-2.5 left-1/2 max-h-[calc(100dvh-12rem)] max-w-[20rem] -translate-x-1/2'
      }`}
      role="group"
      aria-label="Analyze"
      data-fea-mode="1"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-sans font-bold text-cyan-200">
            Analyze
            <span
              data-fea-stub="1"
              className="rounded bg-amber-400 px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-amber-950"
            >
              STUB
            </span>
          </div>
          <div className="mt-0.5 font-sans text-[11px] normal-case text-cyan-100/90">
            Fix a face, add a load, then Run.
          </div>
        </div>
        <button
          type="button"
          onClick={() => panel.close?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit analyze"
          aria-label="Exit analyze"
          data-fea-dismiss=""
        >
          <X size={14} />
        </button>
      </div>
      <div className="rail-scroll mt-1.5 flex min-h-0 flex-col gap-1.5 overflow-y-auto font-sans" data-fea-chip-scroll="">
        <FeaStudyControls panel={panel} />
      </div>
      <FeaRunBar panel={panel} />
    </div>
  );
}
