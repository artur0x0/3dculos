#!/usr/bin/env node
/**
 * Multi-face shell — one hollow(), pierce faces (Parasolid / OCCT ClosingFaces).
 *
 * Manifold.cube([40, 30, 20], true), wall 2.5.
 * Outer box x [-20,20], y [-15,15], z [-10,10].
 *   1. -Z only. Floor gone. Lid 2.5 (inner ceiling z=7.5). Volume 8687.5.
 *   2. +Z and +Y. Shared edge consumed, no rib. Volume 7156.25.
 *   3. +Z and -Z. Tube, four walls. Volume 6500.
 *   4. +X, +Y, +Z. Three edges consumed. Walls meet at (-20,-15,-10). Volume 5953.125.
 *
 * A kept face offsets inward by exactly t. A removed face is deleted: the
 * cavity corner on a shared removed edge must sit a full t past EACH of those
 * faces (not one bisector push of length t). A vertex in the open void, or a
 * wall ≥10 on Z or ≥15 on Y, fails.
 */
import { register } from 'node:module';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const near = (a, b, tol = 1e-2) => Math.abs(a - b) <= tol;
const nearVol = (a, b) => Math.abs(a - b) <= Math.max(1e-2, 1e-4 * Math.abs(b));

console.log('multi-face shell');

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

function coords(mesh, axis) {
  const np = mesh.numProp || 3;
  const set = new Set();
  for (let i = 0; i < mesh.vertProperties.length; i += np) {
    set.add(Math.round(mesh.vertProperties[i + axis] * 1000) / 1000);
  }
  return [...set].sort((a, b) => a - b);
}

function hasNear(list, v, tol = 0.05) {
  return list.some((x) => Math.abs(x - v) <= tol);
}

function hasVertex(mesh, x, y, z, tol = 0.05) {
  const np = mesh.numProp || 3;
  const vp = mesh.vertProperties;
  for (let i = 0; i < vp.length; i += np) {
    if (Math.abs(vp[i] - x) <= tol
      && Math.abs(vp[i + 1] - y) <= tol
      && Math.abs(vp[i + 2] - z) <= tol) return true;
  }
  return false;
}

function countVoid(mesh, inside) {
  const np = mesh.numProp || 3;
  const vp = mesh.vertProperties;
  let n = 0;
  for (let i = 0; i < vp.length; i += np) {
    if (inside(vp[i], vp[i + 1], vp[i + 2])) n++;
  }
  return n;
}

/** Every vertex sits on a boundary plane. Steiner points on a wall are fine. */
function vertsOnPlanes(mesh, px, py, pz, tol = 0.05) {
  const np = mesh.numProp || 3;
  const vp = mesh.vertProperties;
  const on = (v, planes) => planes.some((p) => Math.abs(v - p) <= tol);
  let off = 0;
  for (let i = 0; i < vp.length; i += np) {
    if (!on(vp[i], px) && !on(vp[i + 1], py) && !on(vp[i + 2], pz)) off++;
  }
  return off;
}

const BOX = 'Manifold.cube([40, 30, 20], true)';
const T = 2.5;

// The worker returns one manifold. Run walls and cavity as two scripts.
async function pair(openingExpr) {
  const walls = await exec(`
    let part = ${BOX};
    part = hollow(part, ${T}, ${openingExpr});
    return part;
  `);
  const cavity = await exec(`
    let part = ${BOX};
    return shell(part, ${T}, ${openingExpr});
  `);
  return { walls, cavity };
}

