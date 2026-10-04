import React from 'react';
import { Check, X } from 'lucide-react';

/**
 * Delete Face chip — ShellModeChip placement + chrome.
 * Tap a face to add it. Tap a selected face again to remove it. Undo drops
 * the last face. Clear drops every face. No modifier key. Confirm writes one
 * deleteFace(); grey X exits with no write.
 */
const DeleteFaceModeChip = ({
  faces = [],
  compact = false,
  onUndo,
  onClear,
  onConfirm,
  onDismiss,
}) => {
  const faceCount = Array.isArray(faces) ? faces.length : 0;

  let status;
  if (faceCount > 1) {
    status = `${faceCount} faces · tap to add, tap a selected face to remove`;
  } else if (faceCount === 1) {
    status = '1 face · tap another to add, tap it again to remove';
  } else {
    status = 'Tap faces to delete. Neighbors extend or trim to heal.';
  }

  const canConfirm = faceCount > 0;

  return (
    <div
      className={`absolute bg-cyan-950/80 surface-glass-chip border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(16rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[18rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Delete Face"
      data-delete-face-mode="1"
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">
            Delete Face{faceCount ? ` · ${faceCount} face${faceCount === 1 ? '' : 's'}` : ''}
          </div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            {status}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit Delete Face without committing"
          aria-label="Dismiss Delete Face without committing"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0"
        data-delete-face-chip-scroll=""
      >
        {faceCount > 0 && (
          <div className="flex gap-1 flex-wrap" role="group" aria-label="Picked faces">
            <button
              type="button"
              className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
              onClick={() => onUndo?.()}
              title="Drop the last selected face"
              data-delete-face-undo=""
            >
              Undo
            </button>
            <button
              type="button"
              className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
              onClick={() => onClear?.()}
              title="Drop every selected face"
              data-delete-face-clear=""
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] text-cyan-200/70 leading-tight">
          deleteFace(body, faces)
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
          data-delete-face-confirm={canConfirm ? 'enabled' : 'disabled'}
          title={canConfirm
            ? 'Commit one deleteFace() and leave Delete Face.'
            : 'Tap a face first'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default DeleteFaceModeChip;
