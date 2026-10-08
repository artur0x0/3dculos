/**
 * Load-time migration off the legacy `local:` row-id prefix.
 *
 * PRs that made surf ids permanent left IndexedDB row ids as `local:<body>`
 * (uuid, or `Date.now()-<base36>` when `crypto.randomUUID` is missing).
 * Sync is `isSynced` only. This strips that prefix and rewrites the
 * references that stored it: part ids, active id, script keys, color keys,
 * undo/history keys, and selection. A repo path and a surf id do not start
 * with `local:` and are left alone. A bare id that is already taken is left
 * prefixed so two parts are not merged. A second pass is a no-op.
 */
import { isVaultPartPath } from './vaultLayout.js';

export const LOCAL_ROW_PREFIX = 'local:';

/** Drop every leading `local:` prefix. Any other string is returned as-is. */
export function stripLocalRowPrefix(id) {
  const original = String(id ?? '');
  if (!original.startsWith(LOCAL_ROW_PREFIX)) return original;
  let text = original;
  while (text.startsWith(LOCAL_ROW_PREFIX)) text = text.slice(LOCAL_ROW_PREFIX.length);
  return text || original;
}

function claim(from, occupied, map) {
  const key = String(from ?? '');
  if (!key.startsWith(LOCAL_ROW_PREFIX) || map.has(key) || isVaultPartPath(key)) return;
  const to = stripLocalRowPrefix(key);
  if (!to || to === key || occupied.has(to)) return;
  occupied.delete(key);
  occupied.add(to);
  map.set(key, to);
}

function remapKeys(obj, map) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(obj)) {
    const nextKey = map.has(key) ? map.get(key) : key;
    if (nextKey !== key) changed = true;
    if (Object.prototype.hasOwnProperty.call(next, nextKey) && nextKey !== key) {
      changed = true;
      continue;
    }
    next[nextKey] = value;
  }
  return changed ? next : obj;
}

/**
 * Color keys move with the id map. A leftover `local:` key is stripped
 * when the bare key is free. A bare key already present wins.
 */
export function remapLocalColorKeys(colors, map = new Map()) {
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return colors;
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(colors)) {
    let nextKey = map.has(key) ? map.get(key) : key;
    if (nextKey === key && key.startsWith(LOCAL_ROW_PREFIX)) {
      const stripped = stripLocalRowPrefix(key);
      if (stripped && stripped !== key && !Object.prototype.hasOwnProperty.call(colors, stripped)
        && !Object.prototype.hasOwnProperty.call(next, stripped)) {
        nextKey = stripped;
      }
    }
    if (nextKey !== key) changed = true;
    if (!Object.prototype.hasOwnProperty.call(next, nextKey)) next[nextKey] = value;
    else if (nextKey !== key) changed = true;
  }
  return changed ? next : colors;
}

function remapSelection(value, map) {
  if (typeof value === 'string') return map.has(value) ? map.get(value) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = remapSelection(item, map);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== 'object') return value;
  let changed = false;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    const nextKey = map.has(key) ? map.get(key) : key;
    let nextItem = item;
    if (typeof item === 'string' && (key === 'partId' || key === 'activeId' || key === 'cadPartId' || key === 'id')) {
      nextItem = map.has(item) ? map.get(item) : item;
    } else if (item && typeof item === 'object') {
      nextItem = remapSelection(item, map);
    }
    if (nextKey !== key || nextItem !== item) changed = true;
    if (Object.prototype.hasOwnProperty.call(next, nextKey) && nextKey !== key) {
      changed = true;
      continue;
    }
    next[nextKey] = nextItem;
  }
  return changed ? next : value;
}

function remapHistories(histories, map) {
  if (!histories || typeof histories !== 'object' || Array.isArray(histories)) return histories;
  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(histories)) {
    const nextKey = key === '__game__' ? key : (map.has(key) ? map.get(key) : key);
    const nextValue = value && typeof value === 'object' ? remapSelection(value, map) : value;
    if (nextKey !== key || nextValue !== value) changed = true;
    if (Object.prototype.hasOwnProperty.call(next, nextKey) && nextKey !== key) {
      changed = true;
      continue;
    }
    next[nextKey] = nextValue;
  }
  return changed ? next : histories;
}

