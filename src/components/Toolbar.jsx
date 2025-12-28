import React, { useRef, useState } from 'react';
import { FolderOpen, Save, Play, Square, Download, Undo, Redo, ChevronLeft, ChevronRight, Truck } from 'lucide-react';

const Toolbar = ({ 
  onOpen, 
  onSave, 
  onRun, 
  onDownload,
  onQuote,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  isExecuting,
  isDownloading,
  currentFilename 
}) => {
  const fileInputRef = useRef(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

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

return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 lg:left-auto lg:right-4 lg:translate-x-0 flex gap-2 bg-white/60 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10">
      {/* Run/Stop */}
      <button
        onClick={onRun}
        disabled={isExecuting || isDownloading}
        className={`p-2 rounded hover:bg-gray-100 ${isExecuting ? 'text-red-600' : 'text-green-600'}`}
        title={isExecuting ? 'Stop' : 'Run'}
      >
        {isExecuting ? <Square size={20} /> : <Play size={20} />}
      </button>

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
        accept=".js,.txt"
      />
      
      {/* Open */}
      <button
        onClick={() => fileInputRef.current?.click()}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded"
        title="Open File"
      >
        <FolderOpen size={20} />
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