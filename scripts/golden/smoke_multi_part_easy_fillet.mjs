#!/usr/bin/env node
/**
 * Multi-part easy fillet: each part comes out the way a solo Fillet of that
 * part would.
 *
 * An untouched Fillet radius is the fixed 2 mm default, clamped down only on
 * a part too thin for it (defaultFilletRadius: 0.45 × the part's thinnest
 * extent). A multi-part Accept used to validate every part with the active
 * part's one session radius, so a thin part took a thicker part's seed. Each
 * part now reseeds against its own solid: 2 mm on the 40 × 30 × 20 block,
 * the 20 mm cube and the cylinder rim; 1.8 mm on the 4 mm plate.
 *
 * The Accept below is the viewport's: picks from each part's pick graph,
 * the session seeded from the active part's picks, planMultiPartEdgeAccept
 * with partEdgeParams, a class per part from that part's own geometry, then
 * composeMultiPartEdgeCommit. Each composed script runs and must match the
 * solo Fillet of that part (seed from its own solid): same radius, class,
 * volume, surface area, triangle count and genus. Both directions (A or B
 * active), and a typed radius still applies to every part.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { toggleEdgeSelectionPropagated } from '../../src/utils/selectEdge.js';
import {
  composeMultiPartEdgeCommit,
  partEdgeParams,
  planMultiPartEdgeAccept,
} from '../../src/utils/multiPartEdges.js';
import {
  composeFilletCommit,
  defaultFilletParams,
  enterFilletState,
  FILLET_DEFAULT_RADIUS,
  hasFilletModeBlock,
  solidMinExtent,
  validateFilletAccept,
} from '../../src/utils/filletMode.js';
import { classifyFilletEdges } from '../../src/utils/filletEdgeClass.js';
import {
  cachedSolidGeometry,
  createSolidCache,
  featureGraphFor,
} from '../../src/utils/partSolidCache.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

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

/** Genus of a closed mesh, positions welded (property seams split verts). */
function genusOf(mesh) {
  const np = mesh.numProp || 3;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const weld = new Map();
  const id = new Int32Array(vp.length / np);
  for (let i = 0; i < id.length; i++) {
    const k = `${Math.round(vp[i * np] * 1e4)},${Math.round(vp[i * np + 1] * 1e4)},${Math.round(vp[i * np + 2] * 1e4)}`;
    if (!weld.has(k)) weld.set(k, weld.size);
    id[i] = weld.get(k);
  }
  const edges = new Set();
  const F = tv.length / 3;
  for (let t = 0; t < F; t++) {
    for (let j = 0; j < 3; j++) {
      const a = id[tv[t * 3 + j]];
      const b = id[tv[t * 3 + ((j + 1) % 3)]];
      edges.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
  }
  const chi = weld.size - edges.size + F;
  return 1 - chi / 2;
}

function topo(run) {
  return {
    volume: run.volume,
    area: run.surfaceArea,
    tris: run.mesh?.triVerts ? run.mesh.triVerts.length / 3 : 0,
    genus: run.mesh?.triVerts ? genusOf(run.mesh) : null,
  };
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const sameTopo = (a, b) => near(a.volume, b.volume) && near(a.area, b.area)
  && a.tris === b.tris && a.genus === b.genus;
const fmt = (t) => `vol ${t.volume.toFixed(3)} area ${t.area.toFixed(3)} tris ${t.tris} genus ${t.genus}`;

console.log('multi-part easy fillet — each part matches its solo fillet');

const PARTS = {
  A: 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;',
  B: 'let part = Manifold.cube([20, 20, 20], true);\nreturn part;',
  P: 'let part = Manifold.cube([40, 30, 4], true);\nreturn part;',
  C: 'let part = Manifold.cylinder(20, 10, 10, 48, true);\nreturn part;',
};

const cache = createSolidCache();
const graphs = {};
for (const [id, script] of Object.entries(PARTS)) {
  const run = await exec(script);
  const solid = cachedSolidGeometry(cache, run.mesh);
  const graph = featureGraphFor(solid.geometry, solid.faceIDs);
  for (const edge of graph.featureEdges) edge.partId = id;
  graphs[id] = { script, run, geometry: solid.geometry, edges: graph.featureEdges };
}

/** One click in Fillet mode on part `id` (tangent propagation on, like the viewport). */
function pick(sel, id, edge) {
  return toggleEdgeSelectionPropagated(sel, edge, { propagate: true, featureEdges: graphs[id].edges });
}
const along = (id, axis, at = null) => graphs[id].edges.find((e) => Math.abs(e.tangent?.[axis] || 0) > 0.99
  && (!at || at(e.mid)));
const topRim = (id) => graphs[id].edges.find((e) => Math.abs(e.tangent?.[2] || 0) < 0.01 && e.mid[2] > 9.9);

/** Default seed for one part's picks: 2 mm, thin-clamped by that part's solid. */
const seedFor = (id, picks = []) => defaultFilletParams(picks, {
  minExtent: solidMinExtent(graphs[id].geometry),
}).radius;

/** The session params after the radius seed effect ran on the active part. */
function sessionParams(sel, activeId, typed = null) {
  const state = enterFilletState([]);
  const active = sel.filter((e) => e.partId === activeId);
  if (typed != null) return { state: { ...state, params: { ...state.params, radius: typed }, radiusTouched: true } };
  return {
    state: { ...state, params: { ...state.params, radius: seedFor(activeId, active) } },
  };
}

/** The viewport's Accept (acceptFillet) + App's compose, as pure calls. */
function multiAccept(sel, activeId, state) {
  const plan = planMultiPartEdgeAccept({
    edges: sel,
    activeId,
    validate: (list) => validateFilletAccept(list, partEdgeParams(state.params, list, {
      touched: !!state.radiusTouched,
      seed: (picks) => seedFor(picks[0].partId, picks),
    })),
  });
  if (!plan.ok) return { ok: false, message: plan.message };
  const groups = plan.groups.map((group) => ({
    partId: group.partId,
    edges: group.edges,
    params: group.gate.normalized,
    filletClass: classifyFilletEdges(group.edges, {
      radius: group.gate.normalized.radius,
      geometry: graphs[group.partId].geometry,
    }).klass,
    geometry: group.partId === activeId ? graphs[group.partId].geometry : null,
  }));
  const parts = {};
  for (const id of Object.keys(graphs)) {
    if (id !== activeId) parts[id] = { script: graphs[id].script, name: id, ok: true };
  }
  const out = composeMultiPartEdgeCommit({
    groups,
    editorId: activeId,
    editorBuffer: graphs[activeId].script,
    parts,
    compose: composeFilletCommit,
    hasBlock: hasFilletModeBlock,
  });
  if (!out.ok) return { ok: false, message: out.message };
  const buffers = { [activeId]: out.editor?.buffer };
  for (const w of out.writes) buffers[w.id] = w.buffer;
  const meta = Object.fromEntries(groups.map((g) => [g.partId, { radius: g.params.radius, klass: g.filletClass }]));
  return { ok: true, buffers, meta };
}

/** A solo Fillet of one part: its own picks, its own seed (or the typed radius). */
function soloAccept(id, edges, typed = null) {
  const state = enterFilletState([]);
  const params = { ...state.params, radius: typed != null ? typed : seedFor(id, edges) };
  const gate = validateFilletAccept(edges, params);
  const klass = classifyFilletEdges(edges, { radius: gate.normalized.radius, geometry: graphs[id].geometry }).klass;
  const res = composeFilletCommit(graphs[id].script, {
    edges,
    params: gate.normalized,
    filletClass: klass,
    geometry: graphs[id].geometry,
  });
  return { ok: res.ok, buffer: res.buffer, radius: gate.normalized.radius, klass };
}

async function compare(label, picksByPart, activeId, typed = null) {
  let sel = [];
  for (const [id, edges] of picksByPart) for (const edge of edges) sel = pick(sel, id, edge);
  const { state } = sessionParams(sel, activeId, typed);
  const multi = multiAccept(sel, activeId, state);
  check(`${label}: multi-part Accept composes`, multi.ok, multi.message);
  if (!multi.ok) return;
  for (const [id] of picksByPart) {
    const own = sel.filter((e) => e.partId === id);
    const solo = soloAccept(id, own, typed);
    check(`${label}: ${id} solo composes`, solo.ok);
    const m = multi.meta[id];
    check(`${label}: ${id} radius + class match solo (${solo.radius} ${solo.klass})`,
      m && m.radius === solo.radius && m.klass === solo.klass,
      `multi ${m?.radius} ${m?.klass}`);
    const [rm, rs] = [await exec(multi.buffers[id]), await exec(solo.buffer)];
    const [tm, ts] = [topo(rm), topo(rs)];
    check(`${label}: ${id} solid matches solo (${fmt(ts)})`, sameTopo(tm, ts), `multi ${fmt(tm)}`);
    check(`${label}: ${id} fillet removed material`, tm.volume < topo(graphs[id].run).volume - 1e-3,
      fmt(tm));
  }
}

const edgeA = along('A', 0, (m) => m[1] < -14 && m[2] > 9);    // 40 mm edge: seed 2
const edgeB = along('B', 2, (m) => m[0] > 9 && m[1] < -9);     // 20 mm edge: seed 2
const edgeP = along('P', 0, (m) => m[1] < -14 && m[2] > 1.9);  // 40 mm edge on a 4 mm plate: 1.8
const rimC = topRim('C');                                       // 62.8 mm rim loop: seed 2
check('fixture edges found', !!(edgeA && edgeB && edgeP && rimC));
check('untouched seed is 2 mm whatever the path length (A, B, rim)',
  FILLET_DEFAULT_RADIUS === 2 && seedFor('A', [edgeA]) === 2 && seedFor('B', [edgeB]) === 2
  && seedFor('C', pick([], 'C', rimC)) === 2,
  `A ${seedFor('A', [edgeA])} B ${seedFor('B', [edgeB])} C ${seedFor('C', pick([], 'C', rimC))}`);
check('the 4 mm plate clamps the seed down (1.8 mm)', seedFor('P', [edgeP]) === 1.8,
  `P ${seedFor('P', [edgeP])}`);

await compare('A then B, B active', [['A', [edgeA]], ['B', [edgeB]]], 'B');
await compare('B then A, A active', [['B', [edgeB]], ['A', [edgeA]]], 'A');
// The rim's 2 mm session seed must not land on the 4 mm plate: P reseeds to 1.8.
await compare('plate + rim, rim active', [['P', [edgeP]], ['C', [rimC]]], 'C');
await compare('plate + rim, plate active', [['C', [rimC]], ['P', [edgeP]]], 'P');
// A typed radius applies to every part, as a typed solo Fillet would.
await compare('typed radius 3, B active', [['A', [edgeA]], ['B', [edgeB]]], 'B', 3);

// Wiring: the viewport Accept reseeds per part unless the radius was typed.
{
  const vp = read('src/components/Viewport.jsx');
  const i = vp.indexOf('const acceptFillet = useCallback');
  const body = vp.slice(i, vp.indexOf('const exitShellMode', i));
  check('acceptFillet validates each part with partEdgeParams',
    /validateFilletAccept\(list, partEdgeParams\(state\.params, list/.test(body));
  check('a typed radius (radiusTouched) skips the per-part reseed',
    /touched: !!state\.radiusTouched/.test(body));
  check('the per-part seed is the fixed default, thin-clamped by that part\'s solid',
    /seed: \(picks\) => defaultFilletParams\(picks, \{\s*minExtent: solidMinExtent\(pickPartGeometry\(picks\[0\]\?\.partId/.test(body));
  const arch = read('docs/architecture.md');
  check('architecture.md documents the per-part seed', /partEdgeParams/.test(arch)
    && /2 mm/.test(arch));
}

if (failed) {
  console.log(`\nmulti-part easy fillet: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nmulti-part easy fillet: all checks passed');
process.exit(0);
