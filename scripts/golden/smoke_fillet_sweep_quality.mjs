/**
 * Fillet sweep quality against main 1c4e69b.
 *
 * For Artur's wrap-then-hollow script, the wrap-chamfer fixture, and the
 * box-stack sliver fixture:
 *   - two-sided sampled surface distance < 0.02 mm
 *   - no new triangles under the kernel sliver area (1e-8 mm²)
 *   - every densified path knot of each fillet has a cutter ring within 1e-6 mm
 *
 * The ring check is this branch only. Main still sweeps by uniform extrude
 * slices, so it has no ring log. Surface distance is this branch vs that commit.
 */
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const MAIN = '1c4e69b';
const DIST_MAX = 0.02;
const RING_MAX = 1e-6;
const SLIVER_AREA = 1e-8;

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

register(new URL('./manifold-resolve-hook.mjs', import.meta.url));

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

function ensureMainTree() {
  const dir = path.join(os.tmpdir(), `wt-surf-${MAIN}`);
  let ok = false;
  if (fs.existsSync(path.join(dir, 'src/workers/sandboxWorker.js'))) {
    const rev = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    ok = rev.status === 0 && rev.stdout.startsWith(MAIN);
  }
  if (!ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    const add = spawnSync('git', ['-C', REPO, 'worktree', 'add', '--detach', dir, MAIN], {
      encoding: 'utf8',
    });
    if (add.status !== 0) {
      throw new Error(`worktree ${MAIN} failed: ${add.stderr || add.stdout}`);
    }
  }
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) {
    fs.symlinkSync(path.join(REPO, 'node_modules'), nm);
  }
  return dir;
}

function meshFromTree(repoRoot, scriptFile) {
  const worker = path.join(repoRoot, 'src/workers/sandboxWorker.js');
  const dump = path.join(HERE, 'sweep_quality_dump.mjs');
  const res = spawnSync(process.execPath, [dump, worker, scriptFile], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    cwd: REPO,
  });
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || `dump failed (${res.status})`);
  }
  const line = res.stderr.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error(res.stderr || res.stdout || 'dump produced no mesh');
  return JSON.parse(line);
}

function triArea(vp, idx, t, np) {
  const i0 = idx[t * 3] * np;
  const i1 = idx[t * 3 + 1] * np;
  const i2 = idx[t * 3 + 2] * np;
  const ax = vp[i1] - vp[i0];
  const ay = vp[i1 + 1] - vp[i0 + 1];
  const az = vp[i1 + 2] - vp[i0 + 2];
  const bx = vp[i2] - vp[i0];
  const by = vp[i2 + 1] - vp[i0 + 1];
  const bz = vp[i2 + 2] - vp[i0 + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

function countSlivers(mesh) {
  const vp = mesh.vertProperties;
  const idx = mesh.triVerts;
  const np = mesh.numProp || 3;
  const n = idx.length / 3;
  let tiny = 0;
  for (let t = 0; t < n; t++) {
    if (triArea(vp, idx, t, np) < SLIVER_AREA) tiny++;
  }
  return tiny;
}

function dist3(ax, ay, az, bx, by, bz) {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

function distPointTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return dist3(px, py, pz, ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist3(px, py, pz, bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist3(px, py, pz, ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist3(px, py, pz, cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist3(px, py, pz, ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return dist3(px, py, pz, bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return dist3(
    px, py, pz,
    ax + abx * v + acx * w,
    ay + aby * v + acy * w,
    az + abz * v + acz * w,
  );
}

const CELL = 2;
function sliverSet(mesh) {
  const vp = mesh.vertProperties;
  const idx = mesh.triVerts;
  const np = mesh.numProp || 3;
  const nTri = idx.length / 3;
  const sliver = new Uint8Array(nTri);
  for (let t = 0; t < nTri; t++) {
    if (triArea(vp, idx, t, np) < SLIVER_AREA) sliver[t] = 1;
  }
  return sliver;
}

function buildGrid(mesh, sliver) {
  const vp = mesh.vertProperties;
  const idx = mesh.triVerts;
  const np = mesh.numProp || 3;
  const nTri = idx.length / 3;
  const grid = new Map();
  const tris = new Array(nTri);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const add = (ix, iy, iz, t) => {
    const key = `${ix}|${iy}|${iz}`;
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(t);
  };
  for (let t = 0; t < nTri; t++) {
    const i0 = idx[t * 3] * np;
    const i1 = idx[t * 3 + 1] * np;
    const i2 = idx[t * 3 + 2] * np;
    const ax = vp[i0], ay = vp[i0 + 1], az = vp[i0 + 2];
    const bx = vp[i1], by = vp[i1 + 1], bz = vp[i1 + 2];
    const cx = vp[i2], cy = vp[i2 + 1], cz = vp[i2 + 2];
    tris[t] = [ax, ay, az, bx, by, bz, cx, cy, cz];
    if (sliver && sliver[t]) continue;
    const x0 = Math.min(ax, bx, cx);
    const y0 = Math.min(ay, by, cy);
    const z0 = Math.min(az, bz, cz);
    const x1 = Math.max(ax, bx, cx);
    const y1 = Math.max(ay, by, cy);
    const z1 = Math.max(az, bz, cz);
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (z0 < minZ) minZ = z0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
    if (z1 > maxZ) maxZ = z1;
    const ix0 = Math.floor(x0 / CELL);
    const iy0 = Math.floor(y0 / CELL);
    const iz0 = Math.floor(z0 / CELL);
    const ix1 = Math.floor(x1 / CELL);
    const iy1 = Math.floor(y1 / CELL);
    const iz1 = Math.floor(z1 / CELL);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) add(ix, iy, iz, t);
      }
    }
  }
  return { grid, tris, minX, minY, minZ, maxX, maxY, maxZ };
}

function distToMesh(grid, px, py, pz) {
  const { grid: cells, tris } = grid;
  const ix = Math.floor(px / CELL);
  const iy = Math.floor(py / CELL);
  const iz = Math.floor(pz / CELL);
  const span = Math.ceil(Math.max(
    Math.abs(px - grid.minX), Math.abs(px - grid.maxX),
    Math.abs(py - grid.minY), Math.abs(py - grid.maxY),
    Math.abs(pz - grid.minZ), Math.abs(pz - grid.maxZ),
  ) / CELL) + 2;
  let best = Infinity;
  const seen = new Set();
  for (let r = 0; r <= span; r++) {
    if (r > 1 && (r - 1) * CELL >= best) break;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const list = cells.get(`${ix + dx}|${iy + dy}|${iz + dz}`);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const t = list[i];
            if (seen.has(t)) continue;
            seen.add(t);
            const tri = tris[t];
            const d = distPointTri(px, py, pz, tri[0], tri[1], tri[2], tri[3], tri[4], tri[5], tri[6], tri[7], tri[8]);
            if (d < best) best = d;
          }
        }
      }
    }
  }
  return best;
}

function bruteDist(grid, px, py, pz) {
  let best = Infinity;
  const tris = grid.tris;
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t];
    const d = distPointTri(px, py, pz, tri[0], tri[1], tri[2], tri[3], tri[4], tri[5], tri[6], tri[7], tri[8]);
    if (d < best) best = d;
  }
  return best;
}

