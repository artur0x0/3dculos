// Closed triangle surfaces for the volume-mesher tests.
//
// Positions are millimetres. Indices are three per triangle. faceIds is one
// id per triangle. Windings point out of the solid, so the signed volume is
// positive.

function pushPoint(positions, x, y, z) {
  const index = positions.length / 3;
  positions.push(x, y, z);
  return index;
}

function addTriangle(indices, faceIds, a, b, c, faceId) {
  indices.push(a, b, c);
  faceIds.push(faceId);
}

function pack(positions, indices, faceIds) {
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    faceIds: Uint32Array.from(faceIds),
  };
}

function cross(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function normal(positions, a, b, c) {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  return cross(
    positions[b * 3] - ax,
    positions[b * 3 + 1] - ay,
    positions[b * 3 + 2] - az,
    positions[c * 3] - ax,
    positions[c * 3 + 1] - ay,
    positions[c * 3 + 2] - az,
  );
}

function addQuad(positions, indices, faceIds, a, b, c, d, faceId, want) {
  const n = normal(positions, a, b, c);
  const flip = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0;
  if (flip) {
    addTriangle(indices, faceIds, a, c, b, faceId);
    addTriangle(indices, faceIds, a, d, c, faceId);
  } else {
    addTriangle(indices, faceIds, a, b, c, faceId);
    addTriangle(indices, faceIds, a, c, d, faceId);
  }
}

/** Axis-aligned box. Face ids: -x 1, +x 2, -y 3, +y 4, -z 5, +z 6. */
export function box(size) {
  const [sx, sy, sz] = size;
  const positions = [];
  const v = (x, y, z) => pushPoint(positions, x, y, z);
  const c000 = v(0, 0, 0);
  const c100 = v(sx, 0, 0);
  const c110 = v(sx, sy, 0);
  const c010 = v(0, sy, 0);
  const c001 = v(0, 0, sz);
  const c101 = v(sx, 0, sz);
  const c111 = v(sx, sy, sz);
  const c011 = v(0, sy, sz);
  const indices = [];
  const faceIds = [];
  addQuad(positions, indices, faceIds, c000, c010, c011, c001, 1, [-1, 0, 0]);
  addQuad(positions, indices, faceIds, c100, c101, c111, c110, 2, [1, 0, 0]);
  addQuad(positions, indices, faceIds, c000, c001, c101, c100, 3, [0, -1, 0]);
  addQuad(positions, indices, faceIds, c010, c110, c111, c011, 4, [0, 1, 0]);
  addQuad(positions, indices, faceIds, c000, c100, c110, c010, 5, [0, 0, -1]);
  addQuad(positions, indices, faceIds, c001, c011, c111, c101, 6, [0, 0, 1]);
  return pack(positions, indices, faceIds);
}

/**
 * Polygonal cylinder along z. Face ids: bottom 1, top 2, side 3.
 * The side is an n-gon, so the volume is the prism volume, not π r² h.
 */
export function cylinder(radius, height, segments) {
  const positions = [];
  const bottomCenter = pushPoint(positions, 0, 0, 0);
  const topCenter = pushPoint(positions, 0, 0, height);
  const bottom = [];
  const top = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    bottom.push(pushPoint(positions, x, y, 0));
    top.push(pushPoint(positions, x, y, height));
  }
  const indices = [];
  const faceIds = [];
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments;
    addTriangle(indices, faceIds, bottomCenter, bottom[j], bottom[i], 1);
    addTriangle(indices, faceIds, topCenter, top[i], top[j], 2);
    addQuad(positions, indices, faceIds, bottom[i], bottom[j], top[j], top[i], 3, [
      Math.cos(((i + 0.5) / segments) * Math.PI * 2),
      Math.sin(((i + 0.5) / segments) * Math.PI * 2),
      0,
    ]);
  }
  return pack(positions, indices, faceIds);
}

function rayBox(halfX, halfY, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let t = Infinity;
  if (c > 1e-15) t = Math.min(t, halfX / c);
  if (c < -1e-15) t = Math.min(t, -halfX / c);
  if (s > 1e-15) t = Math.min(t, halfY / s);
  if (s < -1e-15) t = Math.min(t, -halfY / s);
  return [t * c, t * s];
}

/**
 * Rectangular plate with a circular hole through the thickness.
 * Face ids: bottom 1, top 2, outer wall 3, hole wall 4.
 * `segments` should be a multiple of 4 so the outer rays hit the corners.
 */
export function plateWithHole(width, depth, thickness, radius, segments) {
  const positions = [];
  const cx = width / 2;
  const cy = depth / 2;
  const bottomIn = [];
  const bottomOut = [];
  const topIn = [];
  const topOut = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const [ox, oy] = rayBox(width / 2, depth / 2, angle);
    const ix = radius * Math.cos(angle);
    const iy = radius * Math.sin(angle);
    bottomOut.push(pushPoint(positions, cx + ox, cy + oy, 0));
    bottomIn.push(pushPoint(positions, cx + ix, cy + iy, 0));
    topOut.push(pushPoint(positions, cx + ox, cy + oy, thickness));
    topIn.push(pushPoint(positions, cx + ix, cy + iy, thickness));
  }
  const indices = [];
  const faceIds = [];
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments;
    const outward = [
      Math.cos(((i + 0.5) / segments) * Math.PI * 2),
      Math.sin(((i + 0.5) / segments) * Math.PI * 2),
      0,
    ];
    addQuad(positions, indices, faceIds, bottomOut[i], bottomOut[j], bottomIn[j], bottomIn[i], 1, [0, 0, -1]);
    addQuad(positions, indices, faceIds, topOut[i], topIn[i], topIn[j], topOut[j], 2, [0, 0, 1]);
    addQuad(positions, indices, faceIds, bottomOut[i], bottomOut[j], topOut[j], topOut[i], 3, outward);
    addQuad(positions, indices, faceIds, bottomIn[i], topIn[i], topIn[j], bottomIn[j], 4, [
      -outward[0],
      -outward[1],
      0,
    ]);
  }
  return pack(positions, indices, faceIds);
}

/**
 * L-bracket extruded along z. The profile, CCW, is
 * (0,0), (L,0), (L,T), (T,T), (T,L), (0,L). Face ids are 1 for z = 0,
 * 2 for z = H, then 3..8 around the profile.
 */
export function lBracket(length, thickness, height) {
  const profile = [
    [0, 0],
    [length, 0],
    [length, thickness],
    [thickness, thickness],
    [thickness, length],
    [0, length],
  ];
  const positions = [];
  const bottom = profile.map(([x, y]) => pushPoint(positions, x, y, 0));
  const top = profile.map(([x, y]) => pushPoint(positions, x, y, height));
  const indices = [];
  const faceIds = [];
  const fan = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 5],
  ];
  for (const [a, b, c] of fan) {
    addTriangle(indices, faceIds, bottom[a], bottom[c], bottom[b], 1);
    addTriangle(indices, faceIds, top[a], top[b], top[c], 2);
  }
  for (let i = 0; i < profile.length; i += 1) {
    const j = (i + 1) % profile.length;
    const dx = profile[j][0] - profile[i][0];
    const dy = profile[j][1] - profile[i][1];
    const len = Math.hypot(dx, dy);
    addQuad(
      positions,
      indices,
      faceIds,
      bottom[i],
      bottom[j],
      top[j],
      top[i],
      3 + i,
      [dy / len, -dx / len, 0],
    );
  }
  return pack(positions, indices, faceIds);
}
