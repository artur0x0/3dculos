import React from 'react';
import StickyPickApply from './StickyPickApply';
import { useDisplayUnit } from '../hooks/useDisplayUnit';
import {
  JOINT_TYPE_LABEL,
  jointConfirmDisabled,
  jointSubtitle,
  stickyJointPick,
} from '../joints/jointUi';
import { displayToMm, lengthCaption, lengthToDisplay } from '../utils/displayUnit';

const TYPES = ['coincident', 'concentric', 'distance', 'angle', 'fixed'];
const PROPERTIES = TYPES.map((id) => ({ id, label: JOINT_TYPE_LABEL[id] }));

function valueText(mm, unit) {
  if (!Number.isFinite(Number(mm))) return '';
  const shown = lengthToDisplay(Number(mm), unit);
  if (!Number.isFinite(shown)) return '';
  const digits = unit === 'in' ? 4 : 2;
  return String(Number(shown.toFixed(digits)));
}

/**
 * Create card. StickyPickApply owns the chrome. The parent owns the
 * fingerprints. A placed joint is not edited here; its tag is Delete / X.
 */
export default function JointCard({
  card,
  unit = null,
  onChange,
  onConfirm,
  onCancel,
  compact = false,
  locked = false,
}) {
  const [liveUnit] = useDisplayUnit();
  const shownUnit = unit || liveUnit;
  if (!card || card.mode === 'edit') return null;
  const set = (patch) => onChange?.({ ...card, ...patch });
  const picks = (card.picks || []).map(stickyJointPick);
  const distance = card.type === 'distance';
  const angle = card.type === 'angle';
  const suggestion = card.suggested ? JOINT_TYPE_LABEL[card.suggested] : '';
  const note = [suggestion ? `Suggested: ${suggestion}` : '', card.note || ''].filter(Boolean).join(' ');
  return (
    <StickyPickApply
      title="Joint"
      subtitle={jointSubtitle(card.picks)}
      picks={picks}
      max={2}
      properties={PROPERTIES}
      property={card.type || ''}
      onProperty={(id) => set({ type: id, userPickedType: true })}
      onRemovePick={(pick) => {
        const next = (card.picks || []).filter((row, index) => stickyJointPick(row, index).id !== pick.id);
        set({ picks: next });
      }}
      onApply={onConfirm}
      onCancel={onCancel}
      applyLabel="Add"
      applyDisabled={jointConfirmDisabled({ card, locked })}
      note={note}
      compact={compact}
      cardAttrs={{
        'data-joint-card': '',
        'data-joint-id': card.id || '',
        'data-joint-type': card.type || '',
        ...(suggestion ? { 'data-joint-suggestion': card.suggested } : {}),
      }}
    >
      <div className="flex flex-col gap-2" data-joint-body="">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-cyan-200/80">Name</span>
          <input
            data-joint-name=""
            value={card.name || ''}
            onChange={(event) => set({ name: event.target.value, userNamed: true })}
            className="min-h-[36px] rounded border border-cyan-700/70 bg-cyan-950/80 px-2 text-white"
          />
        </label>
        {card.picks?.length === 1 && (
          <button
            type="button"
            data-joint-ground=""
            onClick={() => set({ type: 'fixed', userPickedType: true })}
            className="self-start rounded-md border border-cyan-700/70 bg-cyan-950/80 px-2 py-1 text-[12px] text-cyan-100"
          >
            Ground
          </button>
        )}
        {distance && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-cyan-200/80" data-joint-value-caption="">
              {lengthCaption('Distance', shownUnit)}
            </span>
            <input
              data-joint-value=""
              inputMode="decimal"
              value={valueText(card.valueMm, shownUnit)}
              onChange={(event) => set({ valueMm: displayToMm(event.target.value, shownUnit) })}
              className="min-h-[36px] rounded border border-cyan-700/70 bg-cyan-950/80 px-2 text-white"
            />
          </label>
        )}
        {angle && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-cyan-200/80" data-joint-angle-caption="">
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
              className="min-h-[36px] rounded border border-cyan-700/70 bg-cyan-950/80 px-2 text-white"
            />
          </label>
        )}
        {(distance || angle) && (
          <button
            type="button"
            data-joint-flip=""
            onClick={() => set({ sense: card.sense === -1 ? 1 : -1 })}
            className="self-start rounded-md border border-cyan-700/70 bg-cyan-950/80 px-2 py-1 text-[12px] text-cyan-100"
          >
            Flip
          </button>
        )}
      </div>
    </StickyPickApply>
  );
}
