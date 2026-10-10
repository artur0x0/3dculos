/**
 * Touch focused-field edit for the shared feature card.
 * Label and unit come off the field itself so each card gets the same view.
 * The lift parks that view on the visual-viewport bottom (keyboard and the
 * Safari toolbar sit outside that rect). A stubbed visualViewport that does
 * not shift getBoundingClientRect is treated as layout coordinates.
 */

const TEXT_TYPES = new Set(['text', 'number', 'search', 'tel', 'url', 'email', 'password']);
const TRAILING_UNIT = /^(.*\S)\s+(N|kN|MPa|GPa|Pa|mm|cm|in|°|deg)$/;

export function isTouchEditDevice(win) {
  const target = win || (typeof window !== 'undefined' ? window : null);
  if (!target) return false;
  const points = Number(target.navigator?.maxTouchPoints) || 0;
  let coarse = false;
  try {
    coarse = target.matchMedia?.('(pointer: coarse)')?.matches === true;
  } catch {
    coarse = false;
  }
  return coarse || points > 0;
}

/** Number and text inputs only. A select or a range slider does not qualify. */
export function isTextOrNumberField(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.disabled) return false;
  if (typeof el.closest === 'function' && el.closest('[data-feature-field-edit-view]')) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = String(el.getAttribute?.('type') || 'text').toLowerCase();
  return TEXT_TYPES.has(type);
}

function escapeId(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}

function controlLabelText(label, control) {
  if (!label || !label.childNodes) return '';
  const parts = [];
  for (const node of label.childNodes) {
    if (node === control) continue;
    if (node.nodeType === 1 && typeof node.contains === 'function' && node.contains(control)) continue;
    const text = node.textContent || '';
    if (text.trim()) parts.push(text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** data-field-label, an associated label, then aria-label. Empty when none. */
export function readFieldLabel(el) {
  if (!el || typeof el.getAttribute !== 'function') return '';
  const explicit = String(el.getAttribute('data-field-label') || '').trim();
  if (explicit) return explicit;
  const id = el.id || el.getAttribute('id') || '';
  const doc = el.ownerDocument;
  if (id && doc && typeof doc.querySelector === 'function') {
    let found = null;
    try {
      found = doc.querySelector(`label[for="${escapeId(id)}"]`);
    } catch {
      found = null;
    }
    const viaFor = controlLabelText(found, el);
    if (viaFor) return viaFor;
  }
  if (typeof el.closest === 'function') {
    const wrapped = controlLabelText(el.closest('label'), el);
    if (wrapped) return wrapped;
  }
  const aria = String(el.getAttribute('aria-label') || '').trim();
  if (aria) return aria.replace(/\s+value$/i, '').trim();
  return '';
}

/** data-unit, or a short unit span that follows the input. */
export function readFieldUnit(el) {
  if (!el || typeof el.getAttribute !== 'function') return '';
  const explicit = String(el.getAttribute('data-unit') || '').trim();
  if (explicit) return explicit;
  const next = el.nextElementSibling;
  if (next && String(next.tagName).toUpperCase() === 'SPAN') {
    const text = String(next.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length <= 12) return text;
  }
  return '';
}

/**
 * CSS bottom (px) that puts the card's bottom edge on the visual viewport.
 * `paneBottom` and `docTop` are getBoundingClientRect values.
 */
export function featureSheetEditLift({
  paneBottom,
  docTop = 0,
  scrollY = 0,
  vvHeight,
  vvOffsetTop = 0,
} = {}) {
  const height = Number(vvHeight);
  const bottom = Number(paneBottom);
  if (!(height > 0) || !Number.isFinite(bottom)) return 0;
  const offsetTop = Number(vvOffsetTop);
  const safeOffset = Number.isFinite(offsetTop) ? offsetTop : 0;
  const shifted = Number(docTop) < -0.5 || (Number(scrollY) || 0) > 0;
  const visibleBottom = shifted || safeOffset === 0 ? height : safeOffset + height;
  const lift = bottom - visibleBottom;
  if (!Number.isFinite(lift) || lift <= 0) return 0;
  return Math.round(lift);
}

/** Split a trailing unit token. An explicit unit wins. The caption can stay whole. */
export function numberFieldLabelParts(label, unit) {
  const text = label == null ? '' : String(label).trim();
  const given = unit == null ? '' : String(unit).trim();
  if (given) return { label: text, unit: given };
  const match = text.match(TRAILING_UNIT);
  if (match) return { label: match[1], unit: match[2] };
  return { label: text, unit: '' };
}

/** Write through the native setter so a controlled React input sees the change. */
export function commitFieldValue(el, value) {
  if (!el) return;
  const next = value == null ? '' : String(value);
  const tag = String(el.tagName || '').toUpperCase();
  const proto = tag === 'TEXTAREA'
    ? globalThis.HTMLTextAreaElement?.prototype
    : globalThis.HTMLInputElement?.prototype;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (desc?.set) desc.set.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
