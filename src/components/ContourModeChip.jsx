import React from 'react';
import { Check } from 'lucide-react';

/**
 * Slice 24/25/26/28/30 — contour-mode chip (Edge-pick pattern).
 * Plane + profile params; Extrude / Revolve / Loft / Sweep entries also edit
 * solid params and Confirm commits the solid. Mobile-first compact card.
 */
const ContourModeChip = ({
  tool = 'circle',
  entry = 'crossSection',
  params = {},
  extrude = {},
  revolve = {},
  loft = {},
  sweep = {},
  sweepPath = null,
  pickMode = 'face',
  planeLabel = 'default +Z',
  onParamChange,
  onExtrudeChange,
  onRevolveChange,
  onSweepChange,
  onPickPath,
  onPickPlane,
  onSelectLoftProfile,
  onAddLoftProfile,
  onRemoveLoftProfile,
  onLoftOffsetChange,
  onConfirm,
  onUndoPoint,
  onClearPoints,
  savedContours = [],
  pickedContourId = null,
  onPickSaved,
  compact = false,
}) => {
  const isExtrude = entry === 'makeExtrude';
  const isRevolve = entry === 'makeRevolve';
  const isLoft = entry === 'makeLoft';
  const isSweep = entry === 'makeSweep';
  const commitName = isSweep ? 'Sweep' : isLoft ? 'Loft' : isRevolve ? 'Revolve' : isExtrude ? 'Extrude' : null;
  const loftProfiles = Array.isArray(loft.profiles) ? loft.profiles : [];
  const loftSelected = Number.isInteger(loft.selected) ? loft.selected : 0;
  const loftOffset = Number(loftProfiles[loftSelected]?.offset);
  const loftOffsetVal = Number.isFinite(loftOffset) ? loftOffset : 0;
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
          compact
            ? ((isLoft || isSweep)
              ? 'bottom-4 right-2 max-w-[min(18rem,calc(100%-5.5rem))]'
              : 'bottom-4 right-2 max-w-[min(16rem,calc(100%-5.5rem))]')
            : ((isLoft || isSweep)
              ? 'bottom-4 right-2 lg:right-4 max-w-[18rem]'
              : 'bottom-4 right-2 lg:right-4 max-w-[16rem]')
        }`}
    >
      <div className="font-bold font-sans text-cyan-200">
        Contour · {tool}
      </div>
      <div className="text-[10px] text-cyan-100/90 normal-case font-sans mt-0.5">
        Plane · {planeLabel}
      </div>
      <div className="mt-1.5 font-sans" role="group" aria-label="Saved contours">
        <div className="text-[10px] uppercase tracking-wide text-cyan-200/80">
          Saved · {savedContours.length}
        </div>
        {savedContours.length === 0 ? (
          <p className="mt-0.5 text-[10px] text-cyan-100/80 leading-tight" role="status">
            No saved contours yet. Confirm Profile, or draw one here.
          </p>
        ) : (
          <div className="mt-0.5 flex flex-col gap-0.5 max-h-16 overflow-y-auto">
            {savedContours.map((c) => {
              const active = c.id === pickedContourId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPickSaved?.(c.id)}
                  aria-pressed={active}
                  title={`Use ${c.label}`}
                  className={`truncate rounded px-1.5 py-0.5 text-left text-[11px] ${
                    active
                      ? 'bg-amber-500 text-amber-950'
                      : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-1.5 font-sans">
        {fields}
      </div>
      {isRevolve && (
        <div className="mt-2 pt-1.5 border-t border-cyan-700/50 flex flex-col gap-1.5 font-sans">
          <div className="text-[10px] uppercase tracking-wide text-cyan-200/80">Revolve</div>
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">Angle</span>
            <div className="flex items-center gap-1.5">
              <input
                type="range"
                value={Number.isFinite(Number(revolve.angle)) ? Number(revolve.angle) : 360}
                min={0.1}
                max={360}
                step={1}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onRevolveChange?.({
                    ...revolve,
                    angle: Number.isFinite(n) ? n : revolve.angle,
                  });
                }}
                className="flex-1 min-w-0 accent-cyan-400"
                aria-label="Angle"
              />
              <input
                type="number"
                value={revolve.angle ?? ''}
                min={0.1}
                max={360}
                step="any"
                onChange={(e) => {
                  const raw = e.target.value;
                  let v = raw;
                  if (raw === '' || raw === '-' || raw === '.') v = raw;
                  else {
                    const n = Number(raw);
                    v = Number.isFinite(n) ? n : revolve.angle;
                  }
                  onRevolveChange?.({ ...revolve, angle: v });
                }}
                className="w-14 rounded border border-cyan-700/70 bg-cyan-950/80 px-1 py-0.5
                  text-[11px] tabular-nums text-white"
                aria-label="Angle value"
              />
            </div>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">Axis</span>
            <select
              value={revolve.axis || 'v'}
              onChange={(e) => onRevolveChange?.({ ...revolve, axis: e.target.value })}
              className="rounded border border-cyan-700/70 bg-cyan-950/80 px-1.5 py-1 text-[11px] text-white"
              aria-label="Axis"
            >
              <option value="v">along V</option>
              <option value="u">along U</option>
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
                const active = (revolve.sense || 'positive') === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onRevolveChange?.({ ...revolve, sense: opt.id })}
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
      {isLoft && (
        <div className="mt-2 pt-1.5 border-t border-cyan-700/50 flex flex-col gap-1.5 font-sans">
          <div className="text-[10px] uppercase tracking-wide text-cyan-200/80">Loft profiles</div>
          <div className="flex items-center gap-1 flex-wrap">
            {loftProfiles.map((p, i) => {
              const active = i === loftSelected;
              return (
                <button
                  key={p.id || i}
                  type="button"
                  onClick={() => onSelectLoftProfile?.(i)}
                  className={`px-1.5 py-0.5 rounded text-[11px] ${
                    active ? 'bg-cyan-600 text-white' : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
                  }`}
                  aria-pressed={active}
                  title={`Select profile ${i + 1}`}
                >
                  P{i + 1}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => onAddLoftProfile?.()}
              className="px-1.5 py-0.5 rounded text-[11px] bg-cyan-950/80 text-cyan-100 border border-cyan-700/70"
              title="Add a profile (same workplane, next offset)"
              disabled={loftProfiles.length >= 8}
            >
              +
            </button>
            {loftProfiles.length > 2 && (
              <button
                type="button"
                onClick={() => onRemoveLoftProfile?.(loftSelected)}
                className="px-1.5 py-0.5 rounded text-[11px] text-cyan-200 underline"
                title="Remove selected profile"
              >
                Remove
              </button>
            )}
          </div>
          <label className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-cyan-200/80">Offset</span>
            <div className="flex items-center gap-1.5">
              <input
                type="range"
                value={loftOffsetVal}
                min={-80}
                max={80}
                step={0.5}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onLoftOffsetChange?.(Number.isFinite(n) ? n : loftOffsetVal);
                }}
                className="flex-1 min-w-0 accent-cyan-400"
                aria-label="Offset"
              />
              <input
                type="number"
                value={Number.isFinite(loftOffset) ? loftOffset : ''}
                step="any"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '' || raw === '-' || raw === '.') {
                    onLoftOffsetChange?.(raw);
                    return;
                  }
                  const n = Number(raw);
                  onLoftOffsetChange?.(Number.isFinite(n) ? n : loftOffsetVal);
                }}
                className="w-14 rounded border border-cyan-700/70 bg-cyan-950/80 px-1 py-0.5
                  text-[11px] tabular-nums text-white"
                aria-label="Offset value"
              />
            </div>
          </label>
          <div className="text-[10px] text-cyan-200/70 leading-tight">
            Same plane · offset along normal · min 2
          </div>
        </div>
      )}
      {isSweep && (
        <div className="mt-2 pt-1.5 border-t border-cyan-700/50 flex flex-col gap-1.5 font-sans">
          <div className="text-[10px] uppercase tracking-wide text-cyan-200/80">Path</div>
          <div className="text-[11px] text-cyan-100 leading-tight">
            {sweepPath?.ok
              ? `${sweepPath.path.edgeCount} edge${sweepPath.path.edgeCount === 1 ? '' : 's'} · ${sweepPath.path.closed ? 'loop' : 'chain'} · ${Number(sweepPath.path.length).toFixed(1)} mm`
              : (sweepPath?.message || 'Pick a contiguous edge chain')}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onPickPath?.()}
              aria-pressed={pickMode === 'edge'}
              className={`flex-1 px-1 py-1 rounded text-[11px] ${
                pickMode === 'edge' ? 'bg-cyan-600 text-white' : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
              }`}
              title="Pick the sweep path from edges"
            >
              Path
            </button>
            <button
              type="button"
              onClick={() => onPickPlane?.()}
              aria-pressed={pickMode !== 'edge'}
              className={`flex-1 px-1 py-1 rounded text-[11px] ${
                pickMode !== 'edge' ? 'bg-cyan-600 text-white' : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
              }`}
              title="Pick the profile workplane"
            >
              Plane
            </button>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-cyan-100">
            <input
              type="checkbox"
              checked={!!sweep.reverse}
              onChange={(e) => onSweepChange?.({ ...sweep, reverse: e.target.checked })}
              className="h-3.5 w-3.5 accent-cyan-400"
            />
            Reverse path
          </label>
        </div>
      )}
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
          {commitName
            ? `Confirm writes ${commitName} (adds if part exists)`
            : 'Confirm writes Profile only'}
        </span>
        <button
          type="button"
          onClick={() => onConfirm?.()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium
            bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-400 text-white shrink-0"
          title={
            commitName
              ? `Commit or update ${commitName}. Second Confirm updates the same block.`
              : 'Commit or update in-mode Profile (makeCrossSection). Does not Extrude, Revolve, Loft, or Sweep.'
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
