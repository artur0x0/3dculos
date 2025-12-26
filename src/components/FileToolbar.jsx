// components/FileToolbar.js
import React, { useRef, useState } from 'react';
import { FolderOpen, Save, Undo, Redo } from 'lucide-react';

const FileToolbar = ({ onLoadFile, getEditorContent, onUndo, onRedo, canUndo, canRedo }) => {
  const fileInputRef = useRef(null);
  const [currentFilename, setCurrentFilename] = useState(null);

  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      console.log('File loaded, content length:', text.length);
      onLoadFile(text);
      setCurrentFilename(file.name);
    } catch (err) {
      console.error('Error reading file:', err);
    }
    
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSave = async () => {
    console.log('Save button clicked');
    // Get current content immediately before saving
    const content = getEditorContent();
    console.log('Current editor content length:', content.length);

    if (window.showSaveFilePicker && typeof window.showSaveFilePicker === 'function') {
      try {
        console.log('Using File System Access API');
        const options = {
          suggestedName: currentFilename || 'script.js',
          types: [
            {
              description: 'JavaScript files',
              accept: {
                'text/javascript': ['.js'],
              },
            },
            {
              description: 'Text files',
              accept: {
                'text/plain': ['.txt'],
              },
            },
          ],
        };

        const handle = await window.showSaveFilePicker(options);
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        
        setCurrentFilename(handle.name);
        console.log('File saved successfully');
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.log('Falling back to download method');
          const blob = new Blob([content], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = currentFilename || 'script.js';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      }
    } else {
      console.log('File System Access API not supported, using download method');
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentFilename || 'script.js';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="absolute bottom-16 right-4 lg:top-4 lg:bottom-auto flex gap-2 bg-white/90 backdrop-blur-sm p-2 rounded-lg shadow-lg z-50">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
        accept=".js,.txt"
      />
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
      <button
        onClick={() => fileInputRef.current?.click()}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded"
        title="Open File"
      >
        <FolderOpen size={20} />
      </button>
      <button
        onClick={handleSave}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded"
        title={currentFilename ? `Save ${currentFilename}` : 'Save As'}
      >
        <Save size={20} />
      </button>
    </div>
  );
};

export default FileToolbar;