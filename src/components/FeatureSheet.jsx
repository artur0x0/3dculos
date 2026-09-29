import React, { useMemo, useState, useEffect } from 'react';
import {
  ArrowUpFromLine,
  Rotate3d,
  Pyramid,
  Route,
  NotebookPen,
  TriangleRight,
  Code2,
  X,
  Check,
} from 'lucide-react';
import SquareRoundCorner from './icons/SquareRoundCorner';
import {
  NumberField,
  ChoiceRow,
  PopupButton,
  POPUP_TEXT,
  accentOf,
} from './controls/popupUI';
import {
  featureBlockText,
  parseFeatureSheetParams,
  isFeatureSheetEditable,
} from '../utils/featureSheetWriteback';

/**
 * Slice Mobile C — bottom glass feature sheet (CAD-stage default edit path).
 *
 * Reuses popupUI NumberField / ChoiceRow. Accept writes params into the marked
 * block via the caller; Cancel dismisses; "Edit script" escapes to Script stage.
 * Desktop never mounts this.
 */

const FEATURE_ICONS = Object.freeze({
  profile: NotebookPen,
  extrude: ArrowUpFromLine,
  revolve: Rotate3d,
  loft: Pyramid,
  sweep: Route,
  fillet: SquareRoundCorner,
  chamfer: TriangleRight,
});

const ACCENT = 'cyan';

