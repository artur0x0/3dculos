import React from 'react';
import { LengthNumberField } from './controls/popupUI';
import { growToFit } from '../utils/sliderRange';
import { FeatureDeleteButton } from './FeatureEditDelete';
import FeatureSheet from './FeatureSheet';

/**
 * Fillet / Chamfer on the shared feature card.
 * Tangent (default-on) / Clear / Undo (= last edge pick only) / Confirm.
 * X / Escape / dismiss without Confirm clears all picks and exits.
 * Easy/hard class still chooses the kernel on Confirm; the card does not warn.
 * Picks can span parts; `partCount` > 1 says so, and Confirm writes each part.
 */
const FilletModeChip = ({
  kind = 'fillet',
  edgeCount = 0,
  partCount = 1,
  tangentOn = true,
  params = {},
  pathOk = false,
  componentCount = 0,
  compact = false,
  onToggleTangent,
  onClear,
  onAccept,
  onBack,
  onDismiss,
  onParamChange,
  missingLabel = '',
  onClearMissing,
  onDelete = null,
}) => {
  const chamfer = kind === 'chamfer';
  const sizeKey = chamfer ? 'chamfer' : 'radius';
  const setSize = (raw) => {
    let v = raw;
    if (raw === '' || raw === '-' || raw === '.') v = raw;
    else {
      const n = Number(raw);
      v = Number.isFinite(n) ? n : params[sizeKey];
    }
    onParamChange?.(
      { ...params, [sizeKey]: v },
      chamfer ? { sizeTouched: true } : { radiusTouched: true },
    );
  };

  const size = params[sizeKey];
  const sizeNum = Number(size);
  const baseMax = Number(params._blendMax) > 0
    ? Number(params._blendMax)
    : (chamfer
      ? 40
      : (Number(params._sweepMax) > 0 ? Number(params._sweepMax) : 40));
  const baseMin = Number(params._blendMin) > 0 ? Number(params._blendMin) : 0.1;
  const fit = growToFit(Math.min(baseMin, baseMax), baseMax, Number.isFinite(sizeNum) ? sizeNum : baseMin);
  const title = chamfer ? 'Chamfer' : 'Fillet';
  const heading = `${title} · ${edgeCount} edge${edgeCount === 1 ? '' : 's'}`;
  const subtitle = pathOk
    ? (componentCount > 1
      ? `${componentCount} independent ${chamfer ? 'chamfers' : 'fillets'} · Confirm commits and exits`
      : (chamfer
        ? 'Sweep chamfer preview · Confirm commits and exits'
        : 'Sweep blend preview · Confirm commits and exits'))
    : edgeCount
      ? 'Path not ready — branched picks need a simple chain (Tangent on)'
      : (chamfer ? 'Tap edges, then Confirm' : 'Tap edges — shallow blend tessellation is not pickable');

  return (
    <FeatureSheet
      title={heading}
      subtitle={subtitle}
      compact={compact}
      fullLeft
      onCancel={onDismiss}
      onConfirm={onAccept}
      cardAttrs={{
        'data-edge-blend': chamfer ? 'chamfer' : 'fillet',
        'data-fillet-dismiss': '',
        'data-fillet-accept': 'enabled',
      }}
      note={onDelete ? <FeatureDeleteButton onClick={onDelete} /> : null}
    >
      <div className="mt-1.5 flex flex-col gap-1.5 font-sans">
        <LengthNumberField
          id={chamfer ? 'size' : 'radius'}
          label={chamfer ? 'Size' : 'Radius'}
          accent="cyan"
          valueMm={size}
          onChangeMm={setSize}
          minMm={fit.min}
          maxMm={fit.max}
        />
      </div>
      {partCount > 1 ? (
        <div className="mt-1 font-sans text-[11px] text-gray-300" data-fillet-part-count={partCount}>
          {partCount} parts
        </div>
      ) : null}
      {missingLabel ? (
        <div className="mt-1.5 flex items-center gap-2 font-sans text-[11px] text-gray-200" data-feature-edit-missing="">
          <span>{missingLabel}</span>
          <button
            type="button"
            data-feature-edit-clear-missing=""
            className="underline text-cyan-200"
            onClick={() => onClearMissing?.()}
          >
            Clear
          </button>
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-3 font-sans flex-wrap">
        <button
          type="button"
          className={`text-[11px] underline ${tangentOn ? 'text-cyan-300' : 'text-gray-300'}`}
          onClick={() => onToggleTangent?.()}
          title="When on, picking one edge adds G1-connected (tangent) edges in the loop"
          aria-pressed={tangentOn}
        >
          Tangent {tangentOn ? 'on' : 'off'}
        </button>
        <button
          type="button"
          data-fillet-clear=""
          className="text-[11px] text-gray-200 underline"
          onClick={() => onClear?.()}
          title="Clear all selected edges"
        >
          Clear
        </button>
        <button
          type="button"
          data-fillet-back=""
          className="text-[11px] text-gray-200 underline"
          onClick={() => onBack?.()}
          title="Undo"
          aria-label="Undo"
        >
          Undo
        </button>
      </div>
    </FeatureSheet>
  );
};

export default FilletModeChip;
