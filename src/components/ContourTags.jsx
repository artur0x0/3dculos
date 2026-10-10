import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Vector3 } from 'three';
import { useDisplayUnit } from '../hooks/useDisplayUnit';
import { formatDisplayLength } from '../utils/displayUnit';
import { dimensionAnchor, planeUvToWorld } from '../utils/contourPick';

/**
 * Floating dimension tags. Only while this contour is open.
 * The overlay box ignores pointers. Each tag does not, so orbit still
 * hits the canvas. Tap a tag for Delete and X. Positions follow the
 * camera in a frame loop and are not React state.
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

  useEffect(() => {
    let frame = 0;
    const list = model?.dimensions || [];
    const tick = () => {
      const camera = cameraRef?.current;
      const canvas = canvasRef?.current;
      const container = containerRef?.current;
      const box = container?.getBoundingClientRect();
      const view = canvas?.getBoundingClientRect();
      if (camera && view && box && plane?.center) {
        for (const dim of list) {
          const el = nodes.current.get(dim.id);
          const uv = dimensionAnchor(model, dim);
          if (!el || !uv) continue;
          const world = planeUvToWorld(uv, plane);
          const p = scratch.current.set(world[0], world[1], world[2]).project(camera);
          const behind = p.z < -1 || p.z > 1;
          el.style.display = behind ? 'none' : '';
          const x = (p.x * 0.5 + 0.5) * view.width + view.left - box.left;
          const y = (-p.y * 0.5 + 0.5) * view.height + view.top - box.top;
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, canvasRef, containerRef, plane, model]);

  if (!dimensions.length || !plane) return null;

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
    </div>
  );
};

export default ContourTags;