function samplePoints(mesh, sliver) {
  const vp = mesh.vertProperties;
  const idx = mesh.triVerts;
  const np = mesh.numProp || 3;
  const nTri = idx.length / 3;
  const nVert = vp.length / np;
  const live = new Uint8Array(nVert);
  const pts = [];
  for (let t = 0; t < nTri; t++) {
    if (sliver && sliver[t]) continue;
    const i0 = idx[t * 3];
    const i1 = idx[t * 3 + 1];
    const i2 = idx[t * 3 + 2];
    live[i0] = 1;
    live[i1] = 1;
    live[i2] = 1;
    const a = i0 * np;
    const b = i1 * np;
    const c = i2 * np;
    pts.push([
      (vp[a] + vp[b] + vp[c]) / 3,
      (vp[a + 1] + vp[b + 1] + vp[c + 1]) / 3,
      (vp[a + 2] + vp[b + 2] + vp[c + 2]) / 3,
    ]);
  }
  for (let i = 0; i < nVert; i++) {
    if (!live[i]) continue;
    pts.push([vp[i * np], vp[i * np + 1], vp[i * np + 2]]);
  }
  return pts;
}

function maxSurfaceDist(fromMesh, toGrid, sliver) {
  const pts = samplePoints(fromMesh, sliver);
  let worst = 0;
  let at = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const d = distToMesh(toGrid, p[0], p[1], p[2]);
    if (d > worst) {
      worst = d;
      at = p;
    }
  }
  return { worst, at, samples: pts.length };
}

function ringReport(log) {
  const calls = Array.isArray(log) ? log : [];
  let longest = 0;
  for (const call of calls) longest = Math.max(longest, call.knots?.length || 0);
  let worst = 0;
  let wrapWorst = 0;
  let knots = 0;
  let wrapKnots = 0;
  let over = 0;
  for (const call of calls) {
    const ks = call.knots || [];
    const origins = call.origins || [];
    if (!ks.length) continue;
    const isWrap = ks.length === longest && longest >= 8;
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      let best = Infinity;
      for (let j = 0; j < origins.length; j++) {
        const o = origins[j];
        const d = Math.hypot(k[0] - o[0], k[1] - o[1], k[2] - o[2]);
        if (d < best) best = d;
      }
      knots++;
      if (best > worst) worst = best;
      if (best > RING_MAX) over++;
      if (isWrap) {
        wrapKnots++;
        if (best > wrapWorst) wrapWorst = best;
      }
    }
  }
  return { worst, wrapWorst, knots, wrapKnots, over, longest, calls: calls.length };
}

