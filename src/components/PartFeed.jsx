import React, { useEffect, useRef } from 'react';
import { Eye, EyeOff, FilePlus, FolderOpen, GripVertical, Plus } from 'lucide-react';

// Same ribbon and strip buttons as the script editor top bar
// (CodeEditor `data-editor-ribbon` + Toolbar `variant="strip"`).
const STRIP_ROW = 'flex items-center gap-0.5 sm:gap-1 flex-1 min-w-0 overflow-x-auto';
const STRIP_BTN = 'shrink-0 p-1.5 flex items-center rounded active:opacity-80 hover:bg-gray-700/60 text-blue-400';
const STRIP_DIVIDER = 'shrink-0 w-px bg-gray-600 mx-0.5 self-stretch my-1';
const STRIP_ICON = 18;

/**
 * Parts feed. Desktop mounts it to the left of the editor. Mobile mounts it
 * as the Parts stage. Each row is a thumbnail and a name. A red bar marks
 * the selected row. The eye toggles visibility. Load lives in this pane.
 */
function drawThumbnail(canvas, mesh) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, w, h);
  const src = mesh?.vertProperties;
  const np = mesh?.numProp || 3;
  if (!src || src.length < np * 3) {
    ctx.strokeStyle = '#6b7280';
    ctx.strokeRect(18, 18, 28, 28);
    return;
  }
  const n = Math.min(Math.floor(src.length / np), 2500);
  const pts = new Array(n);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = src[i * np];
    const y = src[i * np + 1];
    const z = src[i * np + 2];
    const px = (x - y) * 0.866;
    const py = -((x + y) * 0.5 - z);
    pts[i] = [px, py];
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const pad = 6;
  const scale = (Math.min(w, h) - pad * 2) / span;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  ctx.fillStyle = '#e8eef7';
  const step = Math.max(1, Math.floor(n / 400));
  for (let i = 0; i < n; i += step) {
    const sx = w / 2 + (pts[i][0] - cx) * scale;
    const sy = h / 2 + (pts[i][1] - cy) * scale;
    ctx.fillRect(sx, sy, 1.4, 1.4);
  }
}

function PartThumbnail({ mesh }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) drawThumbnail(ref.current, mesh);
  }, [mesh]);
  return (
    <canvas
      ref={ref}
      width={64}
      height={64}
      className="h-12 w-12 shrink-0 rounded-md bg-neutral-800"
      data-part-thumbnail=""
    />
  );
}

