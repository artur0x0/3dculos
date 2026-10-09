import React from 'react';
import { NumberField } from '../controls/popupUI';
import { getMaterial } from '../../fea/materials.js';
import {
  assumptionFields,
  customAssumptionFields,
  libraryOptions,
} from '../../fea/studyPanel.js';

function AssumedBadge({ field }) {
  return (
    <span
      data-fea-assumed={field}
      className="rounded border border-amber-300/60 bg-amber-400/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-100"
    >
      assumed
    </span>
  );
}

/**
 * Library materials plus a custom E / ν / yield. An assumed or missing
 * ν or yield wears an "assumed" badge.
 */
export function FeaMaterialPicker({ study, draft, onMaterial, onCustomMode, onCustomField }) {
  const options = libraryOptions();
  const customMode = !!draft?.customMode;
  const selected = study?.material?.id ? getMaterial(study.material.id) : null;
  const libraryBadges = selected ? assumptionFields(selected) : [];
  const custom = draft?.custom || {};
  const customBadges = customMode ? customAssumptionFields(custom) : [];

  return (
    <div className="flex flex-col gap-1.5" data-fea-material-picker="">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-cyan-200/80">Material</span>
        <select
          data-fea-material=""
          value={customMode ? '__custom__' : (study?.material?.id || 'al-6061-t6')}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '__custom__') onCustomMode?.(true);
            else onMaterial?.(value);
          }}
          className="rounded border border-cyan-700/70 bg-cyan-950/80 px-2 py-1 text-base text-white"
          aria-label="Material"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id} className="bg-gray-900">
              {option.name}
            </option>
          ))}
          <option value="__custom__" className="bg-gray-900">Custom</option>
        </select>
      </label>

      {!customMode && selected && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-cyan-100/90" data-fea-material-props="">
          <span>E {selected.E_MPa} MPa</span>
          <span className="inline-flex items-center gap-1">
            ν {selected.nu ?? selected.nu_assumed}
            {libraryBadges.includes('nu') && <AssumedBadge field="nu" />}
          </span>
          <span className="inline-flex items-center gap-1">
            yield {selected.yield_MPa == null ? '—' : `${selected.yield_MPa} MPa`}
            {libraryBadges.includes('yield') && <AssumedBadge field="yield" />}
          </span>
          {selected.anisotropic && (
            <span data-fea-anisotropic="">anisotropic, indicative only</span>
          )}
        </div>
      )}

      {customMode && (
        <div className="flex flex-col gap-1.5" data-fea-custom="">
          <label className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] text-cyan-100/80">Name</span>
            <input
              data-fea-custom-name=""
              value={custom.name || ''}
              onChange={(event) => onCustomField?.('name', event.target.value)}
              className="min-w-0 flex-1 rounded border border-cyan-700/70 bg-cyan-950/80 px-2 py-1 text-base text-white"
              aria-label="Custom material name"
            />
          </label>
          <NumberField
            label="E MPa"
            id="fea-E"
            accent="cyan"
            min={1}
            max={500000}
            step={100}
            value={custom.E_MPa}
            onChange={(value) => onCustomField?.('E_MPa', value)}
          />
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NumberField
                label="ν"
                id="fea-nu"
                accent="cyan"
                min={0}
                max={0.49}
                step={0.01}
                value={custom.nu}
                onChange={(value) => onCustomField?.('nu', value)}
              />
            </div>
            {customBadges.includes('nu') && <AssumedBadge field="nu" />}
          </div>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NumberField
                label="Yield MPa"
                id="fea-yield"
                accent="cyan"
                min={0}
                max={5000}
                step={1}
                value={custom.yield_MPa}
                onChange={(value) => onCustomField?.('yield_MPa', value)}
              />
            </div>
            {customBadges.includes('yield') && <AssumedBadge field="yield" />}
          </div>
        </div>
      )}
    </div>
  );
}
