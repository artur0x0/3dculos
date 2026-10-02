#!/usr/bin/env node
/**
 * Artur playtest 2026-10-02 — shell/hollow after vertical + top-rim fillets.
 *
 * Fixture `fixtures/artur_playtest_shell_after_fillets.txt`:
 *   cube(40×30×20) → 4 vertical fillets r=6 → top-rim wrap r=6 →
 *   hollow(2.5, { center:[0,-15,0], normal:[0,-1,0] }).
 *
 * Pre-fix: `_c4OffsetCavity` treated every tessellated fillet facet normal
 * as a distinct plane (1e-6 component match). Junction verts accumulated
 * ~24 near-parallel normals; `_c4SolvePlaneMoves` then shot those verts
 * ~1000mm, cavity volume went negative, and shell threw "no cavity".
 *
 * FIX: angular normal clustering (~15°) in the offset path + displacement
 * cap fallback to smooth avg-normal offset when the solve still blows up.
 *
 * Asserts: hollow succeeds, positive volume, cavity vs solid, open toward
 * -Y (vol below closed hollow; outer bbox still on y=-15), NoError status.
 * Also: simple cube hollow and prior box-stack fillets-only still healthy.
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

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(here, 'fixtures/artur_playtest_shell_after_fillets.txt'),
  'utf8',
);

await import('../../src/workers/sandboxWorker.js');
await send('init');
const exec = async (s) =>
  (await send('execute', { script: s, importedModels: {}, memoryLimitMB: 512 })).payload;

console.log('Artur playtest — shell after fillets');

// ── Baseline: simple cube hollow with the same face pick must still work ──
{
  const simple = await exec(`
    let part = Manifold.cube([40, 30, 20], true);
    part = hollow(part, 2.5, { center: [0, -15, 0], normal: [0, -1, 0] });
    return part;
  `);
  // Open -Y: walls on ±X, ±Z, +Y. Cavity = (40-5)*(30-2.5)*(20-5) = 35*27.5*15.
  const expect = 40 * 30 * 20 - 35 * 27.5 * 15;
  check('simple cube hollow succeeds', simple.status === 'NoError' && simple.volume > 0,
    `status=${simple.status} vol=${simple.volume}`);
  check('simple cube hollow volume exact', Math.abs(simple.volume - expect) < 0.05,
    `got ${simple.volume.toFixed(4)} want ${expect.toFixed(4)}`);
}

// ── Filleted solid (no hollow) ───────────────────────────────────────────
const filletsOnly = fixture.replace(
  /\/\/ --- shell begin ---[\s\S]*\/\/ --- shell end ---/,
  '/* shell skipped */',
);
let solid;
{
  solid = await exec(filletsOnly);
  check('filleted solid builds', solid.status === 'NoError' && solid.volume > 20000,
    `status=${solid.status} vol=${solid.volume}`);
  check('filleted solid bbox intact',
    solid.boundingBox?.min?.[1] === -15 && solid.boundingBox?.max?.[1] === 15,
    JSON.stringify(solid.boundingBox));
}

// ── Exact playtest: hollow open toward -Y ────────────────────────────────
let hollowed;
{
  try {
    hollowed = await exec(fixture);
    check('playtest hollow succeeds', true);
  } catch (e) {
    check('playtest hollow succeeds', false, e.message);
  }
  if (hollowed) {
    check('playtest status NoError', hollowed.status === 'NoError',
      `status=${hollowed.status}`);
    check('playtest positive volume', hollowed.volume > 1e3,
      `vol=${hollowed.volume}`);
    check('playtest cavity exists (vol << solid)',
      hollowed.volume < solid.volume - 1000,
      `hollow=${hollowed.volume.toFixed(1)} solid=${solid.volume.toFixed(1)}`);
    check('playtest outer bbox still on y=-15 (open face plane)',
      Math.abs(hollowed.boundingBox.min[1] + 15) < 1e-6
        && Math.abs(hollowed.boundingBox.max[1] - 15) < 1e-6,
      JSON.stringify(hollowed.boundingBox));
    // Opening toward -Y removes the bottom wall → less material than closed.
    let closed;
    try {
      closed = await exec(filletsOnly.replace(
        '/* shell skipped */',
        "part = hollow(part, 2.5, 'none');",
      ));
    } catch (e) {
      check('closed hollow on same body (for open compare)', false, e.message);
    }
    if (closed) {
      check('open -Y removes the bottom wall vs closed',
        hollowed.volume < closed.volume - 200,
        `open=${hollowed.volume.toFixed(1)} closed=${closed.volume.toFixed(1)}`);
    }
    // Opening probe: rim verts still sit on the -Y plane, but no large -Y-facing
    // triangle covers the face center (that would be a closed bottom wall).
    const np = hollowed.mesh.numProp || 3;
    const vp = hollowed.mesh.vertProperties;
    const tv = hollowed.mesh.triVerts;
    let rimAtOpen = 0;
    for (let i = 0; i < vp.length; i += np) {
      if (Math.abs(vp[i + 1] + 15) < 0.15) rimAtOpen++;
    }
    let centerCapArea = 0;
    for (let t = 0; t < tv.length; t += 3) {
      const ia = tv[t], ib = tv[t + 1], ic = tv[t + 2];
      const ax = vp[ia * np], ay = vp[ia * np + 1], az = vp[ia * np + 2];
      const bx = vp[ib * np], by = vp[ib * np + 1], bz = vp[ib * np + 2];
      const cx = vp[ic * np], cy = vp[ic * np + 1], cz = vp[ic * np + 2];
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      if (Math.abs(my + 15) > 0.5) continue;
      if (Math.abs(mx) > 8 || Math.abs(mz) > 5) continue;
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      const crx = aby * acz - abz * acy;
      const cry = abz * acx - abx * acz;
      const crz = abx * acy - aby * acx;
      const nL = Math.hypot(crx, cry, crz);
      if (nL < 1e-12) continue;
      if (cry / nL < -0.85) centerCapArea += 0.5 * nL;
    }
    check('open-face rim verts exist at y≈-15', rimAtOpen > 0, `rim=${rimAtOpen}`);
    check('no -Y wall covers the opening center',
      centerCapArea < 1,
      `centerCapArea=${centerCapArea.toFixed(3)}`);
  }
}

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll Artur shell-after-fillets checks passed.');
