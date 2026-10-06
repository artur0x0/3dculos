#!/usr/bin/env node
/**
 * Fillet default radius: a fixed 2 mm, however many edges are picked.
 *
 * The untouched radius used to be 0.1 × the picked path length (clamped
 * 1–6 mm), so every edge added in Fillet mode grew it: one 40 mm edge seeded
 * 4, the whole top loop 6. Now it stays at 2 mm on one part or several; only
 * a part too thin for 2 mm clamps it down (0.45 × the part's thinnest
 * extent), and a typed radius still applies to every part.
 *
 * Real solids (worker + pick graphs, like the viewport), Fillet mode's own
 * seed / Accept calls, and wiring checks on the Viewport seed effect.
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { defaultSweepBlendSize, pathLengthFromEdges, toggleEdgeSelectionPropagated } from '../../src/utils/selectEdge.js';
import { partEdgeParams, planMultiPartEdgeAccept } from '../../src/utils/multiPartEdges.js';
import {
  composeFilletCommit,
  defaultFilletParams,
  defaultFilletRadius,
  enterFilletState,
  FILLET_DEFAULT_RADIUS,
  normalizeFilletParams,
  solidMinExtent,
  validateFilletAccept,
} from '../../src/utils/filletMode.js';
import { classifyFilletEdges } from '../../src/utils/filletEdgeClass.js';
import { cachedSolidGeometry, createSolidCache, featureGraphFor } from '../../src/utils/partSolidCache.js';


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

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

console.log('fillet default radius — fixed 2 mm, thin parts clamp, typed is shared');

const PARTS = {
  A: 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;',
  B: 'let part = Manifold.cube([20, 20, 20], true);\nreturn part;',
  T: 'let part = Manifold.cube([40, 30, 2], true);\nreturn part;',   // 2 mm sheet: too thin for 2
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
const pick = (sel, id, edge) => toggleEdgeSelectionPropagated(sel, edge, { propagate: true, featureEdges: graphs[id].edges });
/** The viewport seed: defaultFilletParams with the part's solid for the thin clamp. */
const seedFor = (id, picks) => defaultFilletParams(picks, { minExtent: solidMinExtent(graphs[id].geometry) }).radius;
/** Straight edges of a part, longest first, so each pick adds path length. */
const straight = (id) => graphs[id].edges.filter((e) => e.length > 1).sort((a, b) => b.length - a.length);

// ── Pure helpers ───────────────────────────────────────────────
check('FILLET_DEFAULT_RADIUS is 2 mm', FILLET_DEFAULT_RADIUS === 2);
check('no part / no extent → 2', defaultFilletRadius() === 2 && defaultFilletParams(null).radius === 2);
check('thick parts keep 2 (10 mm, 4.45 mm)', defaultFilletRadius({ minExtent: 10 }) === 2
  && defaultFilletRadius({ minExtent: 4.45 }) === 2);
check('thin parts clamp (4 → 1.8, 2 → 0.9, 1 → 0.45)', defaultFilletRadius({ minExtent: 4 }) === 1.8
  && defaultFilletRadius({ minExtent: 2 }) === 0.9 && defaultFilletRadius({ minExtent: 1 }) === 0.45);
check('solidMinExtent reads a plain box', solidMinExtent({ min: [0, 0, 0], max: [40, 30, 2] }) === 2);
check('solidMinExtent reads the solids (A 20, T 2)',
  near(solidMinExtent(graphs.A.geometry), 20) && near(solidMinExtent(graphs.T.geometry), 2));
check('enterFilletState / normalizeFilletParams seed 2 without a part',
  enterFilletState(straight('A')).params.radius === 2 && normalizeFilletParams({}, straight('A')).radius === 2);

// ── One part: the seed stays 2 as edges accumulate ─────────────
{
  let sel = [];
  const seeds = [];
  const lens = [];
  const legacy = [];
  for (const edge of straight('A')) {
    if (sel.some((e) => e === edge)) continue;
    sel = pick(sel, 'A', edge);
    seeds.push(seedFor('A', sel));
    lens.push(pathLengthFromEdges(sel));
    legacy.push(defaultSweepBlendSize(pathLengthFromEdges(sel)));
    if (sel.length >= 12) break;
  }
  check(`picked ${sel.length} edges on A, path ${lens[0]?.toFixed(0)} → ${lens.at(-1)?.toFixed(0)} mm`,
    sel.length >= 6 && lens.at(-1) > lens[0] * 3);
  check('the old 0.1 × path seed would have grown', legacy.at(-1) > legacy[0], legacy.join(' '));
  check('seed stays 2 mm after every pick', seeds.every((r) => r === 2), seeds.join(' '));
  // Accept on an accumulated top loop (a closed loop the sweep takes) keeps 2.
  let loop = [];
  for (const edge of straight('A').filter((e) => e.mid[2] > 9.9)) loop = pick(loop, 'A', edge);
  const gate = validateFilletAccept(loop, { ...enterFilletState([]).params, radius: seedFor('A', loop) });
  check(`Accept on the ${loop.length}-edge top loop keeps 2 mm`, loop.length === 4 && gate.ok
    && gate.normalized.radius === 2, gate.message);
}