export default function PartFeed({
  placement = 'desktop',
  source = 'local',
  rows = [],
  activeId = null,
  onSelect,
  onToggleVisible,
  onReorder,
  onLoadFile,
  onResolveFile,
  onAddPart,
  onAddGitPart,
}) {
  const loadRef = useRef(null);
  const resolveRef = useRef(null);
  const resolveIdRef = useRef(null);
  const gitPathRef = useRef(null);
  const gitFileRef = useRef(null);

  const onLoadPicked = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      onLoadFile?.(text, file.name);
    } catch (err) {
      console.error('[PartFeed] load failed', err);
    }
  };

  const onResolvePicked = async (event) => {
    const file = event.target.files?.[0];
    const id = resolveIdRef.current;
    event.target.value = '';
    resolveIdRef.current = null;
    if (!file || !id) return;
    try {
      const text = await file.text();
      onResolveFile?.(id, text, file.name);
    } catch (err) {
      console.error('[PartFeed] resolve failed', err);
    }
  };

  const offerResolve = (id) => {
    resolveIdRef.current = id;
    resolveRef.current?.click();
  };

  const submitGit = (event) => {
    event.preventDefault();
    const path = gitPathRef.current?.value || '';
    const file = gitFileRef.current?.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      onAddGitPart?.(path, text, file.name);
      if (gitPathRef.current) gitPathRef.current.value = '';
      if (gitFileRef.current) gitFileRef.current.value = '';
    }).catch((err) => console.error('[PartFeed] git add failed', err));
  };

  const shell = placement === 'mobile'
    ? 'flex h-full w-full flex-col bg-[#1e1e1e] text-gray-100'
    : 'flex h-full w-72 shrink-0 flex-col border-r border-white/10 bg-[#1e1e1e] text-gray-100';

  return (
    <aside className={shell} data-parts-feed="" data-parts-source={source}>
      <div
        data-ribbon-bg="editor"
        data-parts-feed-ribbon=""
        className="relative z-30 w-full flex items-center gap-1 px-1 py-0.5 border-b border-gray-700/60 bg-gray-900 shrink-0"
      >
        <div className={STRIP_ROW} data-parts-feed-toolbar="">
          <button
            type="button"
            className={STRIP_BTN}
            data-assembly-load=""
            title="Load assembly"
            aria-label="Load assembly"
            onClick={() => loadRef.current?.click()}
          >
            <FolderOpen size={STRIP_ICON} />
          </button>
          {source === 'local' && (
            <button
              type="button"
              className={STRIP_BTN}
              data-part-add=""
              title="New part"
              aria-label="New part"
              onClick={() => onAddPart?.()}
            >
              <Plus size={STRIP_ICON} />
            </button>
          )}
          <div className={STRIP_DIVIDER} />
          <span
            className="shrink-0 px-1 text-[11px] font-mono text-gray-300"
            data-parts-source-label=""
          >
            {source === 'git' ? 'Git' : 'Local'}
          </span>
          {source === 'git' && (
            <form className="flex items-center gap-0.5 sm:gap-1 min-w-0 flex-1" data-git-add="" onSubmit={submitGit}>
              <div className={STRIP_DIVIDER} />
              <input
                ref={gitPathRef}
                data-git-path=""
                placeholder="parts/name.js"
                className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs text-gray-100 outline-none"
              />
              <input
                ref={gitFileRef}
                data-git-file=""
                type="file"
                accept=".js,.txt"
                className="min-w-0 w-24 text-[10px] text-gray-400"
              />
              <button
                type="submit"
                className={STRIP_BTN}
                title="Add git part"
                aria-label="Add git part"
              >
                <FilePlus size={STRIP_ICON} />
              </button>
            </form>
          )}
        </div>
        <input
          ref={loadRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          data-assembly-file=""
          onChange={onLoadPicked}
        />
        <input
          ref={resolveRef}
          type="file"
          accept=".js,.txt"
          className="hidden"
          data-part-file=""
          onChange={onResolvePicked}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-16" data-parts-rows="">
        {rows.map((row, index) => {
          const selected = row.id === activeId;
          const status = row.error ? 'error' : row.missing ? 'missing' : 'ok';
          return (
            <div
              key={row.id}
              role="button"
              tabIndex={0}
              data-part-row={row.id}
              data-part-selected={selected ? 'true' : 'false'}
              data-part-status={status}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', String(index));
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const from = Number(event.dataTransfer.getData('text/plain'));
                if (Number.isInteger(from) && from !== index) onReorder?.(from, index);
              }}
              onClick={() => onSelect?.(row.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect?.(row.id);
                }
              }}
              className={`relative flex w-full cursor-pointer items-center gap-2 border-b border-white/5 px-2 py-2 text-left ${
                row.error ? 'bg-red-950/55 ring-1 ring-inset ring-red-500/80' : ''
              } ${selected && !row.error ? 'bg-red-950/45' : ''} ${
                !selected && !row.error ? 'hover:bg-white/5' : ''
              }`}
            >
              {selected && (
                <span
                  data-part-selected-bar=""
                  className="absolute bottom-1 left-0 top-1 w-1 rounded-full bg-red-500"
                />
              )}
              <GripVertical
                size={14}
                className="shrink-0 text-gray-500"
                data-part-drag=""
                aria-hidden="true"
              />
              <PartThumbnail mesh={row.mesh} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-gray-100">{row.name}</div>
                <div className="truncate text-[10px] text-gray-500">{row.id}</div>
                {row.missing && (
                  <button
                    type="button"
                    data-part-missing={row.action}
                    className="mt-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-sky-200 hover:bg-white/15"
                    onClick={(event) => {
                      event.stopPropagation();
                      offerResolve(row.id);
                    }}
                  >
                    {row.action === 'find-in-repo' ? 'Find in repo' : 'Upload'}
                  </button>
                )}
                {row.error && (
                  <div className="mt-0.5 text-[10px] font-medium text-red-300" data-part-error="">
                    Script failed
                  </div>
                )}
              </div>
              <button
                type="button"
                data-part-visibility={row.id}
                aria-pressed={row.visible}
                aria-label={row.visible ? 'Hide part' : 'Show part'}
                className="shrink-0 rounded-full p-1.5 text-gray-300 hover:bg-white/10"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleVisible?.(row.id);
                }}
              >
                {row.visible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
