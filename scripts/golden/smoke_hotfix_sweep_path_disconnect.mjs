#!/usr/bin/env node
/**
 * Hotfix — makeSweepPath "disconnected" on one post-fillet compound edge.
 *
 * After a first planar fillet of a box top rim, Tangent-on pick of a remaining
 * vertical corner yields a ~95-edge G1 chain (valid open path). Rematching
 * those mids to convexEdges is asymmetric by corner (ball-probe drops G1
 * rails) and can feed makeSweepPath a disconnected scrap set.
 *
 * Sweep/Path now emit the picked wire literally. All four corner chains must
 * form a sweep path; largest-component recovery covers chain+stray.
 */
import { register } from 'node:module';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  composeHelperInsert,
  allocateUniqueName,
} from '../../src/utils/helperPaletteSnippets.js';
import { emitSelectedEdgeLiteralLines } from '../../src/utils/faceFeaturePlacement.js';
import {
  buildFeatureEdges,
  propagateTangentEdges,
  edgeKey,
} from '../../src/utils/selectEdge.js';
import {
  orderEdgePath,
  assembleSweepPath,
  makeSweepPathLoud,
} from '../../src/utils/edgeSweepPath.js';
import { canBuildFilletAlongPath } from '../../src/utils/filletAlongPath.js';

register('./manifold-resolve-hook.mjs', import.meta.url);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('hotfix sweep-path disconnect (post-fillet compound)');

function uniqueG1(feat) {
  const seen = new Set();
  const chains = [];
  for (const seed of feat) {
    const prop = propagateTangentEdges(feat, seed);
    const sig = prop.map((e) => edgeKey(e)).sort().join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    chains.push({ seed, prop });
  }
  chains.sort((a, b) => b.prop.length - a.prop.length);
  return chains;
}

