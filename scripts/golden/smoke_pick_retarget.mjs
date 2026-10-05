#!/usr/bin/env node
/**
 * Pick retarget: a face, edge, or body hit makes that part the edit target.
 * The nearest hit wins. A second part within the seam gap offers a which-part
 * chip. Hidden parts are not candidates. A failed row's leftover mesh is.
 * The script pane stays pinned until a body click, Parts, or Script — or a
 * pick inside a feature, so Accept still writes the touched part.
 */
import { readFileSync } from 'node:fs';
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from 'three';
import { serializeAssembly } from '../../src/utils/assembly.js';
import {
  AMBIGUOUS_HIT_GAP,
  emptyClickClearsSelection,
  featureHideKeepsPicks,
  featureStripHidden,
  leftoverPickSolids,
  partIsPickable,
  resolvePartPick,
  shouldSyncScript,
} from '../../src/utils/pickRetarget.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function box(id, position) {
  const mesh = new Mesh(new BoxGeometry(10, 10, 10), new MeshBasicMaterial());
  mesh.position.set(position[0], position[1], position[2]);
  mesh.updateMatrixWorld(true);
  mesh.userData.assemblyPartId = id;
  return { id, mesh, position };
}

function rayHits(solids, origin, direction) {
  const raycaster = new Raycaster();
  raycaster.set(new Vector3(...origin), new Vector3(...direction).normalize());
  const hits = [];
  for (const solid of solids) {
    for (const hit of raycaster.intersectObject(solid.mesh, false)) {
      hits.push({ partId: solid.id, distance: hit.distance, faceIndex: hit.faceIndex });
    }
  }
  return hits;
}

{
  const separated = [box('A', [0, 0, 0]), box('B', [40, 0, 0])];
  const ontoA = resolvePartPick(rayHits(separated, [-20, 0, 0], [1, 0, 0]));
  const ontoB = resolvePartPick(rayHits(separated, [80, 0, 0], [-1, 0, 0]));
  check('a face ray on B retargets to B and does not stay on A',
    ontoA.partId === 'A'
    && ontoA.ambiguous === false
    && ontoA.choices.length === 1
    && ontoB.partId === 'B'
    && ontoB.ambiguous === false
    && ontoB.hit.distance < 40);

  const overlap = [box('A', [0, 0, 0]), box('B', [0.4, 0, 0])];
  const seam = resolvePartPick(rayHits(overlap, [-20, 0, 0], [1, 0, 0]));
  check('a close seam keeps the nearest part and lists both for the chip',
    seam.partId === 'A'
    && seam.ambiguous === true
    && seam.choices.map((item) => item.partId).join(',') === 'A,B'
    && seam.choices[1].distance - seam.choices[0].distance <= AMBIGUOUS_HIT_GAP
    && seam.choices[1].distance - seam.choices[0].distance > 0);

  const far = resolvePartPick([
    { partId: 'A', distance: 10 },
    { partId: 'B', distance: 10 + AMBIGUOUS_HIT_GAP + 0.01 },
  ]);
  check('parts farther than the seam gap are not a which-part choice',
    far.partId === 'A' && far.ambiguous === false && far.choices.length === 1);

  const none = resolvePartPick([]);
  check('an empty ray is not a part',
    none.partId == null && none.ambiguous === false && none.choices.length === 0);
}

