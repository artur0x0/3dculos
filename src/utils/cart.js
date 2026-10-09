/**
 * Signed-in cart. A line points at a part; the script stays in the assembly.
 *
 * Caps match the shipped cart route: 100 lines, qty 1–999, thumbnail
 * data URLs of at most 24,000 characters. The plan text said 30 and 99;
 * a tighter client cap would tombstone lines the server still keeps.
 */
import { scriptForRow } from './assembly.js';

export const CART_MAX_LINES = 100;
export const CART_QTY_MIN = 1;
export const CART_QTY_MAX = 999;
export const CART_THUMB_MAX_CHARS = 24_000;
export const CART_MAX_TOMBSTONES = 200;
export const CART_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CART_CHIP_BREAKPOINT = 768;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function emptyCart() {
  return { version: 0, lines: [], tombstones: [] };
}

/** Cart owner key. `/api/auth/me` sends `_id`; `id` is the same virtual. */
export function cartUserId(user) {
  if (!user || typeof user !== 'object') return '';
  const id = user._id || user.id || '';
  return id ? String(id) : '';
}

export function newCartLineId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable script identity. 32 hex chars, no WebCrypto, same in node and the browser. */
export function scriptHash(script) {
  const text = String(script ?? '');
  let out = '';
  for (let round = 0; round < 4; round += 1) {
    let h = (0x811c9dc5 + round * 0x9e3779b9) >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export function clampQty(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return CART_QTY_MIN;
  return Math.min(CART_QTY_MAX, Math.max(CART_QTY_MIN, n));
}

/** Null when missing, not a data URL, or over the route cap. The line stays. */
export function capThumb(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  if (!url.startsWith('data:')) return null;
  if (url.length > CART_THUMB_MAX_CHARS) return null;
  return url;
}

export function toCartIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  const t = date.getTime();
  if (!Number.isFinite(t)) return new Date().toISOString();
  return new Date(t).toISOString();
}

function timeOf(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Signed-out tap opens login. A pending session writes nothing and waits.
 * `signedIn` is `useAuthState().signedIn` (grey reauth counts).
 */
export function orderIntent({ signedIn = false, pending = false } = {}) {
  if (signedIn) return 'add';
  if (pending) return 'wait';
  return 'login';
}

/**
 * Where the thumbnail flies.
 * Above 768px the CAD viewport chip is on screen. At the phone width the
 * parts ribbon chip is the one the user can see.
 */
export function cartChipSelector(viewportWidth) {
  const width = Number(viewportWidth);
  if (Number.isFinite(width) && width <= CART_CHIP_BREAKPOINT) {
    return '[data-parts-profile-chip] [data-profile-chip]';
  }
  return '[data-profile-chip-variant="viewport"]';
}

export function cartCount(cart) {
  return (cart?.lines || []).reduce((sum, line) => sum + clampQty(line?.qty || 0), 0);
}

function samePart(line, draft) {
  if (!line || !draft) return false;
  if (line.source !== draft.source) return false;
  if (String(line.assemblyName || '') !== String(draft.assemblyName || '')) return false;
  if (line.partId && line.partId === draft.partId) return true;
  return !!(line.surfId && draft.surfId && line.surfId === draft.surfId);
}

export function pruneCartTombstones(tombstones, now = new Date()) {
  const nowMs = timeOf(now);
  const cutoff = nowMs - CART_TOMBSTONE_TTL_MS;
  const fresh = [];
  for (const tomb of tombstones || []) {
    if (!tomb?.lineId) continue;
    const deletedAt = timeOf(tomb.deletedAt);
    if (!deletedAt || deletedAt < cutoff) continue;
    fresh.push({ lineId: String(tomb.lineId), deletedAt: new Date(deletedAt).toISOString() });
  }
  fresh.sort((a, b) => timeOf(a.deletedAt) - timeOf(b.deletedAt));
  const capped = fresh.length > CART_MAX_TOMBSTONES
    ? fresh.slice(fresh.length - CART_MAX_TOMBSTONES)
    : fresh;
  return capped;
}

function latestTombstone(tombstones, lineId) {
  let best = null;
  for (const tomb of tombstones || []) {
    if (!tomb || tomb.lineId !== lineId) continue;
    if (!best || timeOf(tomb.deletedAt) > timeOf(best.deletedAt)) best = tomb;
  }
  return best;
}

function tombstoneCovers(tomb, updatedAt) {
  if (!tomb) return false;
  return timeOf(tomb.deletedAt) >= timeOf(updatedAt);
}

/**
 * Order button. Same part (part id, or surf id after a git rename) bumps qty.
 * A new line past the cap is refused. Tombstones are not cleared by a later add
 * of a different line id.
 */
export function addPartLine(cart, draft, now = new Date()) {
  const state = normalizeCart(cart);
  const iso = toCartIso(now);
  const lines = state.lines.slice();
  const index = lines.findIndex((line) => samePart(line, draft));
  if (index >= 0) {
    const prev = lines[index];
    lines[index] = {
      ...prev,
      partId: draft.partId || prev.partId,
      partName: draft.partName || prev.partName,
      surfId: draft.surfId || prev.surfId || null,
      scriptHash: draft.scriptHash || prev.scriptHash,
      thumbDataUrl: capThumb(draft.thumbDataUrl) || prev.thumbDataUrl || null,
      qty: clampQty((Number(prev.qty) || 1) + (Number(draft.qty) || 1)),
      updatedAt: iso,
    };
    return { ok: true, cart: { ...state, lines }, lineId: prev.lineId, bumped: true };
  }
  if (lines.length >= CART_MAX_LINES) {
    return { ok: false, reason: 'full', cart: state };
  }
  const line = normalizeLine({
    ...draft,
    lineId: draft.lineId && UUID_RE.test(draft.lineId) ? draft.lineId : newCartLineId(),
    qty: draft.qty || 1,
    addedAt: draft.addedAt || iso,
    updatedAt: iso,
  }, iso);
  if (!line) return { ok: false, reason: 'invalid', cart: state };
  const tomb = latestTombstone(state.tombstones, line.lineId);
  if (tombstoneCovers(tomb, line.updatedAt)) {
    return { ok: false, reason: 'tombstoned', cart: state };
  }
  lines.push(line);
  return { ok: true, cart: { ...state, lines }, lineId: line.lineId, bumped: false };
}

export function setCartQty(cart, lineId, qty, now = new Date()) {
  const state = normalizeCart(cart);
  const iso = toCartIso(now);
  const lines = state.lines.map((line) => (
    line.lineId === lineId ? { ...line, qty: clampQty(qty), updatedAt: iso } : line
  ));
  return { ...state, lines };
}

export function removeCartLine(cart, lineId, now = new Date()) {
  const state = normalizeCart(cart);
  const iso = toCartIso(now);
  const lines = state.lines.filter((line) => line.lineId !== lineId);
  const tombstones = pruneCartTombstones([
    ...state.tombstones.filter((tomb) => tomb.lineId !== lineId),
    { lineId: String(lineId), deletedAt: iso },
  ], now);
  return { ...state, lines, tombstones };
}

/**
 * Fold a client op list. A remove is a tombstone. A tombstone drops a line
 * when deletedAt is at least that line's updatedAt. Leaving a line out of
 * the list is not a delete. Equal updatedAt keeps the earlier op.
 */
export function reduceCartOps(cart, ops, now = new Date()) {
  let state = normalizeCart(cart, now);
  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    const at = op.updatedAt || op.deletedAt || op.now || now;
    if (op.type === 'remove') {
      if (!op.lineId) continue;
      state = applyRemove(state, String(op.lineId), toCartIso(at), now);
    } else if (op.type === 'add' || op.type === 'update' || op.type === 'put') {
      if (!op.line?.lineId) continue;
      state = applyPut(state, op.line, toCartIso(op.line.updatedAt || at));
    } else if (op.type === 'setQty') {
      state = setCartQty(state, op.lineId, op.qty, at);
    }
  }
  return state;
}

function applyRemove(state, lineId, deletedAt, now) {
  const prev = latestTombstone(state.tombstones, lineId);
  const stamp = !prev || timeOf(deletedAt) >= timeOf(prev.deletedAt) ? deletedAt : prev.deletedAt;
  const line = state.lines.find((row) => row.lineId === lineId);
  const lines = line && tombstoneCovers({ deletedAt: stamp }, line.updatedAt)
    ? state.lines.filter((row) => row.lineId !== lineId)
    : state.lines.slice();
  const tombstones = pruneCartTombstones([
    ...state.tombstones.filter((tomb) => tomb.lineId !== lineId),
    { lineId, deletedAt: stamp },
  ], now);
  return { ...state, lines, tombstones };
}

function applyPut(state, raw, updatedAt) {
  const line = normalizeLine({ ...raw, updatedAt: raw.updatedAt || updatedAt }, updatedAt);
  if (!line) return state;
  const tomb = latestTombstone(state.tombstones, line.lineId);
  if (tombstoneCovers(tomb, line.updatedAt)) return state;
  const lines = state.lines.slice();
  const index = lines.findIndex((row) => row.lineId === line.lineId);
  if (index < 0) {
    if (lines.length >= CART_MAX_LINES) return state;
    lines.push(line);
    return { ...state, lines };
  }
  const prev = lines[index];
  if (timeOf(line.updatedAt) < timeOf(prev.updatedAt)) return state;
  if (timeOf(line.updatedAt) === timeOf(prev.updatedAt)) return state;
  lines[index] = line;
  return { ...state, lines };
}

function normalizeLine(raw, fallbackIso) {
  if (!raw || typeof raw !== 'object') return null;
  const lineId = String(raw.lineId || '');
  if (!UUID_RE.test(lineId)) return null;
  if (raw.source !== 'local' && raw.source !== 'git') return null;
  const assemblyName = String(raw.assemblyName || '').trim();
  const partId = String(raw.partId || '').trim();
  const partName = String(raw.partName || '').trim();
  const hash = String(raw.scriptHash || '').trim();
  if (!assemblyName || !partId || !partName || !hash) return null;
  return {
    lineId,
    source: raw.source,
    assemblyName,
    partId,
    surfId: raw.surfId ? String(raw.surfId) : null,
    partName,
    scriptHash: hash,
    thumbDataUrl: capThumb(raw.thumbDataUrl),
    qty: clampQty(raw.qty || 1),
    options: normalizeOptions(raw.options),
    addedAt: toCartIso(raw.addedAt || fallbackIso),
    updatedAt: toCartIso(raw.updatedAt || fallbackIso),
  };
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const infill = Number(options.infill);
  return {
    process: options.process == null ? null : String(options.process).slice(0, 32),
    material: options.material == null ? null : String(options.material).slice(0, 64),
    infill: Number.isFinite(infill) ? infill : null,
  };
}

export function normalizeCart(cart, now = new Date()) {
  const version = Number(cart?.version);
  const lines = [];
  for (const raw of cart?.lines || []) {
    const line = normalizeLine(raw, toCartIso(raw?.updatedAt || now));
    if (line) lines.push(line);
  }
  return {
    version: Number.isInteger(version) && version >= 0 ? version : 0,
    lines,
    tombstones: pruneCartTombstones(cart?.tombstones || [], now),
  };
}

export function makeCartDraft({ doc, part, script, thumbDataUrl, now = new Date(), qty = 1 }) {
  const iso = toCartIso(now);
  const source = doc?.source === 'git' ? 'git' : 'local';
  const assemblyName = String(doc?.name || '').trim() || 'Assembly';
  return {
    lineId: newCartLineId(),
    source,
    assemblyName,
    partId: String(part?.id || ''),
    surfId: part?.surfId ? String(part.surfId) : null,
    partName: String(part?.name || '').trim() || 'Part',
    scriptHash: scriptHash(script),
    thumbDataUrl: capThumb(thumbDataUrl),
    qty: clampQty(qty),
    options: null,
    addedAt: iso,
    updatedAt: iso,
  };
}

/**
 * Live lookup. `scriptForRow` is the script. A git rename keeps `surfId`
 * and changes the row id; that still resolves. A miss is flagged, not deleted.
 */
export function resolveCartLine(doc, scripts, line) {
  if (!line) {
    return { missing: true, reason: 'unknown-row', script: null, part: null, renamed: false };
  }
  const direct = scriptForRow(doc, scripts, line.partId);
  if (direct.ok) {
    return { missing: false, reason: null, script: direct.script, part: direct.part, renamed: false };
  }
  if (line.surfId) {
    const renamed = (doc?.parts || []).find((part) => part && part.surfId === line.surfId);
    if (renamed && renamed.id !== line.partId) {
      const via = scriptForRow(doc, scripts, renamed.id);
      if (via.ok) {
        return { missing: false, reason: null, script: via.script, part: via.part, renamed: true };
      }
      return {
        missing: true,
        reason: via.reason || 'missing',
        script: null,
        part: via.part || renamed,
        renamed: true,
      };
    }
  }
  return {
    missing: true,
    reason: direct.reason || 'missing',
    script: null,
    part: direct.part || null,
    renamed: false,
  };
}

/** Rows for the sheet. No open document yet: keep the stored name, don't invent a miss. */
export function presentCartLines(doc, scripts, cart) {
  const openName = String(doc?.name || '').trim();
  return normalizeCart(cart).lines.map((line) => {
    if (!doc) {
      return {
        ...line,
        missing: false,
        elsewhere: false,
        liveName: line.partName,
        hashStale: false,
      };
    }
    const resolved = resolveCartLine(doc, scripts, line);
    const elsewhere = !!(
      resolved.missing
      && openName
      && line.assemblyName
      && openName !== line.assemblyName
    );
    return {
      ...line,
      missing: resolved.missing && !elsewhere,
      elsewhere,
      liveName: resolved.part?.name || line.partName,
      hashStale: !!(resolved.script && scriptHash(resolved.script) !== line.scriptHash),
    };
  });
}

/** Fill a null thumbnail from the open feed. Over-cap stays null. */
export function refillThumbs(cart, thumbsByPartId, now = new Date()) {
  const state = normalizeCart(cart);
  const iso = toCartIso(now);
  let changed = false;
  const lines = state.lines.map((line) => {
    if (line.thumbDataUrl) return line;
    const url = capThumb(thumbsByPartId?.[line.partId]);
    if (!url) return line;
    changed = true;
    return { ...line, thumbDataUrl: url, updatedAt: iso };
  });
  return changed ? { ...state, lines } : state;
}

/**
 * Scripts the order button hashes. The active part uses the live editor
 * buffer when it is non-empty, so an unsaved edit is what gets ordered.
 */
export function scriptsForOrder(scripts, live) {
  const next = { ...(scripts || {}) };
  if (live && live.id && typeof live.script === 'string' && live.script.length) {
    next[live.id] = live.script;
  }
  return next;
}

function runErrorFor(runs, ids) {
  for (const id of ids) {
    if (!id) continue;
    const run = runs?.[id];
    if (!run || run.ok !== false || run.empty || run.skipped) continue;
    const text = typeof run.error === 'string' ? run.error.trim() : '';
    if (text && text !== 'failed') return text;
  }
  return '';
}

/**
 * Lines checkout can price. Part missing and "not in this assembly" stay
 * in the cart. A changed script is included: the cart holds no script, so
 * the quote is the part as it is now. `importMesh` bytes are resolved later
 * from the asset cache, keyed by the live part id.
 */
export function checkoutQueue(doc, scripts, cart, runs = null) {
  const view = presentCartLines(doc, scripts, cart);
  const lines = [];
  const skipped = [];
  if (!doc) {
    for (const line of view) {
      skipped.push({
        lineId: line.lineId,
        reason: 'closed',
        assemblyName: line.assemblyName,
        partName: line.liveName || line.partName,
      });
    }
    return { lines, skipped };
  }
  for (const line of view) {
    const partName = line.liveName || line.partName;
    if (line.missing) {
      skipped.push({ lineId: line.lineId, reason: 'missing', assemblyName: line.assemblyName, partName });
      continue;
    }
    if (line.elsewhere) {
      skipped.push({ lineId: line.lineId, reason: 'elsewhere', assemblyName: line.assemblyName, partName });
      continue;
    }
    const resolved = resolveCartLine(doc, scripts, line);
    if (!resolved.script) {
      skipped.push({ lineId: line.lineId, reason: 'missing', assemblyName: line.assemblyName, partName });
      continue;
    }
    const partId = resolved.part?.id || line.partId;
    lines.push({
      lineId: line.lineId,
      partId,
      partName: resolved.part?.name || partName,
      assemblyName: line.assemblyName,
      qty: clampQty(line.qty),
      options: line.options,
      script: resolved.script,
      hashStale: !!line.hashStale,
      lineError: runErrorFor(runs, [partId, line.partId]),
    });
  }
  return { lines, skipped };
}

/** Short note under Checkout. Empty when every line can be ordered. */
export function checkoutSkipNote(queue) {
  const skipped = queue?.skipped || [];
  const eligible = queue?.lines?.length || 0;
  if (!skipped.length) return '';
  const reasons = new Set(skipped.map((row) => row.reason));
  if (eligible === 0) {
    if (reasons.has('closed')) return 'Open an assembly to check out.';
    if (reasons.has('elsewhere') && !reasons.has('missing')) {
      const name = skipped.find((row) => row.reason === 'elsewhere')?.assemblyName;
      return name
        ? `Open ${name} to check out these parts.`
        : 'Open that assembly to check out these parts.';
    }
    if (reasons.has('missing') && !reasons.has('elsewhere')) {
      return 'Missing parts stay in the cart.';
    }
    return 'Nothing in this assembly can be checked out yet.';
  }
  const notes = [];
  if (reasons.has('missing')) notes.push('Missing parts are skipped.');
  if (reasons.has('elsewhere')) notes.push('Parts in another assembly stay in the cart.');
  return notes.join(' ');
}
