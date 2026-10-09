import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countTetsAlong,
  jacobianAcceptable,
  orientTet4s,
  repairTet10Jacobians,
  tet10MinJacobian,
  tetVolume,
} from './meshVolume.js';

function straightTet() {
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const pairs = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
  const nodes = corners.map((point) => point.slice());
  const midMeta = new Map();
  const elem = [0, 1, 2, 3];
  for (const [a, b] of pairs) {
    const id = nodes.length;
    const straight = [
      (nodes[a][0] + nodes[b][0]) / 2,
      (nodes[a][1] + nodes[b][1]) / 2,
      (nodes[a][2] + nodes[b][2]) / 2,
    ];
    nodes.push(straight.slice());
    midMeta.set(id, { straight: straight.slice(), snapped: false });
    elem.push(id);
  }
  return { nodes, elements: Uint32Array.from(elem), midMeta };
}

test('orientTet4s flips a left-handed tet and leaves a right-handed one', () => {
  const positions = new Float64Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
    2, 0, 0,
    2, 1, 0,
    2, 0, 1,
  ]);
  const negative = [0, 2, 1, 3];
  const positive = [0, 1, 2, 3];
  assert.ok(tetVolume(positions, negative) < 0);
  assert.ok(tetVolume(positions, positive) > 0);
  const tets = new Uint32Array([...negative, ...positive, 1, 4, 5, 6]);
  assert.ok(tetVolume(positions, [1, 4, 5, 6]) > 0);
  const oriented = orientTet4s(positions, tets);
  assert.equal(oriented.flipped, 1);
  assert.ok(tetVolume(positions, oriented.tets.subarray(0, 4)) > 0);
  assert.deepEqual(Array.from(oriented.tets.subarray(4, 8)), positive);
  assert.deepEqual(Array.from(oriented.tets.subarray(8, 12)), [1, 4, 5, 6]);
});

test('a straight unit tet has Jacobian 1, and a snapped mid rolls back', () => {
  const mesh = straightTet();
  const before = tet10MinJacobian(mesh.nodes, mesh.elements);
  assert.ok(Math.abs(before - 1) < 1e-9, `det ${before}`);

  mesh.nodes[4] = [0.5, 0, 2];
  mesh.midMeta.get(4).snapped = true;
  assert.equal(jacobianAcceptable(tet10MinJacobian(mesh.nodes, mesh.elements)), false);

  const repair = repairTet10Jacobians(mesh.nodes, mesh.elements, mesh.midMeta);
  assert.equal(repair.invalid, 0);
  assert.equal(repair.rolled, 1);
  assert.deepEqual(mesh.nodes[4], [0.5, 0, 0]);
  assert.equal(mesh.midMeta.get(4).snapped, false);
  assert.ok(jacobianAcceptable(tet10MinJacobian(mesh.nodes, mesh.elements)));
});

test('a shared snapped mid is straightened once for both elements', () => {
  const nodes = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, -1, 0],
  ];
  const midMeta = new Map();
  const midOf = new Map();
  const idOf = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const existing = midOf.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    const straight = [
      (nodes[a][0] + nodes[b][0]) / 2,
      (nodes[a][1] + nodes[b][1]) / 2,
      (nodes[a][2] + nodes[b][2]) / 2,
    ];
    nodes.push(straight.slice());
    midMeta.set(id, { straight: straight.slice(), snapped: false });
    midOf.set(key, id);
    return id;
  };
  const elemOf = (corners, edgePairs) => {
    const elem = corners.slice();
    for (const [a, b] of edgePairs) elem.push(idOf(a, b));
    return elem;
  };
  const a = elemOf([0, 1, 2, 3], [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]]);
  const b = elemOf([0, 1, 3, 4], [[0, 1], [1, 3], [3, 0], [0, 4], [1, 4], [3, 4]]);
  const shared = a[4];
  assert.equal(shared, b[4]);
  nodes[shared] = [0.5, 0, 2];
  midMeta.get(shared).snapped = true;
  const elements = Uint32Array.from([...a, ...b]);
  assert.equal(jacobianAcceptable(tet10MinJacobian(nodes, elements.subarray(0, 10))), false);

  const repair = repairTet10Jacobians(nodes, elements, midMeta);
  assert.equal(repair.invalid, 0);
  assert.equal(repair.rolled, 1);
  assert.deepEqual(nodes[shared], midMeta.get(shared).straight);
  assert.ok(jacobianAcceptable(tet10MinJacobian(nodes, elements.subarray(0, 10))));
  assert.ok(jacobianAcceptable(tet10MinJacobian(nodes, elements.subarray(10, 20))));
});

test('a collapsed tet with straight mids stays invalid and is counted', () => {
  const mesh = straightTet();
  mesh.nodes[3] = [0.3, 0.3, 0];
  mesh.nodes[7] = [
    (mesh.nodes[0][0] + mesh.nodes[3][0]) / 2,
    (mesh.nodes[0][1] + mesh.nodes[3][1]) / 2,
    (mesh.nodes[0][2] + mesh.nodes[3][2]) / 2,
  ];
  mesh.nodes[8] = [
    (mesh.nodes[1][0] + mesh.nodes[3][0]) / 2,
    (mesh.nodes[1][1] + mesh.nodes[3][1]) / 2,
    (mesh.nodes[1][2] + mesh.nodes[3][2]) / 2,
  ];
  mesh.nodes[9] = [
    (mesh.nodes[2][0] + mesh.nodes[3][0]) / 2,
    (mesh.nodes[2][1] + mesh.nodes[3][1]) / 2,
    (mesh.nodes[2][2] + mesh.nodes[3][2]) / 2,
  ];
  const repair = repairTet10Jacobians(mesh.nodes, mesh.elements, mesh.midMeta);
  assert.equal(repair.rolled, 0);
  assert.equal(repair.invalid, 1);
});

test('countTetsAlong sees two stacked tets through a segment', () => {
  const nodes = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [0, 0, 2],
  ];
  const fill = (corners) => {
    const elem = corners.slice();
    const pairs = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
    for (const [a, b] of pairs) {
      const pa = nodes[corners[a]];
      const pb = nodes[corners[b]];
      nodes.push([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
      elem.push(nodes.length - 1);
    }
    return elem;
  };
  const lower = fill([0, 1, 2, 3]);
  const upper = fill([3, 1, 2, 4]);
  const elements = Uint32Array.from([...lower, ...upper]);
  const crossed = countTetsAlong(nodes, elements, [0.1, 0.1, 0], [0, 0, 1], 2);
  assert.equal(crossed, 2);
});
