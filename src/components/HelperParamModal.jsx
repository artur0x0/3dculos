import React, { useEffect, useMemo, useState } from 'react';
import { X, Check } from 'lucide-react';
import { listBodyNames } from '../utils/helperPaletteSnippets';

/**
 * Slice 10 — param popup for guided helper insert.
 * Confirm → parent builds/inserts; Cancel → no-op.
 */
const HelperParamModal = ({
  item,
  buffer = '',
  onConfirm,
  onCancel,
}) => {
  const params = item?.params || [];
  const bodies = useMemo(() => listBodyNames(buffer), [buffer]);

  const initial = useMemo(() => {
    const o = {};
    for (const p of params) {
      if (p.type === 'body') {
        o[p.name] = bodies.includes(p.default) ? p.default : (bodies[0] || 'part');
      } else {
        o[p.name] = p.default;
      }
    }
    return o;
  }, [item?.id, buffer]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on item/buffer

  const [values, setValues] = useState(initial);

  useEffect(() => {
    setValues(initial);
  }, [initial]);

  if (!item) return null;

  const setField = (name, raw, type) => {
    setValues((prev) => {
      let v = raw;
      if (type === 'number') {
        if (raw === '' || raw === '-' || raw === '.') {
          v = raw;
        } else {
          const n = Number(raw);
          v = Number.isFinite(n) ? n : prev[name];
        }
      } else if (type === 'bool') {
        v = !!raw;
      }
      return { ...prev, [name]: v };
    });
  };

  const handleConfirm = () => {
    const out = { ...values };
    for (const p of params) {
      if (p.type === 'number') {
        const n = Number(out[p.name]);
        out[p.name] = Number.isFinite(n) ? n : p.default;
      }
    }
    onConfirm?.(out);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        role="dialog"
        aria-labelledby="helper-param-title"
        className="w-full max-w-sm max-h-[85dvh] overflow-hidden flex flex-col rounded-lg bg-gray-900 border border-gray-700 shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="min-w-0">
            <h2 id="helper-param-title" className="font-semibold text-sm text-white truncate">
              {item.label}
            </h2>
            <p className="text-[11px] text-gray-400 truncate" title={item.title}>
              {item.title}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onCancel?.()}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 shrink-0"
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3 text-sm text-gray-200">
          {params.length === 0 && (
            <p className="text-xs text-gray-400">No options — confirm to insert.</p>
          )}
          {params.map((p) => (
            <label key={p.name} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                {p.label}
              </span>
              {p.type === 'bool' ? (
                <input
                  type="checkbox"
                  checked={!!values[p.name]}
                  onChange={(e) => setField(p.name, e.target.checked, 'bool')}
                  className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-cyan-500"
                />
              ) : p.type === 'select' || p.type === 'body' ? (
                <select
                  value={String(values[p.name] ?? p.default)}
                  onChange={(e) => setField(p.name, e.target.value, p.type)}
                  className="rounded-md border border-gray-600 bg-gray-950 px-2 py-1.5 text-sm text-white"
                >
                  {(p.type === 'body' ? bodies : p.options || []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="number"
                  value={values[p.name] ?? ''}
                  step={p.step ?? 'any'}
                  min={p.min}
                  onChange={(e) => setField(p.name, e.target.value, 'number')}
                  className="rounded-md border border-gray-600 bg-gray-950 px-2 py-1.5 text-sm text-white tabular-nums"
                />
              )}
            </label>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-700 shrink-0">
          <button
            type="button"
            onClick={() => onCancel?.()}
            className="px-3 py-1.5 rounded-md text-sm text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium
              bg-cyan-600 hover:bg-cyan-500 text-white"
          >
            <Check size={16} />
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};

export default HelperParamModal;
