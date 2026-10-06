// components/controls/popupUI.jsx — the one look for every feature popup.
//
// Before this, each popup invented its own: the contour chip had 10px captions
// and slider+box pairs, the fillet chip had different sizes again, and the
// helper param sheet used a grey panel with a slider ONLY when an item happened
// to set `slider: true`. Same job, three designs.
//
// The contour chip's layout won, so it is the reference here — caption over
// control, slider and typed box side by side, sections separated by an
// uppercase label — at a size a notch larger than the original, which was
// cramped on a phone.
//
// Two rules worth keeping:
//   1. **Every number gets both a slider and a typed box.** The slider is for
//      "a bit more", the box for "exactly 12.5". Neither alone is enough, so
//      NumberField never renders one without the other.
//   2. **Accent classes are written out in full.** Tailwind scans source text,
//      so a computed accent class would be purged from the build. Add a
//      colour by extending ACCENTS, never by interpolating.
import React from 'react';

/* Shared accent/text tokens are imported by chips; keep them here. */
/* eslint-disable react-refresh/only-export-components */

export const ACCENTS = {
  cyan: {
    panel: 'bg-cyan-950/80 border-cyan-400/70',
    caption: 'text-cyan-200/80',
    muted: 'text-cyan-100/90',
    field: 'border-cyan-700/70 bg-cyan-950/80',
    range: 'accent-cyan-400',
    chipOn: 'bg-cyan-600 text-white',
    chipOff: 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70',
    confirm: 'bg-cyan-600 hover:bg-cyan-500 text-white',
  },
  amber: {
    panel: 'bg-amber-950/80 border-amber-400/70',
    caption: 'text-amber-200/80',
    muted: 'text-amber-100/90',
    field: 'border-amber-700/70 bg-amber-950/80',
    range: 'accent-amber-400',
    chipOn: 'bg-amber-600 text-white',
    chipOff: 'bg-amber-950/80 text-amber-100 border border-amber-700/70',
    confirm: 'bg-amber-600 hover:bg-amber-500 text-white',
  },
  slate: {
    panel: 'bg-gray-900/80 border-gray-500/60',
    caption: 'text-gray-400',
    muted: 'text-gray-300',
    field: 'border-gray-600/80 bg-gray-950/70',
    range: 'accent-cyan-500',
    chipOn: 'bg-cyan-600 text-white',
    chipOff: 'bg-gray-800/80 text-gray-200 border border-gray-600/80',
    confirm: 'bg-cyan-600 hover:bg-cyan-500 text-white',
  },
};

export const accentOf = (name) => ACCENTS[name] || ACCENTS.slate;

/** Shared type scale. Bigger than the original chips, which were phone-tight. */
export const POPUP_TEXT = {
  title: 'text-sm font-semibold',
  subtitle: 'text-xs',
  caption: 'text-[11px] font-semibold uppercase tracking-wide',
  value: 'text-[13px]',
  note: 'text-xs',
};

/** Uppercase caption over a block of controls. */
export const PopupSection = ({ label, accent = 'slate', children, className = '' }) => {
  const a = accentOf(accent);
  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
      {label && <span className={`${POPUP_TEXT.caption} ${a.caption}`}>{label}</span>}
      {children}
    </div>
  );
};

/**
 * Number control: caption, slider and typed box — always all three.
 * The box is wide enough for a real value (not the old 3.5rem), and both
 * inputs write through the same onChange so they can never disagree.
 */
export const NumberField = ({
  label, value, onChange, min, max, step, accent = 'slate',
  disabled = false, id, className = '',
}) => {
  const a = accentOf(accent);
  const num = Number.isFinite(Number(value)) ? Number(value) : (Number(min) || 0);
  return (
    <PopupSection label={label} accent={accent} className={className}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          value={num}
          min={min ?? 0}
          max={max ?? 100}
          step={step ?? 0.5}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          className={`flex-1 min-w-0 h-1.5 ${a.range} disabled:opacity-40`}
          aria-label={label}
          data-popup-slider={id || label}
        />
        <input
          type="number"
          value={value ?? ''}
          min={min}
          max={max}
          step={step ?? 'any'}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          className={`w-20 shrink-0 rounded border px-2 py-1 tabular-nums text-white
            ${POPUP_TEXT.value} ${a.field} disabled:opacity-40`}
          aria-label={`${label} value`}
          data-popup-number={id || label}
        />
      </div>
    </PopupSection>
  );
};

/** Segmented row — plane axes, loft profiles, tool pickers. */
export const ChoiceRow = ({ label, options, value, onChange, accent = 'slate', children }) => {
  const a = accentOf(accent);
  return (
    <PopupSection label={label} accent={accent}>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((opt) => {
          const val = typeof opt === 'object' ? opt.value : opt;
          const text = typeof opt === 'object' ? (opt.label ?? opt.value) : opt;
          const on = val === value;
          return (
            <button
              key={String(val)}
              type="button"
              onClick={() => onChange?.(val)}
              className={`rounded px-2.5 py-1 ${POPUP_TEXT.value} font-medium
                ${on ? a.chipOn : a.chipOff}`}
              aria-pressed={on}
            >
              {text}
            </button>
          );
        })}
        {children}
      </div>
    </PopupSection>
  );
};

export const SelectField = ({ label, value, onChange, options = [], accent = 'slate' }) => {
  const a = accentOf(accent);
  const val = (o) => (o && typeof o === 'object' ? o.value : o);
  const text = (o) => (o && typeof o === 'object' ? (o.label ?? o.value) : o);
  return (
    <PopupSection label={label} accent={accent}>
      <select
        value={String(value ?? '')}
        onChange={(e) => onChange?.(e.target.value)}
        className={`rounded border px-2 py-1 text-white ${POPUP_TEXT.value} ${a.field}`}
      >
        {options.map((o) => (
          <option key={String(val(o))} value={String(val(o))} className="bg-gray-900">
            {text(o)}
          </option>
        ))}
      </select>
    </PopupSection>
  );
};

export const CheckField = ({ label, checked, onChange, accent = 'slate' }) => {
  const a = accentOf(accent);
  return (
    <label className={`flex items-center gap-2 ${POPUP_TEXT.value} ${a.muted}`}>
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange?.(e.target.checked)}
        className={`h-4 w-4 rounded ${a.range}`}
      />
      {label}
    </label>
  );
};

/** Footer action. `primary` is the accent-filled Confirm. */
export const PopupButton = ({ variant = 'ghost', accent = 'slate', children, ...rest }) => {
  const a = accentOf(accent);
  const look = variant === 'primary'
    ? a.confirm
    : `${a.chipOff} hover:brightness-125`;
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium
        ${POPUP_TEXT.value} ${look} disabled:opacity-50`}
      {...rest}
    >
      {children}
    </button>
  );
};