function rewriteSurfObject(raw, map) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  let changed = false;
  const stripField = (value) => {
    if (typeof value !== 'string' || !value.startsWith(LOCAL_ROW_PREFIX)) return value;
    if (map.has(value)) return map.get(value);
    const stripped = stripLocalRowPrefix(value);
    return stripped || value;
  };
  const next = { ...raw };
  if (typeof next.activeId === 'string') {
    const activeId = stripField(next.activeId);
    if (activeId !== next.activeId) {
      next.activeId = activeId;
      changed = true;
    }
  }
  if (Array.isArray(next.parts)) {
    next.parts = next.parts.map((part) => {
      if (!part || typeof part !== 'object') return part;
      let partChanged = false;
      const row = { ...part };
      if (typeof row.path === 'string') {
        const path = stripField(row.path);
        if (path !== row.path) {
          row.path = path;
          partChanged = true;
        }
      }
      if (typeof row.id === 'string' && row.id.startsWith(LOCAL_ROW_PREFIX)) {
        const id = stripField(row.id);
        if (id !== row.id) {
          row.id = id;
          partChanged = true;
        }
      }
      if (partChanged) changed = true;
      return partChanged ? row : part;
    });
  }
  if (next.colors && typeof next.colors === 'object' && !Array.isArray(next.colors)) {
    const colors = remapLocalColorKeys(next.colors, map);
    if (colors !== next.colors) {
      next.colors = colors;
      changed = true;
    }
  }
  return changed ? next : raw;
}

/**
 * Rewrite `local:` prefixes in a `.surf.json` text. Surf ids (`local-` or
 * bare) stay. The same string comes back when nothing changes.
 */
export function rewriteSurfJsonLocalIds(text, map = new Map()) {
  if (typeof text !== 'string') return text;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return text;
  }
  const next = rewriteSurfObject(raw, map);
  if (next === raw) return text;
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * -> { doc, scripts, histories, selection, colors, draftPartId, surfJson,
 *      pairs, changed }
 * Same objects come back when nothing changes.
 */
export function migrateLocalPartIds({
  doc,
  scripts,
  histories,
  selection,
  colors,
  draftPartId,
  surfJson,
} = {}) {
  const parts = Array.isArray(doc?.parts) ? doc.parts : [];
  const occupied = new Set(parts.map((part) => String(part?.id || '')).filter(Boolean));
  const map = new Map();
  for (const part of parts) claim(part?.id, occupied, map);
  for (const key of Object.keys(scripts || {})) claim(key, occupied, map);
  for (const key of Object.keys(histories || {})) {
    if (key !== '__game__') claim(key, occupied, map);
  }
  const colorSource = colors !== undefined ? colors : doc?.colors;
  for (const key of Object.keys(colorSource || {})) claim(key, occupied, map);
  if (doc?.activeId != null) claim(doc.activeId, occupied, map);
  if (draftPartId != null) claim(draftPartId, occupied, map);
  if (typeof selection === 'string') claim(selection, occupied, map);

  const nextParts = parts.map((part) => {
    const from = String(part?.id || '');
    if (!map.has(from)) return part;
    return { ...part, id: map.get(from) };
  });
  const partsChanged = nextParts.some((part, index) => part !== parts[index]);
  const nextActive = doc?.activeId != null && map.has(String(doc.activeId))
    ? map.get(String(doc.activeId))
    : doc?.activeId;
  const nextScripts = remapKeys(scripts, map);
  const nextHistories = remapHistories(histories, map);
  const nextColors = remapLocalColorKeys(colorSource, map);
  const nextSelection = remapSelection(selection, map);
  const nextDraft = draftPartId != null && map.has(String(draftPartId))
    ? map.get(String(draftPartId))
    : draftPartId;
  const nextSurf = typeof surfJson === 'string' ? rewriteSurfJsonLocalIds(surfJson, map) : surfJson;

  let nextDoc = doc;
  if (doc && (partsChanged || nextActive !== doc.activeId || (colors === undefined && nextColors !== doc.colors))) {
    nextDoc = { ...doc, parts: nextParts, activeId: nextActive };
    if (colors === undefined && nextColors !== doc.colors) nextDoc.colors = nextColors;
  }

  const changed = nextDoc !== doc
    || nextScripts !== scripts
    || nextHistories !== histories
    || nextColors !== colorSource
    || nextSelection !== selection
    || nextDraft !== draftPartId
    || nextSurf !== surfJson;

  return {
    doc: nextDoc,
    scripts: nextScripts === undefined ? scripts : nextScripts,
    histories: nextHistories === undefined ? histories : nextHistories,
    selection: nextSelection,
    colors: nextColors,
    draftPartId: nextDraft,
    surfJson: nextSurf,
    pairs: [...map].map(([from, to]) => ({ from, to })),
    changed,
  };
}
