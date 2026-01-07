// components/CrossSectionPanel.jsx
import React, { useState, useEffect } from 'react';
import { FlipHorizontal, ChevronDown, ChevronUp, Maximize2 } from 'lucide-react';
import { PLANE_PRESETS } from '../utils/crossSection';

const CrossSectionPanel = ({ 
  enabled,
  onToggle,
  onPlaneChange,
  onZoomToFit,
  bounds 
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [planeType, setPlaneType] = useState('XY');
  const [offset, setOffset] = useState(0);
  const [customNormal, setCustomNormal] = useState([0, 0, 1]);
  const [isCustom, setIsCustom] = useState(false);

  // Calculate offset range based on bounds
  const [offsetRange, setOffsetRange] = useState({ min: -100, max: 100, center: 0 });

  useEffect(() => {
    if (bounds) {
      // Calculate range based on bounding box and current normal
      const normal = isCustom ? customNormal : PLANE_PRESETS[planeType].normal;
      const range = calculateOffsetRange(bounds, normal);
      setOffsetRange(range);
      
      // On first bounds calculation, set offset to center
      // Check if we're still at the default range
      if (offsetRange.min === -100 && offsetRange.max === 100) {
        setOffset(range.center);
        
        // Also notify parent of the centered position
        onPlaneChange?.({
          normal,
          originOffset: range.center,
          showPlane: true
        });
      } else if (offset < range.min || offset > range.max) {
        // If offset is out of new range, re-center
        setOffset(range.center);
        
        onPlaneChange?.({
          normal,
          originOffset: range.center,
          showPlane: !isCollapsed
        });
      }
    }
  }, [bounds, planeType, isCustom, customNormal]);

  const calculateOffsetRange = (bounds, normal) => {
    if (!bounds) return { min: -100, max: 100, center: 0 };
    
    // Project bounding box onto normal
    const corners = [
      [bounds.min[0], bounds.min[1], bounds.min[2]],
      [bounds.max[0], bounds.min[1], bounds.min[2]],
      [bounds.min[0], bounds.max[1], bounds.min[2]],
      [bounds.max[0], bounds.max[1], bounds.min[2]],
      [bounds.min[0], bounds.min[1], bounds.max[2]],
      [bounds.max[0], bounds.min[1], bounds.max[2]],
      [bounds.min[0], bounds.max[1], bounds.max[2]],
      [bounds.max[0], bounds.max[1], bounds.max[2]]
    ];

    const projections = corners.map(corner => 
      corner[0] * normal[0] + corner[1] * normal[1] + corner[2] * normal[2]
    );

    const min = Math.min(...projections);
    const max = Math.max(...projections);
    const center = (min + max) / 2;

    return { min, max, center };
  };

  const handlePresetChange = (preset) => {
    console.log(`Handling preset change to ${preset}`)
    setPlaneType(preset);
    setIsCustom(false);
    const normal = PLANE_PRESETS[preset].normal;
    
    // Sync rotation boxes with preset normal
    setCustomNormal([...normal]);
    
    // Re-center position
    const newOffset = offsetRange.center;
    setOffset(newOffset);
    
    onPlaneChange?.({
      normal,
      originOffset: newOffset,
      showPlane: !isCollapsed
    });
  };

  const handleOffsetChange = (newOffset) => {
    setOffset(parseFloat(newOffset));
    
    const normal = isCustom ? customNormal : PLANE_PRESETS[planeType].normal;
    onPlaneChange?.({
      normal,
      originOffset: parseFloat(newOffset),
      showPlane: !isCollapsed
    });
  };

  const handleCustomNormalChange = (axis, value) => {
    const newNormal = [...customNormal];
    newNormal[axis] = parseFloat(value) || 0;
    setCustomNormal(newNormal);
    
    // Auto-activate custom if any value is non-zero
    const hasNonZero = newNormal.some(v => v !== 0);
    setIsCustom(hasNonZero);
    
    if (hasNonZero) {
      onPlaneChange?.({
        normal: newNormal,
        originOffset: offset,
        showPlane: !isCollapsed
      });
    }
  };

const handleButtonClick = () => {
  if (!enabled) {
    // Turn on and expand
    onToggle?.(true);
    requestAnimationFrame(() => {
      handlePresetChange('XY');
      setIsCollapsed(false);
    })    
  } else {
    // Turn off and collapse
    onToggle?.(false);
    setIsCollapsed(true);
  }
};

  const handleChevronClick = () => {
    setIsCollapsed(!isCollapsed);
    // Update plane visibility
    const normal = isCustom ? customNormal : PLANE_PRESETS[planeType].normal;
    onPlaneChange?.({
      normal,
      originOffset: offset,
      showPlane: isCollapsed // Will become true when expanding
    });
  };

  if (isCollapsed || !enabled) {
    return (
      <div className="absolute bottom-4 right-4 flex gap-2 bg-white/60 backdrop-blur-sm p-2 rounded-lg shadow-lg z-10">
        <button
          onClick={onZoomToFit}
          className="p-2 rounded text-blue-600 hover:bg-blue-100"
          title="Zoom to Fit"
        >
          <Maximize2 size={20} />
        </button>
        <button
          onClick={handleButtonClick}
          className={`p-2 rounded ${enabled ? 'text-green-600' : 'text-blue-600'} hover:bg-gray-100`}
          title={enabled ? 'Disable Cross Section' : 'Enable Cross Section'}
        >
          <FlipHorizontal size={20} />
        </button>
        {enabled && (
          <button
            onClick={handleChevronClick}
            className="p-2 rounded hover:bg-gray-100 text-gray-600"
            title="Show Options"
          >
            <ChevronUp size={20} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="absolute bottom-4 right-4 bg-white/60 backdrop-blur-sm rounded-lg shadow-lg p-3 z-10 w-72">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onZoomToFit}
          className="p-2 rounded text-blue-600 hover:bg-blue-100"
          title="Zoom to Fit"
        >
          <Maximize2 size={20} />
        </button>
        <button
          onClick={handleButtonClick}
          className="p-2 rounded text-green-600 hover:bg-gray-100"
          title="Disable Cross Section"
        >
          <FlipHorizontal size={20} />
        </button>
        <button
          onClick={handleChevronClick}
          className="p-2 rounded hover:bg-gray-100 text-gray-600"
          title="Hide Options"
        >
          <ChevronDown size={20} />
        </button>
      </div>

      <div className="space-y-3">
        {/* Preset Planes */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Plane
          </label>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(PLANE_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                onClick={() => handlePresetChange(key)}
                className={`px-3 py-2 rounded text-xs font-medium transition-colors ${
                  planeType === key
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {key}
              </button>
            ))}
          </div>
        </div>

        {/* Position Slider */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Position: {offset.toFixed(1)} mm
          </label>
          <input
            type="range"
            min={offsetRange.min}
            max={offsetRange.max}
            step="0.5"
            value={offset}
            onChange={(e) => handleOffsetChange(e.target.value)}
            className="w-full h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-blue-500"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>{offsetRange.min.toFixed(0)}</span>
            <button
              onClick={() => handleOffsetChange(offsetRange.center)}
              className="text-gray-600 hover:text-gray-900 font-medium"
            >
              Center
            </button>
            <span>{offsetRange.max.toFixed(0)}</span>
          </div>
        </div>

        {/* Rotation */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Rotation
          </label>
          <div className="grid grid-cols-3 gap-2">
            <input
              type="number"
              value={customNormal[0]}
              onChange={(e) => handleCustomNormalChange(0, e.target.value)}
              placeholder="X"
              step="0.1"
              disabled={Math.abs(customNormal[0]) === 1}
              className={`border border-gray-300 rounded px-2 py-1 text-xs ${
                Math.abs(customNormal[0]) === 1
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-white text-gray-700'
              }`}
            />
            <input
              type="number"
              value={customNormal[1]}
              onChange={(e) => handleCustomNormalChange(1, e.target.value)}
              placeholder="Y"
              step="0.1"
              disabled={Math.abs(customNormal[1]) === 1}
              className={`border border-gray-300 rounded px-2 py-1 text-xs ${
                Math.abs(customNormal[1]) === 1
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-white text-gray-700'
              }`}
            />
            <input
              type="number"
              value={customNormal[2]}
              onChange={(e) => handleCustomNormalChange(2, e.target.value)}
              placeholder="Z"
              step="0.1"
              disabled={Math.abs(customNormal[2]) === 1}
              className={`border border-gray-300 rounded px-2 py-1 text-xs ${
                Math.abs(customNormal[2]) === 1
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-white text-gray-700'
              }`}
            />
          </div>
        </div>

      </div>
    </div>
  );
};

export default CrossSectionPanel;
