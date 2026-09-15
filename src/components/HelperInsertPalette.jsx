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
} from 'lucide-react';
import { HELPER_PALETTE_GROUPS, itemsByGroup } from '../utils/helperPaletteSnippets';
import { resolveFaceModal } from '../utils/faceFeaturePlacement';
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
};

/**
 * Slice 09/10/11 — left vertical helper insert palette (game mode).
 * Tap opens HelperParamModal; with selectedFace, face features get a
 * face-type-aware sheet (or refuse for irregular). Confirm → onInsert(id, params, faceContext).
 */
const HelperInsertPalette = ({ onInsert, getBuffer, selectedFace = null, compact = false }) => {
  const grouped = itemsByGroup();
  const iconSize = compact ? 16 : 18;
  const pad = compact ? 'p-1.5' : 'p-2';
  const [pending, setPending] = useState(null);
  const [bufferSnapshot, setBufferSnapshot] = useState('');
  const [faceSnapshot, setFaceSnapshot] = useState(null);
  const [modalMode, setModalMode] = useState('default'); // default | params | refuse
  const [refuseMessage, setRefuseMessage] = useState(null);

  const openParams = (item) => {
    const buf = typeof getBuffer === 'function' ? getBuffer() : '';
    setBufferSnapshot(typeof buf === 'string' ? buf : '');
    const resolved = resolveFaceModal(item, selectedFace);
    if (resolved.mode === 'refuse') {
      setPending(item);
      setFaceSnapshot(resolved.face);
      setRefuseMessage(resolved.message);
      setModalMode('refuse');
      return;
    }
    if (resolved.mode === 'params') {
      setPending(resolved.item);
      setFaceSnapshot(resolved.face);
      setRefuseMessage(null);
      setModalMode('params');
      return;
    }
    setPending(item);
    setFaceSnapshot(null);
    setRefuseMessage(null);
    setModalMode('default');
  };

  const close = () => {
    setPending(null);
    setFaceSnapshot(null);
    setRefuseMessage(null);
    setModalMode('default');
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
          onCancel={close}
          onConfirm={(params) => {
            const id = pending.id;
            const faceCtx = faceSnapshot;
            close();
            onInsert?.(id, params, faceCtx);
          }}
        />
      )}
    </>
  );
};

export default HelperInsertPalette;
