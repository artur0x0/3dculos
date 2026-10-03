#!/usr/bin/env node
/**
 * Artur playtest — variable-profile wrap over a prior fillet (r=4 then r=4.83).
 *
 * Fixture `fixtures/artur_playtest_variable_wrap_pinch.txt` is the exact
 * script: cube → straight fillet r=4 on the top edge (y=15, z=10) →
 * variableProfile wrap r=4.83 along the +X face boundary. That path includes
 * the quarter-circle the first fillet left (~6.2 mm, four chords, ~15–22°).
 *
 * On #113 main the variable-profile chord densify ran first. Colinear
 * midpoints leave the circle, so densifySweepArcTurns could not resample the
 * arc and the same-radius semi-arc split missed the site. One sweep over the
 * coarse chords pinched the corner (crease dihedral ~10.5°, 30 edges > 8°).
 *
 * Fix: resample circular arcs to ≤5° BEFORE chord densify. Semi-arc split
 * stays. Shell code is untouched.
 *
 * Asserts probe the pinched corner (blend where the prior-fillet arc meets
 * the wrap), not a volume check. Measured after the fix: max crease 4.92°,
 * edges > 8° = 0, fins = 14.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isFilletSliverDirty } from '../../src/utils/filletSliverGuard.js';
import { assembleSweepPath } from '../../src/utils/edgeSweepPath.js';
import {
  densifySweepArcTurns,
  planFilletSweepPath,
} from '../../src/utils/filletAlongPath.js';
import {
  densifyPathPoints,
  variableProfileDensifyStep,
  pathPolylineLength,
  FRAME_DENSIFY_MAX_TURN_DEG,
} from '../../src/utils/edgeTangencyField.js';

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

function maxChordTurnDeg(points) {
  let max = 0;
  const n = points.length;
  for (let i = 1; i < n - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const t0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const t1 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const l0 = Math.hypot(...t0);
    const l1 = Math.hypot(...t1);
    if (l0 < 1e-12 || l1 < 1e-12) continue;
    const dot = (t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2]) / (l0 * l1);
    const ang = Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
    if (ang > max) max = ang;
  }
  return max;
}

/** Corner blend on the +X end of the r=4 fillet, where the wrap crosses the arc. */
function inPinchCorner(p) {
  return p[0] > 14 && p[0] < 20.1 && p[1] > 10.2 && p[1] < 15.05 && p[2] > 5.2 && p[2] < 10.05;
}

