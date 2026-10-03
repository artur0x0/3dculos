/**
 * Shell face-pick mode — enter from the left rail, tap a face (or Closed),
 * set wall thickness, Confirm writes hollow() in SHELL begin/end markers.
 *
 * Replaces the HelperParamModal axis Opening select (X/Y/Z/+/-), which was
 * confusing. Face pick maps to hollow(body, wall, { center, normal }) — the
 * same worker API as axis / 'none' / facesByNormal forms.
 *
 * Confirm Auto-Runs. Grey X / Cancel exits with no write. One Shell feature:
 * any number of opening faces emit a single hollow(body, wall, [pick, …]).
 * A later Shell replaces that block. It does not append another hollow()
 * onto an already thin body. Closed stays 'none'.
 */

import {
  composeHelperInsert,
  SHELL_BEGIN,
  SHELL_END,
} from './helperPaletteSnippets.js';
import { classifySelectedFace } from './faceFeaturePlacement.js';

export const SHELL_ENTRY_ID = 'shell';

export const SHELL_MODE_EMPTY =
  'Tap a face to open the shell, or choose Closed, then Confirm.';

export const SHELL_MODE_NO_COMMIT =
  'Dismiss exits Shell mode with no commit.';

export function isShellEntry(id) {
  return id === SHELL_ENTRY_ID;
}

export function defaultShellParams() {
  return {
    body: 'part',
    wall: 2.5,
    /** 'face' | 'none' — face uses the live viewport pick; none → closed hollow. */
    openingMode: 'face',
  };
}

/**
 * Seed in-mode state. A pre-selected face is fine; empty is OK (pick in-mode).
 * @param {object|null} [face]
 */
export function enterShellState(face = null) {
  const classified = face && face.type
    ? face
    : (face ? classifySelectedFace(face) : null);
  return {
    entry: SHELL_ENTRY_ID,
    params: defaultShellParams(),
    lastFace: classified,
    enterRefuse: null,
  };
}

export function normalizeShellParams(raw = {}) {
  const seeded = defaultShellParams();
  const wall = Number(raw.wall);
  return {
    body: raw.body || seeded.body,
    wall: Number.isFinite(wall) && wall > 0 ? wall : seeded.wall,
    openingMode: raw.openingMode === 'none' ? 'none' : 'face',
  };
}

/**
 * @param {object|null} face — classified or raw selectedFace
 * @param {object} params
 */
export function validateShellAccept(face, params = {}) {
  const n = normalizeShellParams(params);
  if (!(n.wall > 0)) {
    return { ok: false, message: 'Wall thickness must be greater than 0.' };
  }
  if (n.openingMode === 'none') {
    return {
      ok: true,
      normalized: n,
      face: null,
      openScope: 'none',
    };
  }
  const classified = face && face.type
    ? face
    : (face ? classifySelectedFace(face) : null);
  if (!classified) {
    return { ok: false, message: SHELL_MODE_EMPTY };
  }
  return {
    ok: true,
    normalized: n,
    face: classified,
    openScope: 'selected',
  };
}

export function hasShellBlock(buffer) {
  const t = String(buffer || '');
  return t.includes(SHELL_BEGIN) && t.includes(SHELL_END);
}

export function shellOwnedRegion(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(SHELL_BEGIN);
  if (i < 0) return '';
  const j = text.indexOf(SHELL_END, i);
  if (j < 0) return '';
  return text.slice(i, j + SHELL_END.length);
}

export function stripShellBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(SHELL_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(SHELL_END, i);
  if (j < 0) return text;
  const after = text.slice(j + SHELL_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

/**
 * Confirm → one hollow() wrapped in SHELL markers.
 * Always replaces the last marked Shell block. `commitMode: 'append'` is
 * accepted and ignored: a second hollow() would shell an already thin body.
 *
 * @param {string} buffer
 * @param {{ face?: object|null, params?: object, commitMode?: string }} [opts]
 */
export function composeShellCommit(buffer, {
  face = null,
  params = {},
} = {}) {
  const gate = validateShellAccept(face, params);
  if (!gate.ok) return gate;

  const text = String(buffer || '');
  // One feature. Never keep the previous hollow() and add another,
  // even if the caller still passes commitMode: 'append'.
  const base = stripShellBlock(text);
  const emitParams = {
    body: gate.normalized.body,
    wall: gate.normalized.wall,
    openScope: gate.openScope,
  };
  const composed = composeHelperInsert(
    base,
    'shell',
    null,
    emitParams,
    gate.face,
  );
  if (typeof composed !== 'string') {
    return { ok: false, message: gate.message || SHELL_MODE_EMPTY };
  }
  const owned = shellOwnedRegion(composed);
  if (!/hollow\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeShellCommit: hollow() missing — refusing silent no-op.',
    };
  }
  if (!hasShellBlock(composed)) {
    return {
      ok: false,
      message: 'composeShellCommit: shell markers missing — refusing unscoped insert.',
    };
  }
  if (gate.openScope === 'none') {
    if (!/hollow\s*\([^,]+,\s*[^,]+,\s*'none'\s*\)/.test(owned)) {
      return {
        ok: false,
        message: "composeShellCommit: closed opening must emit 'none'.",
      };
    }
  } else if (!/\{\s*center:\s*\[/.test(owned)) {
    return {
      ok: false,
      message: 'composeShellCommit: face opening must emit a { center, normal } literal.',
    };
  }
  const multi = Array.isArray(gate.face?.group) && gate.face.group.length > 1;
  if (multi && !/hollow\s*\(\s*[^,]+,\s*[^,]+,\s*\[/.test(owned)) {
    return {
      ok: false,
      message: 'composeShellCommit: several opening faces must emit one hollow() with an array.',
    };
  }
  if ((owned.match(/hollow\s*\(/g) || []).length !== 1) {
    return {
      ok: false,
      message: 'composeShellCommit: Shell must emit exactly one hollow().',
    };
  }
  return { ok: true, buffer: composed, run: true };
}
