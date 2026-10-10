import React, { useState } from 'react';
import StickyPickApply from './StickyPickApply';
import { useDisplayUnit } from '../hooks/useDisplayUnit';
import { displayToMm, lengthToDisplay } from '../utils/displayUnit';
import {
  CONSTRAINT_LABELS,
  DIMENSION_LABELS,
  prefillForKind,
  suggestContourArc,
  suggestContourConstraint,
  suggestContourDimension,
  validateDimensionName,
} from '../utils/contourGesture';

const FIELD = 'w-full rounded border border-cyan-700/70 bg-cyan-950/80 px-2.5 py-1 text-[16px] text-white';

function formatPrefill(kind, mm, unit) {
  const n = kind === 'angle' ? Number(mm) : lengthToDisplay(mm, unit);
  if (!Number.isFinite(n)) return '';
  const digits = kind === 'angle' ? 2 : (unit === 'in' ? 4 : 2);
  return String(Number(n.toFixed(digits)));
}

function seedText(isArc, arc, suggestion, unit) {
  if (isArc) return formatPrefill('length', arc?.radius || 0, unit);
  return suggestion?.kind ? formatPrefill(suggestion.kind, suggestion.value, unit) : '';
}

/**
 * Dimension, Arc, and Constraints cards. All are StickyPickApply.
 * Confirm saves the contour and stays in the gesture. X drops the pick
 * and writes nothing.
 */
const ContourGestureCard = ({
  gesture = 'dimension',
  model = null,
  picks = [],
  note = '',
  compact = false,
  onRemovePick,
  onApply,
  onCancel,
}) => {
  const [unit] = useDisplayUnit();
  const isArc = gesture === 'arc';
  const isConstraint = gesture === 'constraints';
  const suggestion = isArc || isConstraint ? null : suggestContourDimension(model, picks);
  const arc = isArc ? suggestContourArc(model, picks) : null;
  const constraint = isConstraint ? suggestContourConstraint(model, picks) : null;
  const pickKey = (picks || []).map((p) => `${p.kind}:${p.id}`).join(',');
  const gestureKey = isConstraint ? 'constraints' : (isArc ? 'arc' : 'dimension');
  const sessionKey = `${gestureKey}|${unit}|${pickKey}`;
  const seededKind = isConstraint ? (constraint?.kind || '') : (suggestion?.kind || '');
  const [property, setProperty] = useState(seededKind);
  const [text, setText] = useState(() => (isConstraint ? '' : seedText(isArc, arc, suggestion, unit)));
  const [name, setName] = useState('');
  const [filledKey, setFilledKey] = useState(sessionKey);
  // A new pick or unit refills before paint. Typing keeps the same key.
  if (filledKey !== sessionKey) {
    setFilledKey(sessionKey);
    setProperty(isArc ? '' : seededKind);
    setText(isConstraint ? '' : seedText(isArc, arc, suggestion, unit));
  }

  const kinds = (isConstraint ? constraint?.kinds : suggestion?.kinds) || [];
  const active = property || (isConstraint ? constraint?.kind : suggestion?.kind);
  const prefill = !isArc && !isConstraint && active ? prefillForKind(model, picks, active) : null;
  const nameCheck = isArc || isConstraint ? { ok: true, name: '' } : validateDimensionName(name, model);
  let valueMm = NaN;
  if (isArc || active !== 'angle') valueMm = displayToMm(text, unit);
  else valueMm = Number(text);
  const valueOk = Number.isFinite(valueMm) && (isArc || active !== 'length' && active !== 'radius' ? true : valueMm > 0);
  const lengthOk = isArc || active === 'length' || active === 'radius' ? valueMm > 0 : Number.isFinite(valueMm);
  const ready = isArc
    ? !!(arc?.ok && lengthOk)
    : isConstraint
      ? !!(constraint?.ok && active && kinds.includes(active))
      : !!(suggestion?.ok && active && nameCheck.ok && lengthOk && valueOk);

  const apply = () => {
    if (!ready) return;
    if (isArc) onApply?.({ radiusMm: valueMm });
    else if (isConstraint) onApply?.({ kind: active, side: constraint.side });
    else {
      onApply?.({
        kind: active,
        valueMm,
        name: nameCheck.name || '',
        side: prefill?.side ?? suggestion.side,
        sense: prefill?.sense ?? suggestion.sense,
      });
    }
  };

  const shownNote = note
    || (!nameCheck.ok ? nameCheck.message : '')
    || (isArc ? arc?.note : isConstraint ? constraint?.note : suggestion?.note)
    || '';
  const title = isArc ? 'Arc' : isConstraint ? 'Constrain' : 'Dimension';
  const labels = isConstraint ? CONSTRAINT_LABELS : DIMENSION_LABELS;

  return (
    <StickyPickApply
      title={title}
      subtitle={isArc ? 'Round a corner' : isConstraint ? 'Add a constraint' : 'Add a dimension'}
      picks={picks}
      max={isArc ? 3 : 2}
      properties={(kinds || []).map((id) => ({
        id,
        label: labels[id] || id,
        icon: isConstraint ? id : undefined,
      }))}
      property={active || ''}
      onProperty={(id) => {
        setProperty(id);
        if (isConstraint) return;
        const filled = prefillForKind(model, picks, id);
        setText(formatPrefill(id, filled.value, unit));
      }}
      onRemovePick={onRemovePick}
      onApply={apply}
      onCancel={onCancel}
      applyLabel={isArc ? 'Round' : 'Confirm'}
      applyDisabled={!ready}
      note={shownNote}
      compact={compact}
      cardAttrs={{ 'data-contour-card': isArc ? 'arc' : isConstraint ? 'constraint' : 'dimension' }}
    >
      {!isConstraint && (
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wide text-cyan-200/80">
          {isArc ? 'Radius' : (DIMENSION_LABELS[active] || 'Value')}
        </span>
        <input
          type="number"
          inputMode="decimal"
          className={FIELD}
          data-field-label={isArc ? 'Radius' : (DIMENSION_LABELS[active] || 'Value')}
          data-unit={(!isArc && active === 'angle') ? '°' : unit}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      )}
      {!isArc && !isConstraint && (
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] uppercase tracking-wide text-cyan-200/80">Name</span>
          <input
            type="text"
            className={FIELD}
            data-field-label="Name"
            value={name}
            placeholder="optional"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      )}
    </StickyPickApply>
  );
};

export default ContourGestureCard;
