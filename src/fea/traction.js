/**
 * Consistent nodal forces for a constant traction on a 6-node face.
 *
 * Same 3-point rule and quadratic shape functions as solve_tet10. The sum of
 * the six nodal forces equals traction times the face area. Face order is
 * corners, then mid-edge nodes 01, 12, 20.
 */

const GAUSS = [
  [2 / 3, 1 / 6, 1 / 6],
  [1 / 6, 2 / 3, 1 / 6],
  [1 / 6, 1 / 6, 2 / 3],
];
const GAUSS_WEIGHT = 1 / 6;

function shape(l0, l1, l2) {
  return [
    l0 * (2 * l0 - 1),
    l1 * (2 * l1 - 1),
    l2 * (2 * l2 - 1),
    4 * l0 * l1,
    4 * l1 * l2,
    4 * l2 * l0,
  ];
}

function dShape(l0, l1, l2) {
  return [
    [-(4 * l0 - 1), -(4 * l0 - 1)],
    [4 * l1 - 1, 0],
    [0, 4 * l2 - 1],
    [4 * (l0 - l1), -4 * l1],
    [4 * l2, 4 * l1],
    [-4 * l2, 4 * (l0 - l2)],
  ];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * `xyz` is six [x, y, z] points. `traction` is N/mm². Returns six force
 * vectors in newtons, in face order.
 */
export function faceTractionForces(xyz, traction) {
  const force = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const [l0, l1, l2] of GAUSS) {
    const n = shape(l0, l1, l2);
    const d = dShape(l0, l1, l2);
    const dr1 = [0, 0, 0];
    const dr2 = [0, 0, 0];
    for (let a = 0; a < 6; a += 1) {
      for (let k = 0; k < 3; k += 1) {
        dr1[k] += d[a][0] * xyz[a][k];
        dr2[k] += d[a][1] * xyz[a][k];
      }
    }
    const normal = cross(dr1, dr2);
    const scale = Math.hypot(normal[0], normal[1], normal[2]);
    for (let a = 0; a < 6; a += 1) {
      const weight = n[a] * scale * GAUSS_WEIGHT;
      force[a][0] += traction[0] * weight;
      force[a][1] += traction[1] * weight;
      force[a][2] += traction[2] * weight;
    }
  }
  return force;
}

/** Area of one 6-node face, from the same jacobian as the traction. */
export function faceArea(xyz) {
  let area = 0;
  for (const [l0, l1, l2] of GAUSS) {
    const d = dShape(l0, l1, l2);
    const dr1 = [0, 0, 0];
    const dr2 = [0, 0, 0];
    for (let a = 0; a < 6; a += 1) {
      for (let k = 0; k < 3; k += 1) {
        dr1[k] += d[a][0] * xyz[a][k];
        dr2[k] += d[a][1] * xyz[a][k];
      }
    }
    const normal = cross(dr1, dr2);
    area += Math.hypot(normal[0], normal[1], normal[2]) * GAUSS_WEIGHT;
  }
  return area;
}

export function quadShape(l0, l1, l2) {
  return shape(l0, l1, l2);
}
