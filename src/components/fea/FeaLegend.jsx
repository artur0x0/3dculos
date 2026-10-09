import React from 'react';
import { legendGradientCss, legendTicks, scaleTop } from '../../fea/colormap.js';
import { formatSolveSummary } from '../../fea/studyPanel.js';

function formatMPa(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

/**
 * Gradient, ticks, and the stub summary. Sits in the Analyze chip and the
 * phone sheet. A stale result keeps the last numbers grey and says Re-run.
 * The coloured skin is already gone; this bar is not a live scale.
 */
export function FeaLegend({ result }) {
  if (!result) return null;
  const summary = formatSolveSummary(result);
  const stale = result.stale === true;
  const scale = { p95: result.p95, yield_MPa: result.yield_MPa };
  const top = scaleTop(scale);
  const ticks = legendTicks(scale, 5);
  return (
    <div
      data-fea-summary=""
      data-fea-legend=""
      data-fea-stale={stale ? '1' : '0'}
      className="rounded border border-amber-300/50 bg-amber-400/10 px-2 py-1.5"
    >
      <div className="mb-1 flex items-center gap-1.5">
        {summary.stub && (
          <span
            data-fea-stub="1"
            className="rounded bg-amber-400 px-1.5 py-0.5 text-[13px] font-bold tracking-wide text-amber-950"
          >
            STUB
          </span>
        )}
        {stale && (
          <span
            data-fea-rerun=""
            className="rounded bg-white px-1.5 py-0.5 text-[13px] font-bold tracking-wide text-cyan-950"
          >
            Re-run
          </span>
        )}
      </div>
      <div className={stale ? 'opacity-40 grayscale' : ''}>
        <div
          data-fea-legend-bar=""
          className="h-2 w-full rounded"
          style={{ background: legendGradientCss(scale) }}
          title={`0 to ${formatMPa(top)} MPa`}
        />
        <div
          data-fea-legend-ticks=""
          className="mt-0.5 flex justify-between gap-1 text-[10px] tabular-nums text-cyan-100/90"
        >
          {ticks.map((tick, index) => (
            <span key={index}>{formatMPa(tick)}</span>
          ))}
        </div>
        <div className="text-[12px] text-cyan-50" data-fea-stress="">
          min {summary.min} MPa · p95 {summary.p95} MPa · max {summary.max} MPa
        </div>
        <div className="text-[12px] text-cyan-50" data-fea-fos={summary.fos}>
          safety factor {summary.fos}
        </div>
      </div>
      {summary.warning && (
        <div className="text-[11px] text-amber-100" data-fea-warning="">{summary.warning}</div>
      )}
    </div>
  );
}
