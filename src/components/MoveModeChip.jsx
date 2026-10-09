import React from 'react';
import { Check, X } from 'lucide-react';
import { NumberField } from './controls/popupUI';
import { FeatureDeleteButton } from './FeatureEditDelete';
import { moveTargetLabel, validateMoveAccept } from '../utils/moveMode';

const ACCENT = 'cyan';

/**
 * Move body chip — same cyan glass shell as Shell / Draft / Cut.
 * Double-click sets the body. One click keeps the face and does not change
 * the target. XYZ deltas, or one distance along the cut normal or a picked
 * face normal. Confirm writes one move(); grey X exits with no write.
 * No viewport arrows. The translated body is a preview until Confirm.
 */
const MoveModeChip = ({
  target = null,
  dx = 0,
  dy = 0,
  dz = 0,
  direction = 'xyz',
  distance = 0,
  cutNormal = null,
  faceNormal = null,
  compact = false,
  onDelta,
  onDirection,
  onClear,
  onConfirm,
  onDismiss,
  onDelete = null,
}) => {
  const gate = validateMoveAccept({
    target, dx, dy, dz, direction, distance, cutNormal, faceNormal,
  });
  const canConfirm = gate.ok;
  const along = direction === 'cut' || direction === 'face';

  const setAxis = (axis) => (raw) => {
    onDelta?.(axis, raw);
  };

  const choose = (next) => {
    if (next === 'cut' && !cutNormal) return;
    if (next === 'face' && !faceNormal) return;
    onDirection?.(next, next === 'cut' ? cutNormal : null);
  };

  const modeBtn = (id, label, enabled) => {
    const on = direction === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => choose(id)}
        disabled={!enabled}
        aria-pressed={on}
        className={`rounded px-2.5 py-1 text-[13px] font-medium ${
          on
            ? 'bg-cyan-600 text-white'
            : enabled
              ? 'bg-cyan-950/80 border border-cyan-700/70 text-cyan-100'
              : 'bg-cyan-950/50 border border-cyan-900/60 text-cyan-400/40 cursor-not-allowed'
        }`}
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
      aria-label="Move body"
      data-move-mode="1"
      data-move-direction={direction}
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">Move</div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            {moveTargetLabel(target)}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit Move mode without committing"
          aria-label="Dismiss Move mode without committing"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0"
        data-move-chip-scroll=""
      >
        {target && (
          <button
            type="button"
            className="self-start px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
            onClick={() => onClear?.()}
            title="Drop the picked body"
            data-move-clear=""
          >
            Clear
          </button>
        )}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Move direction">
          {modeBtn('xyz', 'XYZ', true)}
          {modeBtn('cut', 'Cut', !!cutNormal)}
          {modeBtn('face', 'Face', !!faceNormal)}
        </div>
        {along ? (
          <NumberField
            id="distance"
            label="Distance"
            accent={ACCENT}
            value={distance}
            onChange={setAxis('distance')}
            min={-1000}
            max={1000}
            step={0.5}
          />
        ) : (
          <>
            <NumberField
              id="dx"
              label="X"
              accent={ACCENT}
              value={dx}
              onChange={setAxis('dx')}
              min={-1000}
              max={1000}
              step={0.5}
            />
            <NumberField
              id="dy"
              label="Y"
              accent={ACCENT}
              value={dy}
              onChange={setAxis('dy')}
              min={-1000}
              max={1000}
              step={0.5}
            />
            <NumberField
              id="dz"
              label="Z"
              accent={ACCENT}
              value={dz}
              onChange={setAxis('dz')}
              min={-1000}
              max={1000}
              step={0.5}
            />
          </>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {onDelete ? <FeatureDeleteButton onClick={onDelete} /> : null}
          <span className="text-[11px] text-cyan-200/70 leading-tight">
            {along ? 'move along the normal' : 'move(body, [dx, dy, dz])'}
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
          data-move-confirm={canConfirm ? 'enabled' : 'disabled'}
          title={canConfirm
            ? 'Commit move() for this body and leave Move mode.'
            : 'Double-click a body first'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default MoveModeChip;
