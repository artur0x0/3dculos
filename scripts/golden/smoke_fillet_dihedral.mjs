/**
 * Fillet rethink — dihedral cutter (non-orthogonal, no hook) + edge-spec A.
 *
 * - 90° dihedral contour / expand matches the orthogonal wedge helpers
 * - acute prism fillet + chamfer removed volume tracks θ, not a 90° wedge
 * - orthogonal cube edge still tracks the 90° area
 * - edge / edgesBetween round-trip; missing id throws re-pick
 * - Fillet Accept emits helpers when boundary ids are present
 */
import {
  filletWedgeContour,
  chamferWedgeContour,
  expandFilletCutterContour,
  dihedralFilletContour,
  dihedralChamferContour,
  expandDihedralCutterContour,
  filletRemovedArea,
  chamferRemovedArea,
  orientFilletFrame,
} from '../../src/utils/filletAlongPath.js';
import { composeFilletCommit } from '../../src/utils/filletMode.js';
import { isFilletSliverDirty } from '../../src/utils/filletSliverGuard.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function maxAbs2(a, b) {
  let m = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const pa = a[i] || [NaN, NaN];
    const pb = b[i] || [NaN, NaN];
    m = Math.max(m, Math.abs(pa[0] - pb[0]), Math.abs(pa[1] - pb[1]));
  }
  return m;
}

console.log('fillet dihedral — pure profile');

{
  const r = 2.5;
  const seg = 12;
  const filletD = maxAbs2(dihedralFilletContour(r, Math.PI / 2, seg), filletWedgeContour(r, seg));
  check('90° fillet contour matches wedge', filletD < 1e-9, `d=${filletD}`);
  const chamferD = maxAbs2(dihedralChamferContour(r, Math.PI / 2), chamferWedgeContour(r));
  check('90° chamfer contour matches wedge', chamferD < 1e-9, `d=${chamferD}`);
  const exD = maxAbs2(
    expandDihedralCutterContour(dihedralFilletContour(r, Math.PI / 2, seg), r, Math.PI / 2),
    expandFilletCutterContour(filletWedgeContour(r, seg), r),
  );
  check('90° fillet expand matches', exD < 1e-9, `d=${exD}`);
  const exC = maxAbs2(
    expandDihedralCutterContour(dihedralChamferContour(3, Math.PI / 2), 3, Math.PI / 2),
    expandFilletCutterContour(chamferWedgeContour(3), 3),
  );
  check('90° chamfer expand matches', exC < 1e-9, `d=${exC}`);
  const area90 = filletRemovedArea(2, Math.PI / 2);
  check('90° fillet area is r²(1−π/4)', Math.abs(area90 - 4 * (1 - Math.PI / 4)) < 1e-12, `a=${area90}`);
  const c90 = chamferRemovedArea(2, Math.PI / 2);
  check('90° chamfer area is ½ c²', Math.abs(c90 - 2) < 1e-12, `a=${c90}`);

  const th = Math.acos(20 / Math.hypot(30, 20));
  const acute = filletRemovedArea(2, th);
  const orth = filletRemovedArea(2, Math.PI / 2);
  check('acute fillet area exceeds 90° area', acute > orth * 2, `acute=${acute} orth=${orth}`);

  const fr = orientFilletFrame([1, 0, 0], [0, 0, -1], [0, 1, 0]);
  check('frame N is a unit in-face axis', Math.abs(Math.hypot(...fr.N) - 1) < 1e-9);
  const leg = fr.N[0] * 0 + fr.N[1] * 0 + fr.N[2] * -1;
  const other = fr.B[0] * 0 + fr.B[1] * 1 + fr.B[2] * 0;
  check('frame legs align with the two faces', Math.abs(Math.abs(leg) - 1) < 1e-6 && other > 0.9,
    `N=${fr.N} B=${fr.B} θ=${fr.theta}`);
  check('90° frame theta', Math.abs(fr.theta - Math.PI / 2) < 1e-9);
}

console.log('fillet dihedral — Accept emits short helpers');

