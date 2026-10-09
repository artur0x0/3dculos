import React from 'react';
import { X } from 'lucide-react';
import { FeaRunBar, FeaStudyControls } from './FeaStudyControls';

/**
 * Phone Analyze sheet. Same under-title shell as FeatureSheet
 * (`data-feature-sheet`, top-14, internal scroll). Desktop uses the chip.
 */
export function FeaStudySheet({ panel }) {
  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-14 z-40 flex justify-center px-2"
      data-feature-sheet=""
      data-feature-sheet-layout="under-title-horizontal"
      data-feature-sheet-placement="stage"
      data-fea-sheet="1"
      role="dialog"
      aria-label="Analyze"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="flex max-h-[min(16rem,calc(100dvh-16rem))] min-h-0 w-full flex-col overflow-hidden rounded-xl border border-cyan-400/70 bg-cyan-950/80 px-3 py-2 shadow-xl surface-glass-chip"
        data-feature-sheet-panel=""
      >
        <div className="mb-1 flex shrink-0 items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-cyan-200">
            Analyze
          </div>
          <button
            type="button"
            onClick={() => panel.close?.()}
            className="text-gray-400 hover:text-white"
            aria-label="Exit analyze"
            data-fea-dismiss=""
          >
            <X size={16} />
          </button>
        </div>
        <div className="rail-scroll min-h-0 overflow-y-auto" data-feature-sheet-scroll="" data-fea-sheet-scroll="">
          <div className="flex flex-col gap-1.5 pb-1">
            <FeaStudyControls panel={panel} />
          </div>
        </div>
        <FeaRunBar panel={panel} />
      </div>
    </div>
  );
}
