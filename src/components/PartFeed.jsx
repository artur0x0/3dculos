import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, FolderOpen, GripVertical, Plus, Trash2 } from 'lucide-react';
import { partListDeleteAction, sanitizeAssemblyName, sanitizePartName } from '../utils/assembly.js';
import {
  PART_PREVIEW_SIZE,
  blitPartPreview,
  meshPreviewKey,
  paintEmptyPreview,
  partPreviewKind,
  peekPartPreview,
  takePartPreview,
} from '../utils/partPreview.js';

// Same ribbon and strip buttons as the script editor top bar
// (CodeEditor `data-editor-ribbon` + Toolbar `variant="strip"`).
const STRIP_ROW = 'flex items-center gap-0.5 sm:gap-1 flex-1 min-w-0 overflow-x-auto';
const STRIP_BTN = 'shrink-0 p-1.5 flex items-center rounded active:opacity-80 hover:bg-gray-700/60 text-blue-400';
const STRIP_DIVIDER = 'shrink-0 w-px bg-gray-600 mx-0.5 self-stretch my-1';
const STRIP_ICON = 18;

/**
 * Parts feed. Desktop mounts it to the left of the editor. Mobile mounts it
 * as the Parts stage. Each row is a snapshot of that part's solid and a name.
 * A blue bar marks the selected row (red is kept for a failed script). The eye toggles visibility. Delete drops
 * that part. Load lives in this pane.
 */

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

/**
 * Part name on a feed row. Double-click (or F2 on the focused row) edits it;
 * a single click still selects the row. Enter or blur commits, Escape
 * reverts, a blank name commits nothing. The rename targets this row's id.
 */
function RowPartName({ id, name, onRename, editing, setEditing }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) {
      setDraft(name || '');
      inputRef.current?.select();
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    if (!editing) return;
    setEditing(false);
    const next = sanitizePartName(draft);
    if (next && next !== (name || '')) onRename?.(id, next);
  };

  const label = 'truncate text-sm font-medium text-gray-100';
  if (editing) {
    const stop = (event) => event.stopPropagation();
    return (
      <input
        ref={inputRef}
        value={draft}
        draggable={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={stop}
        onDoubleClick={stop}
        onPointerDown={stop}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          e.stopPropagation();
        }}
        className={`${label} w-full rounded border border-blue-400/80 bg-gray-900 px-1 outline-none`}
        aria-label="Part name"
        data-part-name-input={id}
      />
    );
  }
  return (
    <div
      className={`${label} ${onRename ? 'cursor-text' : ''}`}
      data-part-name={id}
      title={onRename ? 'Double-click to rename this part' : undefined}
      onDoubleClick={onRename ? (event) => { event.stopPropagation(); setEditing(true); } : undefined}
    >
      {name}
    </div>
  );
}

function PartThumbnail({ mesh }) {
  const ref = useRef(null);
  const meshRef = useRef(mesh);
  meshRef.current = mesh;
  const previewKey = meshPreviewKey(mesh);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    if (!previewKey) {
      paintEmptyPreview(canvas);
      return undefined;
    }
    const cached = peekPartPreview(previewKey);
    if (cached) {
      blitPartPreview(canvas, cached);
      return undefined;
    }
    let cancel = false;
    const frame = requestAnimationFrame(() => {
      if (cancel || !ref.current) return;
      try {
        const shot = takePartPreview(meshRef.current);
        if (cancel || !ref.current) return;
        if (shot?.canvas) blitPartPreview(ref.current, shot.canvas);
        else paintEmptyPreview(ref.current);
      } catch (err) {
        console.error('[PartFeed] preview failed', err);
        if (ref.current) paintEmptyPreview(ref.current);
      }
    });
    return () => {
      cancel = true;
      cancelAnimationFrame(frame);
    };
  }, [previewKey]);

  return (
    <canvas
      ref={ref}
      width={PART_PREVIEW_SIZE}
      height={PART_PREVIEW_SIZE}
      className="h-12 w-12 shrink-0 rounded-md bg-[#1e1e1e]"
      data-part-thumbnail=""
      data-part-preview={partPreviewKind(mesh)}
      data-part-preview-key={previewKey || ''}
    />
  );
}


