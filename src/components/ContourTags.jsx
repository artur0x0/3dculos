import React, { useEffect, useRef } from 'react';
import {
  X,
  MoveHorizontal,
  MoveVertical,
  AlignCenterHorizontal,
  Plus,
  Radius,
  Equal,
  CircleDot,
  Lock,
} from 'lucide-react';
import { Vector3 } from 'three';
import { useDisplayUnit } from '../hooks/useDisplayUnit';
import { formatDisplayLength } from '../utils/displayUnit';
import { CONSTRAINT_LABELS } from '../utils/contourGesture';
import { constraintAnchor, dimensionAnchor, planeUvToWorld } from '../utils/contourPick';

const CONSTRAINT_ICONS = {
  horizontal: MoveHorizontal,
  vertical: MoveVertical,
  parallel: AlignCenterHorizontal,
  perpendicular: Plus,
  tangent: Radius,
  equal: Equal,
  coincident: CircleDot,
  fix: Lock,
};

/**
 * Floating dimension tags and constraint icons. Only while this contour
 * is open. The overlay box ignores pointers. Each tag does not, so orbit
 * still hits the canvas. Tap one for Delete and X. That does not reopen
 * the card. Positions follow the camera in a frame loop and are not
 * React state.
 */
const ContourTags = ({
  model = null,
  plane = null,
  cameraRef = null,
  canvasRef = null,
  containerRef = null,
  selectedId = null,
  onSelect,
  onDelete,
  onClose,
}) => {
  const [unit] = useDisplayUnit();
  const nodes = useRef(new Map());
  const scratch = useRef(new Vector3());
  const dimensions = model?.dimensions || [];
  const constraints = model?.constraints || [];

  useEffect(() => {
    let frame = 0;
    const dims = model?.dimensions || [];
    const cons = model?.constraints || [];
    const tick = () => {
      const camera = cameraRef?.current;
      const canvas = canvasRef?.current;
      const container = containerRef?.current;
      const box = container?.getBoundingClientRect();
      const view = canvas?.getBoundingClientRect();
      const place = (id, uv) => {
        const el = nodes.current.get(id);
        if (!el || !uv) return;
        const world = planeUvToWorld(uv, plane);
        const p = scratch.current.set(world[0], world[1], world[2]).project(camera);
        const behind = p.z < -1 || p.z > 1;
        el.style.display = behind ? 'none' : '';
        const x = (p.x * 0.5 + 0.5) * view.width + view.left - box.left;
        const y = (-p.y * 0.5 + 0.5) * view.height + view.top - box.top;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      };
      if (camera && view && box && plane?.center) {
        for (const dim of dims) place(dim.id, dimensionAnchor(model, dim));
        for (const con of cons) place(con.id, constraintAnchor(model, con));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, canvasRef, containerRef, plane, model]);

  if ((!dimensions.length && !constraints.length) || !plane) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-contour-tags="">
      {dimensions.map((dim) => {
        const value = dim.kind === 'angle'
          ? `${Number(dim.value).toFixed(1)}°`
          : formatDisplayLength(dim.value, unit);
        const label = dim.name ? `${dim.name} ${value}` : value;
        const open = selectedId === dim.id;
        return (
          <div
            key={dim.id}
            ref={(el) => {
              if (el) nodes.current.set(dim.id, el);
              else nodes.current.delete(dim.id);
            }}
            className="pointer-events-auto absolute"
            style={{ transform: 'translate(-50%, -120%)' }}
          >
            <button
              type="button"
              data-contour-tag={dim.id}
              className="min-h-11 min-w-11 rounded-full bg-white/90 px-2 text-[12px] font-medium text-cyan-950 shadow"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(dim.id);
              }}
            >
              {label}
            </button>
            {open && (
              <div
                data-contour-tag-popup={dim.id}
                className="mt-1 flex gap-1 rounded-md bg-white/95 p-1 shadow"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-contour-tag-delete={dim.id}
                  className="min-h-11 rounded bg-cyan-800 px-3 text-[13px] text-white"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete?.(dim.id);
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-contour-tag-close=""
                  aria-label="Close"
                  className="flex min-h-11 min-w-11 items-center justify-center rounded text-gray-700"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose?.();
                  }}
                >
                  <X size={16} strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        );
      })}
      {constraints.map((con) => {
        const Icon = CONSTRAINT_ICONS[con.kind] || Lock;
        const open = selectedId === con.id;
        const label = CONSTRAINT_LABELS[con.kind] || con.kind;
        return (
          <div
            key={con.id}
            ref={(el) => {
              if (el) nodes.current.set(con.id, el);
              else nodes.current.delete(con.id);
            }}
            className="pointer-events-auto absolute"
            style={{ transform: 'translate(-50%, -120%)' }}
          >
            <button
              type="button"
              data-contour-tag={con.id}
              data-contour-icon={con.kind}
              aria-label={label}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/90 text-cyan-950 shadow"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(con.id);
              }}
            >
              <Icon size={16} strokeWidth={2} />
            </button>
            {open && (
              <div
                data-contour-tag-popup={con.id}
                className="mt-1 flex gap-1 rounded-md bg-white/95 p-1 shadow"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-contour-tag-delete={con.id}
                  className="min-h-11 rounded bg-cyan-800 px-3 text-[13px] text-white"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete?.(con.id);
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-contour-tag-close=""
                  aria-label="Close"
                  className="flex min-h-11 min-w-11 items-center justify-center rounded text-gray-700"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose?.();
                  }}
                >
                  <X size={16} strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ContourTags;
