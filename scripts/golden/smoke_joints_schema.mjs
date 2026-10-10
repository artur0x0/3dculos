#!/usr/bin/env node
/**
 * Joints in .surf.json. A file with no joints stays byte-identical.
 * Bad joints fail validateSurfJson with a specific message. A joint
 * that names a missing surf id is dropped on load. position stays
 * equal to placement.t. The IndexedDB document shape keeps joints.
 */
import { parseAssemblyDocument, serializeAssembly } from '../../src/utils/assembly.js';
import { mintSurfId } from '../../src/utils/git/surfId.js';
import { parseSurfJson, stringifySurfJson, validateSurfJson } from '../../src/utils/git/surfJson.js';

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(name, g === w, `got ${g}, want ${w}`);
}

const A = mintSurfId({ now: new Date('2026-10-08T02:00:00.001Z'), rand: 'a3f9' });
const B = mintSurfId({ now: new Date('2026-10-08T02:00:00.002Z'), rand: 'b10c' });
const J = mintSurfId({ now: new Date('2026-10-08T02:00:00.003Z'), rand: 'ee11' });
const GONE = mintSurfId({ now: new Date('2026-10-08T02:00:00.004Z'), rand: 'd00d' });
const PATH_A = 'assemblies/Gearbox/Bracket.js';
const PATH_B = 'assemblies/Gearbox/Housing.js';
const FACE = { at: [0, 0, 5], n: [0, 0, 1], area: 100 };
const FACE_B = { at: [0, 0, 0], n: [0, 0, -1], area: 80 };

const LEGACY = stringifySurfJson({
  source: 'git',
  name: 'Gearbox',
  activeId: PATH_A,
  parts: [{ id: PATH_A, name: 'Bracket', visible: true, order: 0, position: [0, 0, 0], surfId: A }],
});

function row(path, id, order) {
  return {
    id,
    path,
    name: path.split('/').pop().replace(/\.js$/, ''),
    visible: true,
    order,
  };
}

function file(extra = {}) {
  return {
    format: 'surfcad.assembly',
    version: 1,
    name: 'Gearbox',
    activeId: PATH_A,
    parts: [row(PATH_A, A, 0), row(PATH_B, B, 1)],
    ...extra,
  };
}

function face(part, key) {
  return { part, kind: 'face', key };
}

const joint = {
  id: J,
  name: 'Coincident 1',
  type: 'coincident',
  a: face(A, FACE),
  b: face(B, FACE_B),
};

ok('legacy file round-trips byte-identical', stringifySurfJson(parseSurfJson(LEGACY)) === LEGACY);
ok('legacy file has no placement or joints', !LEGACY.includes('"placement"') && !LEGACY.includes('"joints"'));
ok('legacy file has no placement on the row', !Object.hasOwn(parseSurfJson(LEGACY).parts[0], 'placement'));

function rejects(name, joints, text) {
  const verdict = validateSurfJson(file({ joints }));
  ok(name, !verdict.ok && verdict.errors.some((line) => line.includes(text)),
    (verdict.errors || []).join('; '));
}

rejects('unknown joint type', [{ ...joint, type: 'mate' }], 'type must be coincident');
rejects('unknown joint key', [{ ...joint, mate: true }], 'unknown key "mate"');
rejects('bad joint id', [{ ...joint, id: 'not-a-surf-id' }], 'id must be a surf id');
rejects('fixed with b', [{
  id: J, name: 'Ground 1', type: 'fixed', a: { part: A }, b: { part: B },
}], 'b is omitted on a fixed joint');
rejects('distance without value', [{
  id: J, name: 'Distance 1', type: 'distance', sense: 1, a: face(A, FACE), b: face(B, FACE_B),
}], 'value must be a finite number');
rejects('duplicate joint id', [joint, { ...joint, name: 'Coincident 2' }], `id duplicates ${J}`);

const dangling = file({
  joints: [joint, { ...joint, id: GONE, name: 'Gone', a: face(GONE, FACE) }],
});
const loaded = parseSurfJson(dangling);
eq('dangling joint is dropped', loaded.joints.map((item) => item.id), [J]);
ok('kept joint round-trips', stringifySurfJson(parseSurfJson(stringifySurfJson(loaded))) === stringifySurfJson(loaded));

const mismatch = file();
mismatch.parts[0] = { ...mismatch.parts[0], position: [1, 0, 0], placement: { t: [2, 0, 0], q: [0, 0, 0, 1] } };
const badPose = validateSurfJson(mismatch);
ok('position must equal placement.t', !badPose.ok && badPose.errors.some((line) => line.includes('position must equal placement.t')));

const stored = serializeAssembly({
  source: 'local',
  name: 'Gearbox',
  activeId: PATH_A,
  parts: [
    { id: PATH_A, name: 'Bracket', surfId: A, position: [5, 0, 0], placement: { t: [5, 0, 0], q: [0, 0, 1, 0] } },
    { id: PATH_B, name: 'Housing', surfId: B },
  ],
  joints: [joint],
});
const again = parseAssemblyDocument(JSON.parse(JSON.stringify(stored)));
eq('IndexedDB serialize keeps the joint', again.joints[0].id, J);
eq('placement.t matches position', again.parts[0].placement.t, again.parts[0].position);
ok('opposed is written', again.joints[0].opposed === true);
const written = JSON.parse(stringifySurfJson(again));
eq('file position equals placement.t', written.parts[0].position, written.parts[0].placement.t);

console.log(`\njoints schema: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
