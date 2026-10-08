import React from 'react';
import { Check, X } from 'lucide-react';
import { PAINT_SWATCHES, parsePaintHex, resolvedPaintColor } from '../utils/facePaint';

/**
 * Paint popup. Same card as Shell: between the rails, cyan glass, grey X
 * exits with no write. A tap paints immediately. Confirm writes the session.
 * Cancel writes nothing. The button that opens it lives on the right rail
 * (`data-paint-chip`).
 */
export function PaintModeChip({
  compact = false,
  color = null,
  custom = '',
  canUndo = false,
  canClear = false,
  canConfirm = false,
  unmatched = 0,
  onSwatch,
  onCustom,
  onPart,
  onUndo,
  onClear,
  onConfirm,
  onDismiss,
  onRemoveUnmatched,
}) {
  const typed = typeof custom === 'string' ? custom.trim() : '';
  const resolved = resolvedPaintColor(color, custom);
  const customInvalid = typed !== '' && !parsePaintHex(typed);

  return (
    <div
      className={`absolute bg-cyan-950/80 surface-glass-chip border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 pointer-events-auto ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(18rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[20rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Paint"
      data-paint-mode="1"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">Paint</div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            Tap a face. Double-tap paints the body.
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit paint mode without saving"
          aria-label="Exit paint mode without saving"
          data-paint-dismiss=""
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0">
        <div
          className="flex flex-wrap gap-1.5 p-1"
          role="group"
          aria-label="Swatches"
          data-paint-swatches=""
        >
          {PAINT_SWATCHES.map((hex) => {
            const on = !typed && color === hex;
            return (
              <button
                key={hex}
                type="button"
                data-paint-swatch={hex}
                aria-pressed={on}
                aria-label={hex}
                title={hex}
                onClick={() => onSwatch?.(hex)}
                className={`h-7 w-7 shrink-0 rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 ${
                  on ? 'border-white ring-2 ring-cyan-200' : 'border-white/40'
                }`}
                style={{ background: hex }}
              />
            );
          })}
        </div>

        <label className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-cyan-100/80">Hex</span>
          <input
            data-paint-hex=""
            value={custom}
            onChange={(event) => onCustom?.(event.target.value.toLowerCase())}
            placeholder="#rrggbb"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Custom hex color"
            aria-invalid={customInvalid}
            className={`min-w-0 flex-1 rounded border bg-cyan-950/50 px-2 py-1 font-mono text-base text-white ${
              customInvalid ? 'border-red-400/80' : 'border-cyan-700/70'
            }`}
          />
        </label>

        <div className="flex gap-1 flex-wrap" role="group" aria-label="Paint target">
          <button
            type="button"
            data-paint-part=""
            onClick={() => onPart?.()}
            className="px-2.5 py-1 rounded text-[13px] bg-cyan-950/80 text-cyan-100 border border-cyan-700/70"
            title="Paint the whole part"
          >
            Part
          </button>
          <button
            type="button"
            data-paint-undo=""
            onClick={() => onUndo?.()}
            disabled={!canUndo}
            className={`px-2.5 py-1 rounded text-[13px] underline ${
              canUndo ? 'text-cyan-200' : 'text-cyan-400/40 cursor-not-allowed'
            }`}
            title="Step back one paint"
          >
            Undo
          </button>
          <button
            type="button"
            data-paint-clear=""
            onClick={() => onClear?.()}
            disabled={!canClear}
            className={`px-2.5 py-1 rounded text-[13px] underline ${
              canClear ? 'text-cyan-200' : 'text-cyan-400/40 cursor-not-allowed'
            }`}
            title="Remove the paints from this session"
          >
            Clear
          </button>
        </div>

        {unmatched > 0 && (
          <button
            type="button"
            data-paint-unmatched=""
            onClick={() => onRemoveUnmatched?.()}
            className="self-start text-[11px] text-cyan-200/80 underline"
            title="Drop saved face colors on this part that no longer match one face"
          >
            Remove unmatched colors
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center justify-end gap-2 shrink-0">
        <span
          className="mr-auto h-4 w-4 rounded-full border border-white/40"
          data-paint-preview=""
          style={{ background: resolved || 'transparent' }}
        />
        <button
          type="button"
          data-paint-cancel=""
          onClick={() => onDismiss?.()}
          className="px-2 py-1 rounded-md text-[13px] text-gray-300 hover:text-white"
          title="Leave paint mode without saving"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm?.()}
          disabled={!canConfirm}
          data-paint-confirm={canConfirm ? 'enabled' : 'disabled'}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium shrink-0 ${
            canConfirm
              ? 'bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-400 text-white'
              : 'bg-cyan-950/80 text-cyan-400/50 border border-cyan-800/60 cursor-not-allowed'
          }`}
          title={canConfirm ? 'Save colors and close' : 'Enter a valid hex color'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
}
