/**
 * Move mode — double-click a body, then set delta X, Y, and Z.
 * Confirm writes one move() and replaces a previous Move block, the way
 * Shell, Draft, and Cut replace their previous block.
 *
 * move() is Manifold.translate of the named body. The body is the same
 * { at } centroid cut() already uses. There is no second kernel and no
 * viewport gizmo.
 */

import { MOVE_BEGIN, MOVE_END } from './helperPaletteSnippets.js';

export const MOVE_ENTRY_ID = 'move';

export const MOVE_MODE_NEED_BODY = 'Double-click a body to move.';
export const MOVE_MODE_NEED_DELTA = 'X, Y, and Z must be numbers.';

function formatNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || Object.is(v, -0)) return '0';
  const r = Math.round(v * 1e4) / 1e4;
  if (r === 0) return '0';
  return String(r);
}

function formatVec(arr) {
  const a = Array.isArray(arr) ? arr : [0, 0, 0];
  return `[${formatNum(a[0])}, ${formatNum(a[1])}, ${formatNum(a[2])}]`;
}

export function emptyMoveState() {
  return {
    entry: MOVE_ENTRY_ID,
    body: 'part',
    target: null,
    dx: 0,
    dy: 0,
    dz: 0,
  };
}

export function clearMoveTarget(state) {
  if (!state) return emptyMoveState();
  return { ...state, target: null };
}

export function moveTargetLabel(target) {
  if (!target || !Array.isArray(target.at)) return 'Double-click a body';
  return `Body at ${formatVec(target.at)}`;
}

export function validateMoveAccept(state) {
  const at = state?.target?.at;
  if (!Array.isArray(at) || at.length < 3 || at.slice(0, 3).some((v) => !Number.isFinite(Number(v)))) {
    return { ok: false, message: MOVE_MODE_NEED_BODY };
  }
  const dx = Number(state.dx);
  const dy = Number(state.dy);
  const dz = Number(state.dz);
  if (![dx, dy, dz].every((v) => Number.isFinite(v))) {
    return { ok: false, message: MOVE_MODE_NEED_DELTA };
  }
  return { ok: true, dx, dy, dz, at: at.slice(0, 3).map(Number) };
}

function stripReturn(buffer) {
  return String(buffer || '').replace(/\n*return\s+part\s*;?\s*$/i, '').replace(/\s+$/, '');
}

export function stripMoveBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(MOVE_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(MOVE_END, i);
  if (j < 0) return text;
  const after = text.slice(j + MOVE_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

/**
 * Confirm → one move() wrapped in Move markers.
 * Always names the body. Always replaces the last marked Move block.
 */
export function composeMoveCommit(buffer, state) {
  const gate = validateMoveAccept(state);
  if (!gate.ok) return gate;
  const bodyName = state?.body || 'part';
  const call = `${bodyName} = move(${bodyName}, [${formatNum(gate.dx)}, ${formatNum(gate.dy)}, ${formatNum(gate.dz)}], { bodies: [{ at: ${formatVec(gate.at)} }] });`;
  const base = stripReturn(stripMoveBlock(String(buffer || '')));
  const block = [MOVE_BEGIN, call, MOVE_END].join('\n');
  const composed = base ? `${base}\n${block}\nreturn part;\n` : `${block}\nreturn part;\n`;
  const ownedStart = composed.lastIndexOf(MOVE_BEGIN);
  const ownedEnd = composed.indexOf(MOVE_END, ownedStart);
  const owned = composed.slice(ownedStart, ownedEnd + MOVE_END.length);
  if ((owned.match(/\bmove\s*\(/g) || []).length !== 1) {
    return { ok: false, message: 'composeMoveCommit: Move must emit exactly one move().' };
  }
  return { ok: true, buffer: composed, run: true };
}
