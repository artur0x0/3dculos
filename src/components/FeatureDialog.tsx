import React, { useState } from 'react';
import { X, Check } from 'lucide-react';

interface FeatureParams {
  width?: number;
  height?: number;
  depth?: number;
}

interface FeatureDialogProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'plane' | 'extrude' | null;
  onSubmit: (params: FeatureParams) => void;
}

const FeatureDialog: React.FC<FeatureDialogProps> = ({ isOpen, onClose, type, onSubmit }) => {
  const [params, setParams] = useState<FeatureParams>({
    width: 100,
    height: 100,
    depth: 50
  });

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(params);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-lg w-96">
        <div className="flex justify-between items-center p-4 border-b">
          <h2 className="text-lg font-semibold">
            {type === 'plane' ? 'Add Plane' : 'Extrude'}
          </h2>
          <button 
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-full"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4">
          <div className="space-y-4">
            {type === 'plane' ? (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1">Width (mm)</label>
                  <input
                    type="number"
                    value={params.width}
                    onChange={(e) => setParams({...params, width: parseFloat(e.target.value)})}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Height (mm)</label>
                  <input
                    type="number"
                    value={params.height}
                    onChange={(e) => setParams({...params, height: parseFloat(e.target.value)})}
                    className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="block text-sm font-medium mb-1">Depth (mm)</label>
                <input
                  type="number"
                  value={params.depth}
                  onChange={(e) => setParams({...params, depth: parseFloat(e.target.value)})}
                  className="w-full p-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border rounded-md hover:bg-gray-50 flex items-center gap-2"
            >
              <X className="h-4 w-4" />
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2"
            >
              <Check className="h-4 w-4" />
              Accept
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default FeatureDialog;