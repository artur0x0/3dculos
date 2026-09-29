import React, { useState } from 'react';
import {
  Box,
  Cylinder,
  Circle,
  Torus,
  Hexagon,
  Squircle,
  TriangleRight,
  Grid3x3,
  Bolt,
  Drill,
  PackageOpen,
  Boxes,
  Cone,
  Focus,
  AlignVerticalJustifyCenter,
  FlipHorizontal2,
  Layers3,
  ArrowUpFromLine,
  Rotate3d,
  Pyramid,
  NotebookPen,
  Route,
} from 'lucide-react';
import SquareRoundCorner from './icons/SquareRoundCorner';
import Angle from './icons/Angle';
import { itemsByGroup, paletteRailSections } from '../utils/helperPaletteSnippets';
import { RAIL_PAIR_HEIGHT_CLASS, RAIL_PAIR_HEIGHT_ATTR } from '../utils/railPair';
import { resolveFaceModal } from '../utils/faceFeaturePlacement';
import { canBuildFilletAlongPath, resolveFilletStrategy } from '../utils/filletAlongPath';
import { isContourEntry } from '../utils/contourMode';
import { isFilletEntry, isChamferEntry } from '../utils/filletMode';
import HelperParamModal from './HelperParamModal';

const ICONS = {
  cube: Box,
  cylinder: Cylinder,
  sphere: Circle,
  tube: Torus,
  hexPrism: Hexagon,
  roundedBox: Squircle,
  filletEdges: SquareRoundCorner,
  chamferEdges: TriangleRight,
  hole: Drill,
  holePattern: Grid3x3,
  clearanceHole: Bolt,
  tapDrillHole: Drill,
  cboreHole: Cylinder,
  cskHole: Cone,
  shell: PackageOpen,
  addDraft: Angle,
  center: Focus,
  align: AlignVerticalJustifyCenter,
  mirror: FlipHorizontal2,
  // One Array button; Grid vs Polar is a param inside it.
  array3D: Boxes,
  // Workplane matches the right rail's plane-visibility toggle (both Layers3),
  // and Create contour matches its sketch-visibility toggle (both NotebookPen):
  // the tool that makes the thing wears the icon that shows the thing.
  workplane: Layers3,
  makeExtrude: ArrowUpFromLine,
  makeRevolve: Rotate3d,
  makeLoft: Pyramid,
  // Sweep inherited Route from the retired Path button — a sweep *is* a path.
  makeSweep: Route,
  crossSection: NotebookPen,
};

/** Mobile-first group captions (full names stay on the data model). */
const GROUP_SHORT_LABEL = {
  Primitives: 'Block',
  Advanced: 'Adv',
  Features: 'Polish',
  Transforms: 'Move',
};

/**
 * Slice 09/10/11 — left vertical helper insert palette.
 * Game keeps the Advanced grouping. Regular CAD promotes Profile / Workplane /
 * Extrude / Revolve / Sweep / Loft into the Model section of this same rail.
 * Tap opens HelperParamModal; with selectedFace / selectedEdges, face/edge
 * features get an aware sheet (or refuse). Confirm → onInsert(id, params, faceContext, edgeContext).
 * Slice 24/25/26/28/30: Extrude / Revolve / Loft / Sweep / Profile call onEnterContourMode.
 * Extrude / Revolve / Loft / Sweep Confirm commits the solid; Profile stays Profile-only.
 * Slice 27: Fillet enters edge-pick mode (no pre-select / no soft-fail).
 * Slice 29: groups Block / Adv / Feat / Xform on the game rail.
 * Advanced Confirm unions onto `part` when a solid is already in the script.
 */
