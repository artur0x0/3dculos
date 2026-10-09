import React from 'react';
import { Check, X } from 'lucide-react';
import {
  booleanOp,
  booleanSlot,
  booleanPicksInOrder,
  booleanTargetPartId,
  booleanCrossPart,
} from '../utils/booleanMode';
import { FeatureDeleteButton } from './FeatureEditDelete';

/**
 * Boolean chip — same shell as CutModeChip.
 * Union / Difference / Intersect. Bodies use the Shell sticky picker.
 * Intersect opens Pieces: tap hides a leftover, tap again brings it back.
 * The chip is not a modal. The cross-section rail (z-40) and the part
 * manager stay reachable, and hiding a part does not clear its picks.
 * Confirm writes one booleanBodies(); grey X exits with no write.
 *
 * Picks span parts. The first tap is the target and its part is written.
 * A tool body on another part is copied into the target at Confirm (frozen,
 * not linked) and that Boolean chip gets a yellow border.
 */
const BooleanModeChip = ({
  state = null,
  partId = null,
  compact = false,
  pieceCount = 0,
  /** part id → display name, for the cross-part line. */
  partNames = null,
  onOp,
  onPickTarget,
  onUndo,
  onClear,
  onConfirm,
  onDismiss,
  onDelete = null,
}) => {
  const op = booleanOp(state?.op);
  const pick = state?.pick === 'pieces' && op === 'intersect' ? 'pieces' : 'bodies';
  const picks = booleanPicksInOrder(state);
  const targetId = booleanTargetPartId(state) ?? partId;
  const crossPart = booleanCrossPart(state);
  const slot = booleanSlot(state, targetId);
  const bodyCount = picks.length;
  const dropCount = slot.drop.length;
  const nameOf = (id) => (partNames && partNames[id]) || id;
  const canConfirm = bodyCount >= 2 && !(op === 'intersect' && pieceCount > 0 && dropCount >= pieceCount);

  let status;
  if (pick === 'pieces') {
    status = dropCount
      ? `${dropCount} hidden · tap that piece again to bring it back`
      : 'Each leftover has its own color · tap a piece to hide it';
  } else if (bodyCount > 1) {
    status = `${bodyCount} bodies · first is the target · tap again to remove`;
  } else if (bodyCount === 1) {
    status = '1 body, the target · tap a tool body to add it';
  } else {
    status = 'Tap bodies. The first tap is the target.';
  }

  const opBtn = (id, label, title) => {
    const on = op === id;
    return (
      <button
        type="button"
        onClick={() => onOp?.(id)}
        aria-pressed={on}
        className={`px-2.5 py-1 rounded text-[13px] ${
          on
            ? 'bg-cyan-600 text-white'
            : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
        }`}
        title={title}
        data-boolean-op={id}
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

  const showUndo = (pick === 'bodies' && bodyCount > 0) || (pick === 'pieces' && dropCount > 0);

  return (
    <div
      className={`absolute bg-cyan-950/80 surface-glass-chip border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 pointer-events-auto ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(18rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[18rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Boolean"
      data-boolean-mode="1"
      data-boolean-allow-section="1"
      data-boolean-survives-parts="1"
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">
            Boolean · {op === 'difference' ? 'Difference' : op === 'intersect' ? 'Intersect' : 'Union'}
          </div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            {status}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit Boolean mode without committing"
          aria-label="Dismiss Boolean mode without committing"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0"
        data-boolean-chip-scroll=""
      >
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Boolean operation">
          {opBtn('union', 'Union', 'Add the bodies together')}
          {opBtn('difference', 'Difference', 'Cut the tool bodies out of the target')}
          {opBtn('intersect', 'Intersect', 'Keep only the overlap, then hide leftover pieces')}
        </div>
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Boolean picks">
          {pickBtn('bodies', 'Bodies', 'Tap to add a body. Tap a selected body to remove it.')}
          {op === 'intersect' && pickBtn('pieces', 'Pieces', 'Tap a leftover piece to hide it. Tap again to bring it back.')}
          {showUndo && (
            <>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onUndo?.()}
                title={pick === 'pieces' ? 'Bring back the last hidden piece' : 'Drop the last pick'}
                data-boolean-undo=""
              >
                Undo
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
                onClick={() => onClear?.()}
                title={pick === 'pieces' ? 'Show every piece. The bodies stay.' : 'Drop the bodies in this list'}
                data-boolean-clear=""
              >
                Clear
              </button>
            </>
          )}
        </div>
        {crossPart && (
          <p
            className="text-[11px] text-yellow-200 leading-snug m-0 border-l-2 border-yellow-400 pl-1.5"
            data-boolean-cross-part="1"
          >
            Writes {nameOf(targetId)}. Tool bodies from other parts are copied in at Confirm — not linked.
          </p>
        )}
        <p className="text-[11px] text-cyan-200/80 leading-snug m-0">
          Section and the part list stay open. Hiding a part keeps its picks.
        </p>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {onDelete ? <FeatureDeleteButton onClick={onDelete} /> : null}
          <span className="text-[11px] text-cyan-200/70 leading-tight">
            booleanBodies
          </span>
        </div>
        <button
          type="button"
          onClick={() => onConfirm?.()}
          disabled={!canConfirm}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium shrink-0 ${
            canConfirm
              ? 'bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-400 text-white'
              : 'bg-cyan-950/80 text-cyan-400/50 border border-cyan-800/60 cursor-not-allowed'
          }`}
          data-boolean-confirm={canConfirm ? 'enabled' : 'disabled'}
          title={canConfirm
            ? 'Commit booleanBodies() and leave Boolean mode.'
            : 'Pick a target and at least one tool body'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default BooleanModeChip;
