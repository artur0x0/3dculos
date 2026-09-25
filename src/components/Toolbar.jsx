import React, { useRef, useState } from 'react';
import {
  FolderOpen, Save, Download, Undo, Redo, ChevronLeft, ChevronRight,
  Truck, Upload, User, ArrowLeft, Play, BookOpen, Puzzle, List
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { formatGameTime } from '../utils/gamePuzzle';

/**
 * Shared chrome.
 * - Desktop CAD: floating overlay over the viewport (collapsible).
 * - Mobile CAD + game: action bar in the Monaco mid-strip (variant="strip").
 *   No floating overlay and no collapse chevron (slice 08; CAD mobile matches).
 */
const Toolbar = ({
  mode = 'cad',
  variant = 'overlay',
  onAccount,
  onOpen,
  onSave,
  onDownload,
  onQuote,
  onUpload,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  isExecuting,
  isDownloading,
  isUploading,
  currentFilename,
  onStartGame,
  onExitGame,
  onRun,
  onHint,
  onPickPuzzle,
  gameElapsedMs = 0,
  gameSuccess = false,
  gameBestTimeMs = null,
}) => {
  const fileInputRef = useRef(null);
  const uploadModelRef = useRef(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const { isAuthenticated } = useAuth();
  const isGame = mode === 'game';
  const isStrip = variant === 'strip';

  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      onOpen(text, file.name);
    } catch (err) {
      console.error('Error reading file:', err);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleModelUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await onUpload(file);
    } catch (err) {
      console.error('Error uploading STEP file:', err);
    }

    if (uploadModelRef.current) {
      uploadModelRef.current.value = '';
    }
  };

  // Desktop CAD collapse. Strip variants (game + mobile CAD) never collapse.
  if (!isGame && !isStrip && isCollapsed) {
    return (
      <div className="absolute top-4 right-4 flex items-center gap-2 bg-white/70 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2 rounded hover:bg-gray-100 text-gray-600"
          title="Show Toolbar"
        >
          <ChevronLeft size={20} />
        </button>
      </div>
    );
  }

  // ── Game mode: back, undo/redo, run, picker, hint (BookOpen only) ──
  // Slice 08: rendered inline in CodeEditor mid-strip (no absolute overlay,
  // no ChevronRight collapse).
  if (isGame) {
    const shellClass = isStrip
      ? 'flex items-center gap-0.5 sm:gap-1 flex-1 min-w-0 overflow-x-auto'
      : 'absolute top-4 left-1/2 -translate-x-1/2 lg:left-auto lg:right-4 lg:translate-x-0 flex items-center gap-1 lg:gap-2 bg-white/60 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10 max-w-[calc(100vw-1rem)]';

    const btnPad = isStrip ? 'p-1.5' : 'p-2';
    const iconSize = isStrip ? 18 : 20;
    // Strip sits on Monaco dark chrome; overlay fallback keeps light frosted bar.
    const backCls = isStrip
      ? 'text-gray-300 hover:bg-gray-700/60 hover:text-white'
      : 'text-gray-700 hover:bg-gray-100';
    const editCls = isStrip
      ? 'text-blue-400 hover:bg-gray-700/60'
      : 'text-blue-600 hover:bg-gray-100';
    const runCls = isStrip
      ? 'text-green-400 hover:bg-gray-700/60'
      : 'text-green-600 hover:bg-gray-100';
    const cyanCls = isStrip
      ? 'text-cyan-400 hover:bg-gray-700/60'
      : 'text-cyan-700 hover:bg-gray-100';
    const dividerCls = isStrip ? 'w-px bg-gray-600 mx-0.5 self-stretch my-1' : 'w-px bg-gray-300 mx-1';
    const timeCls = gameSuccess
      ? (isStrip ? 'text-emerald-400 font-semibold' : 'text-emerald-700 font-semibold')
      : (isStrip ? 'text-gray-300' : 'text-gray-700');
    const spinBorder = isStrip ? 'border-green-400' : 'border-green-600';

    return (
      <div className={shellClass}>
        <button
          onClick={onExitGame}
          className={`${btnPad} flex items-center gap-1 ${backCls} rounded active:opacity-80`}
          title="Back to CAD"
        >
          <ArrowLeft size={iconSize} />
        </button>

        <div className={dividerCls} />

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className={`${btnPad} flex items-center gap-2 ${editCls} rounded disabled:opacity-30 active:opacity-80`}
          title="Undo"
        >
          <Undo size={iconSize} />
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          className={`${btnPad} flex items-center gap-2 ${editCls} rounded disabled:opacity-30 active:opacity-80`}
          title="Redo"
        >
          <Redo size={iconSize} />
        </button>

        <div className={dividerCls} />

        <button
          onClick={onRun}
          disabled={isExecuting}
          className={`${btnPad} flex items-center gap-1 ${runCls} rounded disabled:opacity-50 active:opacity-80`}
          title="Run script"
        >
          {isExecuting ? (
            <div className={`${isStrip ? 'w-4 h-4' : 'w-5 h-5'} border-2 ${spinBorder} border-t-transparent rounded-full animate-spin`} />
          ) : (
            <Play size={iconSize} />
          )}
        </button>

        <span
          className={`px-1 min-w-[3rem] text-center text-[11px] font-mono tabular-nums ${timeCls}`}
          title="Elapsed time (lower is better)"
        >
          {formatGameTime(gameElapsedMs)}
        </span>

        {gameBestTimeMs != null && (
          <span
            className="hidden sm:inline px-1 text-[10px] font-mono tabular-nums text-gray-500"
            title="Best time for this puzzle"
          >
            best {formatGameTime(gameBestTimeMs)}
          </span>
        )}

        <button
          onClick={onPickPuzzle}
          className={`${btnPad} flex items-center gap-1 ${cyanCls} rounded active:opacity-80`}
          title="Switch puzzle"
        >
          <List size={iconSize} />
        </button>

        {/* Slice 07: keep BookOpen as the sole Hint control (removed ⋯ overflow
            that sat next to Hint and felt like a second help entry in playtest).
            CAD Account/Save/Download remain available after exiting game. */}
        <button
          onClick={onHint}
          className={`${btnPad} flex items-center gap-1 ${cyanCls} rounded active:opacity-80`}
          title="Hint — target code & helpers"
        >
          <BookOpen size={iconSize} />
        </button>
      </div>
    );
  }

  // Mobile CAD: same mid-strip tokens as the game bar (dark, compact, scroll).
  // No collapse chevron — the strip is the editor header, not a viewport sheet.
  if (isStrip) {
    const btn = 'shrink-0 p-1.5 flex items-center rounded active:opacity-80 hover:bg-gray-700/60';
    const icon = 18;
    const blue = 'text-blue-400';
    const divider = 'shrink-0 w-px bg-gray-600 mx-0.5 self-stretch my-1';
    return (
      <div
        className="flex items-center gap-0.5 sm:gap-1 flex-1 min-w-0 overflow-x-auto"
        data-toolbar-variant="strip"
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          className="hidden"
          accept=".js,.txt"
        />
        <input
          type="file"
          ref={uploadModelRef}
          onChange={handleModelUpload}
          className="hidden"
          accept=".stl,.obj,.3mf,.step,.stp"
        />

        <button
          type="button"
          onClick={onAccount}
          className={`${btn} ${isAuthenticated ? 'text-green-400' : blue}`}
          title="Account"
        >
          <User size={icon} />
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={`${btn} ${blue}`}
          title="Open File"
        >
          <FolderOpen size={icon} />
        </button>
        <button
          type="button"
          onClick={() => uploadModelRef.current?.click()}
          disabled={isUploading || isExecuting}
          className={`${btn} ${blue} disabled:opacity-50`}
          title="Upload STEP File"
        >
          {isUploading ? (
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Upload size={icon} />
          )}
        </button>

        <div className={divider} />

        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className={`${btn} ${blue} disabled:opacity-30`}
          title="Undo"
        >
          <Undo size={icon} />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          className={`${btn} ${blue} disabled:opacity-30`}
          title="Redo"
        >
          <Redo size={icon} />
        </button>

        <div className={divider} />

        <button
          type="button"
          onClick={onSave}
          className={`${btn} ${blue}`}
          title={currentFilename ? `Save ${currentFilename}` : 'Save As'}
        >
          <Save size={icon} />
        </button>
        <button
          type="button"
          onClick={onDownload}
          disabled={isDownloading || isExecuting}
          className={`${btn} ${blue} disabled:opacity-50`}
          title="Download Model"
        >
          {isDownloading ? (
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Download size={icon} />
          )}
        </button>

        <div className={divider} />

        <button
          type="button"
          onClick={onQuote}
          className={`${btn} text-green-400`}
          title="Get Quote"
        >
          <Truck size={icon} />
        </button>
        <button
          type="button"
          onClick={onStartGame}
          className={`${btn} text-cyan-400`}
          title="Play match-the-part puzzle"
        >
          <Puzzle size={icon} />
        </button>
      </div>
    );
  }

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 lg:left-auto lg:right-4 lg:translate-x-0 flex gap-1 lg:gap-2 bg-white/60 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10">
      {/* Account */}
      <button
        onClick={onAccount}
        className={`p-2 rounded hover:bg-gray-100 ${isAuthenticated ? 'text-green-600' : 'text-blue-600'}`}
        title="Account"
      >
        <User size={20} />
      </button>

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
        accept=".js,.txt"
      />

      <input
        type="file"
        ref={uploadModelRef}
        onChange={handleModelUpload}
        className="hidden"
        accept=".stl,.obj,.3mf,.step,.stp"
      />

      {/* Open */}
      <button
        onClick={() => fileInputRef.current?.click()}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded"
        title="Open File"
      >
        <FolderOpen size={20} />
      </button>

      {/* Upload */}
      <button
        onClick={() => uploadModelRef.current?.click()}
        disabled={isUploading || isExecuting}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded disabled:opacity-50"
        title="Upload STEP File"
      >
        {isUploading ? (
          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        ) : (
          <Upload size={20} />
        )}
      </button>

      <div className="w-px bg-gray-300 mx-1"></div>

      {/* Undo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded disabled:opacity-30"
        title="Undo"
      >
        <Undo size={20} />
      </button>

      {/* Redo */}
      <button
        onClick={onRedo}
        disabled={!canRedo}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded disabled:opacity-30"
        title="Redo"
      >
        <Redo size={20} />
      </button>

      <div className="w-px bg-gray-300 mx-1"></div>

      {/* Save */}
      <button
        onClick={onSave}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded"
        title={currentFilename ? `Save ${currentFilename}` : 'Save As'}
      >
        <Save size={20} />
      </button>

      {/* Download */}
      <button
        onClick={onDownload}
        disabled={isDownloading || isExecuting}
        className="p-2 rounded hover:bg-gray-100 text-blue-600 disabled:opacity-50"
        title="Download Model"
      >
        {isDownloading ? (
          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        ) : (
          <Download size={20} />
        )}
      </button>

      <div className="w-px bg-gray-300 mx-1"></div>

      {/* Quote */}
      <button
        onClick={onQuote}
        className="p-2 rounded hover:bg-gray-100 text-green-600"
        title="Get Quote"
      >
        <Truck size={20} />
      </button>

      {/* Start puzzle / game mode — opens picker */}
      <button
        onClick={onStartGame}
        className="p-2 rounded hover:bg-gray-100 text-cyan-700"
        title="Play match-the-part puzzle"
      >
        <Puzzle size={20} />
      </button>

      {/* Collapse (CAD only) */}
      <button
        onClick={() => setIsCollapsed(true)}
        className="p-2 rounded hover:bg-gray-100 text-gray-600"
        title="Hide Toolbar"
      >
        <ChevronRight size={20} />
      </button>
    </div>
  );
};

export default Toolbar;
