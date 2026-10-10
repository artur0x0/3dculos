#!/usr/bin/env node
/**
 * Joint re-resolution and the rigid pose. Numeric: a drifted face still
 * matches, a 5 mm move and an ambiguous pair stay broken, the pose is the
 * matrixWorld a bonded study reads, and a rotated cross-part copy writes
 * no script.
 */
import { readFileSync } from 'node:fs';
import { Group, Mesh } from 'three';
import { shiftLocalPoint } from '../../src/utils/activePartOverlay.js';
import { crossPartSubtractWrites } from '../../src/utils/externalCopy.js';
import { matchJointFace } from '../../src/utils/jointResolve.js';
import { applyPartPose, frameElements, worldPoint } from '../../src/utils/partPose.js';
import { commitJointEdit, refreshAssemblyJoints } from '../../src/joints/refreshJoints.js';
import { quatFromOmega } from '../../src/joints/rigid.js';

let failed = 0;
let passed = 0;
function ok(name, cond) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ ${name}`); }
}

const A = '2026-10-10-03-00-00-0001-aaaa';
const B = '2026-10-10-03-00-00-0002-bbbb';
const J = '2026-10-10-03-00-00-0003-cccc';
const FACE = { at: [0, 0, 0.5], n: [0, 0, 1], area: 1 };
const tilt = 3 * Math.PI / 180;
ok('face matches after 0.4 mm and 3 degrees', matchJointFace([{
  at: [0.4, 0, 0.5],
  n: [Math.sin(tilt), 0, Math.cos(tilt)],
  area: 1,
}], FACE).status === 'ok');

const parts = [
  { id: 'a.js', name: 'Shaft', visible: true, order: 0, surfId: A, position: [0, 0, 0] },
  {
    id: 'b.js', name: 'Housing', visible: true, order: 1, surfId: B,
    position: [0, 0, 5], placement: { t: [0, 0, 5], q: [0, 0, 0, 1] },
  },
];
const coincident = {
  id: J, name: 'Coincident 1', type: 'coincident', opposed: true,
  a: { part: A, kind: 'face', key: { at: [0, 0, 0.5], n: [0, 0, 1], area: 1 } },
  b: { part: B, kind: 'face', key: { at: [0, 0, -0.5], n: [0, 0, -1], area: 1 } },
};
const doc = {
  version: 1, source: 'local', name: 'Assembly', activeId: 'a.js', parts, joints: [coincident],
};

const moved = refreshAssemblyJoints({
  doc,
  catalogs: {
    [A]: { faces: [{ at: [0, 0, 0.5], n: [0, 0, 1], area: 1 }] },
    [B]: { faces: [{ at: [0, 0, 4.5], n: [0, 0, -1], area: 1 }] },
  },
});
ok('5 mm move is broken', moved.statuses[J] === 'broken' && moved.doc.parts[1].placement.t[2] === 5);

const ambiguous = refreshAssemblyJoints({
  doc,
  catalogs: {
    [A]: { faces: [{ at: [0, 0, 0.5], n: [0, 0, 1], area: 1 }] },
    [B]: {
      faces: [
        { at: [0.2, 0, -0.5], n: [0, 0, -1], area: 1 },
        { at: [-0.2, 0, -0.5], n: [0, 0, -1], area: 1 },
      ],
    },
  },
});
ok('ambiguous face is not guessed', ambiguous.statuses[J] === 'broken'
  && ambiguous.messages[J] === 'More than one face matches on Housing'
  && ambiguous.doc.joints[0].b.key.at[0] === 0);

const failedRun = refreshAssemblyJoints({
  doc,
  catalogs: {
    [A]: { faces: [{ at: [0, 0, 0.5], n: [0, 0, 1], area: 1 }] },
    [B]: { failed: true, faces: [{ at: [0, 0, -0.5], n: [0, 0, -1], area: 1 }] },
  },
});
ok('failed run does not solve the leftover', failedRun.statuses[J] === 'broken' && failedRun.doc.parts[1].placement.t[2] === 5);

const q = quatFromOmega([0, 0, Math.PI / 2]);
const placement = { t: [4, 5, 6], q };
const group = new Group();
group.name = 'assembly-parts';
const mesh = new Mesh();
group.add(mesh);
applyPartPose(group, { t: [0, 0, 0], q: [0, 0, 0, 1] });
applyPartPose(mesh, placement);
group.updateMatrixWorld(true);
const matrix = frameElements(mesh);
const expected = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1];
ok('matrixWorld is the 90 degree pose', matrix.every((value, i) => Math.abs(value - expected[i]) < 1e-9)
  && mesh.scale.x === 1 && mesh.scale.y === 1 && mesh.scale.z === 1
  && group.name === 'assembly-parts'
  && Math.abs(frameElements(group)[0] - 1) < 1e-12
  && Math.abs(frameElements(group)[5] - 1) < 1e-12);
const fitted = worldPoint([1, 0, 0], placement);
const shifted = shiftLocalPoint([1, 0, 0], placement.t, placement.q);
ok('auto-fit and shiftLocalPoint use the rigid pose', Math.abs(fitted[0] - 4) < 1e-9
  && Math.abs(fitted[1] - 6) < 1e-9
  && Math.abs(shifted[0] - fitted[0]) < 1e-9
  && Math.abs(shifted[1] - fitted[1]) < 1e-9);

const viewport = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
ok('placeAssembly applies the pose', viewport.includes('applyPartPose') && viewport.includes('updateMatrixWorld(true)'));

const script = 'let part = box(1, 1, 1);\nreturn part;\n';
const target = { id: 'b', script, position: [0, 0, 0], placement: { t: [0, 0, 0], q: [0, 0, 0, 1] } };
const writes = crossPartSubtractWrites({
  candidates: [{ id: 'b', offset: [0, 0, 0] }],
  begin: '/* @feature start */',
  end: '/* @feature end */',
  ref: 'abcd1234',
  body: 'return box();',
}, {
  source: { id: 'a', name: 'Shaft', placement: { t: [0, 0, 0], q } },
  parts: [target],
  overlapIds: ['b'],
});
ok('rotated cross-part subtract writes no script', writes.length === 0 && target.script === script);

const scripts = { 'a.js': script, 'b.js': script };
let preempted = false;
const confirmed = commitJointEdit({
  doc: { ...doc, joints: [] },
  scripts,
  action: 'confirm',
  joint: coincident,
  preempt: () => { preempted = true; },
});
const locked = commitJointEdit({
  doc,
  scripts,
  action: 'delete',
  joint: coincident,
  locked: true,
  preempt: () => { preempted = true; },
});
ok('joint confirm does not change script bytes', confirmed.ok && confirmed.scripts['a.js'] === script && confirmed.scripts['b.js'] === script);
ok('locked confirm and delete do not preempt', locked.ok === false && locked.doc === doc && preempted === false);

console.log(`\njoints resolve: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
