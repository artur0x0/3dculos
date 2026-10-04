import React from 'react';
import { X } from 'lucide-react';

/**
 * Shared error / soft-fail popup. Always includes an Undo control when an
 * onUndo handler is provided (disabled when canUndo is false).
 */
// Same glass card as the mode chips in docs/POPUP_STYLE.md. Not a rounded pill.
const TONE_CLASS = {
  error: 'bg-red-950/80 border border-red-400/70 text-red-50',
  scrap: 'bg-red-950/80 border border-red-400/70 text-red-50',
  warn: 'bg-amber-950/80 border border-amber-400/70 text-amber-50',
  amber: 'bg-amber-950/80 border border-amber-400/70 text-amber-50',
  cyan: 'bg-cyan-950/80 border border-cyan-400/70 text-cyan-50',
  banner: 'bg-red-950/80 border border-red-400/70 text-red-50',
};

export default function ErrorPopup({
  children,
  title = null,
  tone = 'error',
  onDismiss = null,
  onUndo = null,
  canUndo = false,
  className = '',
  ...rest
}) {
  const handleUndo = () => {
    onUndo?.();
    onDismiss?.();
  };

  return (
    <div
      role="alert"
      data-error-popup=""
      className={`${TONE_CLASS[tone] || TONE_CLASS.error} surface-glass-chip text-xs font-sans font-medium shadow-lg rounded-lg ${className}`}
      {...rest}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {title ? <div className="font-bold mb-1">{title}</div> : null}
          <div className="text-left">{children}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0 pointer-events-auto">
          {typeof onUndo === 'function' && (
            <button
              type="button"
              data-error-undo=""
              onClick={handleUndo}
              disabled={!canUndo}
              className="px-2 py-0.5 rounded-md bg-white/15 hover:bg-white/25
                disabled:opacity-40 disabled:pointer-events-none font-semibold"
              title="Undo"
              aria-label="Undo"
            >
              Undo
            </button>
          )}
          {typeof onDismiss === 'function' && (
            <button
              type="button"
              data-error-dismiss=""
              onClick={onDismiss}
              className="text-white/80 hover:text-white p-0.5"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