function analyze(mesh) {
  const np = mesh.numProp || 3;
  const V = [];
  for (let i = 0; i < mesh.vertProperties.length / np; i++) {
    V.push([
      mesh.vertProperties[i * np],
      mesh.vertProperties[i * np + 1],
      mesh.vertProperties[i * np + 2],
    ]);
  }
  const tris = [];
  let tiny = 0;
  let fins = 0;
  let inwardVis = 0;
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const ia = mesh.triVerts[t];
    const ib = mesh.triVerts[t + 1];
    const ic = mesh.triVerts[t + 2];
    const a = V[ia];
    const b = V[ib];
    const c = V[ic];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const nL = Math.hypot(...cr) || 1;
    let n = [cr[0] / nL, cr[1] / nL, cr[2] / nL];
    const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2] < 0) n = n.map((x) => -x);
    const area = 0.5 * Math.hypot(...cr);
    const L = Math.max(
      Math.hypot(...ab),
      Math.hypot(...ac),
      Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
    );
    const asp = L > 1e-12 ? area / (L * L) : 0;
    if (area < 1e-8) tiny++;
    if ((area < 1e-6 || asp < 1e-4) && L > 1) fins++;
    const nd = (n[0] * cen[0] + n[1] * cen[1] + n[2] * cen[2]) / (Math.hypot(...cen) || 1);
    if (nd < -0.35 && area > 0.5) inwardVis++;
    tris.push({ ia, ib, ic, n, c: cen, area });
  }
  const emap = new Map();
  const ek = (i, j) => (i < j ? `${i},${j}` : `${j},${i}`);
  for (let ti = 0; ti < tris.length; ti++) {
    const tri = tris[ti];
    for (const [i, j] of [[tri.ia, tri.ib], [tri.ib, tri.ic], [tri.ic, tri.ia]]) {
      const k = ek(i, j);
      if (!emap.has(k)) emap.set(k, []);
      emap.get(k).push(ti);
    }
  }
  let creaseMax = 0;
  let creaseOver8 = 0;
  for (const ids of emap.values()) {
    if (ids.length !== 2) continue;
    const A = tris[ids[0]];
    const B = tris[ids[1]];
    if (A.area < 0.02 || B.area < 0.02) continue;
    const mid = [(A.c[0] + B.c[0]) / 2, (A.c[1] + B.c[1]) / 2, (A.c[2] + B.c[2]) / 2];
    if (!inPinchCorner(mid)) continue;
    const dot = A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2];
    const d = Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
    if (d > 70) continue;
    if (d > creaseMax) creaseMax = d;
    if (d > 8) creaseOver8++;
  }
  const nTri = mesh.triVerts.length / 3;
  return {
    nTri,
    tiny,
    fins,
    inwardVis,
    creaseMax,
    creaseOver8,
    dirty: isFilletSliverDirty(tiny, nTri),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(join(here, 'fixtures', 'artur_playtest_variable_wrap_pinch.txt'), 'utf8');
const workerSrc = readFileSync(join(here, '../../src/workers/sandboxWorker.js'), 'utf8');

console.log('Artur playtest — variable wrap over prior fillet (r=4 → r=4.83)');

{
  const iArc = workerSrc.indexOf('densifySweepArcTurns(points');
  const iChord = workerSrc.indexOf('densifyPathPoints(points');
  check(
    'arc resample runs before variable-profile chord densify',
    iArc > 0 && iChord > iArc,
    `arc=${iArc} chord=${iChord}`,
  );
  const m = full.match(/const selEdges2 = (\[[\s\S]*?\]);/);
  check('fixture has selEdges2', !!m);
  if (m) {
    const selEdges2 = Function(`"use strict"; return (${m[1]});`)();
    const assembled = assembleSweepPath(selEdges2);
    check('wrap path assembles', assembled.ok && assembled.value.points.length >= 4);
    const raw = assembled.value.points;
    const rawTurn = maxChordTurnDeg(raw);
    check('raw leftover fillet arc is coarser than 5°', rawTurn > 15, `maxTurn=${rawTurn.toFixed(2)}`);
    const arc = densifySweepArcTurns(raw, false, FRAME_DENSIFY_MAX_TURN_DEG);
    const step = variableProfileDensifyStep(4.83, pathPolylineLength(arc, false));
    const prepared = densifyPathPoints(arc, false, step, { maxTurnDeg: FRAME_DENSIFY_MAX_TURN_DEG });
    const prepTurn = maxChordTurnDeg(prepared);
    check(
      'arc-then-chord keeps consecutive turns ≤ 5°',
      prepTurn <= FRAME_DENSIFY_MAX_TURN_DEG + 0.05,
      `maxTurn=${prepTurn.toFixed(2)} n=${prepared.length}`,
    );
    const chordFirst = densifyPathPoints(raw, false, variableProfileDensifyStep(4.83, pathPolylineLength(raw, false)), {
      maxTurnDeg: FRAME_DENSIFY_MAX_TURN_DEG,
    });
    const poisoned = densifySweepArcTurns(chordFirst, false, FRAME_DENSIFY_MAX_TURN_DEG);
    check(
      'chord-first still leaves the pinch (order matters)',
      maxChordTurnDeg(poisoned) > 15,
      `maxTurn=${maxChordTurnDeg(poisoned).toFixed(2)}`,
    );
    const plan = planFilletSweepPath(prepared, false, 4.83, { profile: 'fillet' });
    check(
      'prepared path still semi-arc splits (mode runs, ≥4)',
      plan.mode === 'runs' && Array.isArray(plan.runs) && plan.runs.length >= 4,
      `mode=${plan.mode} n=${plan.runs?.length}`,
    );
    const rect = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]];
    check(
      'rectangle is not rebuilt into a circle',
      densifySweepArcTurns(rect, true, 5).length === 4,
    );
  }
}

let got;
try {
  const p = await exec(full);
  got = { vol: p.volume, ...analyze(p.mesh) };
  console.log(
    `      wrap  vol=${got.vol.toFixed(1)} tris=${got.nTri} fins=${got.fins} `
    + `inwardVis=${got.inwardVis} creaseMax=${got.creaseMax.toFixed(2)} creaseOver8=${got.creaseOver8}`,
  );
} catch (e) {
  check('variable wrap builds', false, e.message);
}

check('variable wrap builds', !!got && got.vol > 0, `vol=${got?.vol}`);
check(
  'wrap removed material vs the 24000 cube',
  got && got.vol < 23950 && got.vol > 23000,
  `vol=${got?.vol}`,
);
check('wrap not sliver-dirty', got && !got.dirty, `tiny=${got?.tiny}/${got?.nTri}`);
check('wrap has NO visible-area inward triangles', got && got.inwardVis === 0, `inwardVis=${got?.inwardVis}`);
// #113 main (chord densify first): creaseMax ≈ 10.45, creaseOver8 = 30.
// After arc-first resample: creaseMax = 4.92, creaseOver8 = 0.
check(
  'pinched corner crease stays within the 5° chord cap',
  got && got.creaseMax <= 7,
  `creaseMax=${got?.creaseMax?.toFixed(2)}`,
);
check(
  'pinched corner has no edges creased past 8°',
  got && got.creaseOver8 === 0,
  `creaseOver8=${got?.creaseOver8}`,
);
// Measured fins=14 after the fix (open semi-arc endcaps). Headroom to 40.
check(
  'wrap long-fin count does not regress',
  got && got.fins <= 40,
  `fins=${got?.fins}`,
);

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll variable-wrap pinch checks passed.');
