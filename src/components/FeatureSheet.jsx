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
  Trash2,
  Box,
  Cylinder,
  Circle,
  Torus,
  Hexagon,
  Squircle,
  Drill,
  Grid3x3,
  Bolt,
  Cone,
  PackageOpen,
  Focus,
  AlignVerticalJustifyCenter,
  FlipHorizontal2,
  Boxes,
} from 'lucide-react';
import SquareRoundCorner from './icons/SquareRoundCorner';
import Angle from './icons/Angle';
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
 * Slice Mobile C.1 — full-width horizontal feature sheet under the part name.
 *
 * Replaces the Mobile C bottom-sheet chrome. Params + Accept / Cancel / Edit
 * script stay. Mounts on CAD and Script stages. Desktop never mounts this.
 *
 * Layout: title/actions row on top; params scroll horizontally underneath so
 * narrow phones keep Accept visible without hiding Distance / Sense.
 */

const FEATURE_ICONS = Object.freeze({
  profile: NotebookPen,
  extrude: ArrowUpFromLine,
  revolve: Rotate3d,
  loft: Pyramid,
  sweep: Route,
  fillet: SquareRoundCorner,
  chamfer: TriangleRight,
  cube: Box,
  roundedBox: Squircle,
  cylinder: Cylinder,
  sphere: Circle,
  tube: Torus,
  hexPrism: Hexagon,
  hole: Drill,
  holePattern: Grid3x3,
  clearanceHole: Bolt,
  tapDrillHole: Drill,
  cboreHole: Cylinder,
  cskHole: Cone,
  shell: PackageOpen,
  draft: Angle,
  center: Focus,
  align: AlignVerticalJustifyCenter,
  mirror: FlipHorizontal2,
  array: Boxes,
  polarArray: Boxes,
});

const ACCENT = 'cyan';