// 1. One face, -Z. Floor gone. Lid +Z is 2.5.
{
  console.log('\n1. open -Z');
  const { walls, cavity } = await pair('{ center: [0, 0, -10], normal: [0, 0, -1] }');
  check('status manifold', walls.status === 'NoError', walls.status);
  check('volume 8687.5', nearVol(walls.volume, 8687.5), `got ${walls.volume}`);
  const xs = coords(walls.mesh, 0);
  const ys = coords(walls.mesh, 1);
  const zs = coords(walls.mesh, 2);
  check('±X walls at 2.5', hasNear(xs, -20) && hasNear(xs, -17.5) && hasNear(xs, 17.5) && hasNear(xs, 20));
  check('±Y walls at 2.5', hasNear(ys, -15) && hasNear(ys, -12.5) && hasNear(ys, 12.5) && hasNear(ys, 15));
  check('lid inner ceiling z=7.5', hasNear(zs, 7.5) && hasNear(zs, 10) && near(10 - 7.5, T));
  check('floor gone (no inner z=-7.5)', !hasNear(zs, -7.5));
  check('Z wall is not a slab (≥10)', hasNear(zs, 7.5) && (10 - 7.5) < 10);
  check('opening rim still at z=-10', hasNear(zs, -10));
  check('no vertex off the wall planes', vertsOnPlanes(
    walls.mesh,
    [-20, -17.5, 17.5, 20],
    [-15, -12.5, 12.5, 15],
    [-10, 7.5, 10],
  ) === 0);
  // Single opening: cavity clears -Z by a full t, inner ceiling at 7.5.
  check('cavity clears the floor by t', hasVertex(cavity.mesh, -17.5, -12.5, -12.5)
    && hasVertex(cavity.mesh, 17.5, 12.5, 7.5));
  const bb = walls.boundingBox;
  check('outer box kept', near(bb.min[0], -20) && near(bb.max[0], 20)
    && near(bb.min[1], -15) && near(bb.max[1], 15)
    && near(bb.min[2], -10) && near(bb.max[2], 10));
}

// 2. Two adjacent, +Z and +Y. One L opening, shared edge consumed.
{
  console.log('\n2. open +Z and +Y');
  const { walls, cavity } = await pair(`[
    { center: [0, 0, 10], normal: [0, 0, 1] },
    { center: [0, 15, 0], normal: [0, 1, 0] },
  ]`);
  check('status manifold', walls.status === 'NoError', walls.status);
  check('volume 7156.25', nearVol(walls.volume, 7156.25), `got ${walls.volume}`);
  const xs = coords(walls.mesh, 0);
  const ys = coords(walls.mesh, 1);
  const zs = coords(walls.mesh, 2);
  check('±X walls at 2.5', hasNear(xs, -20) && hasNear(xs, -17.5) && hasNear(xs, 17.5) && hasNear(xs, 20));
  check('-Y wall at 2.5', hasNear(ys, -15) && hasNear(ys, -12.5));
  check('-Z wall at 2.5', hasNear(zs, -10) && hasNear(zs, -7.5));
  check('+Y is an opening (no inner wall)', !hasNear(ys, 12.5) && hasNear(ys, 15));
  check('+Z is an opening (no lid)', !hasNear(zs, 7.5) && hasNear(zs, 10));
  check('Y wall is not a slab (≥15)', hasNear(ys, -12.5));
  check('Z wall is not a slab (≥10)', hasNear(zs, -7.5));
  const ribs = countVoid(walls.mesh, (x, y, z) => (
    Math.abs(x) < 17.5 - 0.05 && y > -12.5 + 0.05 && z > -7.5 + 0.05
  ));
  check('no rib in the L void', ribs === 0, `${ribs} verts inside the opening`);
  check('no vertex off the wall planes', vertsOnPlanes(
    walls.mesh,
    [-20, -17.5, 17.5, 20],
    [-15, -12.5, 15],
    [-10, -7.5, 10],
  ) === 0);
  // Full t past BOTH removed faces at once. A bisector push of length t
  // lands near (17.5, 16.77, 11.77) and fails this.
  check('shared edge cleared by t on Y and Z',
    hasVertex(cavity.mesh, 17.5, 17.5, 12.5) && hasVertex(cavity.mesh, -17.5, 17.5, 12.5));
  check('kept walls offset by t inside the cavity',
    hasVertex(cavity.mesh, 17.5, -12.5, -7.5));
}

