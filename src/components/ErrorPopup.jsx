import React from 'react';
import { X } from 'lucide-react';

/**
 * Shared error / soft-fail popup. Always includes an Undo control when an
 * onUndo handler is provided (disabled when canUndo is false).
 */
const TONE_CLASS = {
  error: 'bg-red-900/85 text-white',
  scrap: 'bg-red-950/85 border border-red-400/80 text-red-50',
  warn: 'bg-amber-700/85 text-white',
  amber: 'bg-amber-600/85 text-white',
  cyan: 'bg-cyan-700/85 text-white',
  banner: 'bg-red-900/90 text-white',
};

export default function ErrorPopup({
  children,
  title = null,
  tone = 'error',
  onDismiss = null,
  onUndo = null,
  canUndo = false,
  rounded = 'rounded-lg',
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
      className={`${TONE_CLASS[tone] || TONE_CLASS.error} surface-glass-chip text-xs font-sans font-medium shadow-lg ${rounded} ${className}`}
      {...rest}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {title ? <div className="font-bold mb-1">{title}</div> : null}
          <div className={title || tone === 'banner' || tone === 'error' ? 'text-left' : 'text-center'}>{children}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0 pointer-events-auto">
          {typeof onUndo === 'function' && (
            <button
              type="button"
              data-error-undo=""
              onClick={handleUndo}
              disabled={!canUndo}
              className="px-2 py-0.5 rounded bg-white/15 hover:bg-white/25
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