function meshToGeom(mesh) {
  const np = mesh.numProp || 3;
  const vp = mesh.vertProperties;
  const nV = vp.length / np;
  const pos = new Float32Array(nV * 3);
  for (let i = 0; i < nV; i++) {
    pos[i * 3] = vp[i * np];
    pos[i * 3 + 1] = vp[i * np + 1];
    pos[i * 3 + 2] = vp[i * np + 2];
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(pos, 3));
  geom.setIndex(new BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  return geom;
}

function edgeLit(e) {
  return `{ a: ${e.a}, b: ${e.b}, va: [${e.va[0]},${e.va[1]},${e.va[2]}], vb: [${e.vb[0]},${e.vb[1]},${e.vb[2]}], length: ${e.length} }`;
}

// ── Literal emit + compose ─────────────────────────────────────
{
  const e0 = {
    key: '0-1', a: 0, b: 1,
    va: [-20, -15, 10], vb: [20, -15, 10],
    mid: [0, -15, 10], length: 40,
  };
  const e1 = {
    key: '1-2', a: 1, b: 2,
    va: [20, -15, 10], vb: [20, 15, 10],
    mid: [20, 0, 10], length: 30,
  };
  const names = new Set();
  const lit = emitSelectedEdgeLiteralLines('part', [e0, e1], names, allocateUniqueName);
  check('literal emit ok', lit.ok === true);
  check('literal emit has va/vb', /va:\s*\[/.test(lit.lines.join('\n')) && /vb:\s*\[/.test(lit.lines.join('\n')));
  check('literal emit no convexEdges', !/convexEdges/.test(lit.lines.join('\n')));

  const buf = composeHelperInsert(
    'let part = Manifold.cube([40, 30, 20], true);\n',
    'filletEdges',
    null,
    { body: 'part', strategy: 'sweep', radius: 2, profile: 'fillet' },
    null,
    [e0, e1],
  );
  check('sweep compose uses literal wire', /selEdges\s*=\s*\[/.test(buf || '') && !/convexEdges\(/.test(buf || ''));
}

// ── Geometry via sandboxWorker ─────────────────────────────────
console.log('post-fillet compound G1 chains (bundled wasm)');

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') {
      waiter.reject(new Error(msg.payload?.message || 'worker error'));
    } else {
      waiter.resolve(msg);
    }
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

const SETUP = `
let part = Manifold.cube([40, 30, 20], true);
const top = convexEdges(part).filter((e) => {
  const m = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];
  return Math.abs(m[2] - 10) < 0.3;
});
part = filletEdges(part, top, 3, { sphericalCorners: false });
`;

const payload = await exec(`${SETUP}\nreturn part;`);
check('top-rim first fillet builds', Number.isFinite(payload?.volume) && payload.volume > 0,
  `vol=${payload?.volume}`);

const feat = buildFeatureEdges(meshToGeom(payload.mesh));
const chains = uniqueG1(feat).filter((c) => c.prop.length >= 20);
check('four compound corner chains', chains.length === 4, `got ${chains.length}`);
check('each chain ~90–100 (playtest ~98)',
  chains.every((c) => c.prop.length >= 90 && c.prop.length <= 100),
  chains.map((c) => c.prop.length).join(','));

const corners = [];
for (const [i, c] of chains.entries()) {
  const r = assembleSweepPath(c.prop);
  const gate = canBuildFilletAlongPath(c.prop);
  let loudOk = false;
  try {
    const v = makeSweepPathLoud(c.prop);
    loudOk = v && v.edgeCount === c.prop.length && v.closed === false;
  } catch (e) {
    loudOk = false;
    console.log(`  loud fail chain ${i}:`, e.message);
  }
  check(`corner ${i} n=${c.prop.length} assembleSweepPath`, r.ok === true && r.value?.closed === false);
  check(`corner ${i} fillet gate`, gate.ok === true);
  check(`corner ${i} makeSweepPathLoud`, loudOk);
  corners.push(c);
}

// Worker: literal makeSweepPath + sweep fillet on two opposite corners
for (const i of [0, 3]) {
  const c = corners[i];
  if (!c) continue;
  const lits = c.prop.map(edgeLit).join(',\n');
  try {
    const out = await exec(`
${SETUP}
const sel = [${lits}];
const path = makeSweepPath(sel);
if (!path || path.closed !== false) throw new Error('expected open path, closed=' + path?.closed);
if (path.edgeCount < 90) throw new Error('expected ~95 edges, got ' + path.edgeCount);
const v0 = part.volume();
part = filletAlongPath(part, path, 1.2);
const v1 = part.volume();
if (!(v1 < v0 - 0.4)) throw new Error('sweep did not remove volume ' + v0 + ' → ' + v1);
return part;
`);
    check(`corner ${i} worker makeSweepPath + filletAlongPath`,
      Number.isFinite(out?.volume) && out.volume > 0, `vol=${out?.volume}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ corner ${i} worker makeSweepPath + filletAlongPath — ${e.message}`);
  }
}

// Pin: 3-edge chain + stray recovers; two opposite edges still refuse.
{
  const V = [[-20, -15, 10], [20, -15, 10], [20, 15, 10], [-20, 15, 10]];
  const mk = (a, b) => {
    const va = V[a], vb = V[b];
    return {
      key: `${a}-${b}`, a, b, va: va.slice(), vb: vb.slice(),
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
    };
  };
  const stray = {
    key: '90-91', a: 90, b: 91,
    va: [100, 0, 0], vb: [101, 0, 0], mid: [100.5, 0, 0], length: 1,
  };
  const rec = orderEdgePath([mk(0, 1), mk(1, 2), mk(2, 3), stray]);
  check('hotfix recovers 3+1', rec.ok && rec.orderedEdges.length === 3 && rec.recovered === true);
  const disc = orderEdgePath([mk(0, 1), mk(2, 3)]);
  check('hotfix still refuses 1+1 split', !disc.ok && disc.code === 'disconnected');
}

console.log(failed ? `\n❌ FAIL (${failed})` : '\n✅ PASS');
process.exit(failed ? 1 : 0);
