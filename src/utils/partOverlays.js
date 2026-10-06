/**
 * Sketch contours and construction (work) planes belong to the part whose
 * script declares them.
 *
 * Both are listed from a script and their points are in that part's local
 * frame. They used to be listed from the editor script only and anchored
 * on the active pick part, so a pick on B (script still pinned on A) drew
 * A's planes on B, and saved contours were not anchored at all (they sat at
 * the origin). Now every visible part with a script paints its own
 * overlays, each under a group that follows that part's translation.
 */
import { activePartTranslation } from './activePartOverlay.js';

/**
 * One overlay source per visible part with a script, in part order.
 * The editor part reads the live editor buffer; every other part its saved
 * script. With no assembly context there is one source: the editor.
 *
 * @param {{
 *   parts?: Record<string, { script?: string|null, visible?: boolean, position?: number[]|null }>,
 *   editorId?: string|null,
 *   editorScript?: string,
 * }} args
 * @returns {{ partId: string|null, script: string, editor: boolean, position: number[] }[]}
 */
export function partOverlaySources({ parts = null, editorId = null, editorScript = '' } = {}) {
  const editor = editorId == null || editorId === '' ? null : String(editorId);
  const rows = parts && typeof parts === 'object' ? Object.entries(parts) : [];
  if (!rows.length) {
    return [{ partId: editor, script: String(editorScript || ''), editor: true, position: [0, 0, 0] }];
  }
  const out = [];
  for (const [id, row] of rows) {
    if (!row || row.visible === false) continue;
    const isEditor = editor != null && String(id) === editor;
    const script = isEditor ? String(editorScript || row.script || '') : row.script;
    if (typeof script !== 'string' || !script.trim()) continue;
    out.push({
      partId: String(id),
      script,
      editor: isEditor,
      position: activePartTranslation(row.position),
    });
  }
  return out;
}

/**
 * Where a part's overlay group sits: the live translation of that part's
 * solid in the scene (the pick mesh when it is the active part, else its
 * assembly mesh), else the row position.
 *
 * @param {string|null} partId
 * @param {{ activeId?: string|null, activePosition?: number[]|null, solidPosition?: (id: string) => number[]|null, rowPosition?: number[]|null }} ctx
 * @returns {number[]}
 */
export function partOverlayAnchor(partId, {
  activeId = null,
  activePosition = null,
  solidPosition = null,
  rowPosition = null,
} = {}) {
  const id = partId == null || partId === '' ? null : String(partId);
  const active = activeId == null || activeId === '' ? null : String(activeId);
  if (id == null || id === active) return activePartTranslation(activePosition || rowPosition);
  const live = typeof solidPosition === 'function' ? solidPosition(id) : null;
  return activePartTranslation(live || rowPosition);
}

/** A world ray point moved into a part's local frame. */
export function toPartLocal(point, position) {
  if (!point) return point;
  const [x, y, z] = activePartTranslation(position);
  return [point[0] - x, point[1] - y, point[2] - z];
}

/** The overlay group a plane / contour hit belongs to (walks up to the part group). */
export function overlayHitPartId(object) {
  let o = object;
  while (o) {
    if (o.userData && Object.prototype.hasOwnProperty.call(o.userData, 'overlayPartId')) {
      return o.userData.overlayPartId;
    }
    o = o.parent;
  }
  return undefined;
}
