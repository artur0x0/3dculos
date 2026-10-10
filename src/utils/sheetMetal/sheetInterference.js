/**
 * Bend interference at feature-creation time. Pure JS beside `solveSheet`
 * (no Manifold): the flat blank is axis-aligned rectangles, and the fold
 * is the flange box plus the bend sector sampled from a small angle through
 * the finished pose. A final-position gap is not a pass — a tray corner
 * misses when folded and still sweeps through the neighbour.
 *
 * Touching along the attachment edge is not a hit. The parent flange is
 * not subtracted: a hem that lands on it is a real collision.
 */
import {
  bendDefaults,
  panelPoint,
  solveSheet,
  vAdd,
  vDot,
  vMul,
  vSub,
} from './sheetModel.js';

/** Positive overlap below this is an edge touch, not a covered region. */
export const FLAT_AREA_EPS = 0.5;
/** Penetration below this is the shared face of the attachment, not a clash. */
export const SWEEP_PEN_EPS = 0.05;
const SWEEP_SAMPLES = 12;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

function rectOverlapArea(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

function rectFrom(a, b, owner, kind) {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  if (!(x1 - x0 > 1e-6 && y1 - y0 > 1e-6)) return null;
  return { x0, x1, y0, y1, owner, kind };
}

/** Flat rectangles tagged with the panel (or bend) they belong to. */
export function sheetFlatRects(spec) {
  const flat = solveSheet(spec, { flat: true });
  const base = flat.panels[0];
  if (!base) return [];
  const to2 = (p) => {
    const rel = vSub(p, base.o);
    return [vDot(rel, base.U), vDot(rel, base.V)];
  };
  const rects = [];
  for (const p of flat.panels) {
    const r = rectFrom(to2(panelPoint(p, p.u0, p.v0)), to2(panelPoint(p, p.u1, p.v1)), p.id, 'panel');
    if (r) rects.push(r);
  }
  for (const b of flat.bends) {
    const a0 = vAdd(b.E0, vMul(b.q0, b.e));
    const a1 = vAdd(vAdd(b.E0, vMul(b.q1, b.e)), vMul(b.allowance, b.d));
    const r = rectFrom(to2(a0), to2(a1), b.id, 'strip');
    if (r) rects.push(r);
  }
  for (const tb of flat.tabs) {
    const a0 = vAdd(tb.E0, vMul(tb.q0, tb.e));
    const a1 = vAdd(vAdd(tb.E0, vMul(tb.q1, tb.e)), vMul(tb.depth, tb.d));
    const r = rectFrom(to2(a0), to2(a1), tb.panel, 'tab');
    if (r) rects.push(r);
  }
  return rects;
}

function movingIds(spec, bendId) {
  const ids = new Set([bendId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of spec.bends || []) {
      if (!ids.has(b.id) && ids.has(b.panel)) {
        ids.add(b.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** "flange 2" follows bend order. The base is "the base". */
export function flangeLabel(spec, panelId) {
  if (!panelId || panelId === 'base') return 'the base';
  const i = (spec.bends || []).findIndex((b) => b.id === panelId);
  if (i >= 0) return `flange ${i + 1}`;
  return `flange ${panelId}`;
}

function flatHit(spec, bendId) {
  const moving = movingIds(spec, bendId);
  const rects = sheetFlatRects(spec);
  const fresh = rects.filter((r) => moving.has(r.owner));
  const old = rects.filter((r) => !moving.has(r.owner));
  let best = null;
  for (const a of fresh) {
    for (const b of old) {
      const area = rectOverlapArea(a, b);
      if (area > FLAT_AREA_EPS && (!best || area > best.area)) best = { other: b.owner, area };
    }
  }
  return best;
}

function boxOf(origin, X, Y, Z, sx, sy, sz, meta) {
  if (!(sx > 1e-4 && sy > 1e-4 && sz > 1e-4)) return null;
  const A = [norm(X), norm(Y), norm(Z)];
  if (A.some((a) => !a)) return null;
  const h = [sx / 2, sy / 2, sz / 2];
  const C = [
    origin[0] + A[0][0] * h[0] + A[1][0] * h[1] + A[2][0] * h[2],
    origin[1] + A[0][1] * h[0] + A[1][1] * h[1] + A[2][1] * h[2],
    origin[2] + A[0][2] * h[0] + A[1][2] * h[1] + A[2][2] * h[2],
  ];
  return { C, A, h, ...meta };
}

function sectorDir(phi, flip) {
  // Unit direction from the axis to the material, in (d, N) components.
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  return flip ? [s, c] : [s, -c];
}

function sectorBoxes(bend, t, r) {
  const span = bend.q1 - bend.q0;
  if (!(bend.theta > 1e-4) || !(span > 1e-4) || !bend.axis) return [];
  const n = Math.max(2, Math.ceil((bend.theta / (Math.PI / 2)) * 8));
  const boxes = [];
  const midQ = (bend.q0 + bend.q1) / 2;
  for (let i = 0; i < n; i++) {
    const phi0 = (bend.theta * i) / n;
    const phi1 = (bend.theta * (i + 1)) / n;
    const mid = (phi0 + phi1) / 2;
    const [dx, nx] = sectorDir(mid, bend.flip);
    const [tx, tn] = sectorDir(mid + Math.PI / 2, bend.flip);
    const radial = norm(vAdd(vMul(dx, bend.d), vMul(nx, bend.N)));
    const tangent = norm(vAdd(vMul(tx, bend.d), vMul(tn, bend.N)));
    const along = norm(bend.e);
    if (!radial || !tangent || !along) continue;
    const midR = r + t / 2;
    const C = vAdd(vAdd(bend.axis, vMul(midR, radial)), vMul(midQ, bend.e));
    const halfT = (r + t) * Math.sin((phi1 - phi0) / 2);
    boxes.push({
      C,
      A: [radial, tangent, along],
      h: [t / 2, Math.max(halfT, 1e-4), span / 2],
      owner: bend.id,
      kind: 'sector',
      parent: bend.panel,
    });
  }
  return boxes;
}

function poseBoxes(solved, spec) {
  const boxes = [];
  for (const p of solved.panels) {
    const box = boxOf(
      panelPoint(p, p.u0, p.v0, 0), p.U, p.V, p.N,
      p.u1 - p.u0, p.v1 - p.v0, spec.t,
      { owner: p.id, kind: 'panel', parent: p.parent || null },
    );
    if (box) boxes.push(box);
  }
  for (const b of solved.bends) boxes.push(...sectorBoxes(b, spec.t, spec.r));
  for (const tb of solved.tabs) {
    const box = boxOf(
      vAdd(tb.E0, vMul(tb.q0, tb.e)), tb.d, tb.e, tb.N,
      tb.depth, tb.q1 - tb.q0, spec.t,
      { owner: tb.panel, kind: 'tab', parent: tb.panel },
    );
    if (box) boxes.push(box);
  }
  return boxes;
}

/** Minimum separating-axis overlap. 0 when the boxes miss or only touch. */
export function obbPenetration(a, b) {
  const axes = [];
  const push = (ax) => {
    const n = norm(ax);
    if (!n) return;
    for (const e of axes) if (Math.abs(vDot(e, n)) > 0.999) return;
    axes.push(n);
  };
  for (const ax of a.A) push(ax);
  for (const ax of b.A) push(ax);
  for (const ax of a.A) for (const bx of b.A) push(cross(ax, bx));
  const T = vSub(b.C, a.C);
  let min = Infinity;
  for (const ax of axes) {
    let ra = 0;
    let rb = 0;
    for (let i = 0; i < 3; i++) {
      ra += a.h[i] * Math.abs(vDot(a.A[i], ax));
      rb += b.h[i] * Math.abs(vDot(b.A[i], ax));
    }
    const overlap = ra + rb - Math.abs(vDot(T, ax));
    if (overlap <= SWEEP_PEN_EPS) return 0;
    if (overlap < min) min = overlap;
  }
  return Number.isFinite(min) ? min : 0;
}

function pairsCollide(moving, still) {
  let best = null;
  for (const a of moving) {
    for (const b of still) {
      // The sector meets its own parent along the tangent, and a side bend's
      // sector meets that parent's bend sector only at the shared corner.
      // Those boxes overlap by a fraction of a millimetre; the boolean does not.
      if (a.kind === 'sector' && b.kind === 'panel' && b.owner === a.parent) continue;
      if (b.kind === 'sector' && a.kind === 'panel' && a.owner === b.parent) continue;
      if (a.kind === 'sector' && b.kind === 'sector' && (a.parent === b.owner || b.parent === a.owner)) continue;
      const pen = obbPenetration(a, b);
      if (pen > 0 && (!best || pen > best.pen)) {
        best = { other: b.owner, pen, aKind: a.kind, bKind: b.kind, aOwner: a.owner };
      }
    }
  }
  return best;
}

function sweepHit(spec, bendId) {
  const bend = (spec.bends || []).find((b) => b.id === bendId);
  if (!bend) return null;
  const angle = Math.max(0, Number(bend.angle) || 0);
  if (!(angle > 1e-3)) return null;
  const moving = movingIds(spec, bendId);
  let best = null;
  for (let i = 1; i <= SWEEP_SAMPLES; i++) {
    const sample = angle * (i / SWEEP_SAMPLES);
    const posed = {
      ...spec,
      bends: spec.bends.map((b) => (b.id === bendId ? { ...b, angle: sample } : b)),
    };
    let solved;
    try {
      solved = solveSheet(posed);
    } catch {
      continue;
    }
    if (solved.errors.length) continue;
    const boxes = poseBoxes(solved, spec);
    const hit = pairsCollide(
      boxes.filter((bx) => moving.has(bx.owner)),
      boxes.filter((bx) => !moving.has(bx.owner)),
    );
    if (hit && (!best || hit.pen > best.pen)) best = { ...hit, angle: sample };
  }
  return best;
}

/**
 * Interference of `bendId` (already on `spec`) against the rest of the part.
 * Descendants of that bend move with it. `{ ok, reason, kind, other, area, pen }`.
 */
export function bendInterference(spec, bendId) {
  const bend = (spec?.bends || []).find((b) => b.id === bendId);
  if (!bend) return { ok: true, reason: null, kind: null, other: null };
  const flat = flatHit(spec, bendId);
  const sweep = sweepHit(spec, bendId);
  if (sweep) {
    const label = flangeLabel(spec, sweep.other);
    return {
      ok: false,
      kind: 'sweep',
      other: sweep.other,
      pen: sweep.pen,
      angle: sweep.angle,
      area: flat?.area || 0,
      reason: `Collides with ${label} when folded`,
    };
  }
  if (flat) {
    const label = flangeLabel(spec, flat.other);
    return {
      ok: false,
      kind: 'flat',
      other: flat.other,
      area: flat.area,
      pen: 0,
      reason: `Overlaps ${label} in the flat pattern`,
    };
  }
  return { ok: true, reason: null, kind: null, other: null, area: 0, pen: 0 };
}

/** Would the default bend (90° or the SKU max, quarter-edge length, up) collide? */
export function defaultBendBlocked(spec, panelId, edge) {
  const proposal = bendDefaults(spec, panelId, edge);
  const id = '__trial__';
  const trial = {
    ...spec,
    bends: [...(spec.bends || []).filter((b) => b.id !== id), {
      id, panel: panelId, edge, angle: proposal.angle, length: proposal.length, flip: false,
    }],
  };
  return bendInterference(trial, id);
}
