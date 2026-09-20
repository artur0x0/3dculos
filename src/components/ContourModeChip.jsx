import React from 'react';
import { Check } from 'lucide-react';

/**
 * Slice 24/25 — contour-mode chip (Edge-pick pattern).
 * Plane + profile params; Extrude entry also edits distance / direction / sense
 * and Confirm commits the solid. Mobile-first compact card.
 */
const ContourModeChip = ({
  tool = 'circle',
  entry = 'crossSection',
  params = {},
  extrude = {},
  planeLabel = 'default +Z',
  onParamChange,
  onExtrudeChange,
  onConfirm,
  onUndoPoint,
  onClearPoints,
  compact = false,
}) => {
  const isExtrude = entry === 'makeExtrude';
  const set = (name, raw, type) => {
    let v = raw;
    if (type === 'number') {
      if (raw === '' || raw === '-' || raw === '.') v = raw;
      else {
        const n = Number(raw);
        v = Number.isFinite(n) ? n : params[name];
      }
    } else if (type === 'bool') {
      v = !!raw;
    }
    onParamChange?.({ ...params, [name]: v });
  };

  const numField = (name, label, { min, step, max } = {}) => (
    <label key={name} className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="range"
          value={Number.isFinite(Number(params[name])) ? Number(params[name]) : 0}
          min={min ?? 0.1}
          max={max ?? 80}
          step={step ?? 0.5}
          onChange={(e) => set(name, e.target.value, 'number')}
          className="flex-1 min-w-0 accent-cyan-400"
          aria-label={label}
        />
        <input
          type="number"
          value={params[name] ?? ''}
          min={min}
          step={step ?? 'any'}
          onChange={(e) => set(name, e.target.value, 'number')}
          className="w-14 rounded border border-cyan-700/70 bg-cyan-950/80 px-1 py-0.5
            text-[11px] tabular-nums text-white"
          aria-label={`${label} value`}
        />
      </div>
    </label>
  );

  let fields = null;
  if (tool === 'circle') {
    fields = (
      <>
        {numField('radius', 'Radius', { min: 0.1, step: 0.5, max: 80 })}
        {numField('segments', 'Segments', { min: 3, step: 1, max: 64 })}
      </>
    );
  } else if (tool === 'rectangle') {
    fields = (
      <>
        {numField('width', 'Width', { min: 0.1, step: 0.5, max: 120 })}
        {numField('height', 'Height', { min: 0.1, step: 0.5, max: 120 })}
        <label className="flex items-center gap-2 text-[11px] text-cyan-100">
          <input
            type="checkbox"
            checked={params.centered !== false}
            onChange={(e) => set('centered', e.target.checked, 'bool')}
            className="h-3.5 w-3.5 accent-cyan-400"
          />
          Centered
        </label>
      </>
    );
  } else if (tool === 'polygon') {
    fields = (
      <>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">Polygon</span>
          <select
            value={params.polygonPreset || 'hexagon'}
            onChange={(e) => set('polygonPreset', e.target.value, 'select')}
            className="rounded border border-cyan-700/70 bg-cyan-950/80 px-1.5 py-1 text-[11px] text-white"
          >
            <option value="triangle">triangle</option>
            <option value="square">square</option>
            <option value="pentagon">pentagon</option>
            <option value="hexagon">hexagon</option>
          </select>
        </label>
        {numField('radius', 'Radius', { min: 0.1, step: 0.5, max: 80 })}
      </>
    );
  } else if (tool === 'polyline') {
    const n = Array.isArray(params.points) ? params.points.length : 0;
    fields = (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-cyan-100">{n} pt{n === 1 ? '' : 's'} · tap plane</span>
        {n > 0 && (
          <>
            <button
              type="button"
              className="text-[10px] text-cyan-200 underline"
              onClick={() => onUndoPoint?.()}
            >
              Undo
            </button>
            <button
              type="button"
              className="text-[10px] text-cyan-200 underline"
              onClick={() => onClearPoints?.()}
            >
              Clear
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={`absolute bg-cyan-950/90 border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg ${
          compact ? 'bottom-4 right-2 max-w-[min(16rem,calc(100%-5.5rem))]' : 'bottom-4 right-2 lg:right-4 max-w-[16rem]'
        }`}
    >
      <div className="font-bold font-sans text-cyan-200">
        Contour · {tool}
      </div>
      <div className="text-[10px] text-cyan-100/90 normal-case font-sans mt-0.5">
        Plane · {planeLabel}
      </div>
      <div className="mt-1.5 flex flex-col gap-1.5 font-sans">
        {fields}
      </div>
      {isExtrude && (
        <div className="mt-2 pt-1.5 border-t border-cyan-700/50 flex flex-col gap-1.5 font-sans">
          <div className="text-[10px] uppercase tracking-wide text-cyan-200/80">Extrude</div>
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">Distance</span>
            <div className="flex items-center gap-1.5">
              <input
                type="range"
                value={Number.isFinite(Number(extrude.distance)) ? Number(extrude.distance) : 10}
                min={0.1}
                max={80}
                step={0.5}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onExtrudeChange?.({
                    ...extrude,
                    distance: Number.isFinite(n) ? n : extrude.distance,
                  });
                }}
                className="flex-1 min-w-0 accent-cyan-400"
                aria-label="Distance"
              />
              <input
                type="number"
                value={extrude.distance ?? ''}
                min={0.1}
                step="any"
                onChange={(e) => {
                  const raw = e.target.value;
                  let v = raw;
                  if (raw === '' || raw === '-' || raw === '.') v = raw;
                  else {
                    const n = Number(raw);
                    v = Number.isFinite(n) ? n : extrude.distance;
                  }
                  onExtrudeChange?.({ ...extrude, distance: v });
                }}
                className="w-14 rounded border border-cyan-700/70 bg-cyan-950/80 px-1 py-0.5
                  text-[11px] tabular-nums text-white"
                aria-label="Distance value"
              />
            </div>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">Direction</span>
            <select
              value={extrude.direction || 'normal'}
              onChange={(e) => onExtrudeChange?.({ ...extrude, direction: e.target.value })}
              className="rounded border border-cyan-700/70 bg-cyan-950/80 px-1.5 py-1 text-[11px] text-white"
              aria-label="Direction"
            >
              <option value="normal">along plane</option>
              <option value="x">+X</option>
              <option value="y">+Y</option>
              <option value="z">+Z</option>
            </select>
          </label>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">Sense</span>
            <div className="flex rounded border border-cyan-700/70 overflow-hidden">
              {[
                { id: 'positive', label: 'Out' },
                { id: 'negative', label: 'In' },
                { id: 'both', label: 'Both' },
              ].map((opt) => {
                const active = (extrude.sense || 'positive') === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onExtrudeChange?.({ ...extrude, sense: opt.id })}
                    className={`flex-1 px-1 py-0.5 text-[11px] ${
                      active ? 'bg-cyan-600 text-white' : 'bg-cyan-950/80 text-cyan-100'
                    }`}
                    aria-pressed={active}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-cyan-200/70 leading-tight">
          {isExtrude ? 'Confirm writes Extrude' : 'Confirm writes Profile only'}
        </span>
        <button
          type="button"
          onClick={() => onConfirm?.()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
            bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-400 text-white shrink-0"
          title={
            isExtrude
              ? 'Commit or update Extrude (profile + makeExtrude). Second Confirm updates the same block.'
              : 'Commit or update in-mode Profile (makeCrossSection). Does not Extrude.'
          }
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default ContourModeChip;
