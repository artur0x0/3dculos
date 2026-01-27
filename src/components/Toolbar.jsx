import React, { useRef, useState } from 'react';
import { FolderOpen, Save, Download, Undo, Redo, ChevronLeft, ChevronRight, Truck, Upload, User } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

const Toolbar = ({ 
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
  currentFilename
}) => {
  const fileInputRef = useRef(null);
  const uploadModelRef = useRef(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const { isAuthenticated } = useAuth();

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