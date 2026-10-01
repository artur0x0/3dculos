import React from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { NumberField } from './controls/popupUI';

const ACCENT = 'amber';

/**
 * Slice 27 — Fillet-in-mode chip (Edge-pick pattern).
 * Tangent (default-on) / Clear / Accept / Back. Live radius while edges accumulate.
 * Slice B: a hard edge shows a red banner (same red strip as the feature-modal
 * size guard) and Accept stays enabled. Mobile-first compact card.
 */
const FilletModeChip = ({
  kind = 'fillet',
  edgeCount = 0,
  tangentOn = true,
  params = {},
  pathOk = false,
  componentCount = 0,
  edgeClass = null,
  compact = false,
  onToggleTangent,
  onClear,
  onAccept,
  onBack,
  onDismiss,
  onParamChange,
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
  const hard = !chamfer && edgeClass?.klass === 'hard';
  const title = chamfer ? 'Chamfer' : 'Fillet';

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
      data-fillet-class={chamfer ? undefined : (edgeClass?.klass || 'empty')}
    >
      {hard && (
        <div
          className="mb-1.5 rounded border border-red-400/80 bg-red-950/80 px-2 py-1.5 text-[13px] leading-snug text-red-50"
          role="status"
          data-fillet-warn="hard"
          data-fillet-reason={edgeClass.reason || ''}
        >
          <div className="flex items-start gap-1.5">
            <AlertTriangle size={13} className="text-red-300 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <span className="font-semibold text-red-200">Hard edge</span>
              {edgeClass.reason ? ` · ${edgeClass.reason}` : ''}
              <div className="text-[11px] text-red-100/95 mt-0.5">
                Quality may be poor. Accept still runs.
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold font-sans text-amber-200">
            {title} · {edgeCount} edge{edgeCount === 1 ? '' : 's'}
          </div>
          <div className="text-[11px] text-amber-100/90 normal-case font-sans mt-0.5">
            {chamfer
              ? (edgeCount
                ? 'Accept commits the chamfer and exits'
                : 'Tap edges, then Accept')
              : (pathOk
                ? (componentCount > 1
                  ? `${componentCount} independent fillets · Accept commits and exits`
                  : 'Sweep blend preview · Accept commits and exits')
                : edgeCount
                  ? 'Path not ready — branched picks need a simple chain (Tangent on)'
                  : 'Tap edges — shallow blend tessellation is not pickable')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => (onDismiss || onBack)?.()}
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
          className="text-[11px] text-amber-200 underline"
          onClick={() => onClear?.()}
          title="Clear all selected edges"
        >
          Clear
        </button>
        <button
          type="button"
          className="text-[11px] text-amber-200 underline"
          onClick={() => onBack?.()}
          title={`Exit ${title} mode without committing`}
        >
          Back
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-amber-200/70 leading-tight">
          {chamfer ? 'Equal-leg chamfer' : 'Strategy · sweep'}
        </span>
        <button
          type="button"
          onClick={() => onAccept?.()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium
            bg-amber-600 hover:bg-amber-500 active:bg-amber-400 text-white shrink-0"
          data-fillet-accept="enabled"
          title={chamfer
            ? 'Commit this chamfer (chamferEdges) and leave Chamfer mode.'
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
