/**
 * Paint mode writes assembly face colors. It does not pick and it does not
 * draw. A click still goes through `resolveViewportFaceClick` (one click, the
 * face-graph patch). Confirm stores `faceColorKey` on `colors[surfId]`.
 * Cancel stores nothing. Undo drops a pick and leaves saved colors alone.
 */

import { isSurfId } from './git/surfId.js';
import {
  faceColorKey,
  faceFingerprints,
  matchFaceKeys,
} from './faceColorMatch.js';
import { resolveViewportFaceClick, warmFaceGraph } from './selectFace.js';

/** Eight fixed swatches. A ninth color is the custom hex field. */
export const PAINT_SWATCHES = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#a855f7',
  '#f4f4f5',
];

/** Lowercase `#rrggbb`, or null. */
export function parsePaintHex(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/**
 * The color Confirm will write. A non-empty custom field wins when it is a
 * valid hex and blocks Confirm when it is not. An empty field uses the swatch.
 */
export function resolvedPaintColor(swatch, custom) {
  const typed = typeof custom === 'string' ? custom.trim() : '';
  if (typed) return parsePaintHex(typed);
  return parsePaintHex(swatch);
}

/** The palette chip is a CAD control. Game mode does not paint. */
export function paintChipVisible(mode) {
  return mode !== 'game';
}

export function fingerprintsFromGeometry(geometry, faceIDs) {
  const positions = geometry?.attributes?.position?.array;
  const indices = geometry?.index?.array;
  if (!positions || !indices?.length) return [];
  const graph = warmFaceGraph(geometry, faceIDs);
  if (!graph) return [];
  return faceFingerprints(graph, geometry.userData?.triSource || null, { positions, indices });
}

/**
 * The face-graph patch that owns these triangles, as a save key.
 * Same resolver as a normal one-click face pick: a blend stays a blend, and
 * a coplanar seam stays one face.
 */
export function paintPickFromClick({
  geometry,
  faceIDs = null,
  seedFaceIndex,
  faceNormal = null,
  angleTolerance = 3,
}) {
  const resolved = resolveViewportFaceClick({
    geometry,
    seedFaceIndex,
    faceNormal,
    clickCount: 1,
    faceIDs,
    angleTolerance,
    legacy: false,
  });
  const indices = resolved?.indices || [];
  if (!indices.length) return null;
  const faces = fingerprintsFromGeometry(geometry, faceIDs);
  const want = new Set(indices);
  let best = null;
  let bestN = 0;
  for (const face of faces) {
    let n = 0;
    const tris = face.tris || [];
    for (let i = 0; i < tris.length; i++) if (want.has(tris[i])) n++;
    if (n > bestN) {
      best = face;
      bestN = n;
    }
  }
  const key = best ? faceColorKey(best) : null;
  if (!key) return null;
  return { indices: indices.slice(), key };
}

function samePaintFace(a, b) {
  const as = a?.indices || [];
  const bs = b?.indices || [];
  if (as.length && bs.length) {
    const set = new Set(as);
    let n = 0;
    for (const t of bs) if (set.has(t)) n++;
    if (n > 0 && n * 2 >= as.length && n * 2 >= bs.length) return true;
  }
  if (a?.key && b?.key) {
    const face = {
      id: 0,
      tris: [],
      at: b.key.at,
      n: b.key.n,
      area: b.key.area,
    };
    if (Number.isInteger(b.key.src)) {
      face.src = b.key.src;
      face.ord = b.key.ord;
    }
    if (matchFaceKeys([face], [{ key: a.key }]).matched.length === 1) return true;
  }
  return false;
}

/** Tap adds the face. Tap that face again removes it. */
export function togglePaintPick(picks, pick) {
  const list = Array.isArray(picks) ? picks.slice() : [];
  if (!pick?.key) return list;
  const idx = list.findIndex((row) => samePaintFace(row, pick));
  if (idx >= 0) {
    list.splice(idx, 1);
    return list;
  }
  list.push({
    indices: Array.isArray(pick.indices) ? pick.indices.slice() : [],
    key: pick.key,
  });
  return list;
}

/** Drop the last pick. Does not touch saved colors. */
export function undoPaintPick(picks) {
  const list = Array.isArray(picks) ? picks.slice() : [];
  if (list.length) list.pop();
  return list;
}

/**
 * Switching parts drops in-progress picks. The same part keeps them.
 * The first part (no previous id) keeps whatever was picked. Leaving the
 * active part with no next id drops them.
 */
export function paintPicksAfterPartChange(prevId, nextId, picks) {
  const list = Array.isArray(picks) ? picks : [];
  if (prevId == null) return list;
  if (nextId == null || String(prevId) !== String(nextId)) return [];
  return list;
}

/** A new mesh invalidates triangle indices, so the picks start over. */
export function paintPicksAfterMeshChange(sameMesh, picks) {
  if (sameMesh) return Array.isArray(picks) ? picks : [];
  return [];
}

function cloneColorMap(colors) {
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(colors)) {
    if (!entry || typeof entry !== 'object') continue;
    const next = {};
    if (entry.part !== undefined) next.part = entry.part;
    if (Array.isArray(entry.faces)) {
      next.faces = entry.faces.map((face) => ({
        color: face.color,
        key: { ...face.key },
      }));
    }
    out[id] = next;
  }
  return out;
}

