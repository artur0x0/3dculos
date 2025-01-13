// components/Toolbar.js
import React from 'react';
import { Play, Square } from 'lucide-react';

const Toolbar = ({ onExecute, isExecuting }) => {
  return (
    <div className="absolute top-4 left-4 flex gap-2 bg-white/90 backdrop-blur-sm p-2 rounded-lg shadow-lg">
      <button
        onClick={onExecute}
        className={`p-2 rounded hover:bg-gray-100 ${isExecuting ? 'text-red-600' : 'text-green-600'}`}
        title={isExecuting ? 'Stop' : 'Run'}
      >
        {isExecuting ? <Square size={20} /> : <Play size={20} />}
      </button>
    </div>
  );
};

export default Toolbar;