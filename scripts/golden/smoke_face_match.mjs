/**
 * Face-color fingerprints and matching.
 *
 * A saved key finds one face after a rebuild: 8° on the normal, 1 mm on the
 * centroid, ±25% on area, and the same src/ord when the key has them. Two
 * hits drop the key as ambiguous. None drop it as missing. A key for part A
 * is never tried against part B.
 */
import { register } from 'node:module';
import { buildSolidGeometry } from '../../src/utils/partSolidCache.js';
import { buildPartGraphPatches } from '../../src/utils/partGraphPatches.js';
import {
  faceFingerprints,
  faceColorKey,
  matchFaceKeys,
  matchFaceColors,
} from '../../src/utils/faceColorMatch.js';

register('./manifold-resolve-hook.mjs', import.meta.url);

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const w = pending.get(msg.id);
    if (!w) return;
    pending.delete(msg.id);
    if (msg.type === 'error') w.reject(new Error(msg.payload?.message || 'err'));
    else w.resolve(msg);
  },
};
globalThis.self = workerSelf;
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => workerSelf.onmessage({ data: { type, payload, id } }));
  });
}

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function facesOf(meshData) {
  const { geometry, faceIDs } = buildSolidGeometry(meshData);
  const positions = geometry.attributes.position.array;
  const indices = geometry.index.array;
  const triSource = geometry.userData.triSource || null;
  const graph = buildPartGraphPatches({
    positions,
    indices,
    faceIDs,
    triSource,
    featureTessellation: geometry.userData.featureTessellation || null,
  });
  return faceFingerprints(graph, triSource, { positions, indices });
}

function keysOf(faces) {
  return faces.map((face) => ({ color: '#6b7280', key: faceColorKey(face) }));
}

function roundTrip(items) {
  return JSON.parse(JSON.stringify(items));
}