/** Small glass dialog shared by Open / New part / Add existing. */
function VaultPickerDialog({
  title,
  labelledBy,
  dataAttr,
  onClose,
  children,
  footer = null,
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center surface-scrim p-4"
      data-git-dialog={dataAttr}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose?.();
        }
      }}
    >
      <div className="w-full max-w-sm rounded-lg surface-glass border border-gray-700 p-4 shadow-xl">
        <h2 id={labelledBy} className="text-sm font-semibold text-gray-100">{title}</h2>
        <div className="mt-3">{children}</div>
        {footer}
      </div>
    </div>,
    document.body,
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
  onDeletePart,
  assemblyName = '',
  onRenameAssembly = null,
  onRenamePart = null,
  onToggleSource = null,
  sourceDirty = false,
  onListVaultAssemblies = null,
  onOpenVaultAssembly = null,
  onListAddableParts = null,
  onAddExistingPart = null,
  onFindInRepo = null,
  suggestNewPartPath = '',
}) {
  const [renamingId, setRenamingId] = useState(null);
  const loadRef = useRef(null);
  const resolveRef = useRef(null);
  const resolveIdRef = useRef(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const cancelBtnRef = useRef(null);
  const [openPicker, setOpenPicker] = useState(null); // null | { kind, items, loading, error, draft }
  const pathInputRef = useRef(null);

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
    if (source === 'git' && onFindInRepo) {
      onFindInRepo(id);
      return;
    }
    resolveIdRef.current = id;
    resolveRef.current?.click();
  };

  const closePicker = () => setOpenPicker(null);

  const startOpenAssembly = async () => {
    if (source !== 'git') {
      loadRef.current?.click();
      return;
    }
    setOpenPicker({ kind: 'open', items: [], loading: true, error: '' });
    try {
      const items = (await onListVaultAssemblies?.()) || [];
      setOpenPicker({ kind: 'open', items, loading: false, error: items.length ? '' : 'No assemblies in the vault yet.' });
    } catch (err) {
      setOpenPicker({ kind: 'open', items: [], loading: false, error: err?.message || 'Could not list assemblies' });
    }
  };

  const startNewPart = () => {
    if (source !== 'git') {
      onAddPart?.();
      return;
    }
    setOpenPicker({
      kind: 'new-part',
      items: [],
      loading: false,
      error: '',
      draft: suggestNewPartPath || '',
    });
  };

  const startAddExisting = async () => {
    setOpenPicker({ kind: 'add-existing', items: [], loading: true, error: '' });
    try {
      const items = (await onListAddableParts?.()) || [];
      setOpenPicker({
        kind: 'add-existing',
        items,
        loading: false,
        error: items.length ? '' : 'No other part scripts in the vault.',
      });
    } catch (err) {
      setOpenPicker({ kind: 'add-existing', items: [], loading: false, error: err?.message || 'Could not list parts' });
    }
  };

  useEffect(() => {
    if (openPicker?.kind === 'new-part') pathInputRef.current?.select();
  }, [openPicker?.kind]);
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
            title={source === 'git' ? 'Open assembly from vault' : 'Load assembly'}
            aria-label={source === 'git' ? 'Open assembly from vault' : 'Load assembly'}
            onClick={startOpenAssembly}
          >
            <FolderOpen size={STRIP_ICON} />
          </button>
          <button
            type="button"
            className={STRIP_BTN}
            data-part-add=""
            title="New part"
            aria-label="New part"
            onClick={startNewPart}
          >
            <Plus size={STRIP_ICON} />
          </button>
          {source === 'git' && (
            <button
              type="button"
              className={STRIP_BTN}
              data-git-add-existing=""
              title="Add existing part from vault"
              aria-label="Add existing part from vault"
              onClick={startAddExisting}
            >
              <span className="px-0.5 text-[10px] font-medium leading-none">Add</span>
            </button>
          )}
        </div>
        <div
          data-parts-ribbon-end=""
          className="relative z-10 ml-auto flex shrink-0 items-center"
        >
          {source === 'git' && (
            <button
              type="button"
              disabled
              data-git-connect=""
              data-git-adapter="mock"
              title="GitHub sign-in is coming. Git mode uses a local mock vault for now."
              aria-label="Connect GitHub"
              className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400 opacity-80 cursor-not-allowed"
            >
              Connect GitHub
            </button>
          )}
          <div className={STRIP_DIVIDER} />
          <button
            type="button"
            data-parts-source-label=""
            data-parts-source-toggle=""
            data-git-dirty={sourceDirty ? 'true' : 'false'}
            title={source === 'git' ? 'Switch to Local mode' : 'Switch to Git mode'}
            aria-label={source === 'git' ? 'Git mode' : 'Local mode'}
            aria-pressed={source === 'git'}
            className="relative shrink-0 rounded px-1 py-0.5 text-[11px] font-mono text-gray-300 hover:bg-gray-700/60"
            onClick={() => onToggleSource?.()}
          >
            {source === 'git' ? 'Git' : 'Local'}
            {sourceDirty ? (
              <span
                data-git-dirty-badge=""
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400"
                title="Uncommitted changes"
              />
            ) : null}
          </button>
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
              data-part-dirty={row.dirty ? 'true' : 'false'}
              draggable={renamingId !== row.id}
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
                if (event.key === 'F2' && onRenamePart) {
                  event.preventDefault();
                  setRenamingId(row.id);
                }
              }}
              className={`relative flex w-full cursor-pointer items-center gap-2 border-b border-white/5 px-2 py-2 text-left ${
                row.error ? 'bg-red-950/55 ring-1 ring-inset ring-red-500/80' : ''
              } ${selected && !row.error ? 'bg-blue-950/50' : ''} ${
                !selected && !row.error ? 'hover:bg-white/5' : ''
              }`}
            >
              {selected && (
                <span
                  data-part-selected-bar=""
                  className="absolute bottom-1 left-0 top-1 w-1 rounded-full bg-blue-500"
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
                <RowPartName
                  id={row.id}
                  name={row.name}
                  onRename={onRenamePart}
                  editing={renamingId === row.id}
                  setEditing={(on) => setRenamingId(on ? row.id : null)}
                />
                <div className="flex items-center gap-1 truncate text-[10px] text-gray-500">
                  <span className="truncate">{row.id}</span>
                  {row.dirty ? (
                    <span
                      data-part-dirty=""
                      title="Uncommitted changes"
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                    />
                  ) : null}
                </div>
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

      {openPicker && typeof document !== 'undefined' && openPicker.kind === 'open' && (
        <VaultPickerDialog
          title="Open assembly"
          labelledBy="git-open-title"
          dataAttr="open"
          onClose={closePicker}
          footer={(
            <div className="mt-4 flex justify-end">
              <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closePicker} data-git-dialog-cancel="">
                Cancel
              </button>
            </div>
          )}
        >
          {openPicker.loading && <p className="text-xs text-gray-400" data-git-dialog-loading="">Loading…</p>}
          {openPicker.error && !openPicker.loading && (
            <p className="text-xs text-amber-300" data-git-dialog-empty="">{openPicker.error}</p>
          )}
          {!openPicker.loading && openPicker.items.length > 0 && (
            <ul className="max-h-56 space-y-1 overflow-y-auto" data-git-open-list="">
              {openPicker.items.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    data-git-open-item={name}
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-gray-100 hover:bg-white/10"
                    onClick={async () => {
                      closePicker();
                      await onOpenVaultAssembly?.(name);
                    }}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </VaultPickerDialog>
      )}
      {openPicker && typeof document !== 'undefined' && openPicker.kind === 'new-part' && (
        <VaultPickerDialog
          title="New part path"
          labelledBy="git-new-part-title"
          dataAttr="new-part"
          onClose={closePicker}
          footer={(
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closePicker} data-git-dialog-cancel="">
                Cancel
              </button>
              <button
                type="button"
                data-git-new-part-confirm=""
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                onClick={() => {
                  const path = openPicker.draft || '';
                  closePicker();
                  onAddPart?.(path);
                }}
              >
                Create
              </button>
            </div>
          )}
        >
          <p className="mb-2 text-[11px] text-gray-400">
            Repo path under this assembly or shared parts/.
          </p>
          <input
            ref={pathInputRef}
            data-git-new-part-path=""
            value={openPicker.draft || ''}
            onChange={(e) => setOpenPicker({ ...openPicker, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const path = openPicker.draft || '';
                closePicker();
                onAddPart?.(path);
              }
            }}
            className="w-full rounded-md border border-gray-600 bg-black/30 px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-blue-500"
            placeholder="assemblies/Name/parts/Bracket.js"
          />
        </VaultPickerDialog>
      )}
      {openPicker && typeof document !== 'undefined' && openPicker.kind === 'add-existing' && (
        <VaultPickerDialog
          title="Add existing part"
          labelledBy="git-add-existing-title"
          dataAttr="add-existing"
          onClose={closePicker}
          footer={(
            <div className="mt-4 flex justify-end">
              <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closePicker} data-git-dialog-cancel="">
                Cancel
              </button>
            </div>
          )}
        >
          {openPicker.loading && <p className="text-xs text-gray-400" data-git-dialog-loading="">Loading…</p>}
          {openPicker.error && !openPicker.loading && (
            <p className="text-xs text-amber-300" data-git-dialog-empty="">{openPicker.error}</p>
          )}
          {!openPicker.loading && openPicker.items.length > 0 && (
            <ul className="max-h-56 space-y-1 overflow-y-auto" data-git-add-list="">
              {openPicker.items.map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    data-git-add-item={item.path}
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-gray-100 hover:bg-white/10"
                    onClick={async () => {
                      closePicker();
                      await onAddExistingPart?.(item.path);
                    }}
                  >
                    <span className="block truncate">{item.label || item.path}</span>
                    {item.kind === 'shared-part' ? (
                      <span className="text-[10px] text-gray-500">shared</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </VaultPickerDialog>
      )}
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
