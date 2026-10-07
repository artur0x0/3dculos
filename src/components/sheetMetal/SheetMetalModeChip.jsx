import React from 'react';
import { X } from 'lucide-react';
import { scsGaugeLabel } from '../../utils/scs/scsCatalog';

/**
 * Bottom chip while sheet-metal mode is active: bound SKU + current step,
 * ✕ exits the flow without writing.
 */
const SheetMetalModeChip = ({ mode, compact = false, onDismiss, children }) => {
  if (!mode) return null;
  const rec = mode.sku;
  return (
    <div
      className={`absolute bg-orange-950/80 surface-glass-chip border border-orange-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 ${
          compact
            ? 'bottom-14 left-1/2 -translate-x-1/2 w-[min(20rem,calc(100%-6rem))] max-h-[calc(100dvh-12rem)]'
            : 'bottom-2.5 left-1/2 -translate-x-1/2 w-[22rem] max-h-[calc(100dvh-12rem)]'
        }`}
      role="group"
      aria-label="Sheet metal"
      data-sheet-metal-mode={mode.stage}
    >
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0">
          <div className="font-bold font-sans text-orange-200 truncate">
            Sheet metal · {rec?.name}
          </div>
          <div className="text-[11px] text-orange-100/90 font-sans mt-0.5 truncate">
            {scsGaugeLabel(rec)} · {rec?.sku}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss?.()}
          className="-mr-2 -mt-1 h-11 w-11 shrink-0 inline-flex items-center justify-center rounded text-gray-300 hover:text-white"
          title="Exit sheet metal without writing"
          aria-label="Exit sheet metal without writing"
          data-sm-close="1"
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </div>
  );
};

export default SheetMetalModeChip;
