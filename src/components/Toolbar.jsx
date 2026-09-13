import React, { useEffect, useRef, useState } from 'react';
import {
  FolderOpen, Save, Download, Undo, Redo, ChevronLeft, ChevronRight,
  Truck, Upload, User, ArrowLeft, Play, BookOpen, Puzzle, MoreHorizontal
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

const Toolbar = ({
  mode = 'cad',
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
}) => {
  const fileInputRef = useRef(null);
  const uploadModelRef = useRef(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef(null);

  const { isAuthenticated } = useAuth();
  const isGame = mode === 'game';

  useEffect(() => {
    if (!showOverflow) return;
    const onPointerDown = (e) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target)) {
        setShowOverflow(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setShowOverflow(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showOverflow]);

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

  if (isCollapsed) {
    return (
      <div className="absolute top-4 right-4 flex gap-2 bg-white/70 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10">
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

  // ── Game mode: back, undo, run, hint; stash file/account/order chrome ──
  if (isGame) {
    return (
      <div className="absolute top-4 left-1/2 -translate-x-1/2 lg:left-auto lg:right-4 lg:translate-x-0 flex gap-1 lg:gap-2 bg-white/60 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10">
        <button
          onClick={onExitGame}
          className="p-2 flex items-center gap-1 text-gray-700 hover:bg-gray-100 rounded"
          title="Back to CAD"
        >
          <ArrowLeft size={20} />
        </button>

        <div className="w-px bg-gray-300 mx-1" />

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded disabled:opacity-30"
          title="Undo"
        >
          <Undo size={20} />
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded disabled:opacity-30"
          title="Redo"
        >
          <Redo size={20} />
        </button>

        <div className="w-px bg-gray-300 mx-1" />

        <button
          onClick={onRun}
          disabled={isExecuting}
          className="p-2 flex items-center gap-1 text-green-600 hover:bg-gray-100 rounded disabled:opacity-50"
          title="Run script"
        >
          {isExecuting ? (
            <div className="w-5 h-5 border-2 border-green-600 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Play size={20} />
          )}
        </button>

        <button
          onClick={onHint}
          className="p-2 flex items-center gap-1 text-cyan-700 hover:bg-gray-100 rounded"
          title="Puzzle helpers / docs"
        >
          <BookOpen size={20} />
        </button>

        {/* Overflow: stash CAD file/account actions without losing them entirely */}
        <div className="relative" ref={overflowRef}>
          <button
            onClick={() => setShowOverflow((v) => !v)}
            className="p-2 rounded hover:bg-gray-100 text-gray-500"
            title="More"
          >
            <MoreHorizontal size={20} />
          </button>
          {showOverflow && (
            <div className="absolute right-0 top-full mt-1 flex flex-col gap-0.5 bg-white rounded-lg shadow-lg border border-gray-200 p-1 min-w-[140px]">
              <button
                onClick={() => { onAccount?.(); setShowOverflow(false); }}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded"
              >
                <User size={16} /> Account
              </button>
              <button
                onClick={() => { onSave?.(); setShowOverflow(false); }}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded"
              >
                <Save size={16} /> Save
              </button>
              <button
                onClick={() => { onDownload?.(); setShowOverflow(false); }}
                disabled={isDownloading || isExecuting}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"
              >
                <Download size={16} /> Download
              </button>
            </div>
          )}
        </div>

        <button
          onClick={() => setIsCollapsed(true)}
          className="p-2 rounded hover:bg-gray-100 text-gray-600"
          title="Hide Toolbar"
        >
          <ChevronRight size={20} />
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

      {/* Start puzzle / game mode */}
      <button
        onClick={onStartGame}
        className="p-2 rounded hover:bg-gray-100 text-cyan-700"
        title="Play match-the-part puzzle"
      >
        <Puzzle size={20} />
      </button>

      {/* Collapse */}
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
