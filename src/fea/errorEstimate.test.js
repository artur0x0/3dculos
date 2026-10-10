import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_TARGET,
  recoveryEstimate,
  sizingFromError,
} from './errorEstimate.js';

const MATERIAL = { E_MPa: 1000, nu: 0.25 };

function meshOf(tets) {
  const map = new Map();
  const nodes = [];
  const elements = [];
  const idOf = (point) => {
    const key = point.map((value) => value.toFixed(9)).join(',');
    if (map.has(key)) return map.get(key);
    const id = nodes.length / 3;
    map.set(key, id);
    nodes.push(point[0], point[1], point[2]);
    return id;
  };
  for (const corners of tets) {
    const ids = corners.map(idOf);
    const pairs = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
    const mids = pairs.map(([a, b]) => idOf([
      (corners[a][0] + corners[b][0]) / 2,
      (corners[a][1] + corners[b][1]) / 2,
      (corners[a][2] + corners[b][2]) / 2,
    ]));
    elements.push(...ids, ...mids);
  }
  return {
    nodes: Float64Array.from(nodes),
    elements: Uint32Array.from(elements),
  };
}

function displace(nodes, field) {
  const out = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length / 3; i += 1) {
    const sample = field(nodes[i * 3], nodes[i * 3 + 1], nodes[i * 3 + 2]);
    out[i * 3] = sample[0];
    out[i * 3 + 1] = sample[1];
    out[i * 3 + 2] = sample[2];
  }
  return out;
}

const PATCH = meshOf([
  [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]],
]);

function valueAt(sizing, point) {
  for (let i = 0; i < sizing.values.length; i += 1) {
    const dx = sizing.positions[i * 3] - point[0];
    const dy = sizing.positions[i * 3 + 1] - point[1];
    const dz = sizing.positions[i * 3 + 2] - point[2];
    if (dx * dx + dy * dy + dz * dz < 1e-12) return sizing.values[i];
  }
  return null;
}

test('a patch test has zero recovery error', () => {
  const linear = recoveryEstimate({
    ...PATCH,
    displacement: displace(PATCH.nodes, (x) => [0.001 * x, 0, 0]),
    material: MATERIAL,
  });
  assert.ok(linear.errEst < 1e-8, `patch errEst ${linear.errEst}`);
  assert.ok(linear.elementError.length === 2);
  assert.ok(linear.elementError[0] < 1e-8 && linear.elementError[1] < 1e-8);

  const curved = recoveryEstimate({
    ...PATCH,
    displacement: displace(PATCH.nodes, (x) => [0.001 * x * x, 0, 0]),
    material: MATERIAL,
  });
  assert.ok(curved.errEst > 1e-4, `curved errEst ${curved.errEst}`);
});

test('a degenerate element does not throw and reports no error', () => {
  const estimate = recoveryEstimate({
    nodes: new Float64Array(30),
    elements: new Uint32Array(10),
    displacement: new Float64Array(30),
    material: MATERIAL,
  });
  assert.equal(estimate.errEst, 0);
});

test('sizing shrinks a hot element, grows a cold one, and stops at the DOF cap', () => {
  const elementError = Float64Array.from([0.4, 0.01]);
  const sized = sizingFromError({
    nodes: PATCH.nodes,
    elements: PATCH.elements,
    elementError,
    target: ERROR_TARGET,
  });
  const hot = valueAt(sized, [0, 0, 0]);
  const cold = valueAt(sized, [1, 1, 1]);
  assert.ok(hot > 0 && cold > 0, `hot ${hot} cold ${cold}`);
  assert.ok(hot < cold * 0.5, `hot edge ${hot} should be well under cold edge ${cold}`);
  assert.equal(sized.canRefine, true);
  assert.ok(sized.edgeLength >= cold * 0.99, `ideal edge ${sized.edgeLength} should be the coarse value ${cold}`);

  const capped = sizingFromError({
    nodes: PATCH.nodes,
    elements: PATCH.elements,
    elementError,
    target: ERROR_TARGET,
    cap: 1,
  });
  assert.ok(capped.edgeScale > 1, `edgeScale ${capped.edgeScale}`);
  assert.equal(capped.canRefine, false);
  assert.ok(capped.estimatedDofs <= 1.01);
  assert.ok(capped.uncappedDofs > capped.estimatedDofs, `uncapped ${capped.uncappedDofs}`);
});