await import('../../src/workers/sandboxWorker.js');
await send('init');
async function exec(script) {
  return (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload;
}

console.log('face match — exact rebuild');
{
  const mesh = await exec('return Manifold.cube([20, 16, 12], true);');
  const faces = facesOf(mesh.mesh);
  check('box is six faces', faces.length === 6, `n=${faces.length}`);
  const saved = roundTrip(keysOf(faces));
  const hit = matchFaceKeys(faces, saved);
  check('exact rebuild matches every face', hit.matched.length === faces.length && hit.ambiguous.length === 0 && hit.missing.length === 0,
    `matched=${hit.matched.length} ambiguous=${hit.ambiguous.length} missing=${hit.missing.length}`);
  const ids = new Set(hit.matched.map((rec) => rec.face.id));
  check('each face is its own match', ids.size === faces.length);
}

console.log('face match — box grown 0.5 mm');
{
  const before = facesOf((await exec('return Manifold.cube([20, 16, 12], true);')).mesh);
  const after = facesOf((await exec('return Manifold.cube([20.5, 16.5, 12.5], true);')).mesh);
  const hit = matchFaceKeys(after, roundTrip(keysOf(before)));
  const ids = new Set(hit.matched.map((rec) => rec.face.id));
  check('grown box keeps every face', hit.matched.length === before.length && ids.size === after.length && hit.missing.length === 0 && hit.ambiguous.length === 0,
    `matched=${hit.matched.length} missing=${hit.missing.length} ambiguous=${hit.ambiguous.length}`);
}

console.log('face match — removed boss');
{
  const bossed = facesOf((await exec(`
    const box = Manifold.cube([20, 16, 12], true);
    const boss = Manifold.cube([4, 4, 2], true).translate([0, 0, 7]);
    return box.add(boss);
  `)).mesh);
  const plain = facesOf((await exec('return Manifold.cube([20, 16, 12], true);')).mesh);
  const top = bossed.filter((face) => face.n[2] > 0.99).sort((a, b) => b.at[2] - a.at[2])[0];
  check('boss top is a face', !!top && top.at[2] > 7, top ? `z=${top.at[2].toFixed(2)}` : 'none');
  const hit = matchFaceKeys(plain, roundTrip(keysOf(bossed)));
  const topKey = faceColorKey(top);
  const droppedTop = hit.missing.some((rec) => rec.key.at[2] === topKey.at[2] && rec.key.area === topKey.area);
  check('removed boss top is missing', droppedTop, `missing=${hit.missing.length}`);
  check('remaining box faces still match', hit.matched.length >= 5 && hit.ambiguous.length === 0,
    `matched=${hit.matched.length} ambiguous=${hit.ambiguous.length}`);
}

console.log('face match — symmetric faces');
{
  const cyl = facesOf((await exec('return Manifold.cylinder(0.4, 4, 4, 24);')).mesh);
  const caps = cyl.filter((face) => Math.abs(face.n[2]) > 0.99 && face.area > 20);
  check('short cylinder has two caps', caps.length === 2, `n=${caps.length}`);
  const top = caps.find((face) => face.n[2] > 0) || caps[0];
  const bot = caps.find((face) => face !== top);
  const apart = Math.hypot(top.at[0] - bot.at[0], top.at[1] - bot.at[1], top.at[2] - bot.at[2]);
  check('caps sit within 1 mm', apart <= 1 && apart > 0.05, `d=${apart.toFixed(3)}`);
  const own = matchFaceKeys(caps, [{ key: faceColorKey(top) }, { key: faceColorKey(bot) }]);
  check('opposite normals stay distinct', own.matched.length === 2 && own.ambiguous.length === 0,
    `matched=${own.matched.length} ambiguous=${own.ambiguous.length}`);
  const sameSign = { ...bot, n: top.n.slice(), id: bot.id };
  const flipped = matchFaceKeys([top, sameSign], [{ key: faceColorKey(top) }]);
  check('same normal sign drops as ambiguous', flipped.ambiguous.length === 1 && flipped.matched.length === 0,
    `ambiguous=${flipped.ambiguous.length} matched=${flipped.matched.length}`);
}

console.log('face match — fillet src/ord');
{
  const mesh = await exec(`
    const part = Manifold.cube([40, 24, 16], true);
    const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
    if (vertical.length !== 4) throw new Error('expected 4 vertical edges, got ' + vertical.length);
    const score = (e) => (e.va[0] + e.vb[0]) / 2 + (e.va[1] + e.vb[1]) / 2;
    vertical.sort((a, b) => score(a) - score(b));
    return filletEdges(part, [vertical[0], vertical[vertical.length - 1]], 2, { sphericalCorners: false });
  `);
  const faces = facesOf(mesh.mesh);
  const blends = faces.filter((face) => face.src != null);
  const srcs = new Set(blends.map((face) => face.src));
  check('two fillets share one feature', blends.length >= 2 && srcs.size === 1,
    `blends=${blends.length} srcs=${[...srcs].join(',')}`);
  const ords = blends.map((face) => face.ord).sort((a, b) => a - b);
  check('ords are distinct', new Set(ords).size === blends.length && ords[0] === 0,
    `ords=${ords.join(',')}`);
  const saved = roundTrip(keysOf(blends));
  const hit = matchFaceKeys(faces, saved);
  const blendIds = new Set(blends.map((face) => face.id));
  const matchedIds = hit.matched.map((rec) => rec.face.id);
  check('each fillet matches its own face',
    hit.matched.length === blends.length
    && hit.ambiguous.length === 0
    && matchedIds.every((id) => blendIds.has(id))
    && new Set(matchedIds).size === blends.length,
    `matched=${hit.matched.length} ambiguous=${hit.ambiguous.length}`);
  const a = blends[0];
  const b = blends[1];
  const twin = {
    ...b,
    at: [a.at[0] + 0.4, a.at[1], a.at[2]],
    n: a.n.slice(),
    area: a.area,
  };
  const crowded = matchFaceKeys([a, twin], [{ key: { at: a.at.slice(), n: a.n.slice(), area: a.area } }]);
  check('mirrored fillets without src/ord are ambiguous', crowded.ambiguous.length === 1 && crowded.matched.length === 0,
    `ambiguous=${crowded.ambiguous.length}`);
  const separated = matchFaceKeys([a, twin], [{ key: faceColorKey(a) }]);
  check('src/ord keeps the fillet', separated.matched.length === 1 && separated.matched[0].face === a && separated.ambiguous.length === 0,
    `matched=${separated.matched.length}`);
}

console.log('face match — two parts');
{
  const box = facesOf((await exec('return Manifold.cube([20, 16, 12], true);')).mesh);
  const key = faceColorKey(box[0]);
  const onlyB = matchFaceColors(
    [{ surfId: 'part-b', faces: box }],
    { 'part-a': { faces: [{ color: '#ff0000', key }] } },
  );
  check('a key for part A misses on part B', onlyB.matched.length === 0 && onlyB.missing.length === 1 && onlyB.missing[0].surfId === 'part-a');
  const both = matchFaceColors(
    [{ surfId: 'part-a', faces: box }, { surfId: 'part-b', faces: box }],
    { 'part-a': { faces: [{ color: '#ff0000', key }] } },
  );
  check('the same key matches part A', both.matched.length === 1 && both.matched[0].surfId === 'part-a' && both.matched[0].face === box[0] && both.missing.length === 0);
}

console.log('face match — buckets stay cheap');
{
  const faces = [];
  for (let i = 0; i < 3000; i++) {
    faces.push({
      id: i,
      tris: [i],
      at: [i * 2, 0, 0],
      n: [0, 0, 1],
      area: 10,
      kind: 'planar',
    });
  }
  const items = faces.map((face) => ({ key: faceColorKey(face) }));
  const t0 = Date.now();
  const hit = matchFaceKeys(faces, items);
  const ms = Date.now() - t0;
  check('3000 spaced faces all match', hit.matched.length === 3000 && hit.ambiguous.length === 0 && hit.missing.length === 0,
    `matched=${hit.matched.length}`);
  console.log(`  ${ms.toFixed(1)} ms for 3000 faces`);
  check('spaced match stays under 100 ms', ms < 100, `${ms.toFixed(1)} ms`);
}

if (failed) {
  console.log(`\nface match: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nface match: ${passed} passed`);
