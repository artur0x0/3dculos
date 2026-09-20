import React from 'react';
import { Check } from 'lucide-react';

/**
 * Slice 27 — Fillet-in-mode chip (Edge-pick pattern).
 * Tangent (default-on) / Clear / Accept / Back. Live radius while edges accumulate.
 * Mobile-first compact card.
 */
const FilletModeChip = ({
  edgeCount = 0,
  tangentOn = true,
  params = {},
  pathOk = false,
  compact = false,
  onToggleTangent,
  onClear,
  onAccept,
  onBack,
  onParamChange,
}) => {
  const setRadius = (raw) => {
    let v = raw;
    if (raw === '' || raw === '-' || raw === '.') v = raw;
    else {
      const n = Number(raw);
      v = Number.isFinite(n) ? n : params.radius;
    }
    onParamChange?.({ ...params, radius: v }, { radiusTouched: true });
  };

  const radius = params.radius;
  const radiusNum = Number(radius);
  const max = Number(params._sweepMax) > 0 ? Number(params._sweepMax) : 40;

  return (
    <div
      className={`absolute bg-amber-950/90 border border-amber-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg ${
          compact ? 'bottom-4 right-2 max-w-[min(16rem,calc(100%-5.5rem))]' : 'bottom-4 right-2 lg:right-4 max-w-[16rem]'
        }`}
      role="group"
      aria-label="Fillet edge pick"
    >
      <div className="font-bold font-sans text-amber-200">
        Fillet · {edgeCount} edge{edgeCount === 1 ? '' : 's'}
      </div>
      <div className="text-[10px] text-amber-100/90 normal-case font-sans mt-0.5">
        {pathOk
          ? 'Sweep blend preview · Accept commits'
          : edgeCount
            ? 'Path not ready — pick a contiguous chain (Tangent on)'
            : 'Tap edges — no pre-select required'}
      </div>
      <div className="mt-1.5 flex flex-col gap-1.5 font-sans">
        <label className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-amber-200/80">Radius</span>
          <div className="flex items-center gap-1.5">
            <input
              type="range"
              value={Number.isFinite(radiusNum) ? radiusNum : 3}
              min={0.1}
              max={max}
              step={Math.max(0.5, Math.round((max / 40) * 100) / 100)}
              onChange={(e) => setRadius(e.target.value)}
              className="flex-1 min-w-0 accent-amber-400"
              aria-label="Radius"
            />
            <input
              type="number"
              value={radius ?? ''}
              min={0.01}
              step="any"
              onChange={(e) => setRadius(e.target.value)}
              className="w-14 rounded border border-amber-700/70 bg-amber-950/80 px-1 py-0.5
                text-[11px] tabular-nums text-white"
              aria-label="Radius value"
            />
          </div>
        </label>
      </div>
      <div className="mt-1.5 flex items-center gap-3 font-sans flex-wrap">
        <button
          type="button"
          className={`text-[10px] underline ${tangentOn ? 'text-cyan-300' : 'text-amber-200/70'}`}
          onClick={() => onToggleTangent?.()}
          title="When on, picking one edge adds G1-connected (tangent) edges in the loop"
          aria-pressed={tangentOn}
        >
          Tangent {tangentOn ? 'on' : 'off'}
        </button>
        <button
          type="button"
          className="text-[10px] text-amber-200 underline"
          onClick={() => onClear?.()}
          title="Clear all selected edges"
        >
          Clear
        </button>
        <button
          type="button"
          className="text-[10px] text-amber-200 underline"
          onClick={() => onBack?.()}
          title="Exit Fillet mode without committing"
        >
          Back
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-amber-200/70 leading-tight">
          Strategy · sweep
        </span>
        <button
          type="button"
          onClick={() => onAccept?.()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
            bg-amber-600 hover:bg-amber-500 active:bg-amber-400 text-white shrink-0"
          title="Commit or update Fillet (makeSweepPath + filletAlongPath). Second Accept updates the same block."
        >
          <Check size={14} />
          Accept
        </button>
      </div>
    </div>
  );
};

export default FilletModeChip;