function snippetPreview(text, maxLines = 6) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines - 1).join('\n')}\n…`;
}

export default function FeatureSheet({
  feature = null,
  features = null,
  script = '',
  onAccept,
  onCancel,
  onEditScript,
  onPickFeature,
}) {
  const a = accentOf(ACCENT);
  const block = useMemo(
    () => (feature ? featureBlockText(script, feature) : ''),
    [script, feature],
  );
  const parsed = useMemo(
    () => (feature ? parseFeatureSheetParams(feature.kind, block) : null),
    [feature, block],
  );

  const [draft, setDraft] = useState(() => parsed?.params || {});

  useEffect(() => {
    setDraft(parsed?.params || {});
    // Re-seed draft when the open feature (or its parsed literals) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature?.id, block]);

  // Picker mode: multiple features, none selected yet.
  if (!feature && Array.isArray(features) && features.length > 0) {
    return (
      <div
        className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex justify-center px-2
          pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
        data-feature-sheet=""
        data-feature-sheet-picker=""
        role="dialog"
        aria-label="Choose feature to edit"
      >
        <div
          className={`w-full max-w-sm rounded-t-2xl border shadow-xl surface-glass-chip
            ${a.panel} px-3 pt-3 pb-[max(3.75rem,calc(env(safe-area-inset-bottom,0px)+3.5rem))]`}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className={`${POPUP_TEXT.title} text-white`}>Edit feature</div>
            <button
              type="button"
              aria-label="Cancel"
              data-feature-sheet-cancel=""
              onClick={() => onCancel?.()}
              className="rounded-md p-1.5 text-gray-300 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
            {features.map((f) => {
              const Icon = FEATURE_ICONS[f.kind] || NotebookPen;
              const editable = isFeatureSheetEditable(f.kind);
              return (
                <button
                  key={f.id}
                  type="button"
                  data-feature-sheet-pick={f.id}
                  data-feature-kind={f.kind}
                  onClick={() => onPickFeature?.(f)}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left border
                    ${editable
                      ? 'bg-cyan-950/60 border-cyan-600/50 text-white'
                      : 'bg-gray-900/60 border-gray-600/50 text-gray-300'}`}
                >
                  <Icon size={16} strokeWidth={2} aria-hidden="true" />
                  <span className={`${POPUP_TEXT.value} font-medium flex-1`}>{f.chipLabel}</span>
                  {!editable && (
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">script</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (!feature) return null;

  const Icon = FEATURE_ICONS[feature.kind] || NotebookPen;
  const editable = !!(parsed && parsed.editable);
  const stub = !editable;

  const setNum = (key, raw, fallback) => {
    let next = raw;
    if (raw === '' || raw === '-' || raw === '.') next = raw;
    else {
      const n = Number(raw);
      next = Number.isFinite(n) ? n : (draft[key] ?? fallback);
    }
    setDraft((prev) => ({ ...prev, [key]: next }));
  };

  let fields = null;
  if (editable && feature.kind === 'extrude') {
    fields = (
      <>
        <NumberField
          id="sheet-extrude-distance"
          label="Distance"
          accent={ACCENT}
          value={draft.distance}
          onChange={(v) => setNum('distance', v, 10)}
          min={0.1}
          max={120}
          step={0.5}
        />
        <ChoiceRow
          label="Sense"
          accent={ACCENT}
          value={draft.sense || 'positive'}
          onChange={(sense) => setDraft((prev) => ({ ...prev, sense }))}
          options={[
            { value: 'positive', label: 'Out' },
            { value: 'negative', label: 'In' },
            { value: 'both', label: 'Both' },
          ]}
        />
      </>
    );
  } else if (editable && feature.kind === 'fillet') {
    fields = (
      <NumberField
        id="sheet-fillet-radius"
        label="Radius"
        accent={ACCENT}
        value={draft.radius}
        onChange={(v) => setNum('radius', v, 2)}
        min={0.01}
        max={40}
        step={0.25}
      />
    );
  } else if (editable && feature.kind === 'revolve') {
    fields = (
      <NumberField
        id="sheet-revolve-angle"
        label="Angle"
        accent={ACCENT}
        value={draft.angle}
        onChange={(v) => setNum('angle', v, 360)}
        min={0.1}
        max={360}
        step={1}
      />
    );
  } else {
    fields = (
      <p className={`${POPUP_TEXT.note} ${a.muted}`} data-feature-sheet-stub="">
        Params for {feature.label} aren’t editable here yet. Use Edit script to change the marked block.
      </p>
    );
  }

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex justify-center px-2
        pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
      data-feature-sheet=""
      data-feature-sheet-kind={feature.kind}
      data-feature-sheet-id={feature.id}
      data-feature-sheet-editable={editable ? 'true' : 'false'}
      role="dialog"
      aria-label={`${feature.chipLabel} feature sheet`}
    >
      <div
        className={`w-full max-w-sm rounded-t-2xl border shadow-xl surface-glass-chip
          ${a.panel} px-3 pt-3 pb-[max(3.75rem,calc(env(safe-area-inset-bottom,0px)+3.5rem))]`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="inline-flex items-center justify-center rounded-lg bg-cyan-900/70 p-1.5 border border-cyan-500/40">
            <Icon size={18} strokeWidth={2} aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className={`${POPUP_TEXT.title} text-white truncate`}>{feature.chipLabel}</div>
            <div className={`${POPUP_TEXT.subtitle} text-cyan-100/80`}>Feature sheet</div>
          </div>
          <button
            type="button"
            aria-label="Cancel"
            data-feature-sheet-cancel=""
            onClick={() => onCancel?.()}
            className="rounded-md p-1.5 text-gray-300 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-2 font-sans" data-feature-sheet-params="">
          {fields}
        </div>

        <div
          className="mt-2 rounded-md border border-cyan-800/60 bg-black/35 px-2 py-1.5
            font-mono text-[10px] leading-snug text-cyan-100/85 max-h-24 overflow-hidden"
          data-feature-sheet-snippet=""
          aria-hidden="true"
        >
          <pre className="whitespace-pre-wrap break-all m-0">{snippetPreview(block)}</pre>
        </div>

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <PopupButton
            variant="ghost"
            accent={ACCENT}
            data-feature-sheet-edit-script=""
            onClick={() => onEditScript?.(feature)}
          >
            <Code2 size={14} aria-hidden="true" />
            Edit script
          </PopupButton>
          <div className="flex-1" />
          {!stub && (
            <PopupButton
              variant="primary"
              accent={ACCENT}
              data-feature-sheet-accept=""
              onClick={() => onAccept?.(feature, draft)}
            >
              <Check size={14} aria-hidden="true" />
              Accept
            </PopupButton>
          )}
        </div>
      </div>
    </div>
  );
}