// 3. Two opposite, +Z and -Z. Tube.
{
  console.log('\n3. open +Z and -Z');
  const { walls, cavity } = await pair(`['z', '-z']`);
  check('status manifold', walls.status === 'NoError', walls.status);
  check('volume 6500', nearVol(walls.volume, 6500), `got ${walls.volume}`);
  const xs = coords(walls.mesh, 0);
  const ys = coords(walls.mesh, 1);
  const zs = coords(walls.mesh, 2);
  check('four side walls at 2.5',
    hasNear(xs, -20) && hasNear(xs, -17.5) && hasNear(xs, 17.5) && hasNear(xs, 20)
    && hasNear(ys, -15) && hasNear(ys, -12.5) && hasNear(ys, 12.5) && hasNear(ys, 15));
  check('no Z walls', !hasNear(zs, 7.5) && !hasNear(zs, -7.5) && hasNear(zs, 10) && hasNear(zs, -10));
  check('Z is not a slab (≥10)', zs.filter((z) => near(Math.abs(z), 7.5)).length === 0);
  check('cavity is a tube through both caps',
    hasVertex(cavity.mesh, 17.5, 12.5, 12.5) && hasVertex(cavity.mesh, -17.5, -12.5, -12.5));
  const ribs = countVoid(walls.mesh, (x, y, z) => (
    Math.abs(x) < 17.5 - 0.05 && Math.abs(y) < 12.5 - 0.05 && Math.abs(z) < 10 - 0.05
  ));
  check('tube bore is empty', ribs === 0, `${ribs} verts in the bore`);
}

// 4. Three at a corner, +X +Y +Z. One bite.
{
  console.log('\n4. open +X +Y +Z');
  const { walls, cavity } = await pair(`['x', 'y', 'z']`);
  check('status manifold', walls.status === 'NoError', walls.status);
  check('volume 5953.125', nearVol(walls.volume, 5953.125), `got ${walls.volume}`);
  const xs = coords(walls.mesh, 0);
  const ys = coords(walls.mesh, 1);
  const zs = coords(walls.mesh, 2);
  check('-X wall at 2.5', hasNear(xs, -20) && hasNear(xs, -17.5) && !hasNear(xs, 17.5));
  check('-Y wall at 2.5', hasNear(ys, -15) && hasNear(ys, -12.5) && !hasNear(ys, 12.5));
  check('-Z wall at 2.5', hasNear(zs, -10) && hasNear(zs, -7.5) && !hasNear(zs, 7.5));
  check('openings still reach the outer faces', hasNear(xs, 20) && hasNear(ys, 15) && hasNear(zs, 10));
  check('Y wall is not a slab (≥15)', hasNear(ys, -12.5));
  check('Z wall is not a slab (≥10)', hasNear(zs, -7.5));
  check('walls still meet at (-20,-15,-10)', hasVertex(walls.mesh, -20, -15, -10));
  const ribs = countVoid(walls.mesh, (x, y, z) => (
    x > -17.5 + 0.05 && y > -12.5 + 0.05 && z > -7.5 + 0.05
  ));
  check('no rib along the consumed edges', ribs === 0, `${ribs} verts inside the bite`);
  check('no vertex off the wall planes', vertsOnPlanes(
    walls.mesh,
    [-20, -17.5, 20],
    [-15, -12.5, 15],
    [-10, -7.5, 10],
  ) === 0);
  // The three-face corner must clear all three planes by t (22.5, 17.5, 12.5).
  // Averaging the three normals into one push of length t does not.
  check('corner bite cleared by t on X, Y and Z', hasVertex(cavity.mesh, 22.5, 17.5, 12.5));
  check('each shared edge cleared by t',
    hasVertex(cavity.mesh, 22.5, 17.5, -7.5)
    && hasVertex(cavity.mesh, 22.5, -12.5, 12.5)
    && hasVertex(cavity.mesh, -17.5, 17.5, 12.5));
  check('inner corner of the three kept walls', hasVertex(cavity.mesh, -17.5, -12.5, -7.5));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
