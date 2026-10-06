/**
 * Edge and contour identity.
 *
 * Packed integer edge keys and the collinear foot bins must not change the
 * pick graph. This freezes chain geometry, boundary ids, and feature-edge
 * order on Artur's hollow wrap (current kernel) and on the denser mesh
 * main produced before that kernel (commit 1c4e69b, 29382 tris).
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { BufferGeometry, BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  buildCoherentEdges,
} from '../../src/utils/selectEdge.js';
import {
  annotateFeatureEdges,
  indexBoundaryEdges,
} from '../../src/utils/boundaryEdgeIds.js';
import { contactSeamSegments } from '../../src/utils/contactSeam.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

function hashChains(edges) {
  const by = new Map();
  for (const e of edges) {
    const id = Number.isFinite(e.chainId) ? e.chainId : -1;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(e);
  }
  const parts = [];
  for (const [id, segs] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
    segs.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    const body = segs.map((s) => {
      const pts = (s.pts || [s.va, s.vb])
        .map((p) => p.map((n) => Number(n).toFixed(5)).join(','))
        .join(';');
      return `${s.a},${s.b}|${pts}|${s.faceA ?? ''}/${s.faceB ?? ''}|b${s.boundaryId ?? ''}|${s.bodyId ?? ''}`;
    }).join('#');
    parts.push(`${id}:${body}`);
  }
  return parts.join('\n');
}

function hashBoundaries(edges) {
  return edges.map((e) => {
    const segs = (e.segments || []).map((s) => `${s.a}-${s.b}`).sort().join(',');
    return `${e.id}:${e.faceA}/${e.faceB}:${e.segments.length}:${segs}`;
  }).join('|');
}

function hashFeatures(edges) {
  return edges.map((e) => `${e.a}-${e.b}:${e.bodyId}`).join('|');
}

function typed(buf, byteStart, count, Ctor) {
  const out = new Ctor(count);
  new Uint8Array(out.buffer).set(buf.subarray(byteStart, byteStart + count * out.BYTES_PER_ELEMENT));
  return out;
}

function loadDense() {
  const raw = inflateSync(readFileSync(new URL('./fixtures/main_dense_artur.bin.gz', import.meta.url)));
  const nVert = raw.readUInt32LE(4);
  const nTri = raw.readUInt32LE(8);
  let o = 16;
  const positions = typed(raw, o, nVert * 3, Float32Array);
  o += nVert * 12;
  const indices = typed(raw, o, nTri * 3, Uint32Array);
  o += nTri * 12;
  const faceIDs = typed(raw, o, nTri, Uint32Array);
  return { positions, indices, faceIDs, nTri, nVert };
}

function geomOf(positions, indices) {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  return g;
}

function identityOf(positions, indices, faceIDs, vertProperties, numProp) {
  const g = geomOf(positions, indices);
  const feature = buildFeatureEdges(g);
  const topo = indexBoundaryEdges({ positions, indices, faceIDs });
  const coherent = buildCoherentEdges(annotateFeatureEdges(feature, topo));
  const seam = vertProperties
    ? contactSeamSegments(vertProperties, indices, numProp || 3)
    : [];
  return {
    featureN: feature.length,
    boundaryN: topo.edges.length,
    faceN: topo.faces.length,
    contourN: coherent.length,
    chains: new Set(coherent.map((e) => e.chainId)).size,
    seamN: seam.length,
    chainHash: fnv(hashChains(coherent)),
    boundaryHash: fnv(hashBoundaries(topo.edges)),
    featureHash: fnv(hashFeatures(feature)),
  };
}

function expectIdentity(name, got, want) {
  for (const key of Object.keys(want)) {
    check(`${name} ${key}`, got[key] === want[key], `got ${got[key]}`);
  }
}

// Re-pinned for the three-fillet corner fix: worker face groups no longer
// re-merge same-offset facets of different fillets, so the r=6 wrap probes
// the true dihedral on a few facets. 12096 → 12100 tris, Δvolume 0.017 mm³,
// same genus and zero-area count; 758 → 729 contour chains.
const ARTUR = {
  featureN: 10746,
  boundaryN: 13,
  faceN: 8373,
  contourN: 907,
  chains: 729,
  seamN: 0,
  chainHash: '8a1c2ec4',
  boundaryHash: '145b1a64',
  featureHash: '264b1ad2',
};

const DENSE = {
  featureN: 21734,
  boundaryN: 8,
  faceN: 19165,
  contourN: 1245,
  chains: 1031,
  seamN: 0,
  chainHash: '1c596973',
  boundaryHash: '1f27defa',
  featureHash: 'e3392062',
};

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

console.log('edge/contour identity — Artur hollow wrap');
const script = readFileSync(new URL('./fixtures/artur_wrap_hollow.txt', import.meta.url), 'utf8');
const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
const mesh = res.payload.mesh;
check('Artur run returns a mesh', !!mesh?.triVerts, res.payload?.status || '');
const np = mesh.numProp || 3;
const src = mesh.vertProperties;
const nVert = Math.floor(src.length / np);
const positions = new Float32Array(nVert * 3);
for (let i = 0; i < nVert; i++) {
  positions[i * 3] = src[i * np];
  positions[i * 3 + 1] = src[i * np + 1];
  positions[i * 3 + 2] = src[i * np + 2];
}
const indices = new Uint32Array(mesh.triVerts);
check('Artur mesh stays 12100 tris', indices.length / 3 === 12100, `tris=${indices.length / 3}`);
const artur = identityOf(positions, indices, mesh.faceID, src, np);
expectIdentity('Artur', artur, ARTUR);

console.log('edge/contour identity — main dense mesh (1c4e69b)');
const dense = loadDense();
check('dense mesh stays 29382 tris', dense.nTri === 29382, `tris=${dense.nTri}`);
const denseId = identityOf(dense.positions, dense.indices, dense.faceIDs, dense.positions, 3);
expectIdentity('dense', denseId, DENSE);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nedge/contour identity passed');
