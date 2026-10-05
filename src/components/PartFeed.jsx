import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, FilePlus, FolderOpen, GripVertical, Plus, Trash2 } from 'lucide-react';
import { partListDeleteAction, sanitizeAssemblyName } from '../utils/assembly.js';

// Same ribbon and strip buttons as the script editor top bar
// (CodeEditor `data-editor-ribbon` + Toolbar `variant="strip"`).
const STRIP_ROW = 'flex items-center gap-0.5 sm:gap-1 flex-1 min-w-0 overflow-x-auto';
const STRIP_BTN = 'shrink-0 p-1.5 flex items-center rounded active:opacity-80 hover:bg-gray-700/60 text-blue-400';
const STRIP_DIVIDER = 'shrink-0 w-px bg-gray-600 mx-0.5 self-stretch my-1';
const STRIP_ICON = 18;

/**
 * Parts feed. Desktop mounts it to the left of the editor. Mobile mounts it
 * as the Parts stage. Each row is a thumbnail and a name. A red bar marks
 * the selected row. The eye toggles visibility. Delete drops that part.
 * Load lives in this pane.
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

/**
 * Assembly name in the ribbon. Same commit rules as the CAD title chip:
 * click edits, Enter or blur commits, Escape reverts, empty commits nothing.
 */
function RibbonAssemblyName({ name, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    if (!onRename) return;
    setDraft(name || '');
    setEditing(true);
  };

  const commit = () => {
    if (!editing) return;
    setEditing(false);
    const next = sanitizeAssemblyName(draft);
    if (next && next !== (name || '')) onRename(next);
  };

  const label = 'max-w-[45%] truncate bg-gray-900 px-2 text-center text-xs font-medium text-gray-100';
  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          e.stopPropagation();
        }}
        className={`${label} pointer-events-auto w-40 outline-none`}
        aria-label="Assembly name"
        data-assembly-name=""
        data-assembly-rename="input"
      />
    );
  }
  if (!onRename) {
    return (
      <span className={`${label} pointer-events-none`} data-assembly-name="" title={name}>
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={start}
      className={`${label} pointer-events-auto cursor-text hover:text-white`}
      title="Click to rename this assembly"
      aria-label={`Assembly name: ${name}. Click to rename.`}
      data-assembly-name=""
      data-assembly-rename="button"
    >
      {name}
    </button>
  );
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
  onDeletePart,
  assemblyName = '',
  onRenameAssembly = null,
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

  const [pendingDelete, setPendingDelete] = useState(null);
  const cancelBtnRef = useRef(null);
  const shell = placement === 'mobile'
    ? 'flex h-full w-full flex-col bg-[#1e1e1e] text-gray-100'
    : 'flex h-full w-72 shrink-0 flex-col border-r border-white/10 bg-[#1e1e1e] text-gray-100';
  const ribbonName = typeof assemblyName === 'string' ? assemblyName.trim() : '';

  useEffect(() => {
    if (pendingDelete) cancelBtnRef.current?.focus();
  }, [pendingDelete]);

  const askDeletePart = (partId, name) => {
    setPendingDelete({ id: partId, name: name || 'this part' });
  };

  const cancelDeletePart = () => {
    if (partListDeleteAction('cancel') !== 'keep') return;
    setPendingDelete(null);
  };

  const confirmDeletePart = () => {
    const pending = pendingDelete;
    setPendingDelete(null);
    if (partListDeleteAction('confirm') !== 'drop' || !pending?.id) return;
    onDeletePart?.(pending.id);
  };

  return (
    <aside className={shell} data-parts-feed="" data-parts-source={source}>
      <div
        data-ribbon-bg="editor"
        data-parts-feed-ribbon=""
        className="relative z-30 flex w-full items-center border-b border-gray-700/60 bg-gray-900 px-1 py-0.5 shrink-0"
      >
        <div className={`${STRIP_ROW} relative z-10`} data-parts-feed-toolbar="">
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
        <div
          data-parts-ribbon-end=""
          className="relative z-10 ml-auto flex shrink-0 items-center"
        >
          <div className={STRIP_DIVIDER} />
          <span
            className="shrink-0 px-1 text-[11px] font-mono text-gray-300"
            data-parts-source-label=""
          >
            {source === 'git' ? 'Git' : 'Local'}
          </span>
        </div>
        {ribbonName ? (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
            data-parts-ribbon-center=""
          >
            <RibbonAssemblyName name={ribbonName} onRename={onRenameAssembly} />
          </div>
        ) : null}
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
              <button
                type="button"
                data-part-delete={row.id}
                aria-label="Delete part"
                title="Delete part"
                className="shrink-0 rounded-full p-1.5 text-gray-400 hover:bg-white/10 hover:text-red-300"
                onPointerDown={(event) => event.stopPropagation()}
                onDragStart={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  askDeletePart(row.id, row.name);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          );
        })}
      </div>
      {pendingDelete && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center surface-scrim p-4"
          data-part-delete-dialog=""
          role="dialog"
          aria-modal="true"
          aria-labelledby="part-delete-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancelDeletePart();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelDeletePart();
            }
          }}
        >
          <div className="w-full max-w-sm rounded-lg surface-glass border border-gray-700 p-4 shadow-xl">
            <h2 id="part-delete-title" className="text-sm font-semibold text-gray-100">
              Delete part
            </h2>
            <p className="mt-2 text-xs text-gray-300">
              {`Remove ${pendingDelete.name} from this assembly? This drops the row, its script, and its solid.`}
              {source === 'git' ? ' The git file is left where it is.' : ''}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={cancelBtnRef}
                type="button"
                data-part-delete-cancel=""
                className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                onClick={cancelDeletePart}
              >
                Cancel
              </button>
              <button
                type="button"
                data-part-delete-confirm=""
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
                onClick={confirmDeletePart}
              >
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