// ── Several parts: every part's untouched seed stays 2 ─────────
const multiPlan = (sel, activeId, state) => planMultiPartEdgeAccept({
  edges: sel,
  activeId,
  validate: (list) => validateFilletAccept(list, partEdgeParams(state.params, list, {
    touched: !!state.radiusTouched,
    seed: (picks) => seedFor(picks[0].partId, picks),
  })),
});
const radii = (plan) => Object.fromEntries(plan.groups.map((g) => [g.partId, g.gate.normalized.radius]));
{
  let sel = [];
  const rounds = [];
  const [ea, eb] = [straight('A'), straight('B')];
  for (let i = 0; i < 4; i++) {
    sel = pick(sel, 'A', ea[i * 2]);
    sel = pick(sel, 'B', eb[i * 2]);
    const state = { ...enterFilletState([]), radiusTouched: false };
    state.params = { ...state.params, radius: seedFor('B', sel.filter((e) => e.partId === 'B')) };
    const plan = multiPlan(sel, 'B', state);
    rounds.push(plan.ok ? radii(plan) : { err: plan.message });
  }
  check('A + B: every round, both parts seed 2 mm',
    rounds.every((r) => r.A === 2 && r.B === 2), JSON.stringify(rounds));
}

// ── Thin part clamps; thick part beside it keeps 2 ─────────────
let thinSel = [];
{
  const et = straight('T').filter((e) => e.length > 20);
  thinSel = pick(pick([], 'T', et[0]), 'T', et[1]);
  check('thin sheet (2 mm) seeds 0.9 mm', seedFor('T', thinSel) === 0.9, String(seedFor('T', thinSel)));
  let sel = [...thinSel];
  sel = pick(sel, 'A', straight('A')[0]);
  for (const active of ['A', 'T']) {
    const state = enterFilletState([]);
    state.params = { ...state.params, radius: seedFor(active, sel.filter((e) => e.partId === active)) };
    const plan = multiPlan(sel, active, state);
    const r = plan.ok ? radii(plan) : {};
    check(`A + thin T, ${active} active: A 2, T 0.9`, r.A === 2 && r.T === 0.9, plan.message || JSON.stringify(r));
  }
  const gate = validateFilletAccept(thinSel, { ...enterFilletState([]).params, radius: seedFor('T', thinSel) });
  const klass = classifyFilletEdges(thinSel, { radius: gate.normalized.radius, geometry: graphs.T.geometry }).klass;
  const res = composeFilletCommit(graphs.T.script, {
    edges: thinSel, params: gate.normalized, filletClass: klass, geometry: graphs.T.geometry,
  });
  const run = res.ok ? await exec(res.buffer) : null;
  check('thin sheet fillet at the clamped seed runs and removes material',
    !!run && run.volume < graphs.T.run.volume - 1e-3 && run.volume > graphs.T.run.volume * 0.9,
    run ? `vol ${run.volume}` : 'compose failed');
}

// ── A typed radius is shared across parts ──────────────────────
{
  let sel = [...thinSel];
  sel = pick(sel, 'A', straight('A')[0]);
  sel = pick(sel, 'B', straight('B')[0]);
  const state = enterFilletState([]);
  const typed = { ...state, params: { ...state.params, radius: 0.5 }, radiusTouched: true };
  const plan = multiPlan(sel, 'A', typed);
  const r = plan.ok ? radii(plan) : {};
  check('typed 0.5 lands on A, B and the thin T', r.A === 0.5 && r.B === 0.5 && r.T === 0.5,
    plan.message || JSON.stringify(r));
  const typed3 = { ...state, params: { ...state.params, radius: 3 }, radiusTouched: true };
  const sel2 = pick(pick([], 'A', straight('A')[0]), 'B', straight('B')[0]);
  const plan3 = multiPlan(sel2, 'B', typed3);
  const r3 = plan3.ok ? radii(plan3) : {};
  check('typed 3 lands on A and B', r3.A === 3 && r3.B === 3, plan3.message || JSON.stringify(r3));
}

// ── Wiring ─────────────────────────────────────────────────────
{
  const vp = read('src/components/Viewport.jsx');
  check('seed effect seeds from the active solid, not the picks',
    /const seeded = defaultFilletParams\(filletActiveEdges, \{\s*minExtent: solidMinExtent\(resultRef\.current\?\.geometry\)/.test(vp));
  const i = vp.indexOf('const acceptFillet = useCallback');
  const body = vp.slice(i, vp.indexOf('const exitShellMode', i));
  check('Accept reseeds each untouched part against its own solid',
    /touched: !!state\.radiusTouched/.test(body)
    && /seed: \(picks\) => defaultFilletParams\(picks, \{\s*minExtent: solidMinExtent\(pickPartGeometry\(/.test(body));
  const fm = read('src/utils/filletMode.js');
  const def = fm.slice(fm.indexOf('export function defaultFilletParams'), fm.indexOf('export function enterFilletState'));
  check('defaultFilletParams no longer reads path length', !/pathLength|defaultSweepBlendSize/.test(def));
  check('helper-modal fillet default is the fixed radius too',
    !/defaultSweepBlendSize/.test(read('src/utils/faceFeaturePlacement.js')));
  const arch = read('docs/architecture.md');
  check('architecture.md documents the fixed 2 mm default + thin clamp',
    /defaultFilletRadius/.test(arch) && /golden:fillet-default-radius/.test(arch));
}

if (failed) {
  console.log(`\nfillet default radius: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nfillet default radius: all checks passed');
process.exit(0);
