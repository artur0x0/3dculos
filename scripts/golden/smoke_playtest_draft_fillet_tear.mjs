#!/usr/bin/env node
/**
 * Drafted-face fillet tear. Continues the concave playtest: cut at z = −8,
 * a varying fillet r = 3.65 on the drafted +X rim (path3), then a fillet
 * r = 4 on edgesBetween(4, 76) (path4, the bottom edge whose +X end sits
 * on the 2° face).
 *
 * path3 must keep the arc-to-straight joint, and the same-radius split must
 * not leave a zero-area crack there. endExtend on the variable-profile meta
 * is whichever run wrote last (the sweep pad on an internal piece). That
 * being > 0 does not mean the joint closed, and it is not path4's extension.
 * path4 is the easy kernel; its drafted +X end is checked by a sphere past
 * x = 20, inside the r = 4 profile and still inside the tilted face.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

await import('../../src/workers/sandboxWorker.js');
await send('init');
const exec = async (s) =>
  (await send('execute', { script: s, importedModels: {}, memoryLimitMB: 512 })).payload;

const here = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(join(here, 'fixtures', 'playtest_draft_fillet_tear.txt'), 'utf8');

check('fixture fillets the drafted rim at 3.65',
  /filletAlongPath\(part, path3, 3\.65, \{ variableProfile: true \}\)/.test(full));
check('fixture fillets edgesBetween 4 and 76',
  /edgesBetween\(part, 4, 76\)/.test(full) && /filletAlongPath\(part, path4, 4\)/.test(full));

const body = full.replace(/\n*return\s+part\s*;?\s*$/i, '');
const script = `
${body}
let pathMin = Infinity;
for (const p of path3.points) {
  const d = Math.hypot(p[0] - 20.138, p[1] - 11.05, p[2] - 10);
  if (d < pathMin) pathMin = d;
}
const mesh = part.getMesh();
const np = mesh.numProp || 3;
const vp = mesh.vertProperties;
const tv = mesh.triVerts;
let tinyTear = 0;
let tinyWall = 0;
for (let t = 0; t < tv.length; t += 3) {
  const a = [vp[tv[t] * np], vp[tv[t] * np + 1], vp[tv[t] * np + 2]];
  const b = [vp[tv[t + 1] * np], vp[tv[t + 1] * np + 1], vp[tv[t + 1] * np + 2]];
  const c = [vp[tv[t + 2] * np], vp[tv[t + 2] * np + 1], vp[tv[t + 2] * np + 2]];
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cr = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const area = 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
  if (!(area < 1e-6)) continue;
  const cx = (a[0] + b[0] + c[0]) / 3;
  const cy = (a[1] + b[1] + c[1]) / 3;
  const cz = (a[2] + b[2] + c[2]) / 3;
  if (Math.hypot(cx - 20.121, cy - 11.522, cz - 9.966) <= 1) tinyTear++;
  if (Math.abs(cy - 15) < 0.4 && Math.abs(cz - 6.05) < 0.4) tinyWall++;
}
const ball = (c, rad) => {
  try { return Manifold.intersection(part, Manifold.sphere(rad, 8).translate(c)).volume(); }
  catch (e) { return -1; }
};
globalThis.__note = {
  pathMin,
  tinyTear,
  tinyWall,
  inset: ball([20.05, 11.4, 9.7], 0.025),
  wall: ball([18.8, -5, 0], 0.025),
  extended: ball([20.04, 12.2, -9.9], 0.015),
  e4: selEdges4 && selEdges4[0] ? selEdges4[0].length : 0,
};
return part;
`;

const r = await exec(script);
check('playtest script runs', !r.error, r.error || '');
const note = globalThis.__note;
if (!r.error && note) {
  check('path3 keeps the arc-to-straight joint',
    note.pathMin <= 0.15, `pathMin=${note.pathMin}`);
  check('no zero-area triangle at the drafted-rim tear',
    note.tinyTear === 0, `tinyTear=${note.tinyTear}`);
  check('no zero-area triangle on the semi-arc wall joint',
    note.tinyWall === 0, `tinyWall=${note.tinyWall}`);
  check('inset sphere in the path3 blend is empty',
    note.inset >= 0 && note.inset < 1e-8, `inset=${note.inset}`);
  check('wall sphere stays solid',
    note.wall > 1e-6, `wall=${note.wall}`);
  check('path4 reaches the drafted +X end',
    note.e4 > 39, `e4=${note.e4}`);
  check('path4 cutter extends past that drafted end',
    note.extended >= 0 && note.extended < 1e-9, `extended=${note.extended}`);
}

if (failed) {
  console.log(`❌ playtest-draft-fillet-tear golden FAILED (${failed} checks)`);
  process.exit(1);
}
console.log('playtest-draft-fillet-tear golden passed');