{
  const starter = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n';
  const edge = {
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
    boundaryId: 4,
    faceA: 2,
    faceB: 5,
    pairCount: 1,
  };
  const one = composeFilletCommit(starter, {
    edges: [edge],
    params: { strategy: 'sweep', radius: 2, profile: 'fillet' },
  });
  check('tagged Accept ok', one.ok === true);
  check('tagged Accept uses edgesBetween', /edgesBetween\(/.test(one.buffer || ''));
  check('tagged Accept has no va dump', !/va:/.test(one.buffer || ''));
  const chain = composeFilletCommit(starter, {
    edges: [
      edge,
      { ...edge, key: '2-3', a: 2, b: 3, boundaryId: 7, faceA: 5, faceB: 8, pairCount: 1,
        va: [40, 0, 10], vb: [40, 30, 10], mid: [40, 15, 10], tangent: [0, 1, 0] },
    ],
    params: { strategy: 'sweep', radius: 2 },
  });
  check('chain Accept uses edge()', /flatMap\(\(id\) => edge\(/.test(chain.buffer || ''), chain.buffer);
  check('chain Accept has no va dump', !/va:/.test(chain.buffer || ''));
}

console.log('fillet dihedral — geometry (bundled wasm)');

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

const { register } = await import('node:module');
register('./manifold-resolve-hook.mjs', import.meta.url);
await import('../../src/workers/sandboxWorker.js');
await send('init');

async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}

function sliverOk(mesh) {
  if (!mesh?.triVerts || !mesh?.vertProperties) return false;
  const np = mesh.numProp || 3;
  const V = mesh.vertProperties;
  const T = mesh.triVerts;
  const nTri = T.length / 3;
  let tiny = 0;
  for (let ti = 0; ti < nTri; ti++) {
    const i0 = T[ti * 3] * np;
    const i1 = T[ti * 3 + 1] * np;
    const i2 = T[ti * 3 + 2] * np;
    const ax = V[i1] - V[i0];
    const ay = V[i1 + 1] - V[i0 + 1];
    const az = V[i1 + 2] - V[i0 + 2];
    const bx = V[i2] - V[i0];
    const by = V[i2 + 1] - V[i0 + 1];
    const bz = V[i2 + 2] - V[i0 + 2];
    const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    if (A < 1e-8) tiny++;
  }
  return !isFilletSliverDirty(tiny, nTri);
}

const ACUTE = `
const L = 40, w = 30, h = 20, r = 2;
const cs = new CrossSection([[[0, 0], [w, 0], [0, h]]]);
let part = Manifold.extrude(cs, L);
const before = part.volume();
const theta = Math.acos(h / Math.hypot(w, h));
const apex = convexEdges(part).filter((e) => {
  const my = (e.va[1] + e.vb[1]) / 2;
  const mx = (e.va[0] + e.vb[0]) / 2;
  return Math.abs(mx) < 0.3 && Math.abs(my - h) < 0.3 && Math.abs(e.va[2] - e.vb[2]) > L * 0.5;
});
if (apex.length !== 1) throw new Error('expected one apex edge, got ' + apex.length);
const path = makeSweepPath(apex);
`;

{
  try {
    const payload = await exec(`
${ACUTE}
part = filletAlongPath(part, path, r);
const removed = before - part.volume();
const t = r / Math.tan(theta / 2);
const expect = (r * t - 0.5 * r * r * (Math.PI - theta)) * L;
const orth = r * r * (1 - Math.PI / 4) * L;
if (!(removed > orth * 2)) throw new Error('removed ' + removed.toFixed(3) + ' still looks like a 90° wedge (orth ' + orth.toFixed(3) + ')');
if (Math.abs(removed - expect) / expect > 0.2) {
  throw new Error('removed ' + removed.toFixed(3) + ' vs dihedral ' + expect.toFixed(3));
}
const f1 = [w, -h, 0];
const f1L = Math.hypot(f1[0], f1[1]);
f1[0] /= f1L; f1[1] /= f1L;
const f0 = [0, -1, 0];
let bx = f0[0] + f1[0], by = f0[1] + f1[1];
const bL = Math.hypot(bx, by);
bx /= bL; by /= bL;
const P = [0, h, L / 2];
const bite = [P[0] + bx * 0.4 * r, P[1] + by * 0.4 * r, P[2]];
const spBite = Manifold.sphere(0.25, 12, 8).translate(bite);
const fBite = Manifold.intersection(part, spBite).volume() / spBite.volume();
if (fBite > 0.2) throw new Error('apex bite still inside fIn=' + fBite.toFixed(3));
const inw = [-h, -w];
const inL = Math.hypot(inw[0], inw[1]);
inw[0] /= inL; inw[1] /= inL;
const roof = [
  P[0] + f1[0] * (t + 1) + inw[0] * 0.4,
  P[1] + f1[1] * (t + 1) + inw[1] * 0.4,
  P[2],
];
const spRoof = Manifold.sphere(0.25, 12, 8).translate(roof);
const fRoof = Manifold.intersection(part, spRoof).volume() / spRoof.volume();
if (fRoof < 0.7) throw new Error('roof past setback was cut fIn=' + fRoof.toFixed(3));
return part;
`);
    check('acute fillet builds', Number.isFinite(payload?.volume) && payload.volume > 0, `vol=${payload?.volume}`);
    check('acute fillet no slivers', sliverOk(payload?.mesh));
  } catch (e) {
    failed++;
    console.log(`  ❌ acute fillet — ${e.message}`);
  }
}

{
  try {
    const payload = await exec(`
${ACUTE}
part = filletAlongPath(part, path, r, { profile: 'chamfer' });
const removed = before - part.volume();
const expect = 0.5 * r * r * Math.sin(theta) * L;
const orth = 0.5 * r * r * L;
if (!(removed > orth * 0.5 && removed < orth * 0.95)) {
  throw new Error('chamfer removed ' + removed.toFixed(3) + ' vs dihedral ' + expect.toFixed(3) + ' orth ' + orth.toFixed(3));
}
if (Math.abs(removed - expect) / expect > 0.2) {
  throw new Error('chamfer removed ' + removed.toFixed(3) + ' vs dihedral ' + expect.toFixed(3));
}
return part;
`);
    check('acute chamfer builds', Number.isFinite(payload?.volume) && payload.volume > 0, `vol=${payload?.volume}`);
    check('acute chamfer no slivers', sliverOk(payload?.mesh));
  } catch (e) {
    failed++;
    console.log(`  ❌ acute chamfer — ${e.message}`);
  }
}

{
  try {
    const payload = await exec(`
let part = Manifold.cube([40, 30, 20], true);
const before = part.volume();
const e = convexEdges(part).filter((ed) => {
  const dz = Math.abs(ed.va[2] - ed.vb[2]);
  const len = Math.hypot(ed.vb[0] - ed.va[0], ed.vb[1] - ed.va[1], ed.vb[2] - ed.va[2]);
  return dz < 0.2 && len > 20;
})[0];
if (!e) throw new Error('no long horizontal cube edge');
const edgeLen = Math.hypot(e.vb[0] - e.va[0], e.vb[1] - e.va[1], e.vb[2] - e.va[2]);
const path = makeSweepPath([e]);
const r = 2;
part = filletAlongPath(part, path, r);
const removed = before - part.volume();
const expect = r * r * (1 - Math.PI / 4) * edgeLen;
if (Math.abs(removed - expect) / expect > 0.2) {
  throw new Error('orthogonal removed ' + removed.toFixed(3) + ' vs ' + expect.toFixed(3));
}
return part;
`);
    check('orthogonal cube edge volume', Number.isFinite(payload?.volume) && payload.volume > 0, `vol=${payload?.volume}`);
    check('orthogonal cube edge no slivers', sliverOk(payload?.mesh));
  } catch (e) {
    failed++;
    console.log(`  ❌ orthogonal cube edge — ${e.message}`);
  }
}

{
  try {
    const payload = await exec(`
let part = Manifold.cube([40, 30, 20], true);
const cat = boundaryEdges(part);
if (cat.length !== 12) throw new Error('cube boundary count ' + cat.length);
const again = boundaryEdges(Manifold.cube([40, 30, 20], true));
const sig = (rows) => rows.map((e) => e.id + ':' + e.faceA + ':' + e.faceB).join('|');
if (sig(cat) !== sig(again)) throw new Error('cube edge ids not stable');
const one = cat[0];
const segs = edgesBetween(part, one.faceA, one.faceB);
if (!segs.length || !Array.isArray(segs[0].va)) throw new Error('edgesBetween empty');
const byId = edge(part, one.id);
if (byId.length !== segs.length) throw new Error('edge() length ' + byId.length + ' vs ' + segs.length);
const path = makeSweepPath(segs);
const before = part.volume();
part = filletAlongPath(part, path, 1.2);
if (!(part.volume() < before - 0.2)) throw new Error('edgesBetween fillet removed nothing');
let threw = false;
try { edge(part, 99999); } catch (err) { threw = /re-pick edges/i.test(String(err && err.message)); }
if (!threw) throw new Error('missing edge id did not ask to re-pick');
return part;
`);
    check('edge helpers fillet + re-pick', Number.isFinite(payload?.volume) && payload.volume > 0, `vol=${payload?.volume}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ edge helpers — ${e.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nfillet dihedral golden passed');
