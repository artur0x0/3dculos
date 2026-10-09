/**
 * Size an open order-flow sheet to the visible viewport.
 * `visualViewport` tracks the iOS Safari toolbar and the keyboard;
 * the CSS falls back to `100dvh` when this has not run yet.
 * Background scroll stays locked until the last sheet closes.
 */
import { useEffect } from 'react';

let depth = 0;
let stop = null;

function readViewport() {
  const vv = window.visualViewport;
  const height = vv && vv.height > 0 ? vv.height : window.innerHeight;
  const top = vv && Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
  return { height, top };
}

function scrollFieldIntoView(el) {
  const scroller = el.closest('.overflow-y-auto');
  if (!scroller) return;
  const field = el.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  // A sticky footer that overlaps the scroller (feature card) eats that strip.
  const card = el.closest('[data-feature-card]');
  const footer = card?.querySelector('[data-feature-sheet-footer]');
  const footerTop = footer ? footer.getBoundingClientRect().top : box.bottom;
  const overlap = Math.max(0, box.bottom - footerTop);
  const bottomLimit = box.bottom - overlap - 8;
  if (field.bottom > bottomLimit) {
    scroller.scrollTop += field.bottom - bottomLimit + 12;
  } else if (field.top < box.top + 8) {
    scroller.scrollTop -= box.top - field.top + 12;
  }
}

function sheetField(el) {
  if (!el || !el.closest) return null;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return null;
  if (el.closest('.modal-fit') || el.closest('[data-feature-card]')) return el;
  return null;
}

function focusedField() {
  return sheetField(document.activeElement);
}

function start() {
  const root = document.documentElement;
  const body = document.body;
  const prevHtml = root.style.overflow;
  const prevBody = body.style.overflow;
  root.style.overflow = 'hidden';
  body.style.overflow = 'hidden';

  const apply = () => {
    const { height, top } = readViewport();
    root.style.setProperty('--modal-vvh', `${height}px`);
    root.style.setProperty('--modal-vv-top', `${top}px`);
  };
  const onResize = () => {
    apply();
    const el = focusedField();
    if (el) scrollFieldIntoView(el);
  };
  apply();

  const vv = window.visualViewport;
  vv?.addEventListener('resize', onResize);
  vv?.addEventListener('scroll', apply);
  window.addEventListener('resize', onResize);
  const onFocus = (event) => {
    const el = sheetField(event.target);
    if (!el) return;
    requestAnimationFrame(() => scrollFieldIntoView(el));
  };
  document.addEventListener('focusin', onFocus);

  return () => {
    vv?.removeEventListener('resize', onResize);
    vv?.removeEventListener('scroll', apply);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('focusin', onFocus);
    root.style.removeProperty('--modal-vvh');
    root.style.removeProperty('--modal-vv-top');
    root.style.overflow = prevHtml;
    body.style.overflow = prevBody;
  };
}

export function useModalViewport() {
  useEffect(() => {
    if (depth === 0) stop = start();
    depth += 1;
    return () => {
      depth -= 1;
      if (depth === 0 && stop) {
        stop();
        stop = null;
      }
    };
  }, []);
}
