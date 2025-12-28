import React, { useState, useEffect } from 'react';
import { X, Loader2, DollarSign, Clock, Package, ShoppingCart } from 'lucide-react';

const PROCESSES = {
  FDM: {
    name: 'FDM (Fused Deposition Modeling)',
    maxSize: { x: 256, y: 256, z: 256 }, // mm
    materials: ['PLA', 'PETG', 'ABS', 'TPU', 'Nylon']
  },
  SLA: {
    name: 'SLA (Stereolithography)',
    maxSize: { x: 145, y: 145, z: 175 },
    materials: ['Standard Resin', 'Tough Resin', 'Flexible Resin'],
    disabled: true
  },
  SLS: {
    name: 'SLS (Selective Laser Sintering)',
    maxSize: { x: 300, y: 300, z: 300 },
    materials: ['Nylon PA12', 'Nylon PA11', 'TPU'],
    disabled: true
  },
  MP: {
    name: 'Metal Printing',
    maxSize: { x: 250, y: 250, z: 250 },
    materials: ['Stainless Steel 316L', 'Aluminum AlSi10Mg', 'Titanium Ti6Al4V'],
    disabled: true
  }
};

const QuoteModal = ({ onClose, onGetQuote }) => {
  const [selectedProcess, setSelectedProcess] = useState('FDM');
  const [selectedMaterial, setSelectedMaterial] = useState('PLA');
  const [infill, setInfill] = useState(20);
  const [quoteResult, setQuoteResult] = useState(null);
  const [error, setError] = useState(null);

  const currentProcess = PROCESSES[selectedProcess];

  // Auto-calculate quote when modal opens or options change
  useEffect(() => {
    const getQuote = async () => {
      setError(null);

      try {
        const result = await onGetQuote({
          process: selectedProcess,
          material: selectedMaterial,
          infill: infill
        });

        setQuoteResult(result);
      } catch (err) {
        console.error('Quote error:', err);
        setError(err.message || 'Failed to calculate quote. Please try again.');
      }
    };

    getQuote();
  }, [selectedProcess, selectedMaterial, infill, onGetQuote]);

  const handleProcessChange = (process) => {
    if (PROCESSES[process].disabled) return;
    setSelectedProcess(process);
    // Reset to first available material for this process
    setSelectedMaterial(PROCESSES[process].materials[0]);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-[#1e1e1e] rounded-lg shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <DollarSign size={24} />
            Manufacturing Quote
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Process Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-3">
            Manufacturing Process
          </label>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(PROCESSES).map(([key, process]) => (
              <button
                key={key}
                onClick={() => handleProcessChange(key)}
                disabled={process.disabled}
                className={`p-4 rounded-lg border-2 transition-all text-left ${
                  selectedProcess === key
                    ? 'border-gray bg-gray-700'
                    : 'border-gray-600 bg-gray-800/50 hover:border-gray-500'
                } ${
                  process.disabled
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer'
                }`}
              >
                <div className="font-medium text-white">{key}</div>
                <div className="text-xs text-gray-400 mt-1">{process.name}</div>
                {process.disabled && (
                  <div className="text-xs text-yellow-500 mt-1">Coming Soon</div>
                )}
              </button>
            ))}
          </div>
        </div>

          {/* Max Size Info */}
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <div className="text-sm text-gray-300">
              <span className="font-medium">Maximum Build Size:</span>{' '}
              {currentProcess.maxSize.x} × {currentProcess.maxSize.y} × {currentProcess.maxSize.z} mm
            </div>
          </div>

          {/* Material Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-3">
              Material
            </label>
            <div className="relative">
              <select
                value={selectedMaterial}
                onChange={(e) => setSelectedMaterial(e.target.value)}
                className="w-full bg-[#1e1e1e] text-white border border-gray-600 rounded-lg px-4 py-3 pr-10 focus:outline-none focus:ring-1 focus:ring-grey focus:border-white appearance-none cursor-pointer"
              >
                {currentProcess.materials.map((material) => (
                  <option 
                    key={material} 
                    value={material}
                    className="bg-[#1e1e1e] text-white"
                  >
                    {material}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>

          {/* Infill Slider */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-3">
              Infill Density: {infill}%
            </label>
            <input
              type="range"
              min="10"
              max="100"
              step="5"
              value={infill}
              onChange={(e) => setInfill(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>10% (Faster, Less Strong)</span>
              <span>100% (Slower, Stronger)</span>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
              <div className="text-red-400 text-sm">{error}</div>
            </div>
          )}

          {/* Quote Result */}
          {quoteResult && (
            <div className="bg-green-900/20 border border-green-500/50 rounded-lg p-6 space-y-4">
              <h3 className="text-lg font-semibold text-green-400">Quote Breakdown</h3>
              
              <div className="space-y-3">
                {/* Material Usage */}
                <div className="flex items-center justify-between text-gray-300">
                  <div className="flex items-center gap-2">
                    <Package size={18} className="text-blue-400" />
                    <span>Material Usage:</span>
                  </div>
                  <span className="font-medium">
                    {quoteResult.materialUsage.grams.toFixed(1)}g 
                    {quoteResult.materialUsage.meters > 0 && 
                      ` (${quoteResult.materialUsage.meters.toFixed(1)}m)`
                    }
                  </span>
                </div>

                {/* Print Time */}
                <div className="flex items-center justify-between text-gray-300">
                  <div className="flex items-center gap-2">
                    <Clock size={18} className="text-yellow-400" />
                    <span>Estimated Print Time:</span>
                  </div>
                  <span className="font-medium">
                    {quoteResult.printTime.toFixed(1)} hours
                  </span>
                </div>

                <div className="border-t border-gray-600 my-4"></div>

                {/* Cost Breakdown */}
                <div className="space-y-2">
                  <div className="flex justify-between text-gray-400 text-sm">
                    <span>Material Cost:</span>
                    <span>${quoteResult.costs.material.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-gray-400 text-sm">
                    <span>Machine Time:</span>
                    <span>${quoteResult.costs.machine.toFixed(2)}</span>
                  </div>
                  
                  <div className="border-t border-gray-600 my-2"></div>
                  
                  <div className="flex justify-between text-white text-lg font-bold">
                    <span>Total:</span>
                    <span className="text-green-400">${quoteResult.costs.total.toFixed(2)}</span>
                  </div>
                </div>

                {/* Quote Details */}
                <div className="text-xs text-gray-500 mt-4 pt-4 border-t border-gray-700">
                  <div>Process: {selectedProcess}</div>
                  <div>Material: {selectedMaterial}</div>
                  <div>Infill: {infill}%</div>
                </div>

                {/* Order Button */}
                <div className="pt-4">
                  <button
                    disabled
                    className="w-full px-6 py-4 bg-gray-700 text-gray-400 rounded-lg cursor-not-allowed flex items-center justify-center gap-2 text-lg font-semibold"
                  >
                    <ShoppingCart size={24} />
                    Order - Coming Soon
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuoteModal;