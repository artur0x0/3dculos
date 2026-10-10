/**
 * Joint residuals in the world frame, and their analytic Jacobian.
 *
 * Counts below are the independent rows. A cross product is stored as the
 * two components that are not the seed direction's largest one, so the
 * row choice does not move when the pose does.
 *
 *   coincident   (nₐ ± n_b) twice, and (p_b − pₐ) · nₐ
 *   concentric   dₐ × d_b twice, and (p_b − pₐ) × dₐ twice
 *   distance     nₐ × n_b twice, and (p_b − pₐ) · nₐ − sense · value
 *   angle        sense · (uₐ · u_b) − cos(value in radians)
 *   fixed        no row; the part is not a variable
 *
 * Concentric on an edge reads `key.circle` (center, axis). It does not
 * use the edge tangent. A missing circle leaves the joint with no frame.
 */
import {
  add3,
  addMat,
  cross3,
  dot3,
  dropIndex,
  mulMat,
  scale3,
  scaleMat,
  skew,
  sub3,
  unit3,
  vecTMat,
  worldGeom,
} from './rigid.js';

const ZERO = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

/** Local point and direction a joint equation actually constrains. */
export function localFrame(ref, type) {
  if (!ref || type === 'fixed') return null;
  if (ref.kind === 'face' && ref.key?.at && ref.key?.n) {
    return { at: ref.key.at.slice(), dir: unit3(ref.key.n) };
  }
  if (ref.kind === 'axis' && ref.key?.at && ref.key?.dir) {
    return { at: ref.key.at.slice(), dir: unit3(ref.key.dir) };
  }
  if (ref.kind === 'edge' && ref.key?.at && ref.key?.dir) {
    if (type === 'concentric') {
      const circle = ref.key.circle;
      if (!circle?.at || !circle?.dir) return null;
      return { at: circle.at.slice(), dir: unit3(circle.dir) };
    }
    return { at: ref.key.at.slice(), dir: unit3(ref.key.dir) };
  }
  return null;
}

function geom(poses, ref, type) {
  const local = localFrame(ref, type);
  if (!local || !poses.has(ref.part)) return null;
  return { part: ref.part, ...worldGeom(poses.get(ref.part), local) };
}

function pushScalar(rows, jac, freeIndex, value, partials) {
  const n = freeIndex.size * 6;
  const row = new Array(n).fill(0);
  for (const part of partials) {
    const col = freeIndex.get(part.part);
    if (col == null) continue;
    const base = col * 6;
    row[base] += part.w[0];
    row[base + 1] += part.w[1];
    row[base + 2] += part.w[2];
    row[base + 3] += part.t[0];
    row[base + 4] += part.t[1];
    row[base + 5] += part.t[2];
  }
  rows.push(value);
  jac.push(row);
}

function pushKept(rows, jac, freeIndex, vec, derivs, drop) {
  for (let k = 0; k < 3; k++) {
    if (k === drop) continue;
    const partials = [];
    for (const [part, d] of derivs) {
      partials.push({
        part,
        w: [d.w[k][0], d.w[k][1], d.w[k][2]],
        t: [d.t[k][0], d.t[k][1], d.t[k][2]],
      });
    }
    pushScalar(rows, jac, freeIndex, vec[k], partials);
  }
}

function planePartials(A, B, delta) {
  return [
    {
      part: A.part,
      w: add3(vecTMat(A.dir, scaleMat(A.dAt, -1)), vecTMat(delta, A.dDir)),
      t: scale3(A.dir, -1),
    },
    {
      part: B.part,
      w: vecTMat(A.dir, B.dAt),
      t: A.dir.slice(),
    },
  ];
}

function directionCross(A, B, scale) {
  const vec = scale3(cross3(A.dir, B.dir), scale);
  const dA = scaleMat(mulMat(scaleMat(skew(B.dir), -1), A.dDir), scale);
  const dB = scaleMat(mulMat(skew(A.dir), B.dDir), scale);
  return {
    vec,
    derivs: [
      [A.part, { w: dA, t: ZERO }],
      [B.part, { w: dB, t: ZERO }],
    ],
  };
}

/**
 * Residual rows and Jacobian for one pack of joints.
 * `drops[i]` is the frozen component index for that joint, or null.
 */
export function evaluateJoints(joints, poses, freeIndex, drops) {
  const rows = [];
  const jac = [];
  joints.forEach((joint, i) => {
    if (joint.type === 'fixed') return;
    const A = geom(poses, joint.a, joint.type);
    const B = geom(poses, joint.b, joint.type);
    if (!A || !B) return;
    const drop = drops[i];
    if (joint.type === 'coincident') {
      const plus = joint.opposed === false ? -1 : 1;
      const s = add3(A.dir, scale3(B.dir, plus));
      pushKept(rows, jac, freeIndex, s, [
        [A.part, { w: A.dDir, t: ZERO }],
        [B.part, { w: scaleMat(B.dDir, plus), t: ZERO }],
      ], drop);
      const delta = sub3(B.at, A.at);
      pushScalar(rows, jac, freeIndex, dot3(delta, A.dir), planePartials(A, B, delta));
      return;
    }
    if (joint.type === 'concentric') {
      const align = dot3(A.dir, B.dir) >= 0 ? 1 : -1;
      const crossed = directionCross(A, B, align);
      pushKept(rows, jac, freeIndex, crossed.vec, crossed.derivs, drop);
      const delta = sub3(B.at, A.at);
      const radial = cross3(delta, A.dir);
      const dA = addMat(mulMat(skew(A.dir), A.dAt), mulMat(skew(delta), A.dDir));
      const dB = mulMat(scaleMat(skew(A.dir), -1), B.dAt);
      pushKept(rows, jac, freeIndex, radial, [
        [A.part, { w: dA, t: skew(A.dir) }],
        [B.part, { w: dB, t: scaleMat(skew(A.dir), -1) }],
      ], drop);
      return;
    }
    if (joint.type === 'distance') {
      const crossed = directionCross(A, B, 1);
      pushKept(rows, jac, freeIndex, crossed.vec, crossed.derivs, drop);
      const delta = sub3(B.at, A.at);
      const gap = dot3(delta, A.dir) - joint.sense * joint.value;
      pushScalar(rows, jac, freeIndex, gap, planePartials(A, B, delta));
      return;
    }
    if (joint.type === 'angle') {
      const theta = joint.value * Math.PI / 180;
      const value = joint.sense * dot3(A.dir, B.dir) - Math.cos(theta);
      pushScalar(rows, jac, freeIndex, value, [
        { part: A.part, w: scale3(vecTMat(B.dir, A.dDir), joint.sense), t: [0, 0, 0] },
        { part: B.part, w: scale3(vecTMat(A.dir, B.dDir), joint.sense), t: [0, 0, 0] },
      ]);
    }
  });
  return { residual: rows, jacobian: jac };
}

/** Frozen row choice from the seed pose, so finite differences see the same rows. */
export function seedDrops(joints, seedPoses) {
  return joints.map((joint) => {
    if (joint.type === 'fixed' || joint.type === 'angle') return null;
    const local = localFrame(joint.a, joint.type);
    const pose = seedPoses.get(joint.a?.part);
    if (!local || !pose) return 0;
    return dropIndex(worldGeom({ ...pose, omega: [0, 0, 0] }, local).dir);
  });
}
