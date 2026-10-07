import React from 'react';
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
        />
        {unit && <span className="text-xs text-gray-300 w-7 shrink-0">{unit}</span>}
      </div>
    </div>
  );
};

export const SmButton = ({ variant = 'ghost', className = '', children, ...rest }) => {
  const look = variant === 'primary'
    ? 'bg-orange-500 text-white hover:bg-orange-400 active:bg-orange-600'
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
          unit === u ? 'bg-orange-500 text-white' : 'text-gray-300 hover:text-white'
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
      ${checked ? 'bg-orange-500/30 text-orange-100' : 'bg-white/10 text-gray-200'}`}
    data-sm-toggle={id}
  >
    <span>{label}</span>
    <span className={`h-6 w-11 rounded-full p-0.5 transition-colors ${checked ? 'bg-orange-400' : 'bg-gray-600'}`}>
      <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </span>
  </button>
);

/** Translucent popup shell shared by the picker and feature popups (✕ top-right). */
export const SmPopup = ({
  title, subtitle, onClose, closeLabel = 'Close', children, footer, dataAttr, short = false,
  unit = null, onUnit = null,
}) => (
  <div className="absolute inset-0 z-50 flex items-end justify-center p-3 pointer-events-none" role="presentation">
    <div
      role="dialog"
      aria-label={title}
      className={`pointer-events-auto w-full max-w-sm ${short ? 'max-h-[min(52%,calc(100dvh-8rem))]' : 'max-h-[min(78%,calc(100dvh-8rem))]'} mb-1 overflow-hidden flex flex-col rounded-lg surface-glass border border-orange-500/60 shadow-2xl`}
      {...(dataAttr ? { [dataAttr]: '1' } : {})}
    >
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-gray-700 shrink-0">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white truncate">{title}</h2>
          {subtitle && <p className="text-xs text-gray-300 mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-start gap-1">
          {onUnit && <SmUnitToggle unit={unit === 'in' ? 'in' : 'mm'} onChange={onUnit} />}
          <button
            type="button"
            onClick={() => onClose?.()}
            className="-mr-2 -mt-1 h-11 w-11 shrink-0 inline-flex items-center justify-center rounded text-gray-300 hover:text-white hover:bg-white/10"
            title={closeLabel}
            aria-label={closeLabel}
            data-sm-close="1"
          >
            <span aria-hidden className="text-xl leading-none">✕</span>
          </button>
        </div>
      </div>
      <div className="px-4 py-3 flex flex-col gap-3 overflow-y-auto rail-scroll min-h-0">{children}</div>
      {footer && <div className="px-4 py-3 border-t border-gray-700 shrink-0 flex gap-2 justify-end">{footer}</div>}
    </div>
  </div>
);
