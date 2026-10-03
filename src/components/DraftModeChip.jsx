import React from 'react';
import { Check, X } from 'lucide-react';
import { NumberField } from './controls/popupUI';

const ACCENT = 'cyan';

/**
 * Draft face-pick chip — ShellModeChip placement + chrome.
 * First tap is the neutral face (its normal is the pull). Flip reverses that
 * normal. Later taps add faces to draft; tap a drafted face again to remove
 * it. Undo drops only the last drafted face. Clear drops drafted faces and
 * keeps the neutral face. Confirm writes one draftFaces(); grey X exits
 * with no write. No modifier key and no tangent chain.
 */
const DraftModeChip = ({
  neutral = null,
  drafts = [],
  replaceNeutral = false,
  angle = 2,
  flip = false,
  compact = false,
  onAngle,
  onFlip,
  onUndo,
  onClear,
  onConfirm,
  onDismiss,
}) => {
  const faceCount = Array.isArray(drafts) ? drafts.length : 0;

  const setAngle = (raw) => {
    if (raw === '' || raw === '-' || raw === '.') {
      onAngle?.(raw);
      return;
    }
    const n = Number(raw);
    onAngle?.(Number.isFinite(n) ? n : angle);
  };

  let status;
  if (!neutral) {
    status = 'Tap the neutral face. Its normal is the pull.';
  } else if (replaceNeutral) {
    status = 'Tap a face to replace the neutral plane.';
  } else if (faceCount > 0) {
    status = `${faceCount} face${faceCount === 1 ? '' : 's'} · tap to add, tap again to remove`;
  } else {
    status = 'Neutral set. Tap faces to draft.';
  }

  const canConfirm = !!neutral && faceCount > 0;

  return (
    <div
      className={`absolute bg-cyan-950/80 surface-glass-chip border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(16rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[18rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Draft face pick"
      data-draft-mode="1"
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">
            Draft{faceCount ? ` · ${faceCount} face${faceCount === 1 ? '' : 's'}` : ''}
          </div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            {status}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit Draft mode without committing"
          aria-label="Dismiss Draft mode without committing"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0"
        data-draft-chip-scroll=""
      >
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Pull">
          <button
            type="button"
            onClick={() => onFlip?.(!flip)}
            aria-pressed={!!flip}
            disabled={!neutral}
            data-draft-flip=""
            className={`px-2.5 py-1 rounded text-[13px] ${
              flip
                ? 'bg-cyan-600 text-white'
                : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
            } ${!neutral ? 'opacity-50 cursor-not-allowed' : ''}`}
            title="Reverse the neutral-face normal. That direction is the pull."
          >
            Flip
          </button>
          {faceCount > 0 && (
            <>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onUndo?.()}
                title="Drop the last drafted face. The neutral face stays."
                data-draft-undo=""
              >
                Undo
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onClear?.()}
                title="Drop drafted faces and keep the neutral face"
                data-draft-clear=""
              >
                Clear
              </button>
            </>
          )}
        </div>

        <NumberField
          id="draft-angle"
          label="Angle °"
          accent={ACCENT}
          value={angle}
          onChange={setAngle}
          min={-45}
          max={45}
          step={0.5}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] text-cyan-200/70 leading-tight">
          draftFaces(body, faces, angle)
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
          data-draft-confirm={canConfirm ? 'enabled' : 'disabled'}
          title={canConfirm
            ? 'Commit one draftFaces() about the neutral plane and leave Draft mode.'
            : 'Tap the neutral face, then the faces to draft'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default DraftModeChip;