function paintedFaceIds(faces, keys) {
  const ids = new Set();
  if (!faces?.length) return ids;
  for (const key of keys) {
    if (!key) continue;
    const hit = matchFaceKeys(faces, [{ key }]);
    if (hit.matched.length === 1) ids.add(hit.matched[0].face.id);
  }
  return ids;
}

/**
 * Drop saved face entries that uniquely match a face we are painting.
 * Ambiguous and missing keys stay. They are not pruned here.
 */
function replaceMatchedFaces(existing, faces, keys) {
  const list = Array.isArray(existing) ? existing : [];
  const painted = paintedFaceIds(faces, keys);
  if (!painted.size) return list.map((face) => ({ color: face.color, key: { ...face.key } }));
  const kept = [];
  for (const face of list) {
    const hit = matchFaceKeys(faces, [face]);
    if (hit.matched.length === 1 && painted.has(hit.matched[0].face.id)) continue;
    kept.push({ color: face.color, key: { ...face.key } });
  }
  return kept;
}

function dedupedEntries(keys, color, faces) {
  const rows = [];
  const seen = new Set();
  const list = Array.isArray(keys) ? keys : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const key = list[i];
    if (!key?.at || !key?.n || !(key.area > 0)) continue;
    const hit = faces?.length ? matchFaceKeys(faces, [{ key }]) : { matched: [] };
    const token = hit.matched.length === 1
      ? `face:${hit.matched[0].face.id}`
      : JSON.stringify(key);
    if (seen.has(token)) continue;
    seen.add(token);
    const clean = {
      at: [key.at[0], key.at[1], key.at[2]],
      n: [key.n[0], key.n[1], key.n[2]],
      area: key.area,
    };
    if (Number.isInteger(key.src) && key.src < 0 && Number.isInteger(key.ord) && key.ord >= 0) {
      clean.src = key.src;
      clean.ord = key.ord;
    }
    rows.push({ color, key: clean });
  }
  rows.reverse();
  return rows;
}

function writeEntry(map, surfId, entry) {
  if (!entry.part && !(entry.faces && entry.faces.length)) {
    delete map[surfId];
  } else {
    const next = {};
    if (entry.part) next.part = entry.part;
    if (entry.faces?.length) next.faces = entry.faces;
    map[surfId] = next;
  }
  return Object.keys(map).length ? map : null;
}

/**
 * Confirm. `part` sets `colors[surfId].part` and leaves face keys alone.
 * Otherwise each key is written into `faces[]`, replacing a saved key that
 * uniquely matches that same face.
 * Returns the input when the color or surf id cannot be stored.
 */
export function commitPaintColors(colors, surfId, { color, part = false, keys = [], faces = null } = {}) {
  const hex = parsePaintHex(color);
  if (!hex || !isSurfId(surfId)) return colors ?? null;
  const map = cloneColorMap(colors);
  const prev = map[surfId] ? { ...map[surfId] } : {};
  if (part) {
    prev.part = hex;
    return writeEntry(map, surfId, prev);
  }
  const incoming = dedupedEntries(keys, hex, faces);
  if (!incoming.length) return colors ?? null;
  prev.faces = [
    ...replaceMatchedFaces(prev.faces, faces, incoming.map((row) => row.key)),
    ...incoming,
  ];
  return writeEntry(map, surfId, prev);
}

/**
 * Clear. Part mode removes `colors[surfId].part`. Face mode removes saved
 * keys that uniquely match the picked faces. Ambiguous and missing keys stay.
 */
export function clearPaintColors(colors, surfId, { part = false, keys = [], faces = null } = {}) {
  if (!isSurfId(surfId)) return colors ?? null;
  const map = cloneColorMap(colors);
  const prev = map[surfId];
  if (!prev) return colors ?? null;
  if (part) {
    delete prev.part;
    return writeEntry(map, surfId, prev);
  }
  const drop = paintedFaceIds(faces, keys);
  if (!drop.size) return colors ?? null;
  prev.faces = (prev.faces || []).filter((face) => {
    const hit = matchFaceKeys(faces, [face]);
    return !(hit.matched.length === 1 && drop.has(hit.matched[0].face.id));
  });
  return writeEntry(map, surfId, prev);
}

/**
 * Explicit cleanup for the current part: drop face keys that are missing or
 * ambiguous against the faces just shown. Matched keys and the part color stay.
 * Not called from paint or from render.
 */
export function removeUnmatchedColors(colors, surfId, faces) {
  if (!isSurfId(surfId) || !faces?.length) return colors ?? null;
  const map = cloneColorMap(colors);
  const prev = map[surfId];
  if (!prev?.faces?.length) return colors ?? null;
  const kept = [];
  let dropped = false;
  for (const face of prev.faces) {
    const hit = matchFaceKeys(faces, [face]);
    if (hit.matched.length === 1) kept.push(face);
    else dropped = true;
  }
  if (!dropped) return colors ?? null;
  prev.faces = kept;
  return writeEntry(map, surfId, prev);
}

/** How many face keys on this part the matcher will not draw. */
export function unmatchedColorCount(colors, surfId, faces) {
  if (!surfId || !faces?.length) return 0;
  const items = colors?.[surfId]?.faces;
  if (!items?.length) return 0;
  const hit = matchFaceKeys(faces, items);
  return hit.ambiguous.length + hit.missing.length;
}
