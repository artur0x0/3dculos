/**
 * Boolean mode — union, difference, or intersect of bodies in the active
 * solid. The first picked body is the target. Later bodies are tools.
 * Difference is target − (union of tools). Intersect is target ∩ (union of
 * tools). Intersect then lists the leftover pieces; a tap hides one, a tap
 * again brings it back, the same way Cut's Pieces list works.
 *
 * Picks are stored per part id. Hiding a part (the part manager eye) does
 * not add, remove, or rewrite that part's list. The cross-section manager
 * stays usable while the chip is open: a section hit is matched back to the
 * unsectioned body so the script still names the real centroid.
 *
 * Confirm writes one booleanBodies() and replaces the previous Boolean block.
 */

import { BOOLEAN_BEGIN, BOOLEAN_END } from './helperPaletteSnippets.js';
import { meshBodyComponents, bodyContainingTriangle, cutBodyKey } from './cutMode.js';

export { meshBodyComponents, bodyContainingTriangle, cutBodyKey };

export const BOOLEAN_ENTRY_ID = 'boolean';

export const BOOLEAN_OPS = Object.freeze(['union', 'difference', 'intersect']);

export const BOOLEAN_MODE_NEED_BODIES = 'Tap the bodies. The first is the target. Tap a body again to remove it.';
export const BOOLEAN_MODE_NEED_TOOL = 'Pick a target and at least one tool body.';
export const BOOLEAN_MODE_ALL_DROPPED = 'Every piece is hidden. Tap a hidden piece to bring it back.';

export const BOOLEAN_PIECE_COLORS = Object.freeze([
  0x38bdf8,
  0xfbbf24,
  0xc084fc,
  0x4ade80,
  0xfb7185,
  0x2dd4bf,
  0xf97316,
  0x818cf8,
]);

