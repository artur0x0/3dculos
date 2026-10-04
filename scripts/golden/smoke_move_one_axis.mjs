#!/usr/bin/env node
/**
 * Move one body along a single axis.
 *
 * A picked centroid is the vertex average of the solid the user is looking
 * at. The next run of a fillet does not retessellate the same way, so that
 * average can shift by a few hundredths — outside cut()'s 1e-4 gate — and
 * move() used to throw "that point is not a body centroid". A point that
 * far from every body still throws.
 *
 * The user script is the body of the worker function. It is not nested, and
 * it does not declare cut, hollow, move, moveFace, draftFaces, or deleteFace.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
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

function round4(n) {
  return Math.round(Number(n) * 1e4) / 1e4;
}

{
  const drifted = await exec(`
    let part = Manifold.cube([10, 10, 10], true);
    part = move(part, [8, 0, 0], { bodies: [{ at: [0.04, 0, 0] }] });
    return part;
  `);
  const box = drifted.boundingBox;
  check('a centroid 0.04 off still moves along X',
    Math.abs(box.min[0] - 3) < 1e-3 && Math.abs(box.max[0] - 13) < 1e-3
    && Math.abs(box.min[1] + 5) < 1e-3 && Math.abs(box.max[1] - 5) < 1e-3
    && Math.abs(box.min[2] + 5) < 1e-3 && Math.abs(box.max[2] - 5) < 1e-3,
    JSON.stringify(box));

  const wrong = await execFail(`
    let part = Manifold.cube([10, 10, 10], true);
    part = move(part, [8, 0, 0], { bodies: [{ at: [2, 0, 0] }] });
    return part;
  `);
  check('a point 2mm off the centroid still errors',
    !!wrong && /^move: that point is not a body centroid/.test(wrong),
    wrong || 'no throw');

  const two = await exec(`
    const boxA = Manifold.cube([10, 10, 10], true).translate([-20, 0, 0]);
    const boxB = Manifold.cube([10, 10, 10], true).translate([20, 0, 0]);
    let part = Manifold.compose([boxA, boxB]);
    part = move(part, [0, 10, 0], { bodies: [{ at: [20.04, 0, 0] }] });
    const parts = part.decompose();
    const boxes = parts.map((p) => p.boundingBox());
    const stayed = boxes.find((b) => b.min[0] < 0);
    const shifted = boxes.find((b) => b.min[0] > 0);
    if (!stayed || !shifted) throw new Error('bodies ' + JSON.stringify(boxes));
    if (Math.abs(stayed.min[1] + 5) > 1e-2 || Math.abs(stayed.max[1] - 5) > 1e-2) {
      throw new Error('stayed y ' + JSON.stringify(stayed));
    }
    if (Math.abs(shifted.min[1] - 5) > 1e-2 || Math.abs(shifted.max[1] - 15) > 1e-2) {
      throw new Error('shifted y ' + JSON.stringify(shifted));
    }
    return part;
  `);
  check('only the drifted +X body moves along Y', Math.abs(two.volume - 2000) < 1e-2, `vol=${two.volume}`);

  const miss = await execFail(`
    const boxA = Manifold.cube([10, 10, 10], true).translate([-20, 0, 0]);
    const boxB = Manifold.cube([10, 10, 10], true).translate([20, 0, 0]);
    let part = Manifold.compose([boxA, boxB]);
    part = move(part, [0, 10, 0], { bodies: [{ at: [0, 0, 0] }] });
    return part;
  `);
  check('a point between two bodies still errors',
    !!miss && /^move: that point is not a body centroid/.test(miss) && !/^cut:/.test(miss),
    miss || 'no throw');
}

{
  const shellSrc = readFileSync(
    new URL('./fixtures/artur_playtest_shell_after_fillets.txt', import.meta.url),
    'utf8',
  ).replace(/\n*return\s+part\s*;?\s*$/i, '');
  const base = `${shellSrc}\npart = cut(part, { normal: [0, 0, 1], originOffset: 0 });`;
  const seen = await exec(`${base}\nreturn part;`);
  const picked = (seen.bodyCentroids || []).find((c) => c[2] > 0);
  check('the filleted shell exposes a +Z body centroid', Array.isArray(picked), JSON.stringify(seen.bodyCentroids));
  if (picked) {
    const at = picked.map(round4);
    const moved = await exec(`
      ${base}
      part = move(part, [10, 0, 0], { bodies: [{ at: [${at.join(', ')}] }] });
      return part;
    `);
    const xs = (moved.bodyCentroids || []).map((c) => c[0]);
    const shifted = xs.some((x) => x > 5);
    const stayed = xs.some((x) => x < 2);
    check('that body moves 10 along X and the other stays',
      shifted && stayed && xs.length === 2,
      JSON.stringify(moved.bodyCentroids));
    const far = await execFail(`
      ${base}
      part = move(part, [10, 0, 0], { bodies: [{ at: [0, 0, 0] }] });
      return part;
    `);
    check('the shell still rejects a point that is not a centroid',
      !!far && /^move: that point is not a body centroid/.test(far),
      far || 'no throw');
  }
}

if (failed) {
  console.log(`\n${failed} one-axis move check(s) failed`);
  process.exit(1);
}
console.log('\nAll one-axis move checks passed.');
