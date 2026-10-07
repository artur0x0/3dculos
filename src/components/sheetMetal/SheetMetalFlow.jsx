import React from 'react';
import { SHEET_PLANES } from '../../utils/sheetMetal/sheetModel';
import {
  acceptBaseFlange,
  acceptDraft,
  backToPlanePick,
  BASE_MAX,
  BASE_MIN,
  bendDeductionAt,
  bendLimits,
  cancelDraft,
  deleteDraftFeature,
  pickSheetPlane,
  setBaseDims,
  updateDraft,
} from '../../utils/sheetMetal/sheetMetalMode';
import SheetMetalModeChip from './SheetMetalModeChip';
import { SmButton, SmPopup, SmSlider } from './SmControls';

/**
 * Sheet-metal flow chrome by stage. Viewport owns the mode state, overlay
 * and taps; this renders the chip / translucent popups and calls
 * onCommit(spec) → boolean when a step writes the part script.
 */
const EDGE_NAMES = { 'u+': '+X edge', 'u-': '−X edge', 'v+': '+Y edge', 'v-': '−Y edge' };

/** Accept / Back / Delete footer shared by feature popups. */
const DraftFooter = ({ mode, setMode, onCommit }) => (
  <>
    {!mode.draft.isNew && (
      <SmButton
        variant="danger"
        className="mr-auto"
        data-sm-delete="1"
        onClick={() => {
          const { mode: next, spec } = deleteDraftFeature(mode);
          if (!spec || onCommit?.(spec, { step: `delete-${mode.draft.kind}` }) !== false) setMode(() => next);
        }}
      >
        Delete
      </SmButton>
    )}
    <SmButton onClick={() => setMode((m) => cancelDraft(m))} data-sm-back="1">Back</SmButton>
    <SmButton
      variant="primary"
      data-sm-accept="1"
      onClick={() => {
        const { mode: next, spec } = acceptDraft(mode);
        if (spec && onCommit?.(spec, { step: mode.draft.kind }) !== false) setMode(() => next);
      }}
    >
      Accept
    </SmButton>
  </>
);

const BendPopup = ({ mode, setMode, onCommit, onExit }) => {
  const d = mode.draft;
  const spec = mode.spec;
  const lim = bendLimits(spec);
  const bd = bendDeductionAt(spec, d.angle);
  const where = d.panel === 'base' ? `Base ${EDGE_NAMES[d.edge] || d.edge}` : `Flange ${d.panel} tip`;
  return (
    <SmPopup
      short
      title={d.isNew ? 'Bend' : `Bend ${d.id}`}
      subtitle={where}
      onClose={onExit}
      closeLabel="Exit sheet metal without writing this bend"
      dataAttr="data-sheet-metal-bend"
      footer={<DraftFooter mode={mode} setMode={setMode} onCommit={onCommit} />}
    >
      <SmSlider
        id="sm-bend-angle"
        label={`Angle (max ${lim.angleMax}°)`}
        unit="°"
        value={d.angle}
        min={lim.angleMin}
        max={lim.angleMax}
        step={1}
        onChange={(v) => setMode((m) => updateDraft(m, { angle: v }))}
      />
      <SmSlider
        id="sm-bend-length"
        label={`Flange length (min ${lim.lengthMin} mm)`}
        value={d.length}
        min={lim.lengthMin}
        max={lim.lengthMax}
        step={0.5}
        onChange={(v) => setMode((m) => updateDraft(m, { length: v }))}
      />
      <SmButton
        onClick={() => setMode((m) => updateDraft(m, { flip: !m.draft.flip }))}
        aria-pressed={!!d.flip}
        data-sm-flip="1"
        className={d.flip ? '!bg-orange-500/40' : ''}
      >
        Flip {d.flip ? '(down)' : '(up)'}
      </SmButton>
      <div className="text-xs text-gray-300 leading-relaxed" data-sm-bend-specs="1">
        R {spec.r.toFixed(2)} mm · K {spec.k} · BD {bd.toFixed(2)} mm @ {Math.round(d.angle)}° · reliefs automatic
      </div>
    </SmPopup>
  );
};

const SheetMetalFlow = ({ mode, setMode, onCommit, onExit, compact = false }) => {
  if (!mode) return null;

  if (mode.stage === 'edit' && mode.draft?.kind === 'bend') {
    return <BendPopup mode={mode} setMode={setMode} onCommit={onCommit} onExit={onExit} />;
  }

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
          {mode.tool === 'bend' && 'Tap an orange edge to bend it, or a bend to edit it.'}
          {mode.tool !== 'bend' && 'Pick a tool on the left rail.'}
          {mode.toast && <div className="mt-1 text-amber-200" data-sm-toast="1">{mode.toast}</div>}
        </div>
      )}
    </SheetMetalModeChip>
  );
};

export default SheetMetalFlow;
