// components/Toolbar.tsx
import React from 'react';
import { Play, Square, Grid, ArrowBigUpDash } from 'lucide-react';

interface ToolbarProps {
  onExecute: () => void;
  isExecuting: boolean;
  onAddFeature: (featureType: 'plane' | 'extrude') => void;
}

const Toolbar: React.FC<ToolbarProps> = ({ onExecute, isExecuting, onAddFeature }) => {
  return (
    <div className="absolute top-4 left-4 flex gap-2 bg-white/90 backdrop-blur-sm p-2 rounded-lg shadow-lg">
      <button
        onClick={onExecute}
        className={`p-2 rounded hover:bg-gray-100 ${isExecuting ? 'text-red-600' : 'text-green-600'}`}
        title={isExecuting ? 'Stop' : 'Run'}
      >
        {isExecuting ? <Square size={20} /> : <Play size={20} />}
      </button>
      <button
        onClick={() => onAddFeature('plane')}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded"
        title="Add Plane"
      >
        <Grid size={20} />
      </button>
      <button
        onClick={() => onAddFeature('extrude')}
        className="p-2 flex items-center gap-2 text-blue-600 hover:bg-gray-100 rounded"
        title="Extrude"
      >
        <ArrowBigUpDash size={20} />
      </button>
    </div>
  );
};

export default Toolbar;