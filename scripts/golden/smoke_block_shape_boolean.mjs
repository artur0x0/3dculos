#!/usr/bin/env node
/**
 * Block / Shape Add vs Subtract, and Build → Boolean.
 *
 * Cube 40×30×20 centered is 24000. A 10³ cube centered inside it is 1000.
 * Add → 25000. Subtract → 23000. Empty script stays `let part` even for Subtract.
 *
 * Two 20³ cubes, the second translated +10 in X: overlap 4000.
 * Union 12000, difference 4000, intersect 4000.
 *
 * Intersect of a 40×20×10 plate with two 10×30×10 cubes at x = ±12 is two
 * pieces of 2000. Dropping the +X piece leaves 2000.
 *
 * Hiding a part keeps that part's body and drop arrays. A section hit maps
 * back to the unsectioned body.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { BufferAttribute, BufferGeometry } from 'three';
import {
  composeHelperInsert,
  defaultParamsFor,
} from '../../src/utils/helperPaletteSnippets.js';
import { composeContourExtrude, defaultContourParams, defaultExtrudeParams } from '../../src/utils/contourMode.js';
import { parseFeatureMarkers } from '../../src/utils/featureMarkers.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const {
  emptyBooleanState,
  applyBooleanTap,
  popLastBooleanPick,
  clearBooleanPicks,
  setBooleanOp,
  setBooleanPickTarget,
  composeBooleanCommit,
  noteBooleanPartHidden,
  booleanPickSnapshot,
  bodyContainingPoint,
  meshBodyComponents,
  booleanSlot,
  BOOLEAN_MODE_NEED_TOOL,
  BOOLEAN_MODE_ALL_DROPPED,
} = await import('../../src/utils/booleanMode.js');

console.log('block / shape boolean');

const BLOCKS = ['cube', 'roundedBox', 'cylinder', 'sphere', 'tube', 'hexPrism'];
const SHAPES = ['makeExtrude', 'makeRevolve', 'makeSweep', 'makeLoft'];

{
  for (const id of BLOCKS) {
    check(`${id} defaults to add`, defaultParamsFor(id).combine === 'add');
  }
  for (const id of SHAPES) {
    check(`${id} defaults to add`, defaultParamsFor(id).combine === 'add');
  }
  for (const id of ['crossSection', 'workplane']) {
    check(`${id} has no combine mode`, defaultParamsFor(id).combine == null);
  }

  const cube = composeHelperInsert('', 'cube', null, {});
  check('first cube is let part, even before a mode', /let part = /.test(cube) && !/part\.subtract\(/.test(cube));
  const added = composeHelperInsert(cube, 'cube', null, { width: 10, depth: 10, height: 10, combine: 'add' });
  check('cube Add unions', /part = part\.add\(/.test(added) && !/part\.subtract\(/.test(added));
  const cut = composeHelperInsert(cube, 'cube', null, { width: 10, depth: 10, height: 10, combine: 'subtract' });
  check('cube Subtract cuts the host', /part = part\.subtract\(/.test(cut) && !/part = part\.add\(/.test(cut));
  const bare = composeHelperInsert('', 'cube', null, { combine: 'subtract' });
  check('Subtract on an empty script is still let part', /let part = /.test(bare) && !/part\.subtract\(/.test(bare));

  const host = composeHelperInsert('', 'cube', null, {});
  for (const id of ['makeExtrude', 'makeRevolve', 'makeLoft']) {
    const sub = composeHelperInsert(host, id, null, { combine: 'subtract' });
    check(`${id} Subtract cuts the host`, /part = part\.subtract\(/.test(sub), sub);
    const add = composeHelperInsert(host, id, null, { combine: 'add' });
    check(`${id} Add still unions`, /part = part\.add\(/.test(add) && !/part\.subtract\(/.test(add));
  }
  const sweepAdd = composeHelperInsert(host, 'makeSweep', null, { combine: 'add' });
  check('one-shot sweep Add still replaces',
    /part = placeInFrame\(/.test(sweepAdd) && !/part = part\.add\(/.test(sweepAdd) && !/part\.subtract\(/.test(sweepAdd),
    sweepAdd);
  const sweepSub = composeHelperInsert(host, 'makeSweep', null, { combine: 'subtract' });
  check('one-shot sweep Subtract cuts the host', /part = part\.subtract\(/.test(sweepSub), sweepSub);

  const extruded = composeContourExtrude(host, {
    tool: 'circle',
    params: defaultContourParams('circle'),
    extrude: defaultExtrudeParams(),
    combine: 'subtract',
  });
  check('extrude Subtract writes part.subtract(placeInFrame',
    extruded.ok && /part = part\.subtract\(\s*placeInFrame\(/.test(extruded.buffer),
    extruded.buffer || extruded.message);
  const stickOut = {
    type: 'planar',
    planeFrame: {
      center: [0, 0, 10],
      normal: [0, 0, 1],
      x: [1, 0, 0],
      y: [0, 1, 0],
    },
  };
  const extrudedAdd = composeContourExtrude(host, {
    face: stickOut,
    tool: 'circle',
    params: defaultContourParams('circle'),
    extrude: defaultExtrudeParams(),
    combine: 'add',
  });
  check('extrude Add still unions',
    extrudedAdd.ok && /part = part\.add\(\s*placeInFrame\(/.test(extrudedAdd.buffer)
    && !/part\.subtract\(/.test(extrudedAdd.buffer));
}

{
  const positions = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    5, 0, 0, 6, 0, 0, 5, 1, 0,
  ];
  const index = [0, 1, 2, 3, 4, 5];
  let tap = applyBooleanTap(emptyBooleanState(), { triangle: 0, positions, index, partId: 'a' });
  tap = applyBooleanTap(tap.state, { triangle: 1, positions, index, partId: 'a' });
  check('tap adds a body, a second tap adds the other', booleanSlot(tap.state, 'a').bodies.length === 2);
  const removed = applyBooleanTap(tap.state, { triangle: 0, positions, index, partId: 'a' });
  check('tap again removes that body', booleanSlot(removed.state, 'a').bodies.length === 1);
  const undone = popLastBooleanPick(tap.state, 'a');
  check('Undo drops the last body', booleanSlot(undone, 'a').bodies.length === 1);
  const cleared = clearBooleanPicks(tap.state, 'a');
  check('Clear drops the bodies', booleanSlot(cleared, 'a').bodies.length === 0);

  const snap = booleanPickSnapshot(tap.state, 'a');
  const hidden = noteBooleanPartHidden(tap.state, 'a');
  check('hiding a part keeps the same body and drop arrays',
    hidden.byPart.a.bodies === tap.state.byPart.a.bodies
    && hidden.byPart.a.drop === tap.state.byPart.a.drop
    && JSON.stringify(booleanPickSnapshot(hidden, 'a')) === JSON.stringify(snap));
  check('hiding a part that was never picked leaves the state',
    noteBooleanPartHidden(tap.state, 'other') === tap.state);
  check('hiding does not clear the other part',
    booleanSlot(hidden, 'a').bodies.length === 2 && booleanSlot(hidden, 'b').bodies.length === 0);

  const pieces = setBooleanPickTarget(setBooleanOp(tap.state, 'intersect'), 'pieces');
  const marked = applyBooleanTap(pieces, { at: [1, 2, 3], partId: 'a' });
  check('tap a piece marks it', booleanSlot(marked.state, 'a').drop.length === 1);
  const unmarked = applyBooleanTap(marked.state, { at: [1, 2, 3], partId: 'a' });
  check('tap that piece again brings it back', booleanSlot(unmarked.state, 'a').drop.length === 0);
  const keptBodies = noteBooleanPartHidden(marked.state, 'a');
  check('hiding keeps the piece mark',
    keptBodies.byPart.a.drop === marked.state.byPart.a.drop
    && booleanSlot(keptBodies, 'a').drop.length === 1);

  const one = applyBooleanTap(emptyBooleanState(), { triangle: 0, positions, index, partId: 'a' });
  const need = composeBooleanCommit('let part = 1;', one.state, 'a');
  check('confirm with one body refuses', !need.ok && need.message === BOOLEAN_MODE_NEED_TOOL, need.message);
  const allGone = composeBooleanCommit('', pieces, 'a', { pieceCount: 2 });
  const droppedAll = {
    ...pieces,
    byPart: { a: { bodies: booleanSlot(pieces, 'a').bodies, drop: [{ at: [0, 0, 0] }] } },
  };
  const refused = composeBooleanCommit('', droppedAll, 'a', { pieceCount: 1 });
  check('deleting every piece refuses', !refused.ok && refused.message === BOOLEAN_MODE_ALL_DROPPED, refused.message);
  check('intersect with pieces still showing confirms', allGone.ok, allGone.message || '');

  const union = composeBooleanCommit('let part = Manifold.cube([20, 20, 20], true);', tap.state, 'a');
  check('union is one booleanBodies and a Boolean chip',
    union.ok && /op: 'union'/.test(union.buffer)
    && (union.buffer.match(/booleanBodies\s*\(/g) || []).length === 1
    && parseFeatureMarkers(union.buffer).some((f) => f.kind === 'boolean' && f.chipLabel === 'Boolean'),
    union.buffer || union.message);
  const again = composeBooleanCommit(union.buffer, setBooleanOp(tap.state, 'difference'), 'a');
  check('a second confirm replaces the Boolean block',
    again.ok && /op: 'difference'/.test(again.buffer)
    && (again.buffer.match(/booleanBodies\s*\(/g) || []).length === 1
    && !/op: 'union'/.test(again.buffer),
    again.buffer || again.message);

  const onSurface = bodyContainingPoint(
    meshBodyComponents(positions, index),
    [0, 0, 0],
    positions,
    index,
  );
  check('a section point on a body maps to that body', onSurface && onSurface.minTri === 0);
  const other = bodyContainingPoint(
    meshBodyComponents(positions, index),
    [5, 0, 0],
    positions,
    index,
  );
  check('a section point on the other body maps there', other && other.minTri === 1);
}

{
  const palette = readFileSync(new URL('../../src/components/HelperInsertPalette.jsx', import.meta.url), 'utf8');
  const chip = readFileSync(new URL('../../src/components/BooleanModeChip.jsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../../src/workers/sandboxWorker.js', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../../src/lib/surfcad/runtime.js', import.meta.url), 'utf8');
  check('Build Boolean enters boolean mode', /item\.id === 'boolean'[\s\S]{0,180}onEnterBooleanMode/.test(palette));
  check('Boolean chip allows section and survives the part list',
    /data-boolean-allow-section="1"/.test(chip)
    && /data-boolean-survives-parts="1"/.test(chip)
    && /z-20/.test(chip)
    && /pointer-events-auto/.test(chip));
  check('cross-section panel stays mounted during Boolean',
    /<CrossSectionPanel/.test(view) && !/booleanMode &&[\s\S]{0,80}<CrossSectionPanel/.test(view));
  check('hiding a part notes the pick and does not exit Boolean',
    /noteBooleanPartHidden/.test(view) && !/handleTogglePartVisible[\s\S]{0,400}booleanMode/.test(app));
  check('part manager stage keeps the CAD pane mounted',
    /data-stage-pane="cad"/.test(app) && /both panes stay mounted/.test(app));
  check('Confirm writes booleanBodies from the active part',
    /composeBooleanCommit\(/.test(app) && /onCommitBoolean=\{handleCommitBoolean\}/.test(app));
  const preview = worker.slice(worker.indexOf("case 'previewBoolean'"), worker.indexOf("case 'trimByPlane'"));
  check('previewBoolean clones and does not replace the cached solid',
    /cachedManifold\.clone\(/.test(preview) && !/cachedManifold\s*=/.test(preview));
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

async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}
async function execFail(script) {
  try {
    await exec(script);
    return null;
  } catch (e) {
    return e.message || String(e);
  }
}

function near(a, b, eps = 1e-2) {
  return Math.abs(a - b) < eps;
}

{
  const cube = composeHelperInsert('', 'cube', null, {});
  const added = composeHelperInsert(cube, 'cube', null, {
    width: 10, depth: 10, height: 10, combine: 'add',
  }).replace(
    'Manifold.cube([10, 10, 10], true)',
    'Manifold.cube([10, 10, 10], true).translate([30, 0, 0])',
  );
  const subtracted = composeHelperInsert(cube, 'cube', null, {
    width: 10, depth: 10, height: 10, combine: 'subtract',
  });
  const addRes = await exec(added);
  const subRes = await exec(subtracted);
  check('cube Add volume is 25000', near(addRes.volume, 25000), `vol=${addRes.volume}`);
  check('cube Subtract volume is 23000', near(subRes.volume, 23000), `vol=${subRes.volume}`);

  const host = composeHelperInsert('', 'cube', null, {});
  const extrude = composeContourExtrude(host, {
    tool: 'circle',
    params: defaultContourParams('circle'),
    extrude: defaultExtrudeParams(),
    combine: 'subtract',
  });
  const extRes = extrude.ok ? await exec(extrude.buffer) : { volume: -1 };
  check('extrude Subtract removes volume from the cube',
    extrude.ok && extRes.volume < 24000 - 1, `vol=${extRes.volume} ${extrude.message || ''}`);
  const extrudeAdd = composeContourExtrude(host, {
    face: {
      type: 'planar',
      planeFrame: {
        center: [0, 0, 10],
        normal: [0, 0, 1],
        x: [1, 0, 0],
        y: [0, 1, 0],
      },
    },
    tool: 'circle',
    params: defaultContourParams('circle'),
    extrude: defaultExtrudeParams(),
    combine: 'add',
  });
  const extAdd = extrudeAdd.ok ? await exec(extrudeAdd.buffer) : { volume: -1 };
  check('extrude Add increases volume',
    extrudeAdd.ok && extAdd.volume > 24000 + 1, `vol=${extAdd.volume}`);
}

{
  const pair = `
    const a = Manifold.cube([20, 20, 20], true);
    const b = Manifold.cube([20, 20, 20], true).translate([10, 0, 0]);
    let part = Manifold.compose([a, b]);
  `;
  const union = await exec(`
    ${pair}
    part = booleanBodies(part, { op: 'union', bodies: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }] });
    return part;
  `);
  check('boolean union volume is 12000', near(union.volume, 12000), `vol=${union.volume}`);
  const diff = await exec(`
    ${pair}
    part = booleanBodies(part, { op: 'difference', bodies: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }] });
    return part;
  `);
  check('boolean difference volume is 4000', near(diff.volume, 4000), `vol=${diff.volume}`);
  const inter = await exec(`
    ${pair}
    part = booleanBodies(part, { op: 'intersect', bodies: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }] });
    return part;
  `);
  check('boolean intersect volume is 4000', near(inter.volume, 4000), `vol=${inter.volume}`);

  const empty = await execFail(`
    const a = Manifold.cube([10, 10, 10], true);
    const b = Manifold.cube([10, 10, 10], true).translate([30, 0, 0]);
    let part = Manifold.compose([a, b]);
    part = booleanBodies(part, { op: 'intersect', bodies: [{ at: [0, 0, 0] }, { at: [30, 0, 0] }] });
    return part;
  `);
  check('empty intersection throws', !!empty && /intersection is empty/.test(empty), empty || 'no throw');

  const plate = await exec(`
    const plate = Manifold.cube([40, 20, 10], true);
    const left = Manifold.cube([10, 30, 10], true).translate([-12, 0, 0]);
    const right = Manifold.cube([10, 30, 10], true).translate([12, 0, 0]);
    let part = Manifold.compose([plate, left, right]);
    part = booleanBodies(part, {
      op: 'intersect',
      bodies: [{ at: [0, 0, 0] }, { at: [-12, 0, 0] }, { at: [12, 0, 0] }],
      drop: [{ at: [12, 0, 0] }],
    });
    return part;
  `);
  check('intersect drop deletes the +X piece and leaves 2000', near(plate.volume, 2000), `vol=${plate.volume}`);

  const wiped = await execFail(`
    const plate = Manifold.cube([40, 20, 10], true);
    const left = Manifold.cube([10, 30, 10], true).translate([-12, 0, 0]);
    const right = Manifold.cube([10, 30, 10], true).translate([12, 0, 0]);
    let part = Manifold.compose([plate, left, right]);
    part = booleanBodies(part, {
      op: 'intersect',
      bodies: [{ at: [0, 0, 0] }, { at: [-12, 0, 0] }, { at: [12, 0, 0] }],
      drop: [{ at: [12, 0, 0] }, { at: [-12, 0, 0] }],
    });
    return part;
  `);
  check('deleting every intersect piece throws', !!wiped && /every piece was deleted/.test(wiped), wiped || 'no throw');

  await exec(pair + '\nreturn part;');
  const before = await send('getModelInfo');
  const preview = await send('previewBoolean', {
    op: 'intersect',
    bodies: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }],
  });
  const after = await send('getModelInfo');
  const selected = (preview.payload?.pieces || []).filter((p) => p.selected);
  check('previewBoolean lists the overlap and leaves the cached solid',
    selected.length >= 1 && near(before.payload.volume, after.payload.volume) && near(after.payload.volume, 16000),
    `pieces=${selected.length} vol=${after.payload?.volume}`);

  const geometryFromMesh = (mesh) => {
    const np = mesh.numProp || 3;
    const src = mesh.vertProperties;
    const nVert = Math.floor(src.length / np);
    const positions = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) {
      positions[i * 3] = src[i * np];
      positions[i * 3 + 1] = src[i * np + 1];
      positions[i * 3 + 2] = src[i * np + 2];
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(new Uint32Array(mesh.triVerts), 1));
    return geometry;
  };
  const meshRes = await exec(pair + '\nreturn part;');
  const geom = geometryFromMesh(meshRes.mesh);
  const pos = geom.attributes.position;
  const idx = geom.index.array;
  const bodies = meshBodyComponents(pos, idx);
  const hit = bodyContainingPoint(bodies, [15, 0, 0], pos, idx);
  check('a point inside the translated cube maps to that body',
    !!hit && Math.abs(hit.at[0] - 10) < 0.05, hit ? hit.at.join(',') : 'none');
}

if (failed) {
  console.log(`\n${failed} block-shape-boolean check(s) failed`);
  process.exit(1);
}
console.log('\nAll block-shape-boolean checks passed.');
