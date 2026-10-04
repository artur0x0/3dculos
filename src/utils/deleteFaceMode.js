/**
 * Delete Face — remove picked faces and heal by extending or trimming neighbors.
 * Confirm writes one deleteFace() and replaces a previous Delete Face block.
 * Leaving without Confirm writes nothing.
 *
 * Tap adds a face. Tap it again to remove it. Undo drops the last face.
 * Clear drops every face. No modifier key.
 */

import { shellFaceKey } from './shellMode.js';
import { facePickLiteral } from './faceFeaturePlacement.js';
import { DELETE_FACE_BEGIN, DELETE_FACE_END } from './helperPaletteSnippets.js';

export const DELETE_FACE_ENTRY_ID = 'deleteFace';

export const DELETE_FACE_NEED_FACE = 'Tap a face to delete.';

function copyFace(face) {
  return {
    center: face.center.map(Number),
    normal: face.normal.map(Number),
    indices: Array.isArray(face.indices) ? face.indices.slice() : undefined,
  };
}

export function emptyDeleteFaceState(faces = []) {
  const list = [];
  for (const face of Array.isArray(faces) ? faces : []) {
    if (!face || !Array.isArray(face.center) || !Array.isArray(face.normal)) continue;
    list.push(copyFace(face));
  }
  return {
    entry: DELETE_FACE_ENTRY_ID,
    body: 'part',
    faces: list,
  };
}

/** Tap adds. Tap the same face again to remove it. No modifier. */
export function toggleDeleteFaceSelection(state, face) {
  const s = state || emptyDeleteFaceState();
  const key = shellFaceKey(face);
  if (!key) return s;
  const faces = s.faces.slice();
  const idx = faces.findIndex((f) => shellFaceKey(f) === key);
  if (idx >= 0) faces.splice(idx, 1);
  else faces.push(copyFace(face));
  return { ...s, faces };
}

/** Undo: drop only the last face. */
export function popLastDeleteFace(state) {
  const s = state || emptyDeleteFaceState();
  const faces = s.faces.slice();
  if (faces.length) faces.pop();
  return { ...s, faces };
}

/** Clear: drop every face. */
export function clearDeleteFaces(state) {
  const s = state || emptyDeleteFaceState();
  return { ...s, faces: [] };
}

export function validateDeleteFaceAccept(state) {
  const s = state || emptyDeleteFaceState();
  const faces = (s.faces || []).filter((f) => shellFaceKey(f));
  if (!faces.length) return { ok: false, message: DELETE_FACE_NEED_FACE };
  return { ok: true, faces };
}

function stripReturn(buffer) {
  return String(buffer || '').replace(/\n*return\s+part\s*;?\s*$/i, '').replace(/\s+$/, '');
}

export function stripDeleteFaceBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(DELETE_FACE_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(DELETE_FACE_END, i);
  if (j < 0) return text;
  const after = text.slice(j + DELETE_FACE_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

/**
 * Confirm → one deleteFace() wrapped in Delete Face markers.
 * Always replaces the last marked Delete Face block.
 */
export function composeDeleteFaceCommit(buffer, state) {
  const gate = validateDeleteFaceAccept(state);
  if (!gate.ok) return gate;
  const body = state?.body || 'part';
  const faces = gate.faces.map((f) => facePickLiteral(f)).join(', ');
  const call = `${body} = deleteFace(${body}, [${faces}]);`;
  const base = stripReturn(stripDeleteFaceBlock(String(buffer || '')));
  const block = [DELETE_FACE_BEGIN, call, DELETE_FACE_END].join('\n');
  const composed = base ? `${base}\n${block}\nreturn part;\n` : `${block}\nreturn part;\n`;
  const ownedStart = composed.lastIndexOf(DELETE_FACE_BEGIN);
  const ownedEnd = composed.indexOf(DELETE_FACE_END, ownedStart);
  const owned = composed.slice(ownedStart, ownedEnd + DELETE_FACE_END.length);
  if ((owned.match(/\bdeleteFace\s*\(/g) || []).length !== 1) {
    return { ok: false, message: 'composeDeleteFaceCommit: Delete Face must emit exactly one deleteFace().' };
  }
  return { ok: true, buffer: composed, run: true };
}
