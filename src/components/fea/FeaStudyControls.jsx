import React from 'react';
import { Check } from 'lucide-react';
import { ChoiceRow, NumberField } from '../controls/popupUI';
import { PLOT_TABS, activePlot } from '../../fea/resultsView.js';
import { FORCE_DIRECTIONS } from '../../fea/studyPanel.js';
import { FeaLegend } from './FeaLegend';
import { FeaLoadList } from './FeaLoadList';
import { FeaAssemblySetup } from './FeaAssemblySetup';
import { FeaMaterialPicker } from './FeaMaterialPicker';
import { FeaPreviewSliders } from './FeaPreviewSliders';

const TARGETS = [
  { value: 'fixture', label: 'Fix' },
  { value: 'force', label: 'Force' },
  { value: 'pressure', label: 'Pressure' },
];

/** Shared tab row. Fix / Force / Pressure and Stress / Displacement use it. */
export function FeaTabs({ options, value, onChange, groupAttr, itemAttr }) {
  return (
    <div className="flex gap-1" {...{ [groupAttr]: '' }}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            {...{ [itemAttr]: option.value }}
            aria-pressed={active}
            onClick={() => onChange?.(option.value)}
            className={`rounded px-2 py-1 text-[13px] ${
              active
                ? 'bg-cyan-600 text-white'
                : 'border border-cyan-700/70 bg-cyan-950/80 text-cyan-100'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const STUDY_TYPES = [
  { value: 'linear-static', label: 'Static' },
  { value: 'modal', label: 'Modal' },
];

export function FeaStudyControls({ panel }) {
  const draft = panel.draft || {};
  const studyType = panel.study?.type === 'modal' ? 'modal' : 'linear-static';
  return (
    <>
      <FeaTabs
        options={STUDY_TYPES}
        value={studyType}
        onChange={panel.setStudyType}
        groupAttr="data-fea-study-types"
        itemAttr="data-fea-study-type"
      />
      {studyType === 'modal' && (
        <p className="text-[11px] text-cyan-100/80" data-fea-modal-note="">
          Loads are ignored. A modal study uses fixtures only.
        </p>
      )}
      <FeaMaterialPicker
        study={panel.study}
        draft={draft}
        onMaterial={panel.setMaterialId}
        onCustomMode={panel.setCustomMode}
        onCustomField={panel.setCustomField}
      />
      <div data-fea-refine={panel.refine === 'off' ? 'off' : 'auto'}>
        <ChoiceRow
          label="Refine"
          accent="cyan"
          options={[{ value: 'auto', label: 'Auto' }, { value: 'off', label: 'Off' }]}
          value={panel.refine === 'off' ? 'off' : 'auto'}
          onChange={panel.setRefine}
        />
      </div>
      <FeaAssemblySetup panel={panel} />
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-cyan-200/80">Tap adds</span>
      <FeaTabs
        options={TARGETS}
        value={draft.target}
        onChange={panel.setTarget}
        groupAttr="data-fea-targets"
        itemAttr="data-fea-target"
      />
      </div>
      {draft.target === 'force' && (
        <>
          <NumberField
            label="Force N"
            id="fea-force"
            accent="cyan"
            min={0.1}
            max={10000}
            step={10}
            value={draft.magnitudeN}
            onChange={panel.setMagnitude}
          />
          <ChoiceRow
            label="Direction"
            accent="cyan"
            options={FORCE_DIRECTIONS}
            value={draft.direction || 'normal'}
            onChange={panel.setDirection}
          />
        </>
      )}
      {draft.target === 'pressure' && (
        <NumberField
          label="Pressure MPa"
          id="fea-pressure"
          accent="cyan"
          min={-50}
          max={50}
          step={0.1}
          value={draft.pressureMPa}
          onChange={panel.setPressure}
        />
      )}
      <p className="text-[11px] text-cyan-100/80">Tap a face. Tap it again to remove it.</p>
      <FeaLoadList
        study={panel.study}
        onRemoveFixture={panel.removeFixture}
        onRemoveLoad={panel.removeLoad}
        selectedLoad={panel.preview?.available ? panel.preview.loadIndex : -1}
        onSelectLoad={panel.preview?.available ? panel.selectPreviewLoad : null}
      />
      <FeaPreviewSliders panel={panel} />
      {panel.notice && (
        <p className="text-[11px] text-amber-200" data-fea-notice="">{panel.notice}</p>
      )}
    </>
  );
}

const STAGE_LABEL = {
  'loading-mesher': 'Loading mesher',
  meshing: 'Meshing',
  assembling: 'Assembling',
  solving: 'Solving',
  'post-processing': 'Post-processing',
};

function FeaProgressBar({ report }) {
  const indeterminate = report.percent == null;
  const label = [report.stageLabel, report.stepLabel].filter(Boolean).join(' · ');
  const elapsed = report.elapsedText || '';
  return (
    <div
      data-fea-progress-bar=""
      data-fea-progress-indeterminate={indeterminate ? '1' : '0'}
      role="progressbar"
      aria-label={label || 'Analyze'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : report.percent}
      aria-busy="true"
      className="flex flex-col gap-0.5"
    >
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-cyan-50">
        <span data-fea-progress-stage="" className="min-w-0 truncate">{label}</span>
        <span data-fea-progress-elapsed="" className="shrink-0 tabular-nums text-cyan-100/90">
          {elapsed}{report.percent != null ? ` · ${report.percent}%` : ''}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-cyan-950">
        <div
          className={`h-full rounded bg-cyan-300 ${indeterminate ? 'w-1/3 animate-pulse' : ''}`}
          style={indeterminate ? undefined : { width: `${report.percent}%` }}
        />
      </div>
    </div>
  );
}

function FeaTiming({ report }) {
  if (!report || (report.status !== 'done' && report.status !== 'stopped') || !report.text) return null;
  const stopped = report.status === 'stopped';
  return (
    <div className="flex flex-col gap-0.5">
      <p
        data-fea-timing={stopped ? undefined : ''}
        data-fea-stopped={stopped ? '' : undefined}
        className={`text-[11px] leading-snug ${stopped ? 'text-amber-200' : 'text-cyan-50'}`}
      >
        {report.text}
      </p>
      {Array.isArray(report.details) && report.details.length > 0 && (
        <details data-fea-timing-details="" className="text-[11px] text-cyan-100/80">
          <summary>Stage times</summary>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {report.details.map((row) => (
              <li key={row.id} data-fea-stage={row.id}>
                {row.label}: {row.seconds}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function showLegend(panel) {
  if (panel.preview?.showing) return true;
  if (!panel.result) return false;
  if (panel.results) return true;
  if (panel.dismissed && !panel.result.stale) return false;
  return true;
}

/** Results readout. Scrolls in the card body so Stage times cannot cover Back to Setup. */
function ModeList({ panel }) {
  const frequencies = panel.result?.frequenciesHz || [];
  const mass = panel.result?.effectiveMass || [];
  const selected = panel.modeIndex || 0;
  return (
    <div className="flex flex-col gap-1" data-fea-modes="">
      {frequencies.map((hz, index) => {
        const fx = mass[index * 3];
        const fy = mass[index * 3 + 1];
        const fz = mass[index * 3 + 2];
        const title = [fx, fy, fz].every((value) => Number.isFinite(value))
          ? `effective mass ${fx.toFixed(2)} ${fy.toFixed(2)} ${fz.toFixed(2)}`
          : undefined;
        return (
          <button
            key={index}
            type="button"
            data-fea-mode={index}
            data-fea-frequency={hz}
            title={title}
            aria-pressed={selected === index}
            onClick={() => panel.setMode?.(index)}
            className={`rounded px-2 py-1 text-left text-[13px] tabular-nums ${
              selected === index
                ? 'bg-cyan-600 text-white'
                : 'border border-cyan-700/70 bg-cyan-950/80 text-cyan-100'
            }`}
          >
            Mode {index + 1}: {Number(hz).toFixed(1)} Hz
          </button>
        );
      })}
      <label className="flex items-center gap-1.5 text-[12px] text-cyan-100">
        <input
          type="checkbox"
          data-fea-animate=""
          checked={panel.animate === true}
          onChange={(event) => panel.setAnimate?.(event.target.checked)}
        />
        Animate
      </label>
    </div>
  );
}

export function FeaResultsReadout({ panel }) {
  if (panel.results !== true) return null;
  const plot = activePlot(panel.plot);
  const modal = panel.result?.source === 'modal';
  return (
    <div className="mt-1.5 flex flex-col gap-1 font-sans">
      {modal ? (
        <ModeList panel={panel} />
      ) : (
        <FeaTabs
          options={PLOT_TABS}
          value={plot}
          onChange={panel.setPlot}
          groupAttr="data-fea-plots"
          itemAttr="data-fea-plot"
        />
      )}
      {showLegend(panel) && (
        <FeaLegend result={panel.result} preview={panel.preview} plot={modal ? 'displacement' : plot} />
      )}
      {!panel.running && <FeaTiming report={panel.runReport} />}
    </div>
  );
}

export function FeaRunBar({ panel }) {
  const report = panel.runReport;
  const results = panel.results === true;
  const stage = panel.running ? (report?.stageLabel || STAGE_LABEL[panel.progress] || 'Running') : 'Run';
  return (
    <div className="mt-1 flex shrink-0 flex-col gap-1">
      {!results && showLegend(panel) && (
        <FeaLegend result={panel.result} preview={panel.preview} plot="stress" />
      )}
      {panel.running && report?.status === 'running' && <FeaProgressBar report={report} />}
      {!results && !panel.running && <FeaTiming report={report} />}
      <div className="flex items-center justify-end gap-2">
      {panel.running && (
        <button
          type="button"
          data-fea-cancel=""
          onClick={() => panel.cancel?.()}
          className="inline-flex items-center rounded-md border border-cyan-700/70 px-2 py-1 text-[13px] font-medium text-cyan-100"
        >
          Cancel
        </button>
      )}
      {results ? (
        <button
          type="button"
          data-fea-back=""
          onClick={() => panel.backToSetup?.()}
          className="inline-flex items-center gap-1 rounded-md bg-cyan-600 px-2 py-1 text-[13px] font-medium text-white hover:bg-cyan-500"
        >
          <Check size={14} />
          Back to Setup
        </button>
      ) : (
      <button
        type="button"
        data-fea-run={panel.running ? 'busy' : 'ready'}
        data-fea-progress={panel.running ? (panel.progress || 'running') : ''}
        onClick={() => panel.run?.()}
        disabled={!!panel.running}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium ${
          panel.running
            ? 'cursor-wait bg-cyan-950/80 text-cyan-300'
            : 'bg-cyan-600 text-white hover:bg-cyan-500'
        }`}
      >
        <Check size={14} />
        {stage}
      </button>
      )}
      </div>
    </div>
  );
}
