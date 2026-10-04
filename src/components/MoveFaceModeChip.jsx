import React from 'react';
import { Check, X } from 'lucide-react';
import { NumberField } from './controls/popupUI';

const ACCENT = 'cyan';

/**
 * Move Face chip — ShellModeChip placement + chrome.
 * Tap a face to add it. Tap a selected face again to remove it. Undo drops
 * the last face. Clear drops every face. No modifier key. Distance is along
 * each face normal. Flip reverses that normal. Confirm writes one moveFace();
 * grey X exits with no write.
 */
const MoveFaceModeChip = ({
  faces = [],
  distance = 2,
  flip = false,
  compact = false,
  onDistance,
  onFlip,
  onUndo,
  onClear,
  onConfirm,
  onDismiss,
}) => {
  const faceCount = Array.isArray(faces) ? faces.length : 0;
  const distNum = Number(distance);
  const max = Math.max(20, Number.isFinite(distNum) ? Math.abs(distNum) : 0);

  const setDistance = (raw) => {
    if (raw === '' || raw === '-' || raw === '.') {
      onDistance?.(raw);
      return;
    }
    const n = Number(raw);
    onDistance?.(Number.isFinite(n) ? n : distance);
  };

  let status;
  if (faceCount > 1) {
    status = `${faceCount} faces · tap to add, tap a selected face to remove`;
  } else if (faceCount === 1) {
    status = '1 face · tap another to add, tap it again to remove';
  } else {
    status = 'Tap faces to offset along their normals';
  }

  const canConfirm = faceCount > 0 && Number.isFinite(distNum);

  return (
    <div
      className={`absolute bg-cyan-950/80 surface-glass-chip border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(16rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[18rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Move Face"
      data-move-face-mode="1"
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">
            Move Face{faceCount ? ` · ${faceCount} face${faceCount === 1 ? '' : 's'}` : ''}
          </div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            {status}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit Move Face without committing"
          aria-label="Dismiss Move Face without committing"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0"
        data-move-face-chip-scroll=""
      >
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Offset">
          <button
            type="button"
            onClick={() => onFlip?.(!flip)}
            aria-pressed={!!flip}
            data-move-face-flip=""
            className={`px-2.5 py-1 rounded text-[13px] ${
              flip
                ? 'bg-cyan-600 text-white'
                : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
            }`}
            title="Reverse each face normal. The distance is applied the other way."
          >
            Flip
          </button>
          {faceCount > 0 && (
            <>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onUndo?.()}
                title="Drop the last selected face"
                data-move-face-undo=""
              >
                Undo
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onClear?.()}
                title="Drop every selected face"
                data-move-face-clear=""
              >
                Clear
              </button>
            </>
          )}
        </div>

        <NumberField
          id="move-face-distance"
          label="Distance"
          accent={ACCENT}
          value={distance}
          onChange={setDistance}
          min={-max}
          max={max}
          step={0.5}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] text-cyan-200/70 leading-tight">
          moveFace(body, faces, distance)
        </span>
        <button
          type="button"
          onClick={() => onConfirm?.()}
          disabled={!canConfirm}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium shrink-0 ${
            canConfirm
              ? 'bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-400 text-white'
              : 'bg-cyan-950/80 text-cyan-400/50 border border-cyan-800/60 cursor-not-allowed'
          }`}
          data-move-face-confirm={canConfirm ? 'enabled' : 'disabled'}
          title={canConfirm
            ? 'Commit one moveFace() and leave Move Face.'
            : 'Tap a face first'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default MoveFaceModeChip;
