import React from 'react';
import FeatureSheet from '../FeatureSheet';
import { PARTS_TEXT_INPUT_CLASS, PARTS_TEXT_INPUT_STYLE } from '../../utils/partsChrome';
import { displaySheetNumber, displaySheetStep, displayToMm } from '../../utils/sheetMetal/sheetUnits';

/**
 * Sheet-metal popup controls. Mobile-first: ≥44px tap targets and the shared
 * ≥16px input token (PARTS_TEXT_INPUT_*) so iOS never zooms on focus.
 */

export const SM_TAP = 'min-h-[44px]';

export const SmLabel = ({ children, htmlFor }) => (
  <label htmlFor={htmlFor} className="block text-[11px] font-semibold uppercase tracking-wide text-orange-200/90 mb-1">
    {children}
  </label>
);

export const SmSelect = ({ id, label, value, onChange, options = [], placeholder, disabled = false }) => (
  <div>
    <SmLabel htmlFor={id}>{label}</SmLabel>
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      className={`${PARTS_TEXT_INPUT_CLASS} ${SM_TAP} disabled:opacity-50`}
      style={PARTS_TEXT_INPUT_STYLE}
      data-sm-select={id}
    >
      {placeholder != null && <option value="">{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
      ))}
    </select>
  </div>
);

/** Range + number pair; the number box is the ≥16px token. */
export const SmSlider = ({ id, label, value, onChange, min, max, step = 0.5, unit = 'mm', disabled = false }) => {
  const num = Number.isFinite(Number(value)) ? Number(value) : Number(min) || 0;
  return (
    <div>
      <SmLabel htmlFor={`${id}-n`}>{label}</SmLabel>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={num}
          disabled={disabled}
          onChange={(e) => onChange?.(Number(e.target.value))}
          className={`flex-1 min-w-0 accent-orange-400 h-8 ${disabled ? 'opacity-40' : ''}`}
          aria-label={label}
          data-sm-slider={id}
        />
        <input
          id={`${id}-n`}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(Number(value)) ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value === '' ? '' : Number(e.target.value))}
          className={`${PARTS_TEXT_INPUT_CLASS} !w-24 shrink-0 tabular-nums ${SM_TAP}`}
          style={PARTS_TEXT_INPUT_STYLE}
          aria-label={`${label} value`}
          data-sm-number={id}
          data-field-label={label}
          {...(unit ? { 'data-unit': unit } : null)}
        />
        {unit && <span className="text-xs text-gray-300 w-7 shrink-0">{unit}</span>}
      </div>
    </div>
  );
};

export const SmButton = ({ variant = 'ghost', className = '', children, ...rest }) => {
  const look = variant === 'primary'
    ? 'bg-cyan-600 text-white hover:bg-cyan-500 active:bg-cyan-400'
    : variant === 'danger'
      ? 'bg-red-900/60 text-red-100 hover:bg-red-800/70'
      : 'bg-white/10 text-gray-100 hover:bg-white/20 active:bg-white/25';
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-4 ${SM_TAP} text-base font-medium
        ${look} disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
};

/**
 * A length slider stored in millimetres, shown in `unit` ('mm' | 'in').
 * `onMm` receives millimetres, or '' while the number box is cleared.
 */
export const SmMmSlider = ({
  id, label, mm, onMm, minMm, maxMm, stepMm = 0.5, unit = 'mm',
}) => {
  const min = displaySheetNumber(minMm, unit);
  const max = Math.max(min, displaySheetNumber(maxMm, unit));
  return (
    <SmSlider
      id={id}
      label={label}
      value={displaySheetNumber(mm, unit)}
      min={min}
      max={max}
      step={displaySheetStep(stepMm, unit)}
      unit={unit}
      onChange={(v) => onMm?.(v === '' ? '' : displayToMm(v, unit))}
    />
  );
};

/** mm | in. Display only — the model stays millimetres. */
export const SmUnitToggle = ({ unit = 'mm', onChange }) => (
  <div
    role="group"
    aria-label="Display units"
    data-sm-unit-toggle=""
    className="inline-flex shrink-0 rounded-md bg-black/30 p-0.5"
  >
    {['mm', 'in'].map((u) => (
      <button
        key={u}
        type="button"
        data-sm-unit={u}
        aria-pressed={unit === u}
        onClick={() => onChange?.(u)}
        className={`min-h-[44px] min-w-[44px] rounded px-2 text-base font-medium ${
          unit === u ? 'bg-cyan-600 text-white' : 'text-gray-300 hover:text-white'
        }`}
      >
        {u}
      </button>
    ))}
  </div>
);

/** On/off pill (e.g. Tab "Centered"). */
export const SmToggle = ({ id, label, checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={!!checked}
    onClick={() => onChange?.(!checked)}
    className={`flex w-full items-center justify-between rounded-md px-3 ${SM_TAP} text-base
      ${checked ? 'bg-cyan-600/30 text-cyan-100' : 'bg-white/10 text-gray-200'}`}
    data-sm-toggle={id}
  >
    <span>{label}</span>
    <span className={`h-6 w-11 rounded-full p-0.5 transition-colors ${checked ? 'bg-cyan-600' : 'bg-gray-600'}`}>
      <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </span>
  </button>
);

/**
 * The one sheet-metal shell: the shared feature card.
 * X and Esc call `onClose` and write nothing. There is no swipe.
 * The mm|in toggle sits in the header (the subtitle row), because the
 * shell has no header slot and its title has to stay the dialog name.
 * Confirm stays a 44px button in `footer` — the shell's own confirm is
 * shorter than that target, and this file does not restyle the shell.
 */
export const SmPopup = ({
  title,
  subtitle,
  onClose,
  closeLabel = 'Close',
  children,
  footer = null,
  dataAttr,
  unit = null,
  onUnit = null,
  compact = false,
  cardAttrs = null,
  note = null,
}) => {
  const headerSubtitle = onUnit ? (
    <span className="flex items-center justify-between gap-2">
      <span className="min-w-0 flex-1 truncate">{subtitle}</span>
      <SmUnitToggle unit={unit === 'in' ? 'in' : 'mm'} onChange={onUnit} />
    </span>
  ) : subtitle;
  return (
    <FeatureSheet
      title={title}
      subtitle={headerSubtitle}
      onCancel={onClose}
      compact={compact}
      footer={footer}
      note={note}
      cardAttrs={{
        ...(dataAttr ? { [dataAttr]: '1' } : {}),
        title: closeLabel,
        ...(cardAttrs || {}),
      }}
    >
      <div className="flex flex-col gap-3 py-1">
        {children}
      </div>
    </FeatureSheet>
  );
};
