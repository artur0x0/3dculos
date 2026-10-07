import React, { useState } from 'react';
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
  closeSheetExport,
  deleteDraftFeature,
  holeRange,
  openSheetExport,
  pickSheetPlane,
  setBaseDims,
  TAP_SIZES,
  updateDraft,
} from '../../utils/sheetMetal/sheetMetalMode';
import { buildSheetExport } from '../../utils/sheetMetal/sheetExport';
import { formatSheetLength, loadSheetDisplayUnit, saveSheetDisplayUnit } from '../../utils/sheetMetal/sheetUnits';
import { SCS_ORDER_URL } from '../../utils/scs/scsCatalog';
import { downloadBlob } from '../../utils/model-io';
import SheetMetalModeChip from './SheetMetalModeChip';
import { SmButton, SmMmSlider, SmPopup, SmSelect, SmSlider, SmToggle } from './SmControls';

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

const BendPopup = ({ mode, setMode, onCommit, onExit, unit, onUnit }) => {
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
      unit={unit}
      onUnit={onUnit}
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
      <SmMmSlider
        id="sm-bend-length"
        label={`Flange length (min ${formatSheetLength(lim.lengthMin, unit)})`}
        mm={d.length}
        minMm={lim.lengthMin}
        maxMm={lim.lengthMax}
        stepMm={0.5}
        unit={unit}
        onMm={(v) => setMode((m) => updateDraft(m, { length: v }))}
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
        R {formatSheetLength(spec.r, unit)} · K {spec.k} · BD {formatSheetLength(bd, unit)} @ {Math.round(d.angle)}° · reliefs automatic
      </div>
    </SmPopup>
  );
};

const TabPopup = ({ mode, setMode, onCommit, onExit, unit, onUnit }) => {
  const d = mode.draft;
  const span = Number(d.span) || Math.max(d.width, 1);
  const where = d.panel === 'base' ? `Base ${EDGE_NAMES[d.edge] || d.edge}` : `Flange ${d.panel} ${d.edge === 'u+' ? 'tip' : 'side'}`;
  return (
    <SmPopup
      short
      title={d.isNew ? 'Tab' : `Tab ${d.id}`}
      subtitle={`${where} · edge ${formatSheetLength(span, unit, 1)}`}
      onClose={onExit}
      closeLabel="Exit sheet metal without writing this tab"
      dataAttr="data-sheet-metal-tab"
      unit={unit}
      onUnit={onUnit}
      footer={<DraftFooter mode={mode} setMode={setMode} onCommit={onCommit} />}
    >
      <SmMmSlider id="sm-tab-width" label="Width" mm={d.width} minMm={1} maxMm={span} stepMm={0.5} unit={unit}
        onMm={(v) => setMode((m) => updateDraft(m, { width: v }))} />
      <SmMmSlider id="sm-tab-depth" label="Depth" mm={d.depth} minMm={0.5} maxMm={Math.max(50, d.depth)} stepMm={0.5} unit={unit}
        onMm={(v) => setMode((m) => updateDraft(m, { depth: v }))} />
      <SmToggle id="sm-tab-centered" label="Centered" checked={d.centered !== false}
        onChange={(v) => setMode((m) => updateDraft(m, { centered: v }))} />
      {d.centered === false && (
        <SmMmSlider id="sm-tab-offset" label="Offset from edge start" mm={d.offset ?? 0} minMm={0}
          maxMm={Math.max(0, span - d.width)} stepMm={0.5} unit={unit}
          onMm={(v) => setMode((m) => updateDraft(m, { offset: v }))} />
      )}
    </SmPopup>
  );
};

const HOLE_TITLES = { hole: 'Hole', countersink: 'Countersunk hole', tapped: 'Tapped hole' };