{
  const mesh = { vertProperties: [0, 0, 0, 1, 0, 0, 0, 1, 0], triVerts: [0, 1, 2] };
  check('a hidden part is not pickable and a visible solid is',
    partIsPickable({ id: 'H', visible: false, mesh }) === false
    && partIsPickable({ id: 'S', visible: true, mesh }) === true
    && partIsPickable({ id: 'E', visible: true, mesh: null, leftover: null }) === false
    && partIsPickable({ id: 'L', visible: true, leftover: mesh }) === true);

  const doc = serializeAssembly({
    source: 'local',
    activeId: 'A',
    parts: [
      { id: 'A', name: 'Arm', visible: true, order: 0 },
      { id: 'B', name: 'Base', visible: true, order: 1, position: [30, 0, 0] },
      { id: 'H', name: 'Hidden', visible: false, order: 2 },
    ],
  });
  const runs = {
    A: { ok: true, mesh },
    B: { ok: false, mesh: null, error: 'nope' },
    H: { ok: false, mesh: null, error: 'nope' },
  };
  const stored = { B: mesh, H: mesh };
  const leftovers = leftoverPickSolids(doc, runs, stored);
  check('a red row keeps leftover geometry pickable and a hidden row does not',
    leftovers.length === 1
    && leftovers[0].id === 'B'
    && leftovers[0].leftover === true
    && leftovers[0].position[0] === 30
    && leftovers[0].mesh === mesh
    && !leftovers.some((solid) => solid.id === 'A' || solid.id === 'H'));
}

{
  check('the script pane stays pinned on a face or edge pick',
    shouldSyncScript({ kind: 'face' }) === false
    && shouldSyncScript({ kind: 'edge' }) === false);
  check('a body click, Parts, or Script syncs Monaco',
    shouldSyncScript({ kind: 'body' }) === true
    && shouldSyncScript({ surface: 'parts' }) === true
    && shouldSyncScript({ surface: 'script' }) === true
    && shouldSyncScript({ surface: 'cad' }) === false);
  check('a feature pick syncs the touched part and an empty click keeps those picks',
    shouldSyncScript({ kind: 'face', featureSession: true }) === true
    && shouldSyncScript({ kind: 'edge', featureSession: true }) === true
    && emptyClickClearsSelection({ featureSession: false }) === true
    && emptyClickClearsSelection({ featureSession: true }) === false
    && featureHideKeepsPicks(true) === true
    && featureHideKeepsPicks(false) === false
    && featureStripHidden(true) === true
    && featureStripHidden(false) === false);
}

{
  const app = read('src/App.jsx');
  const view = read('src/components/Viewport.jsx');
  const strip = read('src/components/FeatureStrip.jsx');
  const arch = read('docs/architecture.md');
  const selectFn = app.slice(app.indexOf('const handleSelectPart'), app.indexOf('const handleTogglePartVisible'));
  check('viewport raycasts every visible part and retargets before the face walk',
    /resolvePartPick\(/.test(view)
    && /collectPartHits\(/.test(view)
    && /swapPickPart/.test(view)
    && /onPickRetarget/.test(view)
    && /data-which-part-chip/.test(view)
    && /Which part\?/.test(view));
  check('empty space clears selection and a feature hide keeps picks',
    /emptyClickClearsSelection\(/.test(view)
    && /featureHideKeepsPicks\(/.test(view)
    && /preservePicks/.test(view)
    && /preservePicks/.test(app));
  check('the parts list follows the CAD part and a body click updates Monaco',
    /cadHighlightId/.test(app)
    && /shouldSyncScript\(/.test(app)
    && /keepPicks/.test(selectFn)
    && /setTextOnly/.test(selectFn)
    && /loadContent\(picked\.script/.test(selectFn)
    && selectFn.indexOf('adoptActiveSolid') < selectFn.indexOf('loadContent')
    && /showCadBodyHighlight/.test(app));
  check('entering a feature hides the feature strip',
    /featureStripHidden/.test(strip) === false
    && /data-feature-strip-hidden="feature"/.test(strip)
    && /hidden=\{featureSession\}/.test(app)
    && /onFeatureSessionChange/.test(view));
  check('architecture notes pick retarget, the which-part chip, and leftover picks',
    /pick retarget/.test(arch)
    && /which-part/.test(arch)
    && /leftover/.test(arch)
    && /no shadow solid/.test(arch)
    && /does not rebuild from a previous solid/.test(arch));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall pick-retarget checks passed');