function round3(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

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

function readPos(positions, i) {
  if (positions && typeof positions.getX === 'function') {
    return [positions.getX(i), positions.getY(i), positions.getZ(i)];
  }
  const arr = positions?.array || positions;
  if (!arr) return [0, 0, 0];
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

function readIndex(index) {
  if (!index) return null;
  return index.array || index;
}

export function booleanPartKey(partId) {
  if (partId == null || partId === '') return '__active__';
  return String(partId);
}

export function emptyBooleanSlot() {
  return { bodies: [], drop: [] };
}

export function emptyBooleanState() {
  return {
    entry: BOOLEAN_ENTRY_ID,
    op: 'union',
    /** 'bodies' | 'pieces' — pieces is only meaningful for intersect. */
    pick: 'bodies',
    /** part id → { bodies, drop }. Hiding a part must not rewrite its slot. */
    byPart: {},
    body: 'part',
  };
}

export function booleanOp(value) {
  const v = String(value || 'union').toLowerCase();
  if (v === 'difference' || v === 'subtract' || v === 'cut') return 'difference';
  if (v === 'intersect' || v === 'intersection') return 'intersect';
  return 'union';
}

export function booleanSlot(state, partId) {
  const key = booleanPartKey(partId);
  const slot = state?.byPart?.[key];
  if (!slot) return emptyBooleanSlot();
  return {
    bodies: Array.isArray(slot.bodies) ? slot.bodies : [],
    drop: Array.isArray(slot.drop) ? slot.drop : [],
  };
}

function withSlot(state, partId, slot) {
  const s = state || emptyBooleanState();
  const key = booleanPartKey(partId);
  return {
    ...s,
    byPart: {
      ...(s.byPart || {}),
      [key]: {
        bodies: slot.bodies || [],
        drop: slot.drop || [],
      },
    },
  };
}

function copyBody(body) {
  return {
    center: (body.center || body.at).map(Number),
    at: (body.at || body.center).map(Number),
    triangles: (body.triangles || []).slice(),
    minTri: body.minTri,
  };
}

/**
 * Hiding a part does not clear or change that part's pick status.
 * The bodies and drop arrays already stored for that part are kept as they
 * are. A part that was never picked stays unpicked.
 */
export function noteBooleanPartHidden(state, partId) {
  const s = state || emptyBooleanState();
  const key = booleanPartKey(partId);
  const slot = s.byPart?.[key];
  if (!slot) return s;
  return {
    ...s,
    byPart: {
      ...s.byPart,
      [key]: {
        bodies: slot.bodies,
        drop: slot.drop,
      },
    },
  };
}

/** Stable snapshot of one part's picks, for tests that hide must not move them. */
export function booleanPickSnapshot(state, partId) {
  const slot = booleanSlot(state, partId);
  return {
    bodies: slot.bodies.map((b) => cutBodyKey(b)),
    drop: slot.drop.map((d) => (Array.isArray(d.at) ? d.at.map(round3).join(',') : '')),
  };
}

export function setBooleanOp(state, op) {
  const s = state || emptyBooleanState();
  const next = booleanOp(op);
  const pick = next === 'intersect' ? s.pick : 'bodies';
  return { ...s, op: next, pick };
}

export function setBooleanPickTarget(state, pick) {
  const s = state || emptyBooleanState();
  if (pick !== 'bodies' && pick !== 'pieces') return s;
  if (pick === 'pieces' && booleanOp(s.op) !== 'intersect') return s;
  return { ...s, pick };
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Ray from `origin` along `dir` (not necessarily unit) hits the triangle. */
function rayHitsTri(origin, dir, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const pvec = cross(dir, ac);
  const det = dot(ab, pvec);
  if (Math.abs(det) < 1e-10) return false;
  const inv = 1 / det;
  const tvec = sub(origin, a);
  const u = dot(tvec, pvec) * inv;
  if (u < -1e-8 || u > 1 + 1e-8) return false;
  const qvec = cross(tvec, ab);
  const v = dot(dir, qvec) * inv;
  if (v < -1e-8 || u + v > 1 + 1e-8) return false;
  const t = dot(ac, qvec) * inv;
  return t > 1e-8;
}

function triVerts(tri, positions, index) {
  const idx = readIndex(index);
  if (!idx || !positions) return null;
  const i0 = idx[tri * 3];
  const i1 = idx[tri * 3 + 1];
  const i2 = idx[tri * 3 + 2];
  if (i0 == null || i1 == null || i2 == null) return null;
  return [readPos(positions, i0), readPos(positions, i1), readPos(positions, i2)];
}

function pointTriDist2(point, a, b, c) {
  // Distance to the triangle plane is enough to tell "on this surface".
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 1e-12)) return Infinity;
  const d = dot(sub(point, a), n) / len;
  return d * d;
}

/**
 * Which original body contains `point`. Used when the cross-section manager
 * has replaced the drawn mesh, so the hit triangle is not a triangle of the
 * solid the script will boolean. A point on a body's surface wins. Otherwise
 * the body whose interior contains the point (ray parity), nearest surface
 * if several overlap.
 */
export function bodyContainingPoint(bodies, point, positions, index) {
  const list = Array.isArray(bodies) ? bodies : [];
  if (!Array.isArray(point) || point.length < 3 || !list.length) return null;
  const p = [Number(point[0]), Number(point[1]), Number(point[2])];
  if (p.some((v) => !Number.isFinite(v))) return null;
  // Tilted so a section cap parallel to YZ does not graze every edge.
  const dir = [1, 0.00013, 0.00021];
  let surface = null;
  let surfaceD = 0.05 * 0.05;
  let inside = null;
  let insideD = Infinity;
  for (const body of list) {
    let hits = 0;
    let near = Infinity;
    for (const tri of body.triangles || []) {
      const verts = triVerts(tri, positions, index);
      if (!verts) continue;
      const d2 = pointTriDist2(p, verts[0], verts[1], verts[2]);
      if (d2 < near) near = d2;
      if (rayHitsTri(p, dir, verts[0], verts[1], verts[2])) hits += 1;
    }
    if (near < surfaceD) {
      surface = body;
      surfaceD = near;
    }
    if (hits % 2 === 1 && near < insideD) {
      inside = body;
      insideD = near;
    }
  }
  return surface || inside;
}

/**
 * Body under a tap. A live mesh uses the hit triangle. A sectioned view
 * matches the hit point to the unsectioned body.
 */
export function resolveBooleanBody(tap = {}) {
  if (tap.sectioned && tap.basePositions && tap.baseIndex) {
    const bodies = meshBodyComponents(tap.basePositions, tap.baseIndex);
    return bodyContainingPoint(bodies, tap.point, tap.basePositions, tap.baseIndex);
  }
  const bodies = meshBodyComponents(tap.positions, tap.index);
  return bodyContainingTriangle(bodies, tap.triangle);
}

function pieceKey(at) {
  if (!Array.isArray(at)) return '';
  return at.map(round3).join(',');
}

export function applyBooleanTap(state, tap = {}) {
  const s = state || emptyBooleanState();
  const partId = tap.partId;
  const slot = booleanSlot(s, partId);
  if (s.pick === 'pieces') {
    const at = tap.at;
    if (!Array.isArray(at)) return { state: s, toast: 'Tap a piece.' };
    const key = pieceKey(at);
    const drop = slot.drop.slice();
    const idx = drop.findIndex((d) => pieceKey(d.at) === key);
    if (idx >= 0) drop.splice(idx, 1);
    else drop.push({ at: at.map(Number) });
    return { state: withSlot(s, partId, { bodies: slot.bodies, drop }) };
  }
  const hit = tap.body || resolveBooleanBody(tap);
  if (!hit) return { state: s, toast: 'Tap a body.' };
  const list = slot.bodies.slice();
  const key = cutBodyKey(hit);
  const idx = list.findIndex((b) => cutBodyKey(b) === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    return { state: withSlot(s, partId, { bodies: list, drop: [] }) };
  }
  list.push(copyBody(hit));
  return { state: withSlot(s, partId, { bodies: list, drop: slot.drop }) };
}

export function popLastBooleanPick(state, partId) {
  const s = state || emptyBooleanState();
  const slot = booleanSlot(s, partId);
  if (s.pick === 'pieces') {
    const drop = slot.drop.slice();
    drop.pop();
    return withSlot(s, partId, { bodies: slot.bodies, drop });
  }
  const bodies = slot.bodies.slice();
  bodies.pop();
  return withSlot(s, partId, { bodies, drop: [] });
}

export function clearBooleanPicks(state, partId) {
  const s = state || emptyBooleanState();
  const slot = booleanSlot(s, partId);
  if (s.pick === 'pieces') return withSlot(s, partId, { bodies: slot.bodies, drop: [] });
  return withSlot(s, partId, { bodies: [], drop: [] });
}

export function booleanPieceHidden(state, partId, at) {
  const slot = booleanSlot(state, partId);
  const key = pieceKey(at);
  return slot.drop.some((d) => pieceKey(d.at) === key);
}

function stripReturn(buffer) {
  return String(buffer || '').replace(/\n*return\s+part\s*;?\s*$/i, '').replace(/\s+$/, '');
}

export function stripBooleanBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(BOOLEAN_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(BOOLEAN_END, i);
  if (j < 0) return text;
  const after = text.slice(j + BOOLEAN_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

/**
 * Confirm uses the active part's slot. Other parts' picks stay in the mode
 * until dismiss; they are not written, because the editor holds one part.
 */
export function validateBooleanAccept(state, partId, mesh = null) {
  const s = state || emptyBooleanState();
  const op = booleanOp(s.op);
  const slot = booleanSlot(s, partId);
  const bodies = slot.bodies;
  if (bodies.length < 1) return { ok: false, message: BOOLEAN_MODE_NEED_BODIES };
  if (bodies.length < 2) return { ok: false, message: BOOLEAN_MODE_NEED_TOOL };
  const pieceCount = Number(mesh?.pieceCount);
  if (op === 'intersect' && pieceCount > 0 && slot.drop.length >= pieceCount) {
    return { ok: false, message: BOOLEAN_MODE_ALL_DROPPED };
  }
  return { ok: true, op, bodies, drop: op === 'intersect' ? slot.drop : [] };
}

/**
 * Confirm → one booleanBodies() wrapped in Boolean markers.
 * Always replaces the last marked Boolean block.
 */
export function composeBooleanCommit(buffer, state, partId, mesh = null) {
  const gate = validateBooleanAccept(state, partId, mesh);
  if (!gate.ok) return gate;
  const bodyName = state?.body || 'part';
  const specs = gate.bodies.map((b) => `{ at: ${formatVec(b.at)} }`).join(', ');
  const optParts = [`op: '${gate.op}'`, `bodies: [${specs}]`];
  if (gate.op === 'intersect' && gate.drop.length) {
    const drops = gate.drop.map((d) => `{ at: ${formatVec(d.at)} }`).join(', ');
    optParts.push(`drop: [${drops}]`);
  }
  const call = `${bodyName} = booleanBodies(${bodyName}, { ${optParts.join(', ')} });`;
  const base = stripReturn(stripBooleanBlock(String(buffer || '')));
  const block = [BOOLEAN_BEGIN, call, BOOLEAN_END].join('\n');
  const composed = base ? `${base}\n${block}\nreturn part;\n` : `${block}\nreturn part;\n`;
  const ownedStart = composed.lastIndexOf(BOOLEAN_BEGIN);
  const ownedEnd = composed.indexOf(BOOLEAN_END, ownedStart);
  const owned = composed.slice(ownedStart, ownedEnd + BOOLEAN_END.length);
  if ((owned.match(/booleanBodies\s*\(/g) || []).length !== 1) {
    return { ok: false, message: 'composeBooleanCommit: Boolean must emit exactly one booleanBodies().' };
  }
  return { ok: true, buffer: composed, run: true };
}
