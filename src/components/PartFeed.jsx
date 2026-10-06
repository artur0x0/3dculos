import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, FolderOpen, GitBranch, GitCommitHorizontal, Github, GripVertical, Plus, Trash2 } from 'lucide-react';
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
function RibbonAssemblyName({ name, onRename, behind = false, onBehindClick = null }) {
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
  const behindBadge = behind ? (
    <button
      type="button"
      data-assembly-behind=""
      title="Remote changed this assembly — click for Reload / Keep mine / Check in mine"
      aria-label="Assembly behind remote"
      className="pointer-events-auto ml-1 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-400 ring-1 ring-amber-200/80"
      onClick={(event) => {
        event.stopPropagation();
        onBehindClick?.();
      }}
    />
  ) : null;

  if (!onRename) {
    return (
      <span className="pointer-events-none inline-flex max-w-[45%] items-center" data-assembly-behind-wrap={behind ? 'true' : 'false'}>
        <span className={`${label} pointer-events-none`} data-assembly-name="" title={name}>
          {name}
        </span>
        {behindBadge}
      </span>
    );
  }
  return (
    <span className="pointer-events-auto inline-flex max-w-[45%] items-center" data-assembly-behind-wrap={behind ? 'true' : 'false'}>
      <button
        type="button"
        onClick={start}
        className={`${label} cursor-text hover:text-white`}
        title="Click to rename this assembly"
        aria-label={`Assembly name: ${name}. Click to rename.`}
        data-assembly-name=""
        data-assembly-rename="button"
      >
        {name}
      </button>
      {behindBadge}
    </span>
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
  canCommit = false,
  onGitCommit = null,
  onForceMerge = null,
  // G4 pull/conflicts
  behindPartIds = null,
  assemblyBehind = false,
  assemblyPath = '',
  onBehindChoice = null,
  // G5 branch view
  currentBranch = '',
  onListBranches = null,
  onSwitchBranch = null,
  // G6 Local → Git
  onPlanMoveToGit = null,
  onMoveToGit = null,
  defaultVaultName = 'surfcad',
  sanitizeVaultName = null,
}) {
  const [renamingId, setRenamingId] = useState(null);
  const loadRef = useRef(null);
  const resolveRef = useRef(null);
  const resolveIdRef = useRef(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const cancelBtnRef = useRef(null);
  const [openPicker, setOpenPicker] = useState(null); // null | { kind, items, loading, error, draft }
  const pathInputRef = useRef(null);
  // G3 commit flow: null | { stage: 'message'|'busy'|'ask-force'|'done'|'error', ... }
  const [commitFlow, setCommitFlow] = useState(null);
  const commitInputRef = useRef(null);
  // G4 conflict choice: null | { path, kind: 'part'|'assembly', name, stage, error, result }
  const [conflictFlow, setConflictFlow] = useState(null);
  // G5: null | { stage: 'list'|'busy'|'confirm'|'error', items, loading, error, pending }
  const [branchFlow, setBranchFlow] = useState(null);
  const behindSet = behindPartIds instanceof Set
    ? behindPartIds
    : new Set(behindPartIds || []);

  // G5: keep the branch list populated while in Git mode.
  useEffect(() => {
    if (source !== 'git' || !onListBranches) {
      setBranchFlow(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setBranchFlow((prev) => ({
        stage: 'list',
        items: prev?.items || [],
        loading: true,
        error: '',
        pending: null,
      }));
      try {
        const items = (await onListBranches()) || [];
        if (cancelled) return;
        setBranchFlow({
          stage: 'list', items, loading: false,
          error: items.length ? '' : 'No branches yet.',
          pending: null,
        });
      } catch (err) {
        if (cancelled) return;
        setBranchFlow({
          stage: 'list', items: [], loading: false,
          error: err.message || 'Could not list branches',
          pending: null,
        });
      }
    })();
    return () => { cancelled = true; };
    // onListBranches is an App render callback; reload on source/branch only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, currentBranch]);

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

  const startCommit = () => {
    if (source !== 'git' || !canCommit) return;
    setCommitFlow({ stage: 'message', draft: '', result: null, error: '' });
  };

  const closeCommit = () => setCommitFlow(null);

  const closeBranches = () => setBranchFlow(null);

  // G6: Move to Git dialog — { stage: 'form'|'busy'|'done'|'error', vaultName, sharedIds, result, error }
  const [moveFlow, setMoveFlow] = useState(null);
  const closeMove = () => setMoveFlow(null);
  const startMoveToGit = () => {
    setMoveFlow({
      stage: 'form', vaultName: defaultVaultName || 'surfcad', sharedIds: [], result: null, error: '',
    });
  };
  const onSourceToggleClick = () => {
    // Local → Git asks first: move the parts into the vault, or just switch.
    if (source !== 'git' && onMoveToGit) {
      startMoveToGit();
      return;
    }
    onToggleSource?.();
  };
  const moveVaultClean = moveFlow
    ? (sanitizeVaultName ? sanitizeVaultName(moveFlow.vaultName) : String(moveFlow.vaultName || '').trim())
    : '';
  const movePlan = moveFlow && moveFlow.stage === 'form' && onPlanMoveToGit
    ? onPlanMoveToGit({ sharedIds: moveFlow.sharedIds })
    : null;
  const toggleMoveShared = (id) => {
    setMoveFlow((prev) => {
      if (!prev) return prev;
      const has = prev.sharedIds.includes(id);
      return { ...prev, sharedIds: has ? prev.sharedIds.filter((x) => x !== id) : [...prev.sharedIds, id] };
    });
  };
  const runMoveToGit = async () => {
    if (!moveFlow || !moveVaultClean) return;
    const { sharedIds } = moveFlow;
    setMoveFlow((prev) => ({ ...prev, stage: 'busy', error: '' }));
    const result = (await onMoveToGit?.({ vaultName: moveVaultClean, sharedIds }))
      || { status: 'error', error: 'Move unavailable' };
    if (result.status === 'moved') {
      setMoveFlow((prev) => ({ ...(prev || {}), stage: 'done', result, error: '' }));
      return;
    }
    let error = result.error || 'Move to Git failed';
    if (result.status === 'invalid-name') error = 'Enter a repo name (letters, digits, . _ -).';
    else if (result.status === 'not-a-vault') {
      error = `${result.repo?.owner || 'You'}/${result.vaultName} already exists and is not a SurfCAD vault. Pick another name.`;
    } else if (result.status === 'conflict') {
      error = result.assemblyExists
        ? 'This assembly already exists in the vault. Rename the assembly, or pick another vault name.'
        : `These vault files already exist with different content: ${result.paths.join(', ')}`;
    } else if (result.status === 'empty') error = 'Add a part before moving to Git.';
    setMoveFlow((prev) => ({ ...(prev || {}), stage: 'form', result, error }));
  };

  const startBranchView = async () => {
    if (source !== 'git') return;
    setBranchFlow({ stage: 'list', items: [], loading: true, error: '', pending: null });
    try {
      const items = (await onListBranches?.()) || [];
      setBranchFlow({
        stage: 'list', items, loading: false,
        error: items.length ? '' : 'No branches yet.',
        pending: null,
      });
    } catch (err) {
      setBranchFlow({
        stage: 'error', items: [], loading: false,
        error: err.message || 'Could not list branches', pending: null,
      });
    }
  };

  const requestSwitchBranch = (name) => {
    if (!name || name === currentBranch) return;
    if (sourceDirty) {
      setBranchFlow((prev) => ({
        ...(prev || { items: [], loading: false, error: '' }),
        stage: 'confirm', pending: name,
      }));
      return;
    }
    void runSwitchBranch(name);
  };

  const runSwitchBranch = async (name) => {
    const target = name || branchFlow?.pending;
    if (!target) return;
    setBranchFlow((prev) => ({
      ...(prev || { items: [], loading: false, error: '' }),
      stage: 'busy', pending: target,
    }));
    const result = (await onSwitchBranch?.(target)) || { status: 'error', error: 'Switch unavailable' };
    if (result.status === 'switched' || result.status === 'same') {
      setBranchFlow(null);
      return;
    }
    setBranchFlow((prev) => ({
      ...(prev || { items: [], loading: false }),
      stage: 'error',
      error: result.error || 'Could not switch branch',
      pending: target,
    }));
  };

  const runCommit = async () => {
    const draft = commitFlow?.draft || '';
    setCommitFlow({ stage: 'busy', draft, result: null, error: '' });
    const result = (await onGitCommit?.(draft)) || { status: 'error', error: 'Commit unavailable' };
    if (result.status === 'branched') {
      setCommitFlow({ stage: 'ask-force', draft, result, error: '' });
    } else if (result.status === 'error') {
      setCommitFlow({ stage: 'error', draft, result, error: result.error || 'Commit failed' });
    } else {
      setCommitFlow({ stage: 'done', draft, result, error: '' });
    }
  };

  const runForceMerge = async () => {
    const branched = commitFlow?.result;
    setCommitFlow({ ...commitFlow, stage: 'busy' });
    const result = (await onForceMerge?.(branched)) || { status: 'error', error: 'Force merge unavailable' };
    if (result.status === 'moved-again') {
      setCommitFlow({ ...commitFlow, stage: 'error', error: 'Main moved again. Your commit is still on the branch; commit again to retry.' });
    } else if (result.status === 'error') {
      setCommitFlow({ ...commitFlow, stage: 'error', error: result.error || 'Force merge failed' });
    } else {
      setCommitFlow({ stage: 'done', draft: '', result, error: '' });
    }
  };

  const openConflict = (path, kind, name) => {
    if (source !== 'git' || !path) return;
    setConflictFlow({ path, kind, name: name || path, stage: 'choose', error: '', result: null });
  };

  const closeConflict = () => setConflictFlow(null);

  const runConflict = async (action) => {
    if (!conflictFlow) return;
    setConflictFlow({ ...conflictFlow, stage: 'busy', error: '' });
    const result = (await onBehindChoice?.({
      action,
      path: conflictFlow.path,
      kind: conflictFlow.kind,
    })) || { status: 'error', error: 'Action unavailable' };
    if (result.status === 'error') {
      setConflictFlow({ ...conflictFlow, stage: 'error', error: result.error || 'Failed', result });
    } else {
      setConflictFlow({ ...conflictFlow, stage: 'done', result, error: '' });
    }
  };

  useEffect(() => {
    if (commitFlow?.stage === 'message') commitInputRef.current?.focus();
  }, [commitFlow?.stage]);
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
              className={STRIP_BTN}
              data-git-branches=""
              title={currentBranch ? `Branches (on ${currentBranch})` : 'Branches'}
              aria-label="Branches"
              onClick={startBranchView}
            >
              <GitBranch size={STRIP_ICON} />
            </button>
          )}
          {source === 'git' && (
            <button
              type="button"
              className={`${STRIP_BTN} disabled:cursor-not-allowed disabled:opacity-40`}
              data-git-commit=""
              disabled={!canCommit}
              title={canCommit ? `Commit changes to ${currentBranch || 'main'}` : 'Nothing to commit'}
              aria-label="Commit"
              onClick={startCommit}
            >
              <GitCommitHorizontal size={STRIP_ICON} />
            </button>
          )}
          {source === 'git' && (
            <button
              type="button"
              disabled
              data-git-connect=""
              data-git-adapter="mock"
              title="Connect GitHub — sign-in is coming. Git mode uses a local mock vault for now."
              aria-label="Connect GitHub"
              className="shrink-0 rounded border border-gray-700 p-1 text-gray-400 opacity-80 cursor-not-allowed"
            >
              {/* Icon-only so the ribbon fits Commit beside the centered name. */}
              <Github size={14} aria-hidden="true" />
              <span className="sr-only">Connect GitHub</span>
            </button>
          )}
          <div className={STRIP_DIVIDER} />
          <button
            type="button"
            data-parts-source-label=""
            data-parts-source-toggle=""
            data-git-dirty={sourceDirty ? 'true' : 'false'}
            title={source === 'git' ? 'Switch to Local mode' : (onMoveToGit ? 'Move to Git…' : 'Switch to Git mode')}
            aria-label={source === 'git' ? 'Git mode' : 'Local mode'}
            aria-pressed={source === 'git'}
            className="relative shrink-0 rounded px-1 py-0.5 text-[11px] font-mono text-gray-300 hover:bg-gray-700/60"
            onClick={onSourceToggleClick}
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
            <RibbonAssemblyName name={ribbonName}
              onRename={onRenameAssembly}
              behind={!!assemblyBehind}
              onBehindClick={() => openConflict(assemblyPath || '', 'assembly', ribbonName)}
            />
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
              data-part-behind={behindSet.has(row.id) ? 'true' : 'false'}
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
                  {behindSet.has(row.id) ? (
                    <button
                      type="button"
                      data-part-behind=""
                      title="Remote changed this part — click for Reload / Keep mine / Check in mine"
                      aria-label="Part behind remote"
                      className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-400 ring-1 ring-amber-200/80"
                      onClick={(event) => {
                        event.stopPropagation();
                        openConflict(row.id, 'part', row.name);
                      }}
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
        {source === 'git' && (
          <div className="border-t border-gray-700/80 px-2 py-2" data-git-branch-section="">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                Branches
              </span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-white/5"
                data-git-branches-refresh=""
                onClick={startBranchView}
              >
                {currentBranch ? `on ${currentBranch}` : 'List'}
              </button>
            </div>
            {branchFlow?.stage === 'list' && !branchFlow.loading && (branchFlow.items || []).map((b) => {
              const current = !!b.current || b.name === currentBranch;
              return (
                <button
                  key={b.name}
                  type="button"
                  data-git-branch-row={b.name}
                  data-git-branch-current={current ? 'true' : 'false'}
                  className={`flex w-full items-center justify-between rounded px-1.5 py-1 text-left text-[11px] ${
                    current
                      ? 'bg-blue-600/20 text-blue-200'
                      : 'text-gray-300 hover:bg-white/5'
                  }`}
                  onClick={() => requestSwitchBranch(b.name)}
                >
                  <span className="truncate font-mono">{b.name}</span>
                  {current ? (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-blue-300" data-git-branch-marker="">
                      current
                    </span>
                  ) : null}
                </button>
              );
            })}
            {branchFlow?.loading && (
              <p className="text-[10px] text-gray-500" data-git-branch-loading="">Loading…</p>
            )}
            {branchFlow?.error && branchFlow.stage === 'list' && (
              <p className="text-[10px] text-amber-300" data-git-branch-list-error="">{branchFlow.error}</p>
            )}
          </div>
        )}
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
      {commitFlow && typeof document !== 'undefined' && (
        <VaultPickerDialog
          title={commitFlow.stage === 'ask-force' ? 'Main has moved' : 'Commit to main'}
          labelledBy="git-commit-title"
          dataAttr="commit"
          onClose={commitFlow.stage === 'busy' ? undefined : closeCommit}
          footer={(
            <div className="mt-4 flex justify-end gap-2" data-git-commit-stage={commitFlow.stage}>
              {commitFlow.stage === 'message' && (
                <>
                  <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeCommit} data-git-dialog-cancel="">
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-git-commit-confirm=""
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                    onClick={runCommit}
                  >
                    Commit
                  </button>
                </>
              )}
              {commitFlow.stage === 'ask-force' && (
                <>
                  <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeCommit} data-git-keep-branch="">
                    Keep on branch
                  </button>
                  <button
                    type="button"
                    data-git-force-merge=""
                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
                    onClick={runForceMerge}
                  >
                    Force merge
                  </button>
                </>
              )}
              {(commitFlow.stage === 'done' || commitFlow.stage === 'error') && (
                <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeCommit} data-git-dialog-cancel="">
                  Close
                </button>
              )}
            </div>
          )}
        >
          {commitFlow.stage === 'message' && (
            <>
              <p className="mb-2 text-[11px] text-gray-400">
                Changed parts and the assembly go to main as one commit.
              </p>
              <input
                ref={commitInputRef}
                data-git-commit-message=""
                value={commitFlow.draft || ''}
                onChange={(e) => setCommitFlow({ ...commitFlow, draft: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runCommit();
                  }
                }}
                className="w-full rounded-md border border-gray-600 bg-black/30 px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-blue-500"
                placeholder={`Update ${ribbonName || 'assembly'}`}
              />
            </>
          )}
          {commitFlow.stage === 'busy' && <p className="text-xs text-gray-400" data-git-dialog-loading="">Committing…</p>}
          {commitFlow.stage === 'ask-force' && (
            <div data-git-force-merge-ask="" data-git-branch={commitFlow.result?.branch || ''}>
              <p className="text-xs text-gray-300">
                {'Your changes were committed to '}
                <span className="font-mono text-gray-100">{commitFlow.result?.branch}</span>
                {` (from base ${String(commitFlow.result?.baseSha || '').slice(0, 7)}).`}
              </p>
              <p className="mt-2 text-xs text-amber-300" data-git-force-merge-warning="">
                {commitFlow.result?.warning || 'Force merge overwrites main; main\'s diff in these files will be lost.'}
              </p>
            </div>
          )}
          {commitFlow.stage === 'done' && (
            <p className="text-xs text-gray-300" data-git-commit-done={commitFlow.result?.status || ''}>
              {commitFlow.result?.status === 'clean'
                ? 'Nothing to commit.'
                : `${commitFlow.result?.status === 'merged' ? 'Force merged' : 'Committed'} ${(commitFlow.result?.files || []).length} file(s) to ${commitFlow.result?.branch || 'main'} (${String(commitFlow.result?.sha || '').slice(0, 7)}).`}
            </p>
          )}
          {commitFlow.stage === 'error' && (
            <p className="text-xs text-amber-300" data-git-commit-error="">{commitFlow.error}</p>
          )}
        </VaultPickerDialog>
      )}
      {conflictFlow && typeof document !== 'undefined' && (
        <VaultPickerDialog
          title={conflictFlow.kind === 'assembly' ? 'Assembly behind remote' : 'Part behind remote'}
          labelledBy="git-behind-title"
          dataAttr="behind"
          onClose={conflictFlow.stage === 'busy' ? undefined : closeConflict}
          footer={(
            <div className="mt-4 flex flex-wrap justify-end gap-2" data-git-behind-stage={conflictFlow.stage}>
              {conflictFlow.stage === 'choose' && (
                <>
                  <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeConflict} data-git-dialog-cancel="">
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-git-behind-reload=""
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                    onClick={() => runConflict('reload')}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    data-git-behind-keep=""
                    className="rounded-md px-3 py-1.5 text-xs text-gray-100 hover:bg-white/10 border border-gray-600"
                    onClick={() => runConflict('keep')}
                  >
                    Keep mine
                  </button>
                  <button
                    type="button"
                    data-git-behind-branch=""
                    className="rounded-md px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-900/40 border border-amber-500/50"
                    onClick={() => runConflict('branch')}
                  >
                    Check in mine to a branch
                  </button>
                </>
              )}
              {(conflictFlow.stage === 'done' || conflictFlow.stage === 'error') && (
                <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeConflict} data-git-dialog-cancel="">
                  Close
                </button>
              )}
            </div>
          )}
        >
          {conflictFlow.stage === 'choose' && (
            <div data-git-behind-ask="" data-git-behind-path={conflictFlow.path} data-git-behind-kind={conflictFlow.kind}>
              <p className="text-xs text-gray-300">
                {'Remote changed '}
                <span className="font-medium text-gray-100">{conflictFlow.name}</span>
                {'. Reload takes the remote version, Keep mine keeps yours, or Check in mine parks yours on a new branch (base auto-detected).'}
              </p>
              <p className="mt-2 truncate font-mono text-[10px] text-gray-500" title={conflictFlow.path}>{conflictFlow.path}</p>
            </div>
          )}
          {conflictFlow.stage === 'busy' && <p className="text-xs text-gray-400" data-git-dialog-loading="">Working…</p>}
          {conflictFlow.stage === 'done' && (
            <p className="text-xs text-gray-300" data-git-behind-done={conflictFlow.result?.status || ''}>
              {conflictFlow.result?.status === 'reloaded' && 'Reloaded from remote.'}
              {conflictFlow.result?.status === 'kept' && 'Keeping your version. Marker cleared.'}
              {conflictFlow.result?.status === 'branched' && (
                <>
                  {'Parked on '}
                  <span className="font-mono">{conflictFlow.result?.branch}</span>
                  {'. Your working copy is unchanged; marker cleared.'}
                </>
              )}
              {!['reloaded', 'kept', 'branched'].includes(conflictFlow.result?.status) && 'Done.'}
            </p>
          )}
          {conflictFlow.stage === 'error' && (
            <p className="text-xs text-amber-300" data-git-behind-error="">{conflictFlow.error}</p>
          )}
        </VaultPickerDialog>
      )}
      {branchFlow && (branchFlow.stage === 'confirm' || branchFlow.stage === 'busy' || branchFlow.stage === 'error')
        && typeof document !== 'undefined' && (
        <VaultPickerDialog
          title={branchFlow.stage === 'confirm' ? 'Switch branch?' : 'Branches'}
          labelledBy="git-branch-title"
          dataAttr="branch"
          onClose={branchFlow.stage === 'busy' ? undefined : closeBranches}
          footer={(
            <div className="mt-4 flex flex-wrap justify-end gap-2" data-git-branch-stage={branchFlow.stage}>
              {branchFlow.stage === 'confirm' && (
                <>
                  <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeBranches} data-git-branch-cancel="">
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
                    data-git-branch-confirm=""
                    onClick={() => runSwitchBranch(branchFlow.pending)}
                  >
                    Switch anyway
                  </button>
                </>
              )}
              {branchFlow.stage === 'error' && (
                <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeBranches} data-git-dialog-cancel="">
                  Close
                </button>
              )}
            </div>
          )}
        >
          {branchFlow.stage === 'confirm' && (
            <p className="text-xs text-gray-300" data-git-branch-dirty-warn="">
              Uncommitted changes will be lost when switching to
              {' '}
              <span className="font-mono text-gray-100">{branchFlow.pending}</span>
              .
            </p>
          )}
          {branchFlow.stage === 'busy' && (
            <p className="text-xs text-gray-400" data-git-branch-switching="">Switching…</p>
          )}
          {branchFlow.stage === 'error' && (
            <p className="text-xs text-amber-300" data-git-branch-error="">{branchFlow.error}</p>
          )}
        </VaultPickerDialog>
      )}

      {moveFlow && typeof document !== 'undefined' && (
        <VaultPickerDialog
          title={moveFlow.stage === 'done' ? 'Moved to Git' : 'Move to Git'}
          labelledBy="git-move-title"
          dataAttr="move-to-git"
          onClose={moveFlow.stage === 'busy' ? undefined : closeMove}
          footer={(
            <div className="mt-4 flex flex-wrap justify-end gap-2" data-git-move-stage={moveFlow.stage}>
              {moveFlow.stage === 'form' && (
                <>
                  <button type="button" className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10" onClick={closeMove} data-git-dialog-cancel="">
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                    data-git-move-switch-only=""
                    title="Switch to Git mode without writing these parts to the vault"
                    onClick={() => { closeMove(); onToggleSource?.(); }}
                  >
                    Switch only
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                    data-git-move-confirm=""
                    disabled={!moveVaultClean || !!movePlan?.error}
                    onClick={runMoveToGit}
                  >
                    Move to Git
                  </button>
                </>
              )}
              {moveFlow.stage === 'done' && (
                <button type="button" className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500" onClick={closeMove} data-git-move-close="">
                  Done
                </button>
              )}
            </div>
          )}
        >
          {moveFlow.stage === 'form' && (
            <div className="space-y-3">
              <p className="text-xs text-gray-300">
                Writes this assembly and its parts into your vault as one commit, then switches to Git mode.
                IndexedDB keeps autosaving.
              </p>
              <label className="block text-[11px] text-gray-400" htmlFor="git-move-vault-name">
                Vault repo name
              </label>
              <input
                id="git-move-vault-name"
                data-git-move-vault-name=""
                className="w-full rounded border border-gray-600 bg-gray-900 px-2 py-1 font-mono text-xs text-gray-100"
                value={moveFlow.vaultName}
                autoFocus
                spellCheck={false}
                onChange={(event) => {
                  const vaultName = event.target.value;
                  setMoveFlow((prev) => ({ ...prev, vaultName, error: '' }));
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && moveVaultClean) {
                    event.preventDefault();
                    void runMoveToGit();
                  }
                }}
              />
              <p className="text-[10px] text-gray-500" data-git-move-vault-preview="">
                {moveVaultClean ? `Private repo “${moveVaultClean}” (created if missing)` : 'Enter a repo name'}
              </p>
              {movePlan && !movePlan.error && (
                <div>
                  <p className="font-mono text-[10px] text-gray-400" data-git-move-assembly-path="">{movePlan.assemblyPath}</p>
                  <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto" data-git-move-plan="">
                    {movePlan.idMap.map((m) => (
                      <li key={m.from} className="flex items-center gap-2 text-[11px]" data-git-move-row={m.to}>
                        <span className="min-w-0 flex-1 truncate font-mono text-gray-200" title={m.to}>{m.to}</span>
                        <label className="flex shrink-0 items-center gap-1 text-[10px] text-gray-400">
                          <input
                            type="checkbox"
                            data-git-move-shared={m.from}
                            checked={m.shared}
                            onChange={() => toggleMoveShared(m.from)}
                          />
                          Shared
                        </label>
                      </li>
                    ))}
                  </ul>
                  {movePlan.missing?.length ? (
                    <p className="mt-1 text-[10px] text-amber-300" data-git-move-missing="">
                      {`No script yet, not written: ${movePlan.missing.join(', ')}`}
                    </p>
                  ) : null}
                </div>
              )}
              {movePlan?.error && <p className="text-xs text-amber-300" data-git-move-plan-error="">{movePlan.error}</p>}
              {moveFlow.error && <p className="text-xs text-amber-300" data-git-move-error="">{moveFlow.error}</p>}
            </div>
          )}
          {moveFlow.stage === 'busy' && <p className="text-xs text-gray-400" data-git-dialog-loading="">Moving…</p>}
          {moveFlow.stage === 'done' && (
            <p className="text-xs text-gray-300" data-git-move-done={moveFlow.result?.vault?.repo?.name || ''}>
              {`${moveFlow.result?.files?.length || 0} files committed to ${moveFlow.result?.vault?.repo?.name || 'the vault'}/${moveFlow.result?.vault?.defaultBranch || 'main'}. You are in Git mode.`}
            </p>
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
