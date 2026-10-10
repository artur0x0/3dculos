#!/usr/bin/env node
/**
 * Joints on the CAD feature strips, the shared sticky-pick card, and
 * the floating tags. Screenshots are not written.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { serializeAssembly } from '../../src/utils/assembly.js';
import { composeMoveCommit } from '../../src/utils/moveMode.js';
import { refreshAssemblyJoints } from '../../src/joints/refreshJoints.js';
import {
  SAME_PART_MESSAGE,
  acceptJointPick,
  applyJointCard,
  dismissJointEdit,
  draftFromPicks,
  emptyClickCadSelection,
  jointChips,
  jointsChromeMounted,
  seedAssemblyHistory,
  stripUndoTarget,
  suggestJointType,
  undoJointStrip,
} from '../../src/joints/jointUi.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const A = '2026-10-10-03-00-00-0001-aaaa';
const B = '2026-10-10-03-00-00-0002-bbbb';
const J = '2026-10-10-03-00-00-0003-cccc';

const planar = (surfId, name, at, n) => ({
  surfId,
  partName: name,
  kind: 'face',
  planar: true,
  key: { at, n, area: 1 },
});
const axle = (surfId, name) => ({
  surfId,
  partName: name,
  kind: 'axis',
  axis: true,
  planar: false,
  key: { at: [0, 0, 0], dir: [0, 0, 1], radius: 2 },
});

const faces = [planar(A, 'Shaft', [0, 0, 1], [0, 0, 1]), planar(B, 'Housing', [0, 0, -1], [0, 0, -1])];
check('two planar faces suggest coincident', suggestJointType(faces) === 'coincident');
check('two axes suggest concentric', suggestJointType([axle(A, 'Shaft'), axle(B, 'Housing')]) === 'concentric');
check('two-face flow does not suggest fixed', suggestJointType(faces) !== 'fixed');
const same = acceptJointPick([faces[0]], faces[0]);
check('same-part second tap is refused', same.refuse && same.message === SAME_PART_MESSAGE);

const parts = [
  { id: 'a.js', name: 'Shaft', visible: true, order: 0, surfId: A, position: [0, 0, 0] },
  { id: 'b.js', name: 'Housing', visible: true, order: 1, surfId: B, position: [0, 0, 5], placement: { t: [0, 0, 5], q: [0, 0, 0, 1] } },
];
const doc = { version: 1, source: 'local', name: 'Assembly', activeId: 'a.js', parts };
const scripts = { 'a.js': 'let part = cube([20, 20, 20]);\nreturn part;\n' };
const card = draftFromPicks(null, [
  planar(A, 'Shaft', [0, 0, 0.5], [0, 0, 1]),
  planar(B, 'Housing', [0, 0, -0.5], [0, 0, -1]),
], { joints: [] });
check('dismiss writes nothing', dismissJointEdit(doc) === doc);
const confirmed = applyJointCard({
  doc,
  scripts,
  card,
  catalogs: {
    [A]: { faces: [{ at: [0, 0, 0.5], n: [0, 0, 1], area: 1 }] },
    [B]: { faces: [{ at: [0, 0, -0.5], n: [0, 0, -1], area: 1 }] },
  },
});
check('confirm writes a joint and no script', confirmed.ok && confirmed.scripts === scripts && confirmed.doc.joints.length === 1, confirmed.message || '');
const removed = applyJointCard({
  doc: confirmed.doc,
  scripts,
  card: { mode: 'edit', id: confirmed.doc.joints[0].id },
  action: 'delete',
});
check('delete removes the joint', removed.ok && removed.scripts === scripts && !serializeAssembly(removed.doc).joints);

const undone = undoJointStrip({
  history: seedAssemblyHistory(doc),
  doc: confirmed.doc,
  scripts,
});
check('undo with no earlier joint step leaves scripts', undone.scripts === scripts && undone.changed === false);
const pushed = {
  commits: [
    { joints: [], placements: {} },
    { joints: confirmed.doc.joints, placements: { [B]: { t: [0, 0, 5], q: [0, 0, 0, 1] } } },
  ],
  head: 1,
};
const back = undoJointStrip({ history: pushed, doc: confirmed.doc, scripts });
check('strip undo while no part is selected restores joints', back.changed && back.scripts === scripts && !back.doc.joints);
check('strip undo with a part selected stays on that stack', stripUndoTarget('a.js') === 'part' && stripUndoTarget(null) === 'joint');
const cleared = emptyClickCadSelection({ cadPartId: 'b.js', activeId: 'a.js' });
check('empty click clears cadPartId and leaves activeId', cleared.cadPartId == null && cleared.activeId === 'a.js');
check('game mode renders no joint card', jointsChromeMounted({ appMode: 'game' }) === false);

const moved = composeMoveCommit(scripts['a.js'], {
  direction: 'xyz', dx: 10, dy: 0, dz: 0, target: { at: [10, 10, 10] }, body: 'part',
});
const joint = {
  id: J, name: 'Coincident 1', type: 'coincident', opposed: true,
  a: { part: A, kind: 'face', key: { at: [0, 0, 0.5], n: [0, 0, 1], area: 1 } },
  b: { part: B, kind: 'face', key: { at: [0, 0, -0.5], n: [0, 0, -1], area: 1 } },
};
const joined = { ...doc, joints: [joint] };
const seedT = joined.parts[1].placement.t.slice();
const broken = refreshAssemblyJoints({
  doc: joined,
  catalogs: {
    [A]: { faces: [{ at: [10, 0, 0.5], n: [0, 0, 1], area: 1 }] },
    [B]: { faces: [{ at: [0, 0, -0.5], n: [0, 0, -1], area: 1 }] },
  },
});
check('Move Body of 10 mm is the only script change', moved.ok && (moved.buffer.match(/\bmove\s*\(/g) || []).length === 1 && !scripts['a.js'].includes('move('));
check('that move marks the joint broken and leaves placement', broken.statuses[J] === 'broken' && broken.doc.parts[1].placement.t.every((n, i) => n === seedT[i]));

const chips = jointChips(joined, {
  statuses: { [J]: 'broken' },
  messages: { [J]: 'Face not found on Housing' },
});
const conflict = jointChips(
  { joints: [{ ...joint, name: 'Angle 1' }] },
  { statuses: { [J]: 'conflict' }, messages: { [J]: 'Joint "Angle 1" conflicts' } },
);

const dir = mkdtempSync(join(tmpdir(), 'joints-strip-'));
const out = join(dir, 'ui.mjs');
const res = await build({
  stdin: {
    contents: `export { renderToStaticMarkup } from 'react-dom/server';
export { createElement } from 'react';
export { default as FeatureStrip } from './src/components/FeatureStrip.jsx';
export { default as JointCard } from './src/components/JointCard.jsx';
export { default as JointTags } from './src/components/JointTags.jsx';`,
    resolveDir: ROOT,
    loader: 'jsx',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl' },
  logLevel: 'error',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
writeFileSync(out, res.outputFiles[0].text);
const ui = await import(out);
rmSync(dir, { recursive: true, force: true });

const h = (C, props) => {
  const err = console.error;
  console.error = (...args) => {
    if (!/useLayoutEffect does nothing on the server/.test(String(args[0]))) err(...args);
  };
  try { return ui.renderToStaticMarkup(ui.createElement(C, props)); } finally { console.error = err; }
};

const emptyProps = { joints: [], hideWhenEmpty: true, onUndo: () => {}, onRedo: () => {} };
for (const [label, props] of [
  ['mobile CAD strip', { orientation: 'horizontal', ...emptyProps }],
  ['desktop CAD strip', { orientation: 'horizontal', ...emptyProps }],
]) {
  const html = h(ui.FeatureStrip, props);
  check(`${label}: No assembly joints`, html.includes('No assembly joints') && html.includes('data-assembly-joints') && html.includes('data-feature-strip-empty'), html.slice(0, 180));
  check(`${label}: Undo and Redo stay`, html.includes('data-feature-bar-undo') && html.includes('data-feature-bar-redo'));
}
const scriptHtml = h(ui.FeatureStrip, { orientation: 'vertical', script: '', hideWhenEmpty: false });
check('script-stage strip does not show assembly joints', !scriptHtml.includes('No assembly joints') && !scriptHtml.includes('data-assembly-joints'));
const hiddenFeatures = h(ui.FeatureStrip, { orientation: 'horizontal', script: '', hideWhenEmpty: true });
check('part features still hide their empty caption', !hiddenFeatures.includes('No features') && !hiddenFeatures.includes('No assembly joints'));

const chipHtml = h(ui.FeatureStrip, {
  orientation: 'horizontal',
  joints: [...chips, ...conflict],
  hideWhenEmpty: true,
  undoLabel: 'Undo joint',
});
check('a broken chip has the red ring and the joint name', /data-joint-id="/.test(chipHtml) && chipHtml.includes('border-red-400') && chipHtml.includes('feature-failed-ring') && chipHtml.includes('Coincident 1') && chipHtml.includes('aria-invalid'));
check('a conflict chip names the joint', chipHtml.includes('Angle 1') && chipHtml.includes('conflicts'));
check('joint undo title', chipHtml.includes('Undo joint'));

const sheet = h(ui.JointCard, {
  card,
  unit: 'mm',
  onChange: () => {},
  onConfirm: () => {},
  onCancel: () => {},
});
check('the create card is StickyPickApply', sheet.includes('data-sticky-pick-apply') && sheet.includes('data-joint-card') && sheet.includes('data-feature-card-cancel') && sheet.includes('Suggested: Coincident'));
check('the card is not fullLeft', !sheet.includes('data-feature-card-full-left'));
check('subtitle names both faces', sheet.includes('Shaft') && sheet.includes('Housing'));
const game = jointsChromeMounted({ appMode: 'game' }) ? h(ui.JointCard, { card }) : '';
check('game mode renders no joint card markup', game === '');

const tagHtml = h(ui.JointTags, {
  tags: [{
    id: J,
    type: 'coincident',
    label: 'Coincident 1',
    title: 'Coincident 1 — Face not found on Housing',
    invalid: true,
    world: [0, 0, 2.5],
  }],
  selectedId: J,
});
check('a joint tag opens Delete and X', tagHtml.includes(`data-joint-tag="${J}"`) && tagHtml.includes('data-joint-tag-popup') && tagHtml.includes('data-joint-tag-delete') && tagHtml.includes('>Delete<') && tagHtml.includes('data-joint-tag-close') && tagHtml.includes('Close'));
check('a tag tap does not reopen the joint card', !tagHtml.includes('data-joint-card'));
check('a broken tag has the red ring', tagHtml.includes('border-red-400') && tagHtml.includes('feature-failed-ring') && tagHtml.includes('aria-invalid') && tagHtml.includes('Coincident 1'));

const app = read('src/App.jsx');
check('App keeps the joint card off in game', app.includes("appMode !== 'game'") && app.includes('jointCard={jointCardNode}') && app.includes('jointTags={jointTagList}'));
check('joint picking follows the open create card', app.includes('jointPicking={jointCreateOpen}'));
check('Blocks opens the joint card', read('src/components/HelperInsertPalette.jsx').includes('data-joints-button'));
check('App empty click does not assign activeId', app.includes('handleCadEmptyClick') && app.includes('emptyClickCadSelection'));
check('a strip chip selects the tag', app.includes('setJointTagId') && !app.includes('JointModeChip'));

if (failed) {
  console.error(`\n${failed} joints-strip check(s) failed`);
  process.exit(1);
}
console.log('\njoints strip golden passed');