const HelperInsertPalette = ({
  onInsert,
  getBuffer,
  selectedFace = null,
  selectedEdges = null,
  onRequestEdgeMode = null,
  onStaleEdgesClear = null,
  onProfilePreview = null,
  onPathPreview = null,
  onEnterContourMode = null,
  onEnterFilletMode = null,
  compact = false,
  /** 'game' keeps Advanced. 'cad' promotes that set into Model. */
  layout = 'game',
}) => {
  const grouped = itemsByGroup();
  // Both viewport rails (this one and CrossSectionPanel) share one *exact*
  // height via RAIL_PAIR_HEIGHT_CLASS (pixel-perfect pair, not max-h approx).
  const iconSize = 20;
  const pad = 'p-2';
  const [pending, setPending] = useState(null);
  const [bufferSnapshot, setBufferSnapshot] = useState('');
  const [faceSnapshot, setFaceSnapshot] = useState(null);
  const [edgeSnapshot, setEdgeSnapshot] = useState(null);
  const [modalMode, setModalMode] = useState('default'); // default | params | refuse
  const [refuseMessage, setRefuseMessage] = useState(null);
  const [refuseTitle, setRefuseTitle] = useState(null);

  const openParams = (item) => {
    // Labeled slots with no builder stay a refuse — Sweep is a real contour entry.
    if (item.placeholder) {
      setPending(null);
      setFaceSnapshot(null);
      setEdgeSnapshot(null);
      setRefuseTitle(item.label);
      setRefuseMessage(`${item.label} is not available yet.`);
      setModalMode('refuse');
      return;
    }
    setRefuseTitle(null);
    // Slice 24/25/26/28/30: Extrude / Revolve / Loft / Sweep / Profile enter contour mode.
    if (isContourEntry(item.id) && typeof onEnterContourMode === 'function') {
      onEnterContourMode({ entry: item.id });
      return;
    }
    // Slice 27: Fillet enters edge-pick mode even with no prior selection.
    if ((isFilletEntry(item.id) || isChamferEntry(item.id)) && typeof onEnterFilletMode === 'function') {
      onEnterFilletMode({ entry: item.id });
      return;
    }
    // Workplane is a construction plane, not a param sheet and not a host solid.
    if (item.id === 'workplane') {
      onInsert?.('workplane', {}, selectedFace, null);
      return;
    }
    const buf = typeof getBuffer === 'function' ? getBuffer() : '';
    setBufferSnapshot(typeof buf === 'string' ? buf : '');
    // Auto-switch to edge pick when opening chamfer/path with no edges yet.
    if ((item.id === 'chamferEdges' || item.id === 'sweepPath')
      && !(selectedEdges && selectedEdges.length)
      && typeof onRequestEdgeMode === 'function') {
      onRequestEdgeMode();
    }
    const resolved = resolveFaceModal(item, selectedFace, selectedEdges);
    if (resolved.mode === 'refuse') {
      setPending(item);
      setFaceSnapshot(resolved.face || null);
      setEdgeSnapshot(resolved.edges || selectedEdges);
      setRefuseMessage(resolved.message);
      setModalMode('refuse');
      return;
    }
    if (resolved.mode === 'params') {
      setPending(resolved.item);
      setFaceSnapshot(resolved.face || null);
      setEdgeSnapshot(resolved.edges || selectedEdges);
      setRefuseMessage(null);
      setModalMode('params');
      return;
    }
    setPending(item);
    setFaceSnapshot(null);
    setEdgeSnapshot(null);
    setRefuseMessage(null);
    setModalMode('default');
  };

  const close = () => {
    setPending(null);
    setFaceSnapshot(null);
    setEdgeSnapshot(null);
    setRefuseMessage(null);
    setRefuseTitle(null);
    setModalMode('default');
    onProfilePreview?.(null);
    onPathPreview?.(null);
  };

  const sections = paletteRailSections(layout, grouped).map((section) => ({
    key: section.key,
    label: section.key === 'Model' ? 'Model' : (GROUP_SHORT_LABEL[section.key] || section.key),
    section: section.key === 'Model' ? 'model' : section.key.toLowerCase(),
    items: section.items,
  }));

  return (
    <>
      <div
        className={`absolute left-2 lg:left-4 bottom-2.5 z-10 flex flex-col gap-1
          bg-white/60 backdrop-blur-sm rounded-lg shadow-lg
          ${RAIL_PAIR_HEIGHT_CLASS}
          p-2`}
        role="group"
        aria-label="Helper insert palette"
        data-rail-pair="left"
        data-rail-height={RAIL_PAIR_HEIGHT_ATTR}
        data-palette-layout={layout === 'cad' ? 'cad' : 'game'}
      >
        {sections.map((section, gi) => (
          <div
            key={section.key}
            className="flex flex-col gap-0.5"
            data-palette-section={section.section}
          >
            {gi > 0 && (
              <div className="border-t border-gray-300/70 my-0.5 mx-0.5" aria-hidden />
            )}
            <div
              className={`text-[9px] font-semibold uppercase tracking-wide text-gray-500 px-1 ${
                compact ? 'leading-3' : 'leading-4'
              }`}
            >
              {section.label}
            </div>
            {section.items.map((item) => {
              const Icon = ICONS[item.id] || Box;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openParams(item)}
                  title={item.title}
                  aria-label={
                    item.placeholder
                      ? `${item.label} placeholder: ${item.title}`
                      : `Insert ${item.label}: ${item.title}`
                  }
                  className={`${pad} rounded text-blue-700 hover:bg-blue-100 active:bg-blue-200
                    flex items-center justify-center transition-colors`}
                >
                  <Icon size={iconSize} strokeWidth={2} />
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {modalMode === 'refuse' && refuseMessage && (
        <HelperParamModal
          item={null}
          refuseMessage={refuseMessage}
          refuseTitle={refuseTitle}
          onCancel={close}
        />
      )}

      {pending && modalMode !== 'refuse' && (
        <HelperParamModal
          item={pending}
          buffer={bufferSnapshot}
          faceInfo={faceSnapshot}
          edgeInfo={edgeSnapshot}
          onCancel={close}
          onValuesChange={(values, item) => {
            if (item?.id === 'crossSection') {
              onPathPreview?.(null);
              onProfilePreview?.({
                face: faceSnapshot,
                params: values,
              });
              return;
            }
            if (item?.id === 'sweepPath') {
              onProfilePreview?.(null);
              onPathPreview?.({
                edges: edgeSnapshot,
                params: values,
              });
              return;
            }
            // Fillet Strategy=sweep (default / auto→sweep) → same path preview as Path.
            if (
              item?.id === 'filletEdges'
              && resolveFilletStrategy(values?.strategy, edgeSnapshot) === 'sweep'
            ) {
              onProfilePreview?.(null);
              onPathPreview?.({
                edges: edgeSnapshot,
                params: values,
              });
              return;
            }
            onProfilePreview?.(null);
            onPathPreview?.(null);
          }}
          onConfirm={(params) => {
            const id = pending.id;
            const faceCtx = faceSnapshot;
            const edgeCtx = edgeSnapshot;
            const isEdgeFeature = id === 'filletEdges' || id === 'chamferEdges';
            const isSweepPath = id === 'sweepPath';
            const scope = params?.edgeScope
              || (edgeCtx && edgeCtx.length ? 'selected' : (faceCtx ? 'face' : 'allConvex'));
            // Soft-fail: selected-edge scope with no edges — clear + prompt, never emit JS.
            if (isEdgeFeature && scope === 'selected' && !(edgeCtx && edgeCtx.length)) {
              close();
              onStaleEdgesClear?.(
                'No edges selected — re-pick after geometry changes, then Fillet/Chamfer.',
              );
              return;
            }
            if (isSweepPath && !(edgeCtx && edgeCtx.length)) {
              close();
              onStaleEdgesClear?.(
                'No edges selected — re-pick a contiguous chain or loop, then Path.',
              );
              return;
            }
            // Fillet Strategy=sweep (default / auto→sweep) soft-fails like Path.
            if (id === 'filletEdges' && resolveFilletStrategy(params?.strategy, edgeCtx) === 'sweep') {
              const gate = canBuildFilletAlongPath(edgeCtx);
              if (!gate.ok) {
                close();
                onStaleEdgesClear?.(gate.message);
                return;
              }
            }
            close();
            onInsert?.(id, params, faceCtx, edgeCtx);
          }}
        />
      )}
    </>
  );
};

export default HelperInsertPalette;
