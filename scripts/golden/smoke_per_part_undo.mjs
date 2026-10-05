#!/usr/bin/env node
/**
 * Per-part feature undo/redo (edit-what-you-touch slice B).
 *
 * Each part keeps its own stack. A fresh load seeds one commit per feature
 * marker so strip Undo walks that part's features. Undo on A never rewinds B.
 * Redo only exists in-session (reload puts the head on the full script).
 */
import { readFileSync } from 'node:fs';
import { composeHelperInsert } from '../../src/utils/helperPaletteSnippets.js';
import { parseFeatureMarkers } from '../../src/utils/featureMarkers.js';
import {
  featureHistoryCommits,
  historyForPart,
  pushPartHistory,
  redoPartHistory,
  scriptWithFeatureCount,
  undoPartHistory,
} from '../../src/utils/partHistory.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('per-part feature undo/redo');

function twoFeatureScript(firstId, filletRadius) {
  let script = composeHelperInsert('', firstId);
  script = composeHelperInsert(script, 'filletEdges', null, {
    radius: filletRadius,
    strategy: 'planar',
  });
  return script;
}

{
  const script = twoFeatureScript('cube', 2);
  const feats = parseFeatureMarkers(script);
  check('fixture has cube then fillet markers',
    feats.length === 2 && feats[0].kind === 'cube' && feats[1].kind === 'fillet');

  const none = scriptWithFeatureCount(script, 0);
  const cubeOnly = scriptWithFeatureCount(script, 1);
  const both = scriptWithFeatureCount(script, 2);
  check('zero features is an empty step', none === '');
  check('one feature keeps the cube and drops the fillet',
    cubeOnly.includes('cube')
    && cubeOnly.includes('Manifold.cube')
    && !cubeOnly.includes('filletEdges')
    && parseFeatureMarkers(cubeOnly).length === 1);
  check('all features is the full script', both === script);

  const commits = featureHistoryCommits(script);
  check('seed commits are Part → Cube → Fillet with head on full script',
    commits.length === 3
    && commits[0].message === 'Part'
    && commits[0].code === ''
    && commits[1].message === 'Cube'
    && commits[2].message === 'Fillet'
    && commits[2].code === script);
}

{
  const scriptA = twoFeatureScript('cube', 2);
  const scriptB = twoFeatureScript('cylinder', 1);
  const histories = {};
  histories.A = historyForPart(histories, 'A', scriptA);
  histories.B = historyForPart(histories, 'B', scriptB);

  check('fresh load enables Undo on a part with feature history',
    histories.A.head === 2
    && histories.A.head > 0
    && histories.B.head === 2
    && histories.A.head === histories.A.commits.length - 1
    && histories.B.head === histories.B.commits.length - 1);

  check('fresh load has no Redo (session-only)',
    histories.A.head >= histories.A.commits.length - 1
    && redoPartHistory(histories.A).code == null);

  const undoneA = undoPartHistory(histories.A);
  histories.A = undoneA.history;
  const headB = histories.B.commits[histories.B.head].code;
  check('undo on A drops the fillet and leaves B untouched',
    undoneA.code != null
    && !undoneA.code.includes('filletEdges')
    && undoneA.code.includes('Manifold.cube')
    && headB === scriptB
    && headB.includes('filletEdges')
    && headB.includes('cylinder')
    && histories.B.head === 2
    && histories.A.head === 1);

  const undoneA2 = undoPartHistory(histories.A);
  histories.A = undoneA2.history;
  check('second undo on A clears A and still leaves B',
    undoneA2.code === ''
    && histories.A.head === 0
    && histories.B.head === 2
    && histories.B.commits[histories.B.head].code === scriptB);

  const redoneA = redoPartHistory(histories.A);
  histories.A = redoneA.history;
  check('redo on A restores the cube only; B unchanged',
    redoneA.code.includes('Manifold.cube')
    && !redoneA.code.includes('filletEdges')
    && histories.B.commits[histories.B.head].code === scriptB);

  // Confirm on B is one feature step and does not touch A.
  const nextB = `${scriptB}// --- sphere begin ---\nlet sphere1 = Manifold.sphere(5, true);\npart = part.add(sphere1);\n// --- sphere end ---\n`;
  histories.B = pushPartHistory(histories.B, nextB, 'Helper insert');
  check('Confirm on B is one new step and does not move A',
    histories.B.head === 3
    && histories.B.commits.length === 4
    && histories.A.head === 1
    && histories.A.commits[histories.A.head].code.includes('Manifold.cube'));

  const undoneB = undoPartHistory(histories.B);
  histories.B = undoneB.history;
  check('undo on B rewinds only B; A stays on its cube step',
    undoneB.code === scriptB
    && histories.B.head === 2
    && histories.A.head === 1
    && !histories.A.commits[histories.A.head].code.includes('filletEdges'));
}

{
  const plain = 'let part = Manifold.cube([10, 10, 10], true);\nreturn part;\n';
  const seeded = historyForPart({}, 'plain', plain);
  check('unmarked script still seeds a single commit with Undo off',
    seeded.commits.length === 1
    && seeded.head === 0
    && seeded.commits[0].code === plain
    && undoPartHistory(seeded).code == null);
}

{
  const arch = read('docs/architecture.md');
  check('architecture documents per-part feature undo after load',
    /feature-wise|feature step|feature markers/i.test(arch)
    && /Fresh load|fresh load/i.test(arch)
    && /Redo/i.test(arch)
    && /each part keeps its own undo stack/i.test(arch));

  const app = read('src/App.jsx');
  const undoFn = app.slice(app.indexOf('const handleUndo = '), app.indexOf('const handleRedo = '));
  check('App undo still steps only the active part stack',
    /const id = historyKey\(\)/.test(undoFn)
    && /undoPartHistory\(/.test(undoFn)
    && /partHistoriesRef/.test(undoFn)
    && /\.setTextOnly\s*\?/.test(undoFn)
    && !/\.loadContent\s*\(/.test(undoFn));

  const pkg = read('package.json');
  check('package.json registers golden:per-part-undo',
    /"golden:per-part-undo"\s*:\s*"node scripts\/golden\/smoke_per_part_undo\.mjs"/.test(pkg));
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll per-part feature undo checks passed.');
