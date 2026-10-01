import React from 'react';
import { Check, X } from 'lucide-react';
import { NumberField } from './controls/popupUI';

const ACCENT = 'cyan';

/**
 * Shell face-pick chip — ContourModeChip / FilletModeChip placement + chrome.
 * Tap a face to define the opening; Wall thickness stays editable; Closed is
 * the no-opening hollow. Confirm writes SHELL markers; grey X exits cleanly.
 */
const ShellModeChip = ({
  face = null,
  params = {},
  compact = false,
  onParamChange,
  onClearFace,
  onConfirm,
  onDismiss,
}) => {
  const openingMode = params.openingMode === 'none' ? 'none' : 'face';
  const closed = openingMode === 'none';
  const faceCount = Array.isArray(face?.group) && face.group.length > 1
    ? face.group.length
    : (face ? 1 : 0);
  const wall = params.wall;
  const wallNum = Number(wall);
  const max = Math.max(20, Number.isFinite(wallNum) ? wallNum : 0);

  const setWall = (raw) => {
    let v = raw;
    if (raw === '' || raw === '-' || raw === '.') v = raw;
    else {
      const n = Number(raw);
      v = Number.isFinite(n) ? n : params.wall;
    }
    onParamChange?.({ ...params, wall: v });
  };

  const setMode = (mode) => {
    onParamChange?.({ ...params, openingMode: mode });
  };

  let status;
  if (closed) {
    status = 'Closed hollow — no opening face';
  } else if (faceCount > 1) {
    status = `${faceCount} faces · openings at each pick (shift-click to add)`;
  } else if (face) {
    const kind = face.type || 'planar';
    status = `Opening · ${kind} face — Confirm writes hollow()`;
  } else {
    status = 'Tap a face to open the shell (shift-click for more)';
  }

  const canConfirm = closed || !!face;

  return (
    <div
      className={`absolute bg-cyan-950/80 surface-glass-chip border border-cyan-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[min(16rem,calc(100%-9rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 max-w-[18rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Shell face pick"
      data-shell-mode="1"
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-cyan-200">
            Shell{faceCount ? ` · ${faceCount} face${faceCount === 1 ? '' : 's'}` : ''}
          </div>
          <div className="text-[11px] text-cyan-100/90 normal-case font-sans mt-0.5">
            {status}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="shrink-0 text-gray-400 hover:text-white"
          title="Exit Shell mode without committing"
          aria-label="Dismiss Shell mode without committing"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="mt-1.5 flex flex-col gap-1.5 font-sans overflow-y-auto rail-scroll min-h-0"
        data-shell-chip-scroll=""
      >
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Opening">
          <button
            type="button"
            onClick={() => setMode('face')}
            aria-pressed={!closed}
            className={`px-2.5 py-1 rounded text-[13px] ${
              !closed
                ? 'bg-cyan-600 text-white'
                : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
            }`}
            title="Opening at the picked face(s)"
          >
            Face
          </button>
          <button
            type="button"
            onClick={() => setMode('none')}
            aria-pressed={closed}
            className={`px-2.5 py-1 rounded text-[13px] ${
              closed
                ? 'bg-cyan-600 text-white'
                : 'bg-cyan-950/80 text-cyan-100 border border-cyan-700/70'
            }`}
            title="Closed hollow — no opening"
          >
            Closed
          </button>
          {faceCount > 0 && !closed && (
            <button
              type="button"
              className="px-2.5 py-1 rounded text-[13px] text-cyan-200 underline"
              onClick={() => onClearFace?.()}
              title="Clear picked opening faces"
            >
              Clear
            </button>
          )}
        </div>

        <NumberField
          id="shell-wall"
          label="Wall"
          accent={ACCENT}
          value={wall}
          onChange={setWall}
          min={0.1}
          max={max}
          step={0.25}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[11px] text-cyan-200/70 leading-tight">
          hollow(body, wall, opening)
        </span>
        <button
          type="button"
          onClick={() => onConfirm?.()}
          disabled={!canConfirm}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium shrink-0 ${
            canConfirm
              ? 'bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-400 text-white'
              : 'bg-cyan-950/80 text-cyan-400/50 border border-cyan-800/60 cursor-not-allowed'
          }`}
          data-shell-confirm={canConfirm ? 'enabled' : 'disabled'}
          title={canConfirm
            ? 'Commit hollow() with the face opening (or Closed) and leave Shell mode.'
            : 'Tap a face or choose Closed first'}
        >
          <Check size={14} />
          Confirm
        </button>
      </div>
    </div>
  );
};

export default ShellModeChip;
