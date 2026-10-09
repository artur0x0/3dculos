import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';

/**
 * Danger control matching the feature sheet's Delete
 * (`border-red-700/60`, `bg-red-950/50`, `text-red-200`).
 * Callers place it on the opposite side of the row from Confirm.
 */
export function FeatureDeleteButton({ onClick }) {
  return (
    <button
      type="button"
      data-feature-edit-delete=""
      aria-label="Delete feature"
      title="Delete this feature from the script"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[13px]
        font-medium text-red-200 border border-red-700/60 bg-red-950/50
        hover:bg-red-900/70 hover:text-white shrink-0"
    >
      <Trash2 size={14} aria-hidden="true" />
      Delete
    </button>
  );
}

/**
 * Short confirm for deleting the feature that is open in the creation dialog.
 * Dependents are listed before the script changes. Escape and Cancel leave
 * the edit dialog up.
 */
export function FeatureDeleteConfirm({
  open = false,
  label = 'this feature',
  dependents = [],
  onCancel,
  onConfirm,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  const card = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center surface-scrim p-4"
      data-feature-edit-delete-dialog=""
      role="dialog"
      aria-modal="true"
      aria-labelledby="feature-edit-delete-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel?.();
      }}
    >
      <div
        className="w-full max-w-sm rounded-lg surface-glass border border-gray-700 p-4 shadow-xl"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="feature-edit-delete-title" className="text-sm font-semibold text-gray-100">
          {`Delete ${label}?`}
        </h2>
        <p className="mt-2 text-xs text-gray-300">
          Remove this feature from the script and rebuild the part. Undo puts it back.
        </p>
        {dependents.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs text-amber-200" data-feature-edit-dependents="">
            {dependents.map((item) => (
              <li
                key={`${item.id || 'gap'}:${item.reason}:${item.name || ''}`}
                data-feature-edit-dependent=""
                data-feature-edit-dependent-reason={item.reason}
              >
                {item.message}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            data-feature-edit-delete-cancel=""
            className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
            onClick={() => onCancel?.()}
          >
            Cancel
          </button>
          <button
            type="button"
            data-feature-edit-delete-confirm=""
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium
              text-red-100 border border-red-700/60 bg-red-950/70 hover:bg-red-900"
            onClick={() => onConfirm?.()}
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return card;
  return createPortal(card, document.body);
}
