import React, { useEffect } from 'react';
import { Check, X } from 'lucide-react';
import { NumberField } from './controls/popupUI';

const ACCENT = 'amber';

/**
 * Slice 27 — Fillet-in-mode chip (Edge-pick pattern).
 * Tangent (default-on) / Clear / Undo (= last edge pick only) / Accept.
 * X / Escape / dismiss without Accept clears all picks and exits.
 * Easy/hard class still chooses the kernel on Accept; the chip does not warn.
 * Picks can span parts; `partCount` > 1 says so, and Accept writes each part.
 */
const FilletModeChip = ({
  kind = 'fillet',
  edgeCount = 0,
  partCount = 1,
  tangentOn = true,
  params = {},
  pathOk = false,
  componentCount = 0,
  compact = false,
  onToggleTangent,
  onClear,
  onAccept,
  onBack,
  onDismiss,
  onParamChange,
  missingLabel = '',
  onClearMissing,
}) => {
  const chamfer = kind === 'chamfer';
  const sizeKey = chamfer ? 'chamfer' : 'radius';
  const setSize = (raw) => {
    let v = raw;
    if (raw === '' || raw === '-' || raw === '.') v = raw;
    else {
      const n = Number(raw);
      v = Number.isFinite(n) ? n : params[sizeKey];
    }
    onParamChange?.(
      { ...params, [sizeKey]: v },
      chamfer ? { sizeTouched: true } : { radiusTouched: true },
    );
  };

  const size = params[sizeKey];
  const sizeNum = Number(size);
  const max = chamfer
    ? Math.max(40, Number.isFinite(sizeNum) ? sizeNum : 0)
    : (Number(params._sweepMax) > 0 ? Number(params._sweepMax) : 40);
  const title = chamfer ? 'Chamfer' : 'Fillet';

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      (onDismiss || onBack)?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss, onBack]);

  return (
    <div
      className={`absolute bg-amber-950/80 surface-glass-chip border border-amber-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg ${
          // Bottom-centre, like the contour chip — see ContourModeChip.
          // Mobile B: raise above the home-indicator stage pill.
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(16rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)] overflow-y-auto rail-scroll'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[16rem]'
        }`}
      role="group"
      aria-label={chamfer ? 'Chamfer edge pick' : 'Fillet edge pick'}
      data-edge-blend={chamfer ? 'chamfer' : 'fillet'}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold font-sans text-amber-200">
            {title} · {edgeCount} edge{edgeCount === 1 ? '' : 's'}
            {partCount > 1 && (
              <span data-fillet-part-count={partCount}> · {partCount} parts</span>
            )}
          </div>
          <div className="text-[11px] text-amber-100/90 normal-case font-sans mt-0.5">
            {pathOk
              ? (componentCount > 1
                ? `${componentCount} independent ${chamfer ? 'chamfers' : 'fillets'} · Accept commits and exits`
                : (chamfer
                  ? 'Sweep chamfer preview · Accept commits and exits'
                  : 'Sweep blend preview · Accept commits and exits'))
              : edgeCount
                ? 'Path not ready — branched picks need a simple chain (Tangent on)'
                : (chamfer ? 'Tap edges, then Accept' : 'Tap edges — shallow blend tessellation is not pickable')}
          </div>
        </div>
        <button
          type="button"
          data-fillet-dismiss=""
          onClick={() => onDismiss?.()}
          className="shrink-0 text-amber-200 hover:text-white"
          title={`Exit ${title} mode without committing`}
          aria-label={`Dismiss ${title} mode without committing`}
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-col gap-1.5 font-sans">
        {/* Same slider + typed box as every other popup (controls/popupUI). */}
        <NumberField
          id={chamfer ? 'size' : 'radius'}
          label={chamfer ? 'Size' : 'Radius'}
          accent={ACCENT}
          value={size}
          onChange={setSize}
          min={0.1}
          max={max}
          step={Math.max(0.5, Math.round((max / 40) * 100) / 100)}
        />
      </div>
      {missingLabel ? (
        <div className="mt-1.5 flex items-center gap-2 font-sans text-[11px] text-amber-100" data-feature-edit-missing="">
          <span>{missingLabel}</span>
          <button
            type="button"
            data-feature-edit-clear-missing=""
            className="underline text-amber-200"
            onClick={() => onClearMissing?.()}
          >
            Clear
          </button>
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-3 font-sans flex-wrap">
        <button
          type="button"
          className={`text-[11px] underline ${tangentOn ? 'text-cyan-300' : 'text-amber-200/70'}`}
          onClick={() => onToggleTangent?.()}
          title="When on, picking one edge adds G1-connected (tangent) edges in the loop"
          aria-pressed={tangentOn}
        >
          Tangent {tangentOn ? 'on' : 'off'}
        </button>
        <button
          type="button"
          data-fillet-clear=""
          className="text-[11px] text-amber-200 underline"
          onClick={() => onClear?.()}
          title="Clear all selected edges"
        >
          Clear
        </button>
        <button
          type="button"
          data-fillet-back=""
          className="text-[11px] text-amber-200 underline"
          onClick={() => onBack?.()}
          title="Undo"
          aria-label="Undo"
        >
          Undo
        </button>
      </div>
      {/* Space Clear/Undo away from Accept; strategy helper text removed.
          This Undo pops the last edge only. It is not the CAD script Undo. */}
      <div className="mt-4 flex items-center justify-end gap-2" data-fillet-accept-row="">
        <button
          type="button"
          onClick={() => onAccept?.()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium
            bg-amber-600 hover:bg-amber-500 active:bg-amber-400 text-white shrink-0"
          data-fillet-accept="enabled"
          title={chamfer
            ? 'Commit this chamfer (path sweep) and leave Chamfer mode.'
            : 'Commit this fillet (makeSweepPath + filletAlongPath per contiguous component) and leave Fillet mode.'}
        >
          <Check size={14} />
          Accept
        </button>
      </div>
    </div>
  );
};

export default FilletModeChip;
