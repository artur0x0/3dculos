import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Vector3 } from 'three';

/**
 * Floating joint tags. Tap one for Delete and X. The popup does not
 * reopen the joint card. The overlay ignores pointers so orbit still
 * hits the canvas. Positions follow the camera and are not React state.
 */
export default function JointTags({
  tags = [],
  selectedId = null,
  onSelect,
  onDelete,
  onClose,
  cameraRef = null,
  canvasRef = null,
  containerRef = null,
}) {
  const nodes = useRef(new Map());
  const scratch = useRef(new Vector3());

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const camera = cameraRef?.current;
      const canvas = canvasRef?.current;
      const container = containerRef?.current;
      const box = container?.getBoundingClientRect();
      const view = canvas?.getBoundingClientRect();
      if (camera && view && box) {
        for (const tag of tags) {
          const el = nodes.current.get(tag.id);
          const world = tag.world;
          if (!el || !world) continue;
          const p = scratch.current.set(world[0], world[1], world[2]).project(camera);
          const behind = p.z < -1 || p.z > 1;
          el.style.display = behind ? 'none' : '';
          const x = (p.x * 0.5 + 0.5) * view.width + view.left - box.left;
          const y = (-p.y * 0.5 + 0.5) * view.height + view.top - box.top;
          // A projected tag past the pane must not extend scrollable overflow
          // if an ancestor fails to clip. The overlay clips the rest.
          el.style.left = `${Math.min(box.width, Math.max(0, x))}px`;
          el.style.top = `${Math.min(box.height, Math.max(0, y))}px`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, canvasRef, containerRef, tags]);

  if (!tags.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" data-joint-tags="">
      {tags.map((tag) => {
        const open = selectedId === tag.id;
        const invalid = !!tag.invalid;
        return (
          <div
            key={tag.id}
            ref={(el) => {
              if (el) nodes.current.set(tag.id, el);
              else nodes.current.delete(tag.id);
            }}
            className="pointer-events-auto absolute"
            style={{ transform: 'translate(-50%, -120%)' }}
          >
            <button
              type="button"
              data-joint-tag={tag.id}
              data-joint-type={tag.type || ''}
              aria-invalid={invalid || undefined}
              title={tag.title || tag.label}
              className={`min-h-11 min-w-11 rounded-full px-2 text-[12px] font-medium shadow ${
                invalid
                  ? 'border-2 border-red-400 feature-failed-ring bg-white/90 text-cyan-950'
                  : 'bg-white/90 text-cyan-950'
              }`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(open ? null : tag.id);
              }}
            >
              {tag.label}
            </button>
            {open && (
              <div
                data-joint-tag-popup={tag.id}
                className="mt-1 flex gap-1 rounded-md bg-white/95 p-1 shadow"
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-joint-tag-delete={tag.id}
                  className="min-h-11 rounded bg-cyan-800 px-3 text-[13px] text-white"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete?.(tag.id);
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  data-joint-tag-close=""
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
}
