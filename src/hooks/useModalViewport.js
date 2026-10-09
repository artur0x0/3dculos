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
  if (field.bottom > box.bottom - 8) {
    scroller.scrollTop += field.bottom - box.bottom + 12;
  } else if (field.top < box.top + 8) {
    scroller.scrollTop -= box.top - field.top + 12;
  }
}

function focusedField() {
  const el = document.activeElement;
  if (!el || !el.closest || !el.closest('.modal-fit')) return null;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return null;
  return el;
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
    const el = event.target;
    if (!el || !el.closest || !el.closest('.modal-fit')) return;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
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
