/**
 * Fillet follow-up — loft overlay bound, blend-strip filter, sequential sharp fillet.
 *
 * - circle→rect loft indexes without throwing; labels stay on substantial faces
 * - a filleted box keeps long sharp edges and drops blend chords
 * - a second sharp edge appends, and edge() resolves on the filleted solid
 * - blend-only Accept fails loud; replace-in-place still updates one block
 * - missing ids still ask to re-pick
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { FILLET_ARC_SEGMENTS } from '../../src/utils/filletAlongPath.js';
import {
  BOUNDARY_SHALLOW_DEG,
  BOUNDARY_SMALL_FACE_FRAC,
  indexBoundaryEdges,
  filletOverlayTargets,
} from '../../src/utils/boundaryEdgeIds.js';
import {
  composeFilletCommit,
  validateFilletAccept,
  FILLET_BLEND_ONLY,
  countFilletAlongPath,
} from '../../src/utils/filletMode.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('fillet follow-up — thresholds');
check('shallow dihedral gate is 15°', BOUNDARY_SHALLOW_DEG === 15);
check('small-face fraction is 5% of the largest face', BOUNDARY_SMALL_FACE_FRAC === 0.05);
check('default fillet arc is denser than 12', FILLET_ARC_SEGMENTS >= 24);

console.log('fillet follow-up — Accept chrome + blend loud-fail');
{
  const chip = readFileSync(new URL('../../src/components/FilletModeChip.jsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  check('chip has X dismiss without committing', /Dismiss Fillet mode without committing/.test(chip));
  check('Accept leaves Fillet mode', /exitFilletMode\(\)/.test(view) && /commitMode:/.test(view));
  check('Back is still an exit', /onBack=\{exitFilletMode\}/.test(view));
  check(
    'Accept does not force Face pick',
    !/if \(ok\) \{[\s\S]{0,220}setPickMode\('face'\)/.test(view),
  );
  check(
    'exit restores prior Face/Edge',
    /filletPriorPickModeRef/.test(view)
      && /filletPriorPickModeRef\.current === 'edge' \? 'edge' : 'face'/.test(view),
  );
  // Carry-over #51: snapshot must run BEFORE exitContourMode (which forces face).
  check(
    'enterFillet snapshots pick mode before exitContourMode',
    /filletPriorPickModeRef\.current\s*=\s*pickModeRef\.current[\s\S]{0,120}exitContourMode\(\)/.test(view),
  );

  const blend = {
    key: '9-10',
    a: 9,
    b: 10,
    va: [0, 0, 0],
    vb: [1, 0, 0],
    mid: [0.5, 0, 0],
    length: 1,
    tangent: [1, 0, 0],
    blendStrip: true,
    boundaryId: 20,
    faceA: 1,
    faceB: 2,
    pairCount: 1,
  };
  const refused = validateFilletAccept([blend, { ...blend, key: '10-11', a: 10, b: 11 }], {
    strategy: 'sweep',
    radius: 2,
  });
  check('blend-only Accept fails', refused.ok === false);
  check('blend-only message names the blend', refused.message === FILLET_BLEND_ONLY, refused.message || '');

  const starter = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n';
  const sharp = {
    key: '1-2',
    a: 1,
    b: 2,
    va: [0, 0, 10],
    vb: [40, 0, 10],
    mid: [20, 0, 10],
    length: 40,
    tangent: [1, 0, 0],
    n0: [0, 0, 1],
    n1: [0, -1, 0],
    boundaryId: 3,
    faceA: 1,
    faceB: 4,
    pairCount: 1,
  };
  const other = {
    ...sharp,
    key: '2-3',
    a: 2,
    b: 3,
    va: [40, 0, 10],
    vb: [40, 30, 10],
    mid: [40, 15, 10],
    tangent: [0, 1, 0],
    boundaryId: 5,
    faceA: 4,
    faceB: 6,
  };
  const first = composeFilletCommit(starter, {
    edges: [sharp],
    params: { strategy: 'sweep', radius: 3 },
  });
  check('first Accept still one block', first.ok === true && countFilletAlongPath(first.buffer) === 1);
  const replaced = composeFilletCommit(first.buffer, {
    edges: [other],
    params: { strategy: 'sweep', radius: 4 },
  });
  check('default second Accept still replaces', replaced.ok === true && countFilletAlongPath(replaced.buffer) === 1);
  const appended = composeFilletCommit(first.buffer, {
    edges: [other],
    params: { strategy: 'sweep', radius: 2 },
    commitMode: 'append',
  });
  check('append Accept keeps both fillets', appended.ok === true && countFilletAlongPath(appended.buffer) === 2, appended.message || '');
  check('append keeps the first edge id', /edge\(part,\s*3\)|edgesBetween\(/.test(appended.buffer || ''));
  check('append adds the second edge id', /edge\(part,\s*5\)|edgesBetween\(part,\s*4,\s*6\)/.test(appended.buffer || ''));
}

console.log('fillet follow-up — geometry (bundled wasm)');

register('./manifold-resolve-hook.mjs', import.meta.url);

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
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

await import('../../src/workers/sandboxWorker.js');
await send('init');

async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}

function topoOf(mesh) {
  return indexBoundaryEdges({
    positions: mesh.vertProperties,
    indices: mesh.triVerts,
    faceIDs: mesh.faceID,
  });
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const LOFT_RECT = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(8, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileRectangle(20, 12, true));
let part = placeInFrame(fr, makeLoft([xs0, xs1]));
return part;
`;

const LOFT_CIRCLES = `
const fr = { center: [0,0,0], normal: [0,0,1], x: [1,0,0], y: [0,1,0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileCircle(8, 32));
let part = placeInFrame(fr, makeLoft([xs0, xs1]));
return part;
`;

{
  try {
    const rect = await exec(LOFT_RECT);
    const topo = topoOf(rect.mesh);
    const labels = filletOverlayTargets(topo);
    check('loft rect indexes', topo.faces.length > 0, `faces=${topo.faces.length}`);
    check('loft rect candidate edges are pickable', topo.edges.length > 0 && topo.edges.length < 40,
      `edges=${topo.edges.length}`);
    check('loft rect face labels stay bounded', labels.faces.length > 0 && labels.faces.length < 40,
      `labelFaces=${labels.faces.length}`);
    check('loft rect overlay is not a per-triangle dump', labels.faces.length + labels.edges.length < 80,
      `labels=${labels.faces.length + labels.edges.length} tris=${rect.tris}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ loft rect — ${e.message}`);
  }
  try {
    const circles = await exec(LOFT_CIRCLES);
    const topo = topoOf(circles.mesh);
    const labels = filletOverlayTargets(topo);
    check('loft circles has a pickable rim', topo.edges.length >= 8 && topo.edges.length < 200,
      `edges=${topo.edges.length}`);
    check('loft circles labels bounded', labels.faces.length + labels.edges.length < 200,
      `labels=${labels.faces.length + labels.edges.length}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ loft circles — ${e.message}`);
  }
}

{
  try {
    const cube = await exec('let part = Manifold.cube([40, 30, 20], true);\nreturn part;');
    const cubeTopo = topoOf(cube.mesh);
    check('cube still has 12 sharp edges', cubeTopo.edges.length === 12, `n=${cubeTopo.edges.length}`);
    const first = cubeTopo.edges.slice().sort((a, b) => b.length - a.length)[0];
    const onceScript = `
let part = Manifold.cube([40, 30, 20], true);
const sel = edge(part, ${first.id});
part = filletAlongPath(part, makeSweepPath(sel), 4);
return part;
`;
    const once = await exec(onceScript);
    const mid = topoOf(once.mesh);
    const short = mid.edges.filter((e) => e.length < 2);
    const long = mid.edges.filter((e) => e.length > 8);
    check('filleted box drops blend chords', short.length === 0, `short=${short.length} edges=${mid.edges.length}`);
    check('filleted box keeps sharp edges', long.length >= 8 && long.length <= 16,
      `long=${long.length} all=${mid.edges.length}`);
    const second = long
      .slice()
      .sort((a, b) => dist3(b.mid, first.mid) - dist3(a.mid, first.mid))[0];
    const twiceScript = `
let part = Manifold.cube([40, 30, 20], true);
const sel = edge(part, ${first.id});
part = filletAlongPath(part, makeSweepPath(sel), 4);
const sel2 = edge(part, ${second.id});
part = filletAlongPath(part, makeSweepPath(sel2), 4);
return part;
`;
    const twice = await exec(twiceScript);
    check('second sharp fillet builds', Number.isFinite(twice.volume) && twice.volume > 0, `vol=${twice.volume}`);
    check('second fillet removes more than the first', twice.volume < once.volume - 1,
      `once=${once.volume?.toFixed(2)} twice=${twice.volume?.toFixed(2)}`);
    let stale = false;
    try {
      await exec('let part = Manifold.cube([40, 30, 20], true);\nedge(part, 99999);\nreturn part;');
    } catch (err) {
      stale = /re-pick edges/i.test(String(err && err.message));
    }
    check('missing edge id still asks to re-pick', stale);
  } catch (e) {
    failed++;
    console.log(`  ❌ sequential fillet — ${e.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nfillet follow-up golden passed');
