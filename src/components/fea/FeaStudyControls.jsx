import React from 'react';
import { Check } from 'lucide-react';
import { ChoiceRow, NumberField } from '../controls/popupUI';
import { FORCE_DIRECTIONS, formatSolveSummary } from '../../fea/studyPanel.js';
import { FeaLoadList } from './FeaLoadList';
import { FeaMaterialPicker } from './FeaMaterialPicker';

const TARGETS = [
  { value: 'fixture', label: 'Fix' },
  { value: 'force', label: 'Force' },
  { value: 'pressure', label: 'Pressure' },
];

export function FeaStudyControls({ panel }) {
  const draft = panel.draft || {};
  return (
    <>
      <FeaMaterialPicker
        study={panel.study}
        draft={draft}
        onMaterial={panel.setMaterialId}
        onCustomMode={panel.setCustomMode}
        onCustomField={panel.setCustomField}
      />
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-cyan-200/80">Tap adds</span>
      <div className="flex gap-1" data-fea-targets="">
        {TARGETS.map((target) => (
          <button
            key={target.value}
            type="button"
            data-fea-target={target.value}
            aria-pressed={draft.target === target.value}
            onClick={() => panel.setTarget?.(target.value)}
            className={`rounded px-2 py-1 text-[13px] ${
              draft.target === target.value
                ? 'bg-cyan-600 text-white'
                : 'border border-cyan-700/70 bg-cyan-950/80 text-cyan-100'
            }`}
          >
            {target.label}
          </button>
        ))}
      </div>
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
      />
      {panel.notice && (
        <p className="text-[11px] text-amber-200" data-fea-notice="">{panel.notice}</p>
      )}
    </>
  );
}

export function FeaRunBar({ panel }) {
  const summary = panel.result ? formatSolveSummary(panel.result) : null;
  return (
    <div className="mt-1 flex shrink-0 flex-col gap-1">
      {summary && (
        <div data-fea-summary="" className="rounded border border-amber-300/50 bg-amber-400/10 px-2 py-1.5">
          {summary.stub && (
            <div
              data-fea-stub="1"
              className="mb-1 inline-block rounded bg-amber-400 px-1.5 py-0.5 text-[12px] font-bold tracking-wide text-amber-950"
            >
              STUB
            </div>
          )}
          <div className="text-[12px] text-cyan-50" data-fea-stress="">
            min {summary.min} MPa · p95 {summary.p95} MPa · max {summary.max} MPa
          </div>
          <div className="text-[12px] text-cyan-50" data-fea-fos={summary.fos}>
            safety factor {summary.fos}
          </div>
          {summary.warning && (
            <div className="text-[11px] text-amber-100" data-fea-warning="">{summary.warning}</div>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        data-fea-run={panel.running ? 'busy' : 'ready'}
        onClick={() => panel.run?.()}
        disabled={!!panel.running}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium ${
          panel.running
            ? 'cursor-wait bg-cyan-950/80 text-cyan-300'
            : 'bg-cyan-600 text-white hover:bg-cyan-500'
        }`}
      >
        <Check size={14} />
        {panel.running ? 'Running' : 'Run'}
      </button>
      </div>
    </div>
  );
}