function snippetPreview(text, maxLines = 2) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines - 1).join('\n')}\n…`;
}

/** Shared outer shell: full-width under title (top-14). */
function SheetShell({ children, ...attrs }) {
  const a = accentOf(ACCENT);
  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-14 z-40 px-2
        flex justify-center"
      data-feature-sheet=""
      data-feature-sheet-layout="under-title-horizontal"
      role="dialog"
      {...attrs}
    >
      <div
        className={`w-full rounded-xl border shadow-xl surface-glass-chip
          ${a.panel} px-3 py-2 overflow-hidden`}
      >
        {children}
      </div>
    </div>
  );
}

function TypeBadge({ index }) {
  if (!index) return null;
  return (
    <span
      className="absolute -bottom-1 -right-1 min-w-[0.85rem] h-[0.85rem] px-0.5
        rounded-full bg-cyan-500 text-[8px] leading-[0.85rem] text-center
        font-bold text-white"
      data-feature-type-badge={index}
      aria-hidden="true"
    >
      {index}
    </span>
  );
}

export default function FeatureSheet({
  feature = null,
  features = null,
  script = '',
  onAccept,
  onCancel,
  onDelete,
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

  // Picker mode: multiple features, none selected yet — horizontal chip row.
  if (!feature && Array.isArray(features) && features.length > 0) {
    return (
      <SheetShell
        data-feature-sheet-picker=""
        aria-label="Choose feature to edit"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={`${POPUP_TEXT.title} text-white shrink-0`}>Edit feature</div>
          <div className="flex flex-row gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0">
            {features.map((f) => {
              const Icon = FEATURE_ICONS[f.kind] || NotebookPen;
              const editable = isFeatureSheetEditable(f.kind);
              const typeIndex = f.typeIndex || ((f.index ?? 0) + 1);
              return (
                <button
                  key={f.id}
                  type="button"
                  data-feature-sheet-pick={f.id}
                  data-feature-kind={f.kind}
                  data-feature-type-index={typeIndex}
                  onClick={() => onPickFeature?.(f)}
                  className={`relative shrink-0 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left border
                    ${editable
                      ? 'bg-cyan-950/60 border-cyan-600/50 text-white'
                      : 'bg-gray-900/60 border-gray-600/50 text-gray-300'}`}
                >
                  <span className="relative inline-flex">
                    <Icon size={16} strokeWidth={2} aria-hidden="true" />
                    <TypeBadge index={typeIndex} />
                  </span>
                  <span className={`${POPUP_TEXT.value} font-medium whitespace-nowrap`}>{f.chipLabel}</span>
                  {!editable && (
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">script</span>
                  )}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Cancel"
            data-feature-sheet-cancel=""
            onClick={() => onCancel?.()}
            className="shrink-0 rounded-md p-1.5 text-gray-300 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
      </SheetShell>
    );
  }

  if (!feature) return null;

  const Icon = FEATURE_ICONS[feature.kind] || NotebookPen;
  const editable = !!(parsed && parsed.editable);
  const stub = !editable;
  const typeIndex = feature.typeIndex || ((feature.index ?? 0) + 1);

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
        <div className="shrink-0 min-w-[10rem]">
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
        </div>
        <div className="shrink-0 min-w-[10rem]">
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
        </div>
      </>
    );
  } else if (editable && feature.kind === 'fillet') {
    fields = (
      <div className="shrink-0 min-w-[10rem]">
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
      </div>
    );
  } else if (editable && feature.kind === 'revolve') {
    fields = (
      <div className="shrink-0 min-w-[10rem]">
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
      </div>
    );
  } else {
    fields = (
      <p className={`${POPUP_TEXT.note} ${a.muted} shrink-0 max-w-[16rem]`} data-feature-sheet-stub="">
        Params for {feature.label} aren’t editable here yet. Use Edit script.
      </p>
    );
  }

  return (
    <SheetShell
      data-feature-sheet-kind={feature.kind}
      data-feature-sheet-id={feature.id}
      data-feature-sheet-editable={editable ? 'true' : 'false'}
      aria-label={`${feature.chipLabel} feature sheet`}
    >
      {/* Row 1: identity + actions (always visible on narrow phones). */}
      <div
        className="flex flex-row flex-wrap items-center gap-x-2 gap-y-1.5 w-full min-w-0"
        data-feature-sheet-row="identity"
      >
        <span className="relative inline-flex items-center justify-center rounded-lg bg-cyan-900/70 p-1.5 border border-cyan-500/40 shrink-0">
          <Icon size={18} strokeWidth={2} aria-hidden="true" />
          <TypeBadge index={typeIndex} />
        </span>
        {/* `shrink-0` here fought `flex-1` and won, so the title block kept its
            full content width and pushed itself under the actions on a phone —
            `truncate` never got the chance to fire. It must be allowed to
            shrink; the action buttons are the ones that hold their size. */}
        <div className="min-w-0 flex-1">
          <div className={`${POPUP_TEXT.title} text-white truncate`}>{feature.chipLabel}</div>
          <div className={`${POPUP_TEXT.subtitle} text-cyan-100/80 truncate`}>Feature sheet</div>
        </div>
        {/* The four actions are ~315px on their own, which is more than a 360px
            phone has left after the icon — so the cluster wraps to its own line
            instead of colliding with the title or being clipped by the shell's
            overflow-hidden. `ml-auto` keeps it right-aligned either way. */}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          <PopupButton
            variant="ghost"
            accent={ACCENT}
            data-feature-sheet-edit-script=""
            onClick={() => onEditScript?.(feature)}
          >
            <Code2 size={14} aria-hidden="true" />
            Edit script
          </PopupButton>
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
          <button
            type="button"
            aria-label="Delete feature"
            data-feature-sheet-delete=""
            title="Delete this feature from the script"
            onClick={() => onDelete?.(feature)}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[13px]
              font-medium text-red-200 border border-red-700/60 bg-red-950/50
              hover:bg-red-900/70 hover:text-white"
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
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
      </div>

      {/* Row 2: params scroll horizontally when they don’t fit. */}
      <div
        className="mt-2 flex flex-row items-start gap-3 font-sans overflow-x-auto no-scrollbar"
        data-feature-sheet-params=""
      >
        {fields}
        <div
          className="shrink-0 rounded-md border border-cyan-800/60 bg-black/35 px-2 py-1
            font-mono text-[10px] leading-snug text-cyan-100/85 max-w-[10rem] max-h-12 overflow-hidden"
          data-feature-sheet-snippet=""
          aria-hidden="true"
        >
          <pre className="whitespace-pre-wrap break-all m-0">{snippetPreview(block)}</pre>
        </div>
      </div>
    </SheetShell>
  );
}
