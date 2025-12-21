// components/ScriptToolbar.jsx
import React from 'react';
import { Play, Square, Download } from 'lucide-react';

const ScriptToolbar = ({ onExecute, isExecuting, onDownloadModel, isDownloading = false }) => {
  return (
    <div className="absolute bottom-4 right-4 md:top-4 md:left-4 md:bottom-auto md:right-auto flex gap-2 bg-white/90 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10">
      <button
        onClick={onExecute}
        disabled={isExecuting || isDownloading}
        className={`p-2 rounded hover:bg-gray-100 ${isExecuting ? 'text-red-600' : 'text-green-600'}`}
        title={isExecuting ? 'Stop' : 'Run'}
      >
        {isExecuting ? <Square size={20} /> : <Play size={20} />}
      </button>

      <button
        onClick={onDownloadModel}
        disabled={isDownloading || isExecuting}
        className="p-2 rounded hover:bg-gray-100 text-blue-600 disabled:opacity-50"
        title="Download as STL"
      >
        {isDownloading ? (
          <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        ) : (
          <Download size={20} />
        )}
      </button>
    </div>
  );
};

export default ScriptToolbar;