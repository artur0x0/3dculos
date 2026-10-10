import React, { useEffect, useState } from 'react';
import FeatureSheet from './FeatureSheet';
import {
  JOINT_TYPE_LABEL,
  jointConfirmDisabled,
  jointSubtitle,
} from '../joints/jointUi';
import {
  displayToMm,
  lengthCaption,
  lengthToDisplay,
  subscribeDisplayUnit,
} from '../utils/displayUnit';

const TYPES = ['coincident', 'concentric', 'distance', 'angle', 'fixed'];

function valueText(mm, unit) {
  if (!Number.isFinite(Number(mm))) return '';
  const shown = lengthToDisplay(Number(mm), unit);
  if (!Number.isFinite(shown)) return '';
  const digits = unit === 'in' ? 4 : 2;
  return String(Number(shown.toFixed(digits)));
}

export function JointModeChip({ card, unit = 'mm', onChange }) {
  const set = (patch) => onChange?.({ ...card, ...patch });
  const distance = card?.type === 'distance';
  const angle = card?.type === 'angle';
  return (
    <div className="flex flex-col gap-2 px-3 pb-2" data-joint-body="">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-300">Name</span>
        <input
          data-joint-name=""
          value={card?.name || ''}
          onChange={(event) => set({ name: event.target.value, userNamed: true })}
          className="min-h-[36px] rounded border border-gray-600/80 bg-gray-950/70 px-2 text-white"
        />
      </label>
      <div className="flex flex-wrap gap-1" data-joint-types="">
        {TYPES.map((type) => (
          <button
            key={type}
            type="button"
            data-joint-type-choice={type}
            aria-pressed={card?.type === type}
            onClick={() => set({ type, userPickedType: true })}
            className={`rounded-md px-2 py-1 text-[12px] ${
              card?.type === type ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-200'
            }`}
          >
            {JOINT_TYPE_LABEL[type]}
          </button>
        ))}
      </div>
      {card?.picks?.length === 1 && (
        <button
          type="button"
          data-joint-ground=""
          onClick={() => set({ type: 'fixed', userPickedType: true })}
          className="self-start rounded-md bg-gray-800 px-2 py-1 text-[12px] text-gray-100"
        >
          Ground
        </button>
      )}
      {distance && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-300" data-joint-value-caption="">
            {lengthCaption('Distance', unit)}
          </span>
          <input
            data-joint-value=""
            inputMode="decimal"
            value={valueText(card.valueMm, unit)}
            onChange={(event) => set({ valueMm: displayToMm(event.target.value, unit) })}
            className="min-h-[36px] rounded border border-gray-600/80 bg-gray-950/70 px-2 text-white"
          />
        </label>
      )}
      {angle && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-300" data-joint-angle-caption="">
            Angle °
          </span>
          <input
            data-joint-angle=""
            inputMode="decimal"
            value={Number.isFinite(Number(card.valueMm)) ? String(card.valueMm) : ''}
            onChange={(event) => {
              const raw = event.target.value.trim();
              set({ valueMm: raw === '' ? NaN : Number(raw) });
            }}
            className="min-h-[36px] rounded border border-gray-600/80 bg-gray-950/70 px-2 text-white"
          />
        </label>
      )}
      {(distance || angle) && (
        <button
          type="button"
          data-joint-flip=""
          onClick={() => set({ sense: card.sense === -1 ? 1 : -1 })}
          className="self-start rounded-md bg-gray-800 px-2 py-1 text-[12px] text-gray-100"
        >
          Flip
        </button>
      )}
    </div>
  );
}

export default function JointCard({
  card,
  unit = 'mm',
  onChange,
  onConfirm,
  onCancel,
  onDelete,
  compact = false,
  locked = false,
}) {
  const [liveUnit, setLiveUnit] = useState(unit);
  useEffect(() => setLiveUnit(unit), [unit]);
  useEffect(() => subscribeDisplayUnit(setLiveUnit), []);
  if (!card) return null;
  const suggestion = card.suggested ? JOINT_TYPE_LABEL[card.suggested] : '';
  const note = (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {suggestion ? (
        <span data-joint-suggestion={card.suggested} className="text-[11px] text-gray-300">
          {`Suggested: ${suggestion}`}
        </span>
      ) : null}
      {card.note ? (
        <span data-joint-note="" className="text-[11px] text-red-300">{card.note}</span>
      ) : null}
      {card.mode === 'edit' && (
        <button
          type="button"
          data-joint-delete=""
          onClick={onDelete}
          className="self-start text-[12px] font-medium text-red-400"
        >
          Delete
        </button>
      )}
    </div>
  );
  return (
    <FeatureSheet
      title="Joint"
      subtitle={jointSubtitle(card.picks)}
      onCancel={onCancel}
      onConfirm={onConfirm}
      confirmDisabled={jointConfirmDisabled({ card, locked })}
      note={note}
      compact={compact}
      cardAttrs={{
        'data-joint-card': '',
        'data-joint-id': card.id || '',
        'data-joint-type': card.type || '',
      }}
    >
      <JointModeChip card={card} unit={liveUnit} onChange={onChange} />
    </FeatureSheet>
  );
}
