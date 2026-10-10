import assert from 'node:assert/strict';
import test from 'node:test';
import { contactTolerance, detectContacts, mergeContactPairs } from './contactDetect.js';
import { assignedMaterialFromScript } from './partMaterial.js';
import { freshStudy, sameStudyFace, studyWithScope } from './studyPanel.js';

function cube(id, origin, size = 10) {
  const [ox, oy, oz] = origin;
  const s = size;
  const verts = [
    [ox, oy, oz], [ox + s, oy, oz], [ox + s, oy + s, oz], [ox, oy + s, oz],
    [ox, oy, oz + s], [ox + s, oy, oz + s], [ox + s, oy + s, oz + s], [ox, oy + s, oz + s],
  ];
  const quads = [
    [0, 3, 7, 4],
    [1, 5, 6, 2],
    [0, 4, 5, 1],
    [3, 2, 6, 7],
    [0, 1, 2, 3],
    [4, 7, 6, 5],
  ];
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((p, i) => {
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];
  });
  const indices = [];
  const faceIDs = [];
  quads.forEach((quad, faceID) => {
    indices.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
    faceIDs.push(faceID, faceID);
  });
  return {
    id,
    positions,
    indices: Uint32Array.from(indices),
    faceIDs: Uint32Array.from(faceIDs),
  };
}

test('the bond gap is 0.05 mm or 1% of the shortest edge', () => {
  assert.equal(contactTolerance(2), 0.05);
  assert.equal(contactTolerance(10), 0.1);
  assert.equal(contactTolerance(10, 0.25), 0.25);
});

test('touching cubes bond on the shared face and not on the side walls', () => {
  const hit = detectContacts([cube('a', [0, 0, 0]), cube('b', [10, 0, 0])]);
  assert.equal(hit.pairs.length, 1);
  assert.deepEqual(hit.pairs[0], {
    a: { part: 'a', faceID: 1 },
    b: { part: 'b', faceID: 0 },
    kind: 'bonded',
  });

  const gap = detectContacts([cube('a', [0, 0, 0]), cube('b', [10.2, 0, 0])]);
  assert.equal(gap.pairs.length, 0);
  const wide = detectContacts(
    [cube('a', [0, 0, 0]), cube('b', [10.2, 0, 0])],
    { tolerance: 0.25 },
  );
  assert.equal(wide.pairs.length, 1);
});

test('a disabled pair stays off when the same faces are detected again', () => {
  const detected = detectContacts([cube('a', [0, 0, 0]), cube('b', [10, 0, 0])]).pairs;
  const kept = mergeContactPairs(detected, [{ ...detected[0], enabled: false }]);
  assert.equal(kept[0].enabled, false);
  const flipped = mergeContactPairs(detected, [{
    a: detected[0].b,
    b: detected[0].a,
    kind: 'bonded',
    enabled: false,
  }]);
  assert.equal(flipped[0].enabled, false);
  assert.equal(mergeContactPairs(detected, [])[0].enabled, undefined);
});

test('faces on different parts are not the same fixture', () => {
  const face = { faceID: 1, at: [0, 0, 0], n: [0, 0, -1], area: 100, part: 'a' };
  assert.equal(sameStudyFace(face, { ...face, part: 'b' }), false);
  assert.equal(sameStudyFace(face, { ...face }), true);
});

test('sheet metal names a library material and the assembly scope stores it', () => {
  const script = 'const sheetSpec = {"sku":"SST316-125","material":"Stainless Steel (316 Series)"};';
  assert.equal(assignedMaterialFromScript(script), 'ss-304-annealed');
  assert.equal(assignedMaterialFromScript('const part = 1;'), null);
  const rows = [
    { id: 'sheet', geometry: { attributes: { position: { array: cube('sheet', [0, 0, 0]).positions } }, index: { array: cube('sheet', [0, 0, 0]).indices } }, faceIDs: cube('sheet', [0, 0, 0]).faceIDs },
    { id: 'block', geometry: { attributes: { position: { array: cube('block', [10, 0, 0]).positions } }, index: { array: cube('block', [10, 0, 0]).indices } }, faceIDs: cube('block', [10, 0, 0]).faceIDs },
  ];
  const next = studyWithScope(freshStudy(), { kind: 'assembly' }, rows, (id) => (id === 'sheet' ? script : ''));
  assert.equal(next.ok, true);
  assert.equal(next.study.scope.kind, 'assembly');
  assert.equal(next.study.parts.find((part) => part.id === 'sheet').material.id, 'ss-304-annealed');
  assert.equal(next.study.parts.find((part) => part.id === 'block').material.id, 'al-6061-t6');
  assert.equal(next.study.contacts.length, 1);
});
