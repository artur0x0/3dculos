import React, { useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { scsGaugeLabel } from '../../utils/scs/scsCatalog';
import { SHEET_CHIP_DESKTOP_REM, sheetChipBetweenRails } from '../../utils/sheetMetal/sheetChipLayout';

function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
}

function samePlace(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5;
}

/**
 * Bottom chip while sheet-metal mode is active: bound SKU + current step,
 * ✕ exits the flow without writing.
 * On a phone the chip is only as wide as the gap between the measured
 * side rails, centered in that gap, so it does not cover either toolbar.
 */
const SheetMetalModeChip = ({ mode, compact = false, onDismiss, children }) => {
  const chipRef = useRef(null);
  const [place, setPlace] = useState(null);

  useLayoutEffect(() => {
    const el = chipRef.current;
    const root = el?.parentElement;
    if (!root) return undefined;
    let raf = 0;
    const measure = () => {
      const left = root.querySelector('[data-rail-pair="left"]');
      const right = root.querySelector('[data-rail-pair="right"]');
      const box = rectOf(root);
      const maxWidth = compact
        ? null
        : SHEET_CHIP_DESKTOP_REM * parseFloat(getComputedStyle(document.documentElement).fontSize || '16');
      const next = sheetChipBetweenRails(box, rectOf(left), rectOf(right), { maxWidth });
      setPlace((prev) => (samePlace(prev, next) ? prev : next));
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    }) : null;
    ro?.observe(root);
    const left = root.querySelector('[data-rail-pair="left"]');
    const right = root.querySelector('[data-rail-pair="right"]');
    if (left) ro?.observe(left);
    if (right) ro?.observe(right);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [compact, mode?.stage]);

  if (!mode) return null;
  const rec = mode.sku;
  const placed = place != null;
  return (
    <div
      ref={chipRef}
      className={`absolute bg-orange-950/80 surface-glass-chip border border-orange-400/70 text-white px-3 py-2
        rounded-lg text-xs z-20 shadow-lg flex flex-col min-h-0 min-w-0 ${
          compact ? 'bottom-14' : 'bottom-2.5'
        } ${
          placed
            ? ''
            : compact
              ? 'left-1/2 -translate-x-1/2 w-[min(20rem,calc(100%-6rem))]'
              : 'left-1/2 -translate-x-1/2 w-[22rem]'
        } max-h-[calc(100dvh-12rem)]`}
      style={placed ? { left: place.left, width: place.width, right: 'auto', transform: 'none' } : undefined}
      role="group"
      aria-label="Sheet metal"
      data-sheet-metal-mode={mode.stage}
      data-sheet-chip-gap={placed ? 'measured' : 'fallback'}
    >
      <div className="flex items-start justify-between gap-2 shrink-0 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="font-bold font-sans text-orange-200 truncate" data-sm-material="">
            Sheet metal · {rec?.name}
          </div>
          <div className="text-[11px] text-orange-100/90 font-sans mt-0.5 truncate" data-sm-gauge="">
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