const HolePopup = ({ mode, setMode, onCommit, onExit, unit, onUnit }) => {
  const d = mode.draft;
  const range = holeRange(mode) || { u0: -50, u1: 50, v0: -50, v1: 50 };
  const minHole = Number(mode.spec.limits?.minHole) || 0;
  const type = d.type || 'hole';
  return (
    <SmPopup
      short
      title={d.isNew ? HOLE_TITLES[type] : `${HOLE_TITLES[type]} ${d.id}`}
      subtitle={`${d.panel === 'base' ? 'Base' : `Flange ${d.panel}`} face${minHole ? ` · SKU min Ø ${formatSheetLength(minHole, unit)}` : ''}`}
      onClose={onExit}
      closeLabel="Exit sheet metal without writing this hole"
      dataAttr="data-sheet-metal-hole"
      unit={unit}
      onUnit={onUnit}
      footer={<DraftFooter mode={mode} setMode={setMode} onCommit={onCommit} />}
    >
      {type === 'tapped' ? (
        <SmSelect id="sm-hole-thread" label="Thread" value={d.thread}
          options={TAP_SIZES.map((x) => ({ value: x.id, label: `${x.id} (drill Ø ${formatSheetLength(x.tap, unit)})` }))}
          onChange={(v) => setMode((m) => updateDraft(m, { thread: v }))} />
      ) : (
        <SmMmSlider id="sm-hole-d" label="Diameter" mm={d.d} minMm={Math.max(0.5, minHole)} maxMm={Math.max(40, d.d)} stepMm={0.1} unit={unit}
          onMm={(v) => setMode((m) => updateDraft(m, { d: v }))} />
      )}
      {type === 'countersink' && (
        <SmMmSlider id="sm-hole-csk" label="Countersink Ø (82°)" mm={d.cskDia} minMm={d.d} maxMm={Math.max(d.d * 3, d.cskDia)} stepMm={0.1} unit={unit}
          onMm={(v) => setMode((m) => updateDraft(m, { cskDia: v }))} />
      )}
      <SmMmSlider id="sm-hole-u" label="Position along U" mm={d.u} minMm={range.u0} maxMm={range.u1} stepMm={0.5} unit={unit}
        onMm={(v) => setMode((m) => updateDraft(m, { u: v }))} />
      <SmMmSlider id="sm-hole-v" label="Position along V" mm={d.v} minMm={range.v0} maxMm={range.v1} stepMm={0.5} unit={unit}
        onMm={(v) => setMode((m) => updateDraft(m, { v: v }))} />
    </SmPopup>
  );
};


const downloadText = (file) => {
  if (!file?.text) return;
  downloadBlob(new Blob([file.text], { type: `${file.mime || 'text/plain'};charset=utf-8` }), file.name);
};

