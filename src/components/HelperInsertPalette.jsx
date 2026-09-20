import React, { useState } from 'react';
import {
  Box,
  Cylinder,
  Circle,
  Donut,
  Hexagon,
  Squircle,
  Radius,
  Triangle,
  CircleDot,
  Grid3x3,
  Bolt,
  Drill,
  Cone,
  BoxSelect,
  MoveVertical,
  Focus,
  AlignVerticalJustifyCenter,
  FlipHorizontal2,
  Copy,
  RotateCw,
  Frame,
  ArrowUpFromLine,
  Rotate3d,
  Layers,
  SquareDashed,
  Route,
} from 'lucide-react';
import { HELPER_PALETTE_GROUPS, itemsByGroup } from '../utils/helperPaletteSnippets';
import { resolveFaceModal } from '../utils/faceFeaturePlacement';
import { canBuildFilletAlongPath, resolveFilletStrategy } from '../utils/filletAlongPath';
import { isContourEntry } from '../utils/contourMode';
import { isFilletEntry } from '../utils/filletMode';
import HelperParamModal from './HelperParamModal';

const ICONS = {
  cube: Box,
  cylinder: Cylinder,
  sphere: Circle,
  tube: Donut,
  hexPrism: Hexagon,
  roundedBox: Squircle,
  filletEdges: Radius,
  chamferEdges: Triangle,
  hole: CircleDot,
  holePattern: Grid3x3,
  clearanceHole: Bolt,
  tapDrillHole: Drill,
  cboreHole: Cone,
  cskHole: Cone,
  shell: BoxSelect,
  addDraft: MoveVertical,
  center: Focus,
  align: AlignVerticalJustifyCenter,
  mirror: FlipHorizontal2,
  array3D: Copy,
  polarArray: RotateCw,
  workplane: Frame,
  makeExtrude: ArrowUpFromLine,
  makeRevolve: Rotate3d,
  makeLoft: Layers,
  crossSection: SquareDashed,
  sweepPath: Route,
};

/**
 * Slice 09/10/11 — left vertical helper insert palette (game mode).
 * Tap opens HelperParamModal; with selectedFace / selectedEdges, face/edge
 * features get an aware sheet (or refuse). Confirm → onInsert(id, params, faceContext, edgeContext).
 * Slice 24/25/26/28: Extrude / Revolve / Loft / Profile call onEnterContourMode.
 * Extrude / Revolve / Loft Confirm commits the solid; Profile stays Profile-only.
 * Slice 27: Fillet enters edge-pick mode (no pre-select / no soft-fail).
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
}) => {
  const grouped = itemsByGroup();
  const iconSize = compact ? 16 : 18;
  const pad = compact ? 'p-1.5' : 'p-2';
  const [pending, setPending] = useState(null);
  const [bufferSnapshot, setBufferSnapshot] = useState('');
  const [faceSnapshot, setFaceSnapshot] = useState(null);
  const [edgeSnapshot, setEdgeSnapshot] = useState(null);
  const [modalMode, setModalMode] = useState('default'); // default | params | refuse
  const [refuseMessage, setRefuseMessage] = useState(null);

  const openParams = (item) => {
    // Slice 24/25/26: Extrude / Revolve / Profile enter contour mode (never one-shot).
    if (isContourEntry(item.id) && typeof onEnterContourMode === 'function') {
      onEnterContourMode({ entry: item.id });
      return;
    }
    // Slice 27: Fillet enters edge-pick mode even with no prior selection.
    if (isFilletEntry(item.id) && typeof onEnterFilletMode === 'function') {
      onEnterFilletMode();
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
    setModalMode('default');
    onProfilePreview?.(null);
    onPathPreview?.(null);
  };

  return (
    <>
      <div
        className={`absolute left-2 lg:left-4 bottom-4 z-10 flex flex-col gap-1
          bg-white/60 backdrop-blur-sm rounded-lg shadow-lg
          max-h-[min(72%,calc(100%-5.5rem))] overflow-y-auto overflow-x-hidden
          ${compact ? 'p-1' : 'p-1.5'}`}
        role="group"
        aria-label="Helper insert palette"
      >
        {HELPER_PALETTE_GROUPS.map((group, gi) => (
          <div key={group} className="flex flex-col gap-0.5">
            {gi > 0 && (
              <div className="border-t border-gray-300/70 my-0.5 mx-0.5" aria-hidden />
            )}
            <div
              className={`text-[9px] font-semibold uppercase tracking-wide text-gray-500 px-1 ${
                compact ? 'leading-3' : 'leading-4'
              }`}
            >
              {group === 'Primitives' ? 'Prim' : group === 'Features' ? 'Feat' : 'Xform'}
            </div>
            {(grouped[group] || []).map((item) => {
              const Icon = ICONS[item.id] || Box;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openParams(item)}
                  title={item.title}
                  aria-label={`Insert ${item.label}: ${item.title}`}
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
