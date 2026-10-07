import React from 'react';
import { SHEET_PLANES } from '../../utils/sheetMetal/sheetModel';
import {
  acceptBaseFlange,
  backToPlanePick,
  BASE_MAX,
  BASE_MIN,
  pickSheetPlane,
  setBaseDims,
} from '../../utils/sheetMetal/sheetMetalMode';
import SheetMetalModeChip from './SheetMetalModeChip';
import { SmButton, SmPopup, SmSlider } from './SmControls';

/**
 * Sheet-metal flow chrome by stage. Viewport owns the mode state, overlay
 * and taps; this renders the chip / translucent popups and calls
 * onCommit(spec) → boolean when a step writes the part script.
 */
const SheetMetalFlow = ({ mode, setMode, onCommit, onExit, compact = false }) => {
  if (!mode) return null;

  if (mode.stage === 'base' && mode.base) {
    const plane = SHEET_PLANES[mode.base.plane];
    return (
      <SmPopup
        title="Base flange"
        subtitle={`${plane?.label || mode.base.plane} plane · ${mode.sku?.thicknessMm?.toFixed(2)} mm ${mode.sku?.name || ''}`}
        onClose={onExit}
        closeLabel="Exit sheet metal without writing"
        dataAttr="data-sheet-metal-base"
        footer={(
          <>
            <SmButton onClick={() => setMode((m) => backToPlanePick(m))} data-sm-back="1">Back</SmButton>
            <SmButton
              variant="primary"
              data-sm-accept="1"
              onClick={() => {
                const { mode: next, spec } = acceptBaseFlange(mode);
                if (spec && onCommit?.(spec, { step: 'base' }) !== false) setMode(() => next);
              }}
            >
              Accept
            </SmButton>
          </>
        )}
      >
        <SmSlider
          id="sm-base-x"
          label="X (width)"
          value={mode.base.width}
          min={BASE_MIN}
          max={Math.max(300, Number(mode.base.width) || 0)}
          step={1}
          onChange={(v) => setMode((m) => setBaseDims(m, { width: v }))}
        />
        <SmSlider
          id="sm-base-y"
          label="Y (height)"
          value={mode.base.height}
          min={BASE_MIN}
          max={Math.max(300, Number(mode.base.height) || 0)}
          step={1}
          onChange={(v) => setMode((m) => setBaseDims(m, { height: v }))}
        />
        <p className="text-xs text-gray-400">Up to {BASE_MAX} mm. Thickness comes from the SKU.</p>
      </SmPopup>
    );
  }

  return (
    <SheetMetalModeChip mode={mode} compact={compact} onDismiss={onExit}>
      {mode.stage === 'plane' && (
        <div className="mt-1.5 font-sans" data-sheet-metal-step="plane">
          <div className="text-[12px] text-orange-100">Tap a plane for the base flange</div>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {Object.values(SHEET_PLANES).map((p) => (
              <SmButton
                key={p.id}
                className="!px-2"
                onClick={() => setMode((m) => pickSheetPlane(m, p.id))}
                data-sm-plane={p.id}
              >
                {p.label}
              </SmButton>
            ))}
          </div>
        </div>
      )}
      {mode.stage === 'edit' && (
        <div className="mt-1.5 text-[12px] text-orange-100 font-sans" data-sheet-metal-step="edit">
          Base flange written. Tap an edge to add a bend.
        </div>
      )}
    </SheetMetalModeChip>
  );
};

export default SheetMetalFlow;
