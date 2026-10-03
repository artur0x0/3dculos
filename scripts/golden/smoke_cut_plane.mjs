#!/usr/bin/env node
/**
 * Cut bodies with a plane, then optionally delete pieces.
 *
 * Manifold.cube([40, 30, 20], true). Extents x ±20, y ±15, z ±10.
 *
 *   1. Mid plane z=0, keep both halves. Volume of both halves equals the cube
 *      (24000). They are separate bodies.
 *   2. The same cut keeping only z>=0. The kept piece is the +Z half
 *      (z from 0 to 10), volume 12000.
 *   A body that does not cross the plane stays one body with the same volume.
 *
 * Confirm writes one cut() and replaces a previous Cut block. A face plane is
 * { center, normal }, never a world-axis guess. Bodies and pieces use the
 * Shell sticky picker (tap add, tap remove, Undo, Clear). No shift-click.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const {
  emptyCutState,
  applyCutTap,
  popLastCutPick,
  clearCutPicks,
  setCutPlaneSource,
  setCutPickTarget,
  composeCutCommit,
  meshBodyComponents,
  listCutPieces,
  setCutOriginOffset,
  CUT_MODE_NEED_PLANE,
  CUT_MODE_NEED_BODIES,
} = await import('../../src/utils/cutMode.js');
const { contactSeamSegments } = await import('../../src/utils/contactSeam.js');
const { parseFeatureMarkers } = await import('../../src/utils/featureMarkers.js');

console.log('cut plane');

{
  const positions = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    5, 0, 0, 6, 0, 0, 5, 1, 0,
  ];
  const index = [0, 1, 2, 3, 4, 5];
  const bodies = meshBodyComponents(positions, index);
  check('two disjoint triangles are two bodies', bodies.length === 2, `n=${bodies.length}`);
  const joined = meshBodyComponents(
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    [0, 1, 2, 1, 3, 2],
  );
  check('triangles that share vertices are one body', joined.length === 1, `n=${joined.length}`);

  let s = setCutPickTarget(setCutPlaneSource(emptyCutState(), 'xy'), 'bodies');
  let tap = applyCutTap(s, { triangle: 0, positions, index });
  tap = applyCutTap(tap.state, { triangle: 1, positions, index });
  check('tap adds a body, a second tap adds the other', tap.state.bodies.length === 2);
  const removed = applyCutTap(tap.state, { triangle: 0, positions, index });
  check('tap again removes that body', removed.state.bodies.length === 1
    && removed.state.bodies[0].minTri === 1);
  const undone = popLastCutPick(tap.state);
  check('Undo drops the last body', undone.bodies.length === 1 && undone.bodies[0].minTri === 0);
  const cleared = clearCutPicks(tap.state);
  check('Clear drops the bodies', cleared.bodies.length === 0 && cleared.drop.length === 0);

  const crossPos = [0, 0, -1, 1, 0, -1, 0, 0, 1];
  const crossIdx = [0, 1, 2];
  let pieces = setCutPickTarget(setCutPlaneSource(emptyCutState(), 'xy'), 'bodies');
  pieces = applyCutTap(pieces, { triangle: 0, positions: crossPos, index: crossIdx }).state;
  pieces = setCutPickTarget(pieces, 'pieces');
  const mark = applyCutTap(pieces, {
    triangle: 0,
    point: [0, 0, -0.5],
    positions: crossPos,
    index: crossIdx,
  });
  check('tap a piece marks it for deletion', mark.state.drop.length === 1 && mark.state.drop[0].side === '-');
  const unmark = applyCutTap(mark.state, {
    triangle: 0,
    point: [0, 0, -0.5],
    positions: crossPos,
    index: crossIdx,
  });
  check('tap that piece again keeps it', unmark.state.drop.length === 0);
  const marked = applyCutTap(pieces, {
    triangle: 0,
    point: [0, 0, -0.5],
    positions: crossPos,
    index: crossIdx,
  }).state;
  const pieceUndo = popLastCutPick(marked);
  check('Undo on pieces drops the last piece, not the body',
    pieceUndo.drop.length === 0 && pieceUndo.bodies.length === 1);
  const pieceClear = clearCutPicks(marked);
  check('Clear on pieces drops the piece marks and keeps the body',
    pieceClear.drop.length === 0 && pieceClear.bodies.length === 1);

  const needPlane = composeCutCommit('', emptyCutState());
  check('confirm without a plane refuses', !needPlane.ok && needPlane.message === CUT_MODE_NEED_PLANE);
  const needBody = composeCutCommit('', setCutPlaneSource(emptyCutState(), 'xy'));
  check('confirm without a body refuses', !needBody.ok && needBody.message === CUT_MODE_NEED_BODIES);

  const both = composeCutCommit('let part = Manifold.cube([40, 30, 20], true);', pieces, {
    positions: crossPos,
    index: crossIdx,
    bodyCount: 1,
  });
  check('keep both is one cut() with the explicit plane',
    both.ok && /part = cut\(part, \{ normal: \[0, 0, 1\], originOffset: 0 \}\);/.test(both.buffer)
    && (both.buffer.match(/cut\s*\(/g) || []).length === 1,
    both.buffer || both.message);
  check('Cut markers and a strip chip',
    both.ok && parseFeatureMarkers(both.buffer).some((f) => f.kind === 'cut' && f.chipLabel === 'Cut'));

  const half = composeCutCommit('', marked, {
    positions: crossPos,
    index: crossIdx,
    bodyCount: 1,
  });
  check("deleting the - piece emits keep: '+'",
    half.ok && /keep: '\+'/.test(half.buffer) && !/drop:/.test(half.buffer),
    half.buffer || half.message);

  let face = applyCutTap(emptyCutState(), {
    face: { center: [0, 0, 10], normal: [0, 0, 1], indices: [4] },
  }).state;
  face = { ...face, bodies: pieces.bodies, pick: 'bodies' };
  const faceCommit = composeCutCommit('', face, {
    positions: crossPos,
    index: crossIdx,
    bodyCount: 1,
  });
  check('a face plane is { center, normal }, not a world axis',
    faceCommit.ok
    && /cut\(part, \{ center: \[0, 0, 10\], normal: \[0, 0, 1\] \}\)/.test(faceCommit.buffer)
    && !/originOffset/.test(faceCommit.buffer)
    && !/\boffset:/.test(faceCommit.buffer)
    && !/['"]z['"]/.test(faceCommit.buffer)
    && !/pull:\s*'/.test(faceCommit.buffer),
    faceCommit.buffer || faceCommit.message);

  const shifted = setCutOriginOffset(face, 4);
  const shiftCommit = composeCutCommit('', shifted, {
    positions: crossPos,
    index: crossIdx,
    bodyCount: 1,
  });
  check('a face offset is written on the same cut() and the center stays',
    shiftCommit.ok
    && /cut\(part, \{ center: \[0, 0, 10\], normal: \[0, 0, 1\], offset: 4 \}\)/.test(shiftCommit.buffer)
    && !/originOffset/.test(shiftCommit.buffer)
    && (shiftCommit.buffer.match(/cut\s*\(/g) || []).length === 1,
    shiftCommit.buffer || shiftCommit.message);

  const pos2 = [0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, -1, 0, 0, -1];
  const idx2 = [0, 1, 2, 0, 3, 4];
  let halves = setCutPickTarget(setCutPlaneSource(emptyCutState(), 'xy'), 'bodies');
  halves = applyCutTap(halves, { triangle: 0, positions: pos2, index: idx2 }).state;
  const shown = listCutPieces(halves, pos2, idx2);
  check('pieces preview lists both sides in different colors',
    shown.length === 2 && shown[0].hidden === false && shown[1].hidden === false
    && shown[0].color !== shown[1].color
    && shown[0].triangles.length === 1 && shown[1].triangles.length === 1,
    JSON.stringify(shown.map((p) => ({ side: p.side, n: p.triangles.length, hidden: p.hidden }))));
  const hiding = setCutPickTarget(halves, 'pieces');
  const hid = applyCutTap(hiding, {
    triangle: 1,
    point: [0.3, 0, -0.4],
    positions: pos2,
    index: idx2,
  }).state;
  const afterHide = listCutPieces(hid, pos2, idx2);
  check('tapping a piece hides only that piece',
    afterHide.filter((p) => p.hidden).length === 1 && afterHide.find((p) => p.side === '-').hidden);
  const undoneHide = popLastCutPick(hid);
  const afterUndo = listCutPieces(undoneHide, pos2, idx2);
  check('Undo brings back only the last hidden piece',
    afterUndo.every((p) => !p.hidden) && undoneHide.bodies.length === 1);
  const clearedHide = clearCutPicks(hid);
  check('Clear unhides every piece and keeps the plane',
    clearedHide.drop.length === 0 && clearedHide.planeSource === 'xy' && clearedHide.bodies.length === 1);

  const again = composeCutCommit(both.buffer, marked, {
    positions: crossPos,
    index: crossIdx,
    bodyCount: 1,
  });
  check('a later Cut replaces the previous block',
    again.ok
    && (again.buffer.match(/--- cut begin ---/g) || []).length === 1
    && (again.buffer.match(/cut\s*\(/g) || []).length === 1
    && /keep: '\+'/.test(again.buffer),
    again.buffer || again.message);
}

{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const view = read('../../src/components/Viewport.jsx');
  const chip = read('../../src/components/CutModeChip.jsx');
  const palette = read('../../src/components/HelperInsertPalette.jsx');
  const app = read('../../src/App.jsx');
  const popup = read('../../docs/POPUP_STYLE.md');
  const hi = view.indexOf('const highlightFace = useCallback');
  const note = view.indexOf('Below highlightFace on purpose');
  const draftPaint = view.indexOf('const paintDraftPicks = useCallback');
  check('highlightFace stays above the Draft callbacks', hi >= 0 && note > hi && draftPaint > note);
  check('palette routes Cut into cut mode',
    /item\.id === 'cut'/.test(palette) && /onEnterCutMode\(\{\s*entry:\s*'cut'\s*\}\)/.test(palette));
  check('missed tap does not clear the cut set', /Preserve cut body selection/.test(view));
  check('Viewport confirm is acceptCut', /onConfirm=\{acceptCut\}/.test(view) && /onCommitCut/.test(view));
  check('App writes composeCutCommit', /composeCutCommit/.test(app) && /onCommitCut=\{handleCommitCut\}/.test(app));
  check('chip has Undo, Clear, and the Shell sticky copy',
    /data-cut-undo/.test(chip) && /data-cut-clear/.test(chip)
    && /tap to add, tap a selected body to remove/.test(chip)
    && /tap a piece to hide it/.test(chip)
    && /bring it back/.test(chip));
  check('face and named planes share the offset field',
    /id="cut-offset"/.test(chip) && /along the plane normal/.test(chip));
  check('pieces preview colors each piece and leaves hidden ones pickable',
    /listCutPieces/.test(view) && /colorWrite: false/.test(view)
    && /CUT_PIECE_OPACITY/.test(view) && /if \(piece\.hidden\) continue/.test(view));
  check('a cut tap is not swallowed by a contour or a construction plane',
    /!cutModeRef\.current && showContoursRef/.test(view)
    && /!cutModeRef\.current && planeHits/.test(view));
  check('chip does not ask for shift-click', !/shift-click/.test(chip) && !/shiftKey/.test(chip));
  check('POPUP_STYLE documents CutModeChip', /CutModeChip/.test(popup) && /sticky picker/.test(popup));
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

const cube = 'let part = Manifold.cube([40, 30, 20], true);';

{
  const res = await exec(`
    ${cube}
    part = cut(part, { normal: [0, 0, 1], originOffset: 0 });
    const parts = part.decompose();
    if (parts.length !== 2) throw new Error('bodies ' + parts.length);
    const vol = parts[0].volume() + parts[1].volume();
    if (Math.abs(vol - 24000) > 1e-3) throw new Error('half vol ' + vol);
    if (Math.abs(part.volume() - 24000) > 1e-3) throw new Error('composed ' + part.volume());
    const zs = parts.map((p) => {
      const bb = p.boundingBox();
      return [bb.min[2], bb.max[2], p.volume()];
    });
    const has = (z0, z1) => zs.some((r) => Math.abs(r[0] - z0) < 1e-3 && Math.abs(r[1] - z1) < 1e-3 && Math.abs(r[2] - 12000) < 1e-3);
    if (!has(0, 10) || !has(-10, 0)) throw new Error('ranges ' + JSON.stringify(zs));
    return part;
  `);
  check('1 both halves volume 24000', Math.abs(res.volume - 24000) < 1e-3, `vol=${res.volume}`);
  const bothSeams = contactSeamSegments(res.mesh.vertProperties, res.mesh.triVerts, res.mesh.numProp);
  check('1 both halves draw the shared boundary as body edges',
    bothSeams.length === 4 && bothSeams.every((s) => Math.abs(s.a[2]) < 1e-3 && Math.abs(s.b[2]) < 1e-3
      && Math.abs(s.capNormal[2]) > 0.9),
    `n=${bothSeams.length}`);
  check('1 composed bbox is still the cube',
    Math.abs(res.boundingBox.min[2] + 10) < 1e-3 && Math.abs(res.boundingBox.max[2] - 10) < 1e-3
    && Math.abs(res.boundingBox.min[0] + 20) < 1e-3 && Math.abs(res.boundingBox.max[1] - 15) < 1e-3);
}

{
  const res = await exec(`
    ${cube}
    part = cut(part, { normal: [0, 0, 1], originOffset: 0 }, { keep: '+' });
    const n = part.decompose().length;
    if (n !== 1) throw new Error('bodies ' + n);
    if (Math.abs(part.volume() - 12000) > 1e-3) throw new Error('vol ' + part.volume());
    const bb = part.boundingBox();
    if (bb.min[2] < -1e-3 || Math.abs(bb.min[2]) > 1e-3 || Math.abs(bb.max[2] - 10) > 1e-3) {
      throw new Error('z ' + bb.min[2] + ' ' + bb.max[2]);
    }
    if (Math.abs(bb.min[0] + 20) > 1e-3 || Math.abs(bb.max[0] - 20) > 1e-3) throw new Error('x');
    if (Math.abs(bb.min[1] + 15) > 1e-3 || Math.abs(bb.max[1] - 15) > 1e-3) throw new Error('y');
    return part;
  `);
  check('2 keep +Z is volume 12000', Math.abs(res.volume - 12000) < 1e-3, `vol=${res.volume}`);
  check('2 kept piece is z from 0 to 10',
    Math.abs(res.boundingBox.min[2]) < 1e-3 && Math.abs(res.boundingBox.max[2] - 10) < 1e-3,
    JSON.stringify(res.boundingBox));
  const halfSeams = contactSeamSegments(res.mesh.vertProperties, res.mesh.triVerts, res.mesh.numProp);
  check('2 keeping one side does not add a seam edge', halfSeams.length === 0, `n=${halfSeams.length}`);

  const dropped = await exec(`
    ${cube}
    part = cut(part, { normal: [0, 0, 1], originOffset: 0 }, { drop: [{ at: [0, 0, 0], side: '-' }] });
    if (part.decompose().length !== 1) throw new Error('bodies ' + part.decompose().length);
    if (Math.abs(part.volume() - 12000) > 1e-3) throw new Error('vol ' + part.volume());
    const bb = part.boundingBox();
    if (Math.abs(bb.min[2]) > 1e-3 || Math.abs(bb.max[2] - 10) > 1e-3) throw new Error('z');
    return part;
  `);
  check("drop the - piece keeps only the +Z half",
    Math.abs(dropped.volume - 12000) < 1e-3 && Math.abs(dropped.boundingBox.min[2]) < 1e-3);
}

{
  const res = await exec(`
    let part = Manifold.cube([40, 30, 20], true).translate([0, 0, 40]);
    const before = part.volume();
    part = cut(part, { normal: [0, 0, 1], originOffset: 0 });
    const n = part.decompose().length;
    if (n !== 1) throw new Error('bodies ' + n);
    if (Math.abs(part.volume() - before) > 1e-6) throw new Error('vol ' + part.volume() + ' vs ' + before);
    const bb = part.boundingBox();
    if (Math.abs(bb.min[2] - 30) > 1e-3 || Math.abs(bb.max[2] - 50) > 1e-3) {
      throw new Error('z ' + bb.min[2] + ' ' + bb.max[2]);
    }
    return part;
  `);
  check('a body that misses the plane stays one body with the same volume',
    Math.abs(res.volume - 24000) < 1e-3 && Math.abs(res.boundingBox.min[2] - 30) < 1e-3,
    `vol=${res.volume} z0=${res.boundingBox.min[2]}`);
  const missSeams = contactSeamSegments(res.mesh.vertProperties, res.mesh.triVerts, res.mesh.numProp);
  check('a body that is not cut does not grow an extra edge', missSeams.length === 0, `n=${missSeams.length}`);
}

{
  const res = await exec(`
    ${cube}
    part = cut(part, { center: [0, 0, 10], normal: [0, 0, 1] });
    const n = part.decompose().length;
    if (n !== 1) throw new Error('bodies ' + n + ' vol ' + part.volume());
    if (Math.abs(part.volume() - 24000) > 1e-6) throw new Error('vol ' + part.volume());
    return part;
  `);
  check('a face on the top of the cube is that plane, not a guessed z=0 cut',
    Math.abs(res.volume - 24000) < 1e-3, `vol=${res.volume}`);

  const moved = await exec(`
    ${cube}
    part = cut(part, { center: [0, 0, 10], normal: [0, 0, 1], offset: -10 });
    const parts = part.decompose();
    if (parts.length !== 2) throw new Error('bodies ' + parts.length);
    if (Math.abs(part.volume() - 24000) > 1e-3) throw new Error('vol ' + part.volume());
    const zs = parts.map((p) => {
      const bb = p.boundingBox();
      return [bb.min[2], bb.max[2]];
    });
    const has = (z0, z1) => zs.some((r) => Math.abs(r[0] - z0) < 1e-3 && Math.abs(r[1] - z1) < 1e-3);
    if (!has(0, 10) || !has(-10, 0)) throw new Error('ranges ' + JSON.stringify(zs));
    return part;
  `);
  check('face offset -10 from the top face is the mid plane, both halves',
    Math.abs(moved.volume - 24000) < 1e-3, `vol=${moved.volume}`);

  const zeroOff = await exec(`
    ${cube}
    part = cut(part, { center: [0, 0, 10], normal: [0, 0, 1], offset: 0 });
    if (part.decompose().length !== 1) throw new Error('bodies ' + part.decompose().length);
    if (Math.abs(part.volume() - 24000) > 1e-6) throw new Error('vol ' + part.volume());
    return part;
  `);
  check('face offset 0 does not move the plane', Math.abs(zeroOff.volume - 24000) < 1e-3);

  const named = await execFail(`
    ${cube}
    part = cut(part, 'z');
    return part;
  `);
  check('a world-axis name is rejected', !!named && /world-axis/.test(named), named || 'no throw');
}

{
  const res = await exec(`
    const a = Manifold.cube([40, 30, 20], true);
    const b = Manifold.cube([10, 10, 10], true).translate([30, 0, 0]);
    const bVol = b.volume();
    let part = Manifold.compose([a, b]);
    part = cut(part, { normal: [0, 0, 1], originOffset: 0 }, { bodies: [{ at: [0, 0, 0] }] });
    const parts = part.decompose();
    if (parts.length !== 3) throw new Error('bodies ' + parts.length + ' vol ' + part.volume());
    const kept = parts.filter((p) => Math.abs(p.volume() - bVol) < 1e-3);
    if (kept.length !== 1) throw new Error('untouched ' + parts.map((p) => p.volume()).join(','));
    const bb = kept[0].boundingBox();
    if (Math.abs(bb.min[0] - 25) > 1e-2 || Math.abs(bb.max[0] - 35) > 1e-2) throw new Error('x ' + bb.min[0]);
    if (bb.min[2] < -5 - 1e-2 || bb.max[2] > 5 + 1e-2) throw new Error('z ' + bb.min[2] + ' ' + bb.max[2]);
    if (Math.abs(part.volume() - (24000 + bVol)) > 1e-2) throw new Error('sum ' + part.volume());
    return part;
  `);
  check('only the picked body is cut; the other stays whole', res.volume > 24000, `vol=${res.volume}`);
}

if (failed) {
  console.log(`\n${failed} cut-plane check(s) failed`);
  process.exit(1);
}
console.log('\nAll cut-plane checks passed.');
