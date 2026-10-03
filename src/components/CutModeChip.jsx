import React from 'react';
import { Check, X } from 'lucide-react';
import { NumberField } from './controls/popupUI';
import { CUT_EXPLICIT_PLANES, cutPlaneFromState } from '../utils/cutMode';

const ACCENT = 'cyan';

/**
 * Cut chip — ShellModeChip placement and chrome.
 * Plane is a planar face or an explicit XY / YZ / ZX plane.
 * Bodies and pieces use the Shell sticky picker: tap to add, tap again to
 * remove, Undo drops the last pick, Clear drops that list.
 * Offset is along the plane normal for a face and for XY / YZ / ZX.
 * Pieces: each resulting piece gets its own color; tap hides it, tap again
 * brings it back. Undo drops the last hide. Clear unhides every piece.
 * Confirm writes one cut(); grey X exits with no write.
 */
const CutModeChip = ({
  state = null,
  compact = false,
  onPlaneSource,
  onOffset,
  onPickTarget,
  onUndo,
  onClear,
  onConfirm,
  onDismiss,
}) => {
  const source = state?.planeSource === 'xy' || state?.planeSource === 'yz' || state?.planeSource === 'zx'
    ? state.planeSource
    : 'face';
  const pick = state?.pick === 'bodies' || state?.pick === 'pieces' || state?.pick === 'plane'
    ? state.pick
    : 'plane';
  const plane = cutPlaneFromState(state);
  const bodyCount = Array.isArray(state?.bodies) ? state.bodies.length : 0;
  const dropCount = Array.isArray(state?.drop) ? state.drop.length : 0;
  const offset = state?.originOffset ?? 0;
  const offsetNum = Number(offset);
  const offsetMax = Math.max(80, Number.isFinite(offsetNum) ? Math.abs(offsetNum) : 0);

  let status;
  if (!plane && source === 'face') {
    status = 'Tap a planar face, or choose an explicit plane';
  } else if (pick === 'plane') {
    status = 'Plane from the face — tap another face to replace it';
  } else if (pick === 'pieces') {
    status = dropCount
      ? `${dropCount} hidden · tap that piece again to bring it back`
      : 'Each piece has its own color · tap a piece to hide it';
  } else if (bodyCount > 1) {
    status = `${bodyCount} bodies · tap to add, tap a selected body to remove`;
  } else if (bodyCount === 1) {
    status = '1 body · tap another to add, tap it again to remove';
  } else {
    status = 'Tap the bodies to cut';
  }

  const planeLabel = source === 'face'
    ? (plane ? 'Face plane' : 'Face')
    : `${CUT_EXPLICIT_PLANES[source].label} plane`;

  const canConfirm = !!plane && bodyCount > 0;
  const showUndo = (pick === 'plane' && !!state?.planeFace)
    || (pick === 'bodies' && bodyCount > 0)
    || (pick === 'pieces' && dropCount > 0);

  const sourceBtn = (id, label, title) => {
    const on = source === id;
    return (
      <button
        type="button"
        onClick={() => onPlaneSource?.(id)}
        aria-pressed={on}
        className={`px-2.5 py-1 rounded text-[13px] ${
          on
            ? 'bg-cyan-600 text-white'
            : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
        }`}
        title={title}
      >
        {label}
      </button>
    );
  };

  const pickBtn = (id, label, title) => {
    const on = pick === id;
    return (
      <button
        type="button"
        onClick={() => onPickTarget?.(id)}
        aria-pressed={on}
        data-cut-pick={id}
        className={`px-2.5 py-1 rounded text-[13px] ${
          on
            ? 'bg-cyan-600 text-white'
            : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
        }`}
        title={title}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className={`absolute bg-cyan-950/80 surface-glass-chip border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(16rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[18rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Cut plane"
      data-cut-mode="1"
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">
            Cut · {planeLabel}
          </div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            {status}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit Cut mode without committing"
          aria-label="Dismiss Cut mode without committing"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0"
        data-cut-chip-scroll=""
      >
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Cutting plane">
          {sourceBtn('face', 'Face', 'Plane from a planar face')}
          {sourceBtn('xy', 'XY', 'Explicit XY plane, normal +Z')}
          {sourceBtn('yz', 'YZ', 'Explicit YZ plane, normal +X')}
          {sourceBtn('zx', 'ZX', 'Explicit ZX plane, normal +Y')}
        </div>

        <div title="Offset along the plane normal. Positive moves with the normal. Zero keeps a face call as { center, normal }.">
          <NumberField
            id="cut-offset"
            label="Offset"
            accent={ACCENT}
            value={offset}
            onChange={(raw) => onOffset?.(raw)}
            min={-offsetMax}
            max={offsetMax}
            step={1}
          />
        </div>

        <div className="flex gap-1 flex-wrap" role="group" aria-label="Cut picks">
          {source === 'face' && pickBtn('plane', 'Plane', 'Tap a face to set the plane')}
          {pickBtn('bodies', 'Bodies', 'Tap bodies to cut. Tap again to remove.')}
          {pickBtn('pieces', 'Pieces', 'Tap a piece to hide it. Tap again to bring it back.')}
          {showUndo && (
            <>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onUndo?.()}
                title={pick === 'pieces' ? 'Bring back the last hidden piece' : 'Drop the last pick'}
                data-cut-undo=""
              >
                Undo
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onClear?.()}
                title={pick === 'pieces' ? 'Show every piece. The plane stays.' : 'Drop the picks in this list'}
                data-cut-clear=""
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] text-cyan-200/70 leading-tight">
          cut(body, plane)
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
          data-cut-confirm={canConfirm ? 'enabled' : 'disabled'}
          title={canConfirm
            ? 'Commit cut() and leave Cut mode.'
            : 'Choose a plane and at least one body'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default CutModeChip;