function verifyGrid(grid, mesh) {
  const vp = mesh.vertProperties;
  const idx = mesh.triVerts;
  const np = mesh.numProp || 3;
  const samples = [];
  for (let t = 0; t < idx.length / 3 && samples.length < 2; t++) {
    if (triArea(vp, idx, t, np) < SLIVER_AREA) continue;
    const i = idx[t * 3] * np;
    samples.push([vp[i], vp[i + 1], vp[i + 2]]);
  }
  for (const p of samples) {
    const fast = distToMesh(grid, p[0], p[1], p[2]);
    const slow = bruteDist(grid, p[0], p[1], p[2]);
    if (Math.abs(fast - slow) > 1e-6) {
      throw new Error(`grid distance ${fast} != brute ${slow} at ${p}`);
    }
  }
}

await import(pathToFileURL(path.join(REPO, 'src/workers/sandboxWorker.js')).href);
await send('init');

const mainTree = ensureMainTree();
console.log(`baseline tree ${MAIN} at ${mainTree}`);

const fixtures = [
  ['artur wrap + hollow', path.join(HERE, 'fixtures/artur_wrap_hollow.txt')],
  ['wrap chamfer', path.join(HERE, 'fixtures/artur_playtest_wrap_chamfer.txt')],
  ['box-stack sliver', path.join(HERE, 'fixtures/artur_playtest_box_stack_sliver.txt')],
];

for (const [name, file] of fixtures) {
  console.log(`\n${name}`);
  const script = fs.readFileSync(file, 'utf8');
  const branchRes = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  if (branchRes.type === 'error' || !branchRes.payload?.mesh) {
    check(`${name} runs`, false, branchRes.payload?.message || 'no mesh');
    continue;
  }
  const branch = {
    volume: branchRes.payload.volume,
    tris: branchRes.payload.tris,
    numProp: branchRes.payload.mesh.numProp || 3,
    vertProperties: branchRes.payload.mesh.vertProperties,
    triVerts: branchRes.payload.mesh.triVerts,
  };
  const rings = ringReport(globalThis.__filletSweepRingLog);
  console.log(
    `  rings  knots=${rings.knots} wrapKnots=${rings.wrapKnots} `
    + `longest=${rings.longest} maxGap=${rings.worst} wrapGap=${rings.wrapWorst}`,
  );
  check(
    `${name} wrap knots have a cutter ring within ${RING_MAX}`,
    rings.wrapKnots > 0 && rings.wrapWorst <= RING_MAX,
    `wrapGap=${rings.wrapWorst} wrapKnots=${rings.wrapKnots}`,
  );
  check(
    `${name} every fillet knot has a cutter ring within ${RING_MAX}`,
    rings.knots > 0 && rings.over === 0,
    `over=${rings.over} maxGap=${rings.worst}`,
  );

  let mainMesh;
  try {
    mainMesh = meshFromTree(mainTree, file);
  } catch (e) {
    check(`${name} main mesh`, false, String(e && e.message ? e.message : e));
    continue;
  }
  const branchSliver = countSlivers(branch);
  const mainSliver = countSlivers(mainMesh);
  console.log(
    `  volume branch=${branch.volume} main=${mainMesh.volume} `
    + `Δ=${branch.volume - mainMesh.volume}`,
  );
  console.log(
    `  tris branch=${branch.tris} main=${mainMesh.tris} `
    + `slivers(<${SLIVER_AREA}) branch=${branchSliver} main=${mainSliver}`,
  );
  check(
    `${name} no new sliver triangles`,
    branchSliver <= mainSliver,
    `branch ${branchSliver} > main ${mainSliver}`,
  );

  const sliverBranch = sliverSet(branch);
  const sliverMain = sliverSet(mainMesh);
  const gridMain = buildGrid(mainMesh, sliverMain);
  const gridBranch = buildGrid(branch, sliverBranch);
  verifyGrid(gridMain, mainMesh);
  verifyGrid(gridBranch, branch);
  const ab = maxSurfaceDist(branch, gridMain, sliverBranch);
  const ba = maxSurfaceDist(mainMesh, gridBranch, sliverMain);
  const two = Math.max(ab.worst, ba.worst);
  console.log(
    `  surface branch→main=${ab.worst.toFixed(5)} mm (${ab.samples} samples) `
    + `main→branch=${ba.worst.toFixed(5)} mm two-sided=${two.toFixed(5)} mm`,
  );
  if (ab.at) console.log(`  worst branch point ${ab.at.map((n) => n.toFixed(4)).join(', ')}`);
  if (ba.at) console.log(`  worst main point ${ba.at.map((n) => n.toFixed(4)).join(', ')}`);
  check(
    `${name} two-sided surface distance < ${DIST_MAX} mm`,
    two < DIST_MAX,
    `${two} mm`,
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nfillet sweep quality passed');