/** DFM + DXF / STEP / Order on SendCutSend. Hard fails block downloads + order. */
const ExportPopup = ({ mode, setMode, mesh, script, partName, unit, onUnit }) => {
  const bundle = React.useMemo(
    () => buildSheetExport(mode.spec, { mesh: mesh || null, script: script ?? null, partName: partName || mode.partId || 'sheet', unit }),
    [mode.spec, mode.partId, partName, mesh, script, unit],
  );
  const { dfm, files, blocked, flat, stepSource } = bundle;
  const bendCount = files.step?.stats?.bendFaces ? files.step.stats.bendFaces / 2 : 0;
  const fails = dfm.issues.filter((x) => x.level === 'fail');
  const warns = dfm.issues.filter((x) => x.level === 'warn');
  const size = flat?.size;
  const close = () => setMode((m) => closeSheetExport(m));
  return (
    <SmPopup
      title="Check & Export"
      subtitle={blocked
        ? `${fails.length} issue${fails.length === 1 ? '' : 's'} block export`
        : warns.length
          ? `Ready · ${warns.length} warning${warns.length === 1 ? '' : 's'}`
          : 'Ready for SendCutSend'}
      onClose={close}
      closeLabel="Close export"
      dataAttr="data-sheet-metal-export"
      unit={unit}
      onUnit={onUnit}
      footer={(
        <>
          <SmButton onClick={close} data-sm-back="1">Close</SmButton>
          <SmButton
            variant="primary"
            data-sm-order="1"
            disabled={blocked}
            title={blocked ? 'Fix DFM fails first' : 'Open SendCutSend to upload DXF or STEP'}
            onClick={() => {
              if (blocked) return;
              window.open(SCS_ORDER_URL, '_blank', 'noopener,noreferrer');
            }}
          >
            Order on SendCutSend
          </SmButton>
        </>
      )}
    >
      {size && (
        <p className="text-xs text-gray-300" data-sm-flat-size="1">
          Flat {formatSheetLength(size[0], unit, 1)} × {formatSheetLength(size[1], unit, 1)}
          {mode.spec?.sku ? ` · ${mode.spec.sku}` : ''}
        </p>
      )}
      {dfm.issues.length === 0 && (
        <p className="text-sm text-emerald-300" data-sm-dfm-ok="1">All SCS checks passed.</p>
      )}
      {fails.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-sm-dfm-fails="1">
          {fails.map((iss, i) => (
            <li key={`f${i}`} className="rounded-md bg-red-950/70 border border-red-500/50 px-3 py-2 text-sm text-red-100">
              <span className="font-semibold uppercase text-[10px] tracking-wide text-red-300 mr-2">{iss.rule}</span>
              {iss.message}
            </li>
          ))}
        </ul>
      )}
      {warns.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-sm-dfm-warns="1">
          {warns.map((iss, i) => (
            <li key={`w${i}`} className="rounded-md bg-amber-950/50 border border-amber-500/40 px-3 py-2 text-sm text-amber-100">
              <span className="font-semibold uppercase text-[10px] tracking-wide text-amber-300 mr-2">{iss.rule}</span>
              {iss.message}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2">
        <SmButton
          data-sm-dxf="1"
          disabled={blocked || !files.dxf}
          title={blocked ? 'Fix DFM fails first' : files.dxf?.name}
          onClick={() => downloadText(files.dxf)}
        >
          Download DXF
        </SmButton>
        <SmButton
          data-sm-step="1"
          disabled={blocked || !files.step}
          title={blocked ? 'Fix DFM fails first' : (files.step?.name || 'Run the part first')}
          onClick={() => downloadText(files.step)}
        >
          Download STEP
        </SmButton>
      </div>
      <p className="text-[11px] text-gray-400" data-sm-step-source={stepSource || 'none'}>
        DXF is the flat cut (mm). STEP is the bent 3D part
        {stepSource === 'spec' ? `, built from the sheet spec with exact bends${bendCount ? ` (${bendCount} cylindrical)` : ''}` : ''}
        {stepSource === 'mesh' ? ', faceted from the 3D part' : ''}
        . Upload either at app.sendcutsend.com.
      </p>
    </SmPopup>
  );
};

const TOOL_HINTS = {
  tab: 'Tap an orange edge to add a tab, or a tab to edit it.',
  bend: 'Tap an orange edge to bend it, or a bend to edit it.',
  hole: 'Tap a face to place a hole, or a hole to edit it.',
  countersink: 'Tap a face to place a countersunk hole.',
  tapped: 'Tap a face to place a tapped hole.',
};

const SheetMetalFlow = ({ mode, setMode, onCommit, onExit, compact = false, mesh = null, script = null, partName = '' }) => {
  const [unit, setUnit] = useState(() => loadSheetDisplayUnit());
  const onUnit = (next) => setUnit(saveSheetDisplayUnit(next));
  if (!mode) return null;

  if (mode.stage === 'edit' && mode.exportOpen) {
    return <ExportPopup mode={mode} setMode={setMode} mesh={mesh} script={script} partName={partName} unit={unit} onUnit={onUnit} />;
  }

  if (mode.stage === 'edit' && mode.draft?.kind === 'bend') {
    return <BendPopup mode={mode} setMode={setMode} onCommit={onCommit} onExit={onExit} unit={unit} onUnit={onUnit} />;
  }
  if (mode.stage === 'edit' && mode.draft?.kind === 'tab') {
    return <TabPopup mode={mode} setMode={setMode} onCommit={onCommit} onExit={onExit} unit={unit} onUnit={onUnit} />;
  }
  if (mode.stage === 'edit' && mode.draft?.kind === 'hole') {
    return <HolePopup mode={mode} setMode={setMode} onCommit={onCommit} onExit={onExit} unit={unit} onUnit={onUnit} />;
  }

  if (mode.stage === 'base' && mode.base) {
    const plane = SHEET_PLANES[mode.base.plane];
    return (
      <SmPopup
        title="Base flange"
        subtitle={`${plane?.label || mode.base.plane} plane · ${formatSheetLength(mode.sku?.thicknessMm, unit)} ${mode.sku?.name || ''}`}
        onClose={onExit}
        closeLabel="Exit sheet metal without writing"
        dataAttr="data-sheet-metal-base"
        unit={unit}
        onUnit={onUnit}
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
        <SmMmSlider
          id="sm-base-x"
          label="X (width)"
          mm={mode.base.width}
          minMm={BASE_MIN}
          maxMm={Math.max(300, Number(mode.base.width) || 0)}
          stepMm={1}
          unit={unit}
          onMm={(v) => setMode((m) => setBaseDims(m, { width: v }))}
        />
        <SmMmSlider
          id="sm-base-y"
          label="Y (height)"
          mm={mode.base.height}
          minMm={BASE_MIN}
          maxMm={Math.max(300, Number(mode.base.height) || 0)}
          stepMm={1}
          unit={unit}
          onMm={(v) => setMode((m) => setBaseDims(m, { height: v }))}
        />
        <p className="text-xs text-gray-400">Up to {formatSheetLength(BASE_MAX, unit, 0)}. Thickness comes from the SKU. Stored in mm.</p>
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
        <div className="mt-1.5 font-sans" data-sheet-metal-step="edit">
          <div className="text-[12px] text-orange-100">
            {TOOL_HINTS[mode.tool] || 'Pick a tool on the left rail.'}
          </div>
          {mode.toast && <div className="mt-1 text-[12px] text-amber-200" data-sm-toast="1">{mode.toast}</div>}
          <SmButton
            variant="primary"
            className="mt-2 w-full"
            data-sm-export="1"
            onClick={() => setMode((m) => openSheetExport(m))}
          >
            Check &amp; Export
          </SmButton>
        </div>
      )}
    </SheetMetalModeChip>
  );
};

export default SheetMetalFlow;
