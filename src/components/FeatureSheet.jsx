import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { useModalViewport } from '../hooks/useModalViewport';
import { featureSheetBottom, measureFeatureSheetWidth } from '../utils/featureSheetLayout';

/**
 * Shared feature card. Mode chips, helper sheets, and the edit sheet
 * render inside this. One card, bottom center, on the phone and on desktop.
 *
 * Props:
 * - title, subtitle
 * - onCancel: X, Esc, and the rail X. Writes nothing.
 * - onConfirm: saves and closes. Omit it when the card has nothing to write
 *   (the standalone edge card). No swipe-to-dismiss.
 * - confirmDisabled
 * - confirmLabel (default Confirm)
 * - children: scrolling body
 * - footer: sticky blocks above the confirm row (Add/Subtract, Merge, Delete)
 * - note: node on the left of Confirm
 * - compact: phone. The card bottom docks to the hidden stage switcher.
 *   Desktop when false (10px, no switcher to hide).
 * - fullLeft: the left tool rail is not there. The left edge is the 10px
 *   pane inset. The right edge stays clear of the right rail. Other cards
 *   leave this false and stay between both rails.
 * - bodyAttrs / cardAttrs: extra data attributes for the pilot that owns the card
 *
 * The card is pointer-events-auto and stops pointerdown. The pane around it
 * is not covered, so orbit and pinch hit the canvas. Game mode does not mount it.
 */
export default function FeatureSheet({
  title,
  subtitle = '',
  onCancel,
  onConfirm,
  confirmDisabled = false,
  confirmLabel = 'Confirm',
  children,
  footer = null,
  note = null,
  compact = false,
  fullLeft = false,
  bodyAttrs = null,
  cardAttrs = null,
}) {
  useModalViewport();
  const cardRef = useRef(null);
  const bodyRef = useRef(null);
  const [frame, setFrame] = useState(null);
  const [overflow, setOverflow] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const [thumb, setThumb] = useState(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  useEffect(() => {
    const card = cardRef.current;
    const pane = card?.closest('.viewport-shell') || card?.offsetParent;
    if (!pane) return undefined;
    const measure = () => {
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setFrame(measureFeatureSheetWidth(pane, root, { fullLeft }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    const left = pane.querySelector('[data-rail-pair="left"]');
    const right = pane.querySelector('[data-rail-pair="right"]');
    if (left) ro.observe(left);
    if (right) ro.observe(right);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [fullLeft]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const measure = () => {
      const extra = el.scrollHeight - el.clientHeight;
      const over = extra > 1;
      setOverflow(over);
      setMoreBelow(over && el.scrollTop < extra - 2);
      if (!over) {
        setThumb(null);
        return;
      }
      const ratio = el.clientHeight / el.scrollHeight;
      const thumbH = Math.max(24, el.clientHeight * ratio);
      const maxTop = Math.max(0, el.clientHeight - thumbH);
      const top = extra > 0 ? (el.scrollTop / extra) * maxTop : 0;
      setThumb({ height: thumbH, top });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [children, footer, title, subtitle]);

  const bottom = featureSheetBottom(compact);
  const placed = !!(frame && frame.width > 0);
  const stop = (event) => event.stopPropagation();

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={title || 'Feature'}
      data-feature-card=""
      data-feature-card-compact={compact ? '1' : '0'}
      {...(fullLeft ? { 'data-feature-card-full-left': '1' } : null)}
      className={`feature-sheet-card pointer-events-auto absolute z-20 flex min-h-0 flex-col overflow-hidden
        rounded-xl border border-gray-500/50 text-white shadow-lg surface-glass-chip
        ${placed ? '' : 'left-1/2 w-[min(22rem,calc(100%-9.5rem))] -translate-x-1/2'}`}
      style={{
        bottom,
        '--feature-sheet-bottom': bottom,
        ...(placed ? { left: `${frame.left}px`, width: `${frame.width}px`, transform: 'none' } : null),
      }}
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={stop}
      {...cardAttrs}
    >
      <div className="flex shrink-0 items-start gap-2 px-3 pb-1 pt-2" data-feature-sheet-header="">
        <div className="min-w-0 flex-1">
          <div className="truncate font-sans text-sm font-semibold text-white" data-feature-card-title="">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-0.5 font-sans text-[11px] text-gray-300" data-feature-card-subtitle="">
              {subtitle}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          data-feature-card-cancel=""
          onClick={() => onCancel?.()}
          className="shrink-0 rounded-md p-1.5 text-gray-300 hover:bg-white/10 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-auto flex-col">
        <div
          ref={bodyRef}
          className="feature-sheet-scroll min-h-0 flex-auto overflow-y-auto px-3 pb-1"
          data-feature-sheet-body=""
          {...bodyAttrs}
        >
          {children}
        </div>
        {overflow && thumb ? (
          <div
            className="pointer-events-none absolute bottom-1 right-1 top-1 w-2 rounded-full bg-gray-500/25"
            data-feature-sheet-scrollbar=""
            aria-hidden="true"
          >
            <div
              className="absolute left-0 w-2 rounded-full bg-gray-500/45"
              style={{ height: `${thumb.height}px`, top: `${thumb.top}px` }}
            />
          </div>
        ) : null}
        {moreBelow ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-8 items-end justify-center bg-gradient-to-t from-gray-900/80 to-transparent"
            data-feature-sheet-scroll-hint=""
            aria-hidden="true"
          >
            <ChevronDown size={14} className="mb-0.5 text-gray-200" />
          </div>
        ) : null}
      </div>
      {(footer || note || onConfirm) ? (
        <div
          className={`shrink-0 px-3 pt-1 ${compact ? '' : 'pb-2'}`}
          style={compact
            ? { paddingBottom: 'max(8px, env(safe-area-inset-bottom, 0px))' }
            : undefined}
          data-feature-sheet-footer=""
        >
          {footer}
          {(note || onConfirm) ? (
            <div className={`flex items-center justify-between gap-2 ${footer ? 'mt-2' : ''}`}>
              <div className="min-w-0 text-[11px] leading-tight text-gray-300">{note}</div>
              {onConfirm ? (
                <button
                  type="button"
                  onClick={() => onConfirm()}
                  disabled={confirmDisabled}
                  data-feature-card-confirm=""
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-cyan-600 px-2 py-1
                    text-[13px] font-medium text-white hover:bg-cyan-500 active:bg-cyan-400
                    disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Check size={14} />
                  {confirmLabel}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
