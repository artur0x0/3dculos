import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactProbeMix,
  locateProbeFace,
  packProbeSurface,
  probeMeshPoint,
  probeQuantityName,
  probeUnit,
  readTetProbe,
} from './probeSample.js';

function faceMesh() {
  return {
    nodes: new Float64Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]),
    faces: new Uint32Array([0, 1, 2, 3, 4, 5]),
    faceIds: new Uint32Array([7]),
  };
}

test('a linear field is recovered inside the face, not at the nearest node', () => {
  const mesh = faceMesh();
  const stress = new Float64Array([0, 2, 0, 1, 1, 0]);
  const point = [0.5, 0.5, 0];
  const hit = probeMeshPoint(point, 7, mesh, stress, 1);
  assert.ok(hit);
  assert.ok(Math.abs(hit.value - 0.5) < 1e-6, `value ${hit.value}`);
  // The closest nodes are the midsides at x = 1. Snapping there would read 1.
  assert.ok(Math.abs(hit.value - 1) > 0.2);
  let mixed = 0;
  for (let i = 0; i < 6; i += 1) mixed += hit.weights[i] * hit.nodal[i];
  assert.ok(Math.abs(mixed - hit.value) < 1e-9);
});

test('displacement magnitude is the length of the interpolated vector', () => {
  const mesh = faceMesh();
  const displacement = new Float64Array(18);
  displacement[0] = 1;
  displacement[3] = -1;
  displacement[7] = 1;
  const point = [2 / 3, 2 / 3, 0];
  const hit = probeMeshPoint(point, 7, mesh, displacement, 3);
  assert.ok(hit);
  assert.equal(hit.mix, 'magnitude');
  assert.ok(Math.abs(hit.value - (1 / 9)) < 1e-5, `got ${hit.value}`);
  assert.ok(Math.abs(hit.value - (1 / 3)) > 1e-3);
});

test('a different face id does not fall back to the nearest vertex', () => {
  const mesh = faceMesh();
  const stress = new Float64Array([0, 2, 0, 1, 1, 0]);
  assert.equal(probeMeshPoint([0.5, 0.5, 0], 3, mesh, stress, 1), null);
  assert.equal(locateProbeFace([0.5, 0.5, 0], 3, mesh), null);
});

test('contact uses shape functions when every node is set, else the corners', () => {
  const full = contactProbeMix([0, 2, 0, 1, 1, 0], [0.5, 0.25, 0.25]);
  assert.ok(Math.abs(full.value - 0.5) < 1e-6);
  const corners = contactProbeMix([0, 2, 4, NaN, NaN, NaN], [0.5, 0.25, 0.25]);
  assert.ok(Math.abs(corners.value - 1.5) < 1e-6);
  assert.equal(corners.weights[3], 0);
  const mesh = faceMesh();
  const pressure = new Float64Array([0, 2, 4, NaN, NaN, NaN]);
  const record = packProbeSurface(mesh, {
    contact: pressure,
    contactFaces: [7],
  });
  const hit = readTetProbe([0.5, 0.5, 0], 7, record, 'contact');
  assert.ok(hit);
  assert.ok(Math.abs(hit.value - 1.5) < 1e-5, `got ${hit.value}`);
  assert.equal(readTetProbe([0.5, 0.5, 0], 4, record, 'contact'), null);
});

test('a packed surface probes the same point as the source mesh', () => {
  const mesh = faceMesh();
  const stress = new Float64Array([4, 8, 0, 6, 4, 2]);
  const packed = packProbeSurface(mesh, { stress });
  assert.equal(packed.kind, 'tet');
  assert.equal(packed.nodes.length / 3, 6);
  const direct = probeMeshPoint([0.2, 0.2, 0.05], 7, mesh, stress, 1);
  const packedHit = readTetProbe([0.2, 0.2, 0.05], 7, packed, 'stress');
  assert.ok(Math.abs(direct.value - packedHit.value) < 1e-5);
});

test('mode displacement follows the selected mode', () => {
  const mesh = faceMesh();
  const mode0 = new Float64Array(18);
  const mode1 = new Float64Array(18);
  for (let i = 0; i < 6; i += 1) {
    mode0[i * 3] = i;
    mode1[i * 3 + 1] = 3;
  }
  const modes = new Float64Array(36);
  modes.set(mode0, 0);
  modes.set(mode1, 18);
  const packed = packProbeSurface(mesh, { modes, modeCount: 2 });
  const first = readTetProbe([0, 0, 0], 7, packed, 'mode', 0);
  const second = readTetProbe([0, 0, 0], 7, packed, 'mode', 1);
  assert.ok(Math.abs(first.value - 0) < 1e-6);
  assert.ok(Math.abs(second.value - 3) < 1e-5);
});

test('quantity names and units follow the results tab', () => {
  assert.equal(probeQuantityName('static', 'stress'), 'stress');
  assert.equal(probeQuantityName('static', 'displacement'), 'displacement');
  assert.equal(probeQuantityName('static', 'contact'), 'contact');
  assert.equal(probeQuantityName('modal', 'stress'), 'mode');
  assert.equal(probeUnit('stress'), 'MPa');
  assert.equal(probeUnit('contact'), 'MPa');
  assert.equal(probeUnit('displacement'), 'mm');
  assert.equal(probeUnit('mode'), '');
});
