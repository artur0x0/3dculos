#!/usr/bin/env node
/**
 * Assemblies: a parts feed, one script in the editor, every visible part
 * in the viewport.
 *
 * Selecting a row loads that part's script. Hiding a row drops it from the
 * composed viewport. A failed script highlights the row and contributes no
 * solid, including no previous solid. The saved assembly lists ids, never
 * inline scripts.
 *
 * Spawning a new part still auto-drops a 20 mm box, and that box is a Cube
 * feature (same markers as a palette Cube). An unmarked `let part = cube`
 * would run the solid and leave the feature strip empty.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import {
  composeViewportParts,
  feedRows,
  parseAssemblyDocument,
  recordPartRun,
  resolvePartId,
  scriptForRow,
  serializeAssembly,
  setPartVisible,
} from '../../src/utils/assembly.js';
import { runAssemblyParts } from '../../src/utils/assemblyRun.js';
import {
  composeHelperInsert,
  newPartStarterScript,
  CUBE_BEGIN,
  CUBE_END,
} from '../../src/utils/helperPaletteSnippets.js';
import { parseFeatureMarkers } from '../../src/utils/featureMarkers.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const BOX = 'let part = Manifold.cube([10, 10, 10], true);\nreturn part;\n';
const WIDE = 'let part = Manifold.cube([4, 4, 4], true);\nreturn part;\n';
const BAD = 'let part = Manifold.cube([10, 10, 10], true);\nreturn part.missingMethod();\n';

{
  const app = read('src/App.jsx');
  const feed = read('src/components/PartFeed.jsx');
  const view = read('src/components/Viewport.jsx');
  const toggle = read('src/components/MobileStageToggle.jsx');
  const arch = read('docs/architecture.md');
  const selectFn = app.slice(app.indexOf('const handleSelectPart'), app.indexOf('const handleTogglePartVisible'));
  const place = view.slice(view.indexOf('placeAssemblyRef.current ='), view.indexOf('Download the current model'));
  const fail = view.slice(view.indexOf('assembly-fail:'), view.indexOf('return noShadow'));

  check('desktop feed sits to the left of the editor',
    (() => {
      const desk = app.slice(app.lastIndexOf('flex h-dvh bg-gray-900'));
      const feedAt = desk.indexOf('data-parts-feed-placement="desktop-left"');
      const editorAt = desk.indexOf('<CodeEditor');
      return feedAt >= 0 && editorAt > feedAt;
    })());
  check('selecting a row loads that part script into Monaco',
    /scriptForRow\(/.test(selectFn) && /loadContent\(picked\.script/.test(selectFn));
  check('an eye toggles visibility and the viewport is recomposed',
    /setPartVisible\(/.test(app) && /composeViewportParts\(/.test(app) && /placeAssembly/.test(app));
  check('feed row has a thumbnail, a red selection bar, and an eye',
    /data-part-thumbnail/.test(feed)
    && /data-part-selected-bar/.test(feed)
    && /bg-red-500/.test(feed)
    && /data-part-visibility=/.test(feed));
  check('a failed row is highlighted and a missing row offers find or upload',
    /data-part-status=\{status\}/.test(feed)
    && /data-part-error/.test(feed)
    && /Find in repo/.test(feed)
    && /Upload/.test(feed)
    && /data-assembly-load/.test(feed));
  check('mobile pager order is CAD, Script, then Parts',
    (() => {
      const cad = toggle.indexOf('data-stage-dot="cad"');
      const script = toggle.indexOf('data-stage-dot="script"');
      const parts = toggle.indexOf('data-stage-dot="parts"');
      return cad >= 0 && cad < script && script < parts
        && /data-stage-pane="parts"/.test(app)
        && /data-stage-btn="parts"/.test(toggle);
    })());
  check('a failed assembly part drops the cached solid and does not rebuild from it',
    /noShadow/.test(view)
    && /cachedMeshDataRef\.current = null/.test(fail)
    && !/renderMeshData\(prev\)/.test(fail)
    && !/previousMesh/.test(place)
    && /syncFeatureEdges\(/.test(view));
  check('placeAssembly draws the other visible parts and does not sync their graphs',
    /assembly-parts/.test(place) && !/syncFeatureEdges\(/.test(place));
  check('architecture covers the feed, ids, failure, and graph rebuild',
    /Parts feed/.test(arch)
    && /repo path/.test(arch)
    && /IndexedDB key/.test(arch)
    && /no shadow solid/.test(arch)
    && /does not rebuild from a previous solid/.test(arch));
}

{
  const starter = newPartStarterScript();
  const feats = parseFeatureMarkers(starter);
  const cubes = feats.filter((f) => f.kind === 'cube');
  const placed = composeHelperInsert('', 'cube', null, {
    width: 20,
    depth: 20,
    height: 20,
    center: true,
  });
  const placedFeats = parseFeatureMarkers(placed || '');
  check('new-part starter still drops a 20 mm box',
    /Manifold\.cube\(\[20,\s*20,\s*20\],\s*true\)/.test(starter)
    && /return part;/.test(starter));
  check('new-part starter box registers as a cube feature',
    cubes.length === 1
    && cubes[0].kind === 'cube'
    && starter.includes(CUBE_BEGIN)
    && starter.includes(CUBE_END),
    `kinds=${feats.map((f) => f.kind).join(',') || '(none)'}`);
  check('starter feature matches a user-placed 20 mm cube',
    starter === placed
    && placedFeats.length === 1
    && placedFeats[0].kind === 'cube'
    && placedFeats[0].chipLabel === cubes[0]?.chipLabel);

  const app = read('src/App.jsx');
  const add = app.slice(app.indexOf('const handleAddPart'), app.indexOf('const handleAddGitPart'));
  check('spawn writes the marked starter, not an unmarked cube',
    /newPartStarterScript\(/.test(add)
    && !/let part = Manifold\.cube\(\[20,\s*20,\s*20\]/.test(add));

  let ops = composeHelperInsert('', 'cube');
  ops = composeHelperInsert(ops, 'filletEdges', null, { radius: 2, strategy: 'planar' });
  const opFeats = parseFeatureMarkers(ops || '');
  check('a user cube then a fillet still both register',
    opFeats.some((f) => f.kind === 'cube') && opFeats.some((f) => f.kind === 'fillet'),
    `kinds=${opFeats.map((f) => f.kind).join(',') || '(none)'}`);

  const after = composeHelperInsert(starter, 'cylinder');
  const afterFeats = parseFeatureMarkers(after || '');
  check('starter cube stays a feature after a later operation',
    afterFeats.filter((f) => f.kind === 'cube').length === 1
    && afterFeats.some((f) => f.kind === 'cylinder'),
    `kinds=${afterFeats.map((f) => f.kind).join(',') || '(none)'}`);
}

{
  const doc = serializeAssembly({
    source: 'local',
    activeId: 'local:wide',
    parts: [
      { id: 'local:box', name: 'Box', visible: true, order: 0, position: [30, 0, 0], script: BOX },
      { id: 'local:wide', name: 'Wide', visible: true, order: 1, script: WIDE },
    ],
  });
  const scripts = { 'local:box': BOX, 'local:wide': WIDE };
  const saved = JSON.stringify(doc);
  check('saved assembly lists ids and not inline scripts',
    saved.includes('local:box')
    && saved.includes('"order":0')
    && saved.includes('"visible":true')
    && !saved.includes('Manifold')
    && !saved.includes('"script"'));
  check('a stored position is kept and a missing one is omitted',
    doc.parts.find((part) => part.id === 'local:box').position[0] === 30
    && !('position' in doc.parts.find((part) => part.id === 'local:wide')));

  const picked = scriptForRow(doc, scripts, 'local:box');
  check('selecting a row resolves that script from the id, not the document',
    picked.ok === true && picked.script === BOX && picked.script !== WIDE);

  const hidden = setPartVisible(doc, 'local:box', false);
  const hiddenRuns = {
    'local:box': { ok: true, mesh: { vertProperties: [1, 2, 3], triVerts: [0, 0, 0] } },
    'local:wide': { ok: true, mesh: { vertProperties: [4, 5, 6], triVerts: [0, 0, 0] } },
  };
  const hiddenSolids = composeViewportParts(hidden, hiddenRuns);
  check('hiding a row drops it from the composed viewport',
    hiddenSolids.length === 1 && hiddenSolids[0].id === 'local:wide');

  const poisoned = recordPartRun(hiddenRuns, 'local:box', {
    ok: false,
    error: 'nope',
    mesh: hiddenRuns['local:box'].mesh,
    previousMesh: hiddenRuns['local:box'].mesh,
  });
  const poisonedSolids = composeViewportParts(doc, poisoned);
  check('a failed run contributes no solid and keeps no previous mesh',
    poisoned['local:box'].mesh == null
    && !poisonedSolids.some((solid) => solid.id === 'local:box')
    && poisonedSolids.some((solid) => solid.id === 'local:wide'));
  const flags = feedRows(doc, poisoned, scripts).find((row) => row.id === 'local:box');
  check('a failed script highlights that row',
    flags.error === true && flags.mesh == null && flags.missing === false);

  const git = parseAssemblyDocument(JSON.stringify({
    source: 'git',
    activeId: 'parts/arm.js',
    parts: [{ id: 'parts/arm.js', name: 'Arm', visible: true, order: 0, script: BOX }],
  }));
  check('git id is a repo path and a missing row asks to find the file',
    git.source === 'git'
    && git.parts[0].id === 'parts/arm.js'
    && !JSON.stringify(git).includes('Manifold')
    && resolvePartId('git', 'parts/arm.js', {}).action === 'find-in-repo');
  check('local id is an IndexedDB key and a missing row asks to upload',
    resolvePartId('local', 'local:gone', {}).action === 'upload'
    && feedRows(doc, {}, {})[0].action === 'upload');
  const placed = composeViewportParts(doc, {
    'local:box': { ok: true, mesh: { vertProperties: [0, 0, 0] } },
  });
  check('the viewport uses a stored position',
    placed[0].id === 'local:box' && placed[0].position[0] === 30 && placed[0].position[1] === 0);
}

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(msg.payload?.message || 'worker error'));
    else waiter.resolve(msg);
  },
};
globalThis.self = workerSelf;

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => {
      if (!workerSelf.onmessage) {
        reject(new Error('sandboxWorker handler missing'));
        return;
      }
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

register('./manifold-resolve-hook.mjs', import.meta.url);
await import('../../src/workers/sandboxWorker.js');
await send('init');

async function execute(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}

{
  const doc = serializeAssembly({
    source: 'local',
    activeId: 'local:wide',
    parts: [
      { id: 'local:box', name: 'Box', visible: true, order: 0, position: [30, 0, 0] },
      { id: 'local:wide', name: 'Wide', visible: true, order: 1 },
    ],
  });
  const scripts = { 'local:box': BOX, 'local:wide': WIDE };
  const dropped = await execute(newPartStarterScript());
  check('the auto-dropped box is still a 20 mm cube solid',
    Math.abs(dropped.volume - 8000) < 1e-3
    && dropped.mesh?.vertProperties?.length > 0,
    `vol=${dropped.volume}`);
  const both = await runAssemblyParts({ doc, scripts, execute });
  check('both visible parts become solids',
    both.solids.length === 2
    && both.solids[0].id === 'local:box'
    && both.solids[0].position[0] === 30
    && both.solids[0].mesh.vertProperties.length > 0
    && both.solids[1].id === 'local:wide');

  const hidden = await runAssemblyParts({
    doc: setPartVisible(doc, 'local:box', false),
    scripts,
    execute,
  });
  check('hiding a row removes its solid from the worker compose',
    hidden.solids.length === 1 && hidden.solids[0].id === 'local:wide');

  const broke = await runAssemblyParts({
    doc,
    scripts: { ...scripts, 'local:box': BAD },
    execute,
  });
  check('a failing script adds no solid after a previous success',
    broke.runs['local:box'].ok === false
    && broke.runs['local:box'].mesh == null
    && !broke.solids.some((solid) => solid.id === 'local:box')
    && broke.solids.some((solid) => solid.id === 'local:wide')
    && broke.runs['local:box'].mesh !== both.runs['local:box'].mesh);
  const row = feedRows(doc, broke.runs, { ...scripts, 'local:box': BAD })
    .find((entry) => entry.id === 'local:box');
  check('the failed row is marked and carries no mesh',
    row.error === true && row.mesh == null);
}

if (failed) {
  console.log(`\n${failed} assembly check(s) failed`);
  process.exit(1);
}
console.log('\nAll assembly checks passed.');
