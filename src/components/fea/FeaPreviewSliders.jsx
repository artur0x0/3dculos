import React from 'react';
import { libraryOptions } from '../../fea/studyPanel.js';

function Range({ label, attr, min, max, step, value, onBegin, onInput, onEnd }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex items-center justify-between text-[11px] text-fuchsia-100/90">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </span>
      <input
        type="range"
        data-fea-preview-slider={attr}
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onPointerDown={onBegin}
        onInput={onInput}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        className="h-5 w-full accent-fuchsia-400"
      />
    </label>
  );
}

/**
 * Live preview. Hidden when WebGPU is missing. Nothing here writes the
 * part script; pointer-up commits once.
 */
export function FeaPreviewSliders({ panel }) {
  const preview = panel.preview;
  if (!preview?.available) return null;
  const load = panel.study?.loads?.[preview.loadIndex];
  if (!load || load.kind !== 'force') return null;
  const materials = libraryOptions();
  const materialIndex = preview.materialIndex >= 0 ? preview.materialIndex : 0;
  const material = materials[materialIndex] || materials[0];
  const materialLabel = preview.materialIndex < 0 ? 'Material · custom' : `Material · ${material?.name || ''}`;
  const magnitude = Number(preview.magnitude) || 0;
  const magMax = Math.max(1000, Math.ceil(Math.abs(magnitude) * 4) || 0);
  return (
    <div className="flex flex-col gap-1 rounded border border-fuchsia-300/40 bg-fuchsia-400/10 px-2 py-1.5" data-fea-preview-sliders="">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fuchsia-200">Preview</div>
      <Range
        label="Magnitude N"
        attr="magnitude"
        min={1}
        max={magMax}
        step={1}
        value={Math.round(magnitude)}
        onBegin={() => panel.previewBegin?.()}
        onInput={(event) => panel.previewInput?.({ magnitude: Number(event.target.value) })}
        onEnd={() => panel.previewCommit?.()}
      />
      <Range
        label="Direction"
        attr="direction"
        min={0}
        max={360}
        step={1}
        value={Math.round(Number(preview.angle) || 0)}
        onBegin={() => panel.previewBegin?.()}
        onInput={(event) => panel.previewInput?.({ angle: Number(event.target.value) })}
        onEnd={() => panel.previewCommit?.()}
      />
      <Range
        label={materialLabel}
        attr="material"
        min={0}
        max={Math.max(0, materials.length - 1)}
        step={1}
        value={materialIndex}
        onBegin={() => panel.previewBegin?.()}
        onInput={(event) => panel.previewInput?.({ materialIndex: Number(event.target.value) })}
        onEnd={() => panel.previewCommit?.()}
      />
    </div>
  );
}
