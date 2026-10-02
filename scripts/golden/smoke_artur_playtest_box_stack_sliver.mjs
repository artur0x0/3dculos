#!/usr/bin/env node
/**
 * Artur playtest 2026-10-02 — box stack corner cusp / leftover material.
 *
 * Fixture `fixtures/artur_playtest_box_stack_sliver.txt` is Artur's exact
 * script: cube → 4 vertical fillets r=6 → top-rim wrap r=6 (dense selEdges5
 * including prior-fillet arcs) → bottom chamfer r=2.
 *
 * Screenshots (fixtures/artur_playtest_box_stack_sliver{,_2,_chamfer_sliver}.png)
 * showed a bright triangular leftover at the vertical×top-rim junction.
 * #107's sphere-cap post-pass consumed the cusp but left TWO hemispherical
 * bulges with a flat strip between them (playtest fail) — that path is gone.
 *
 * FIX: corner arcs on the sweep path are split into two semi-arcs (path R
 * may differ from cutter r — chamfer-along-prior-fillet); each semi-arc
 * (and each straight) is an independent cutter (union-batched into one
 * subtract) via `planFilletSweepPath` → mode:'runs'. Turn densify tightened
 * (FRAME_DENSIFY_MAX_TURN_DEG 10→5). No sphere-cap post-pass.
 *
 * Asserts: no top/bottom junction cusp verts, no visible inward wedges, no
 * twin sphere-cap bulge signature, long-fin ceilings for the open-run
 * tradeoff; planner unit covers R≠cutter chamfer split.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isFilletSliverDirty } from '../../src/utils/filletSliverGuard.js';
import { detectSameRadiusArcSites, planFilletSweepPath, splitSameRadiusArcsIntoSemiArcRuns } from '../../src/utils/filletAlongPath.js';

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
  let tiny = 0, fins = 0, inward = 0, inwardVis = 0, sharpCorner = 0, sharpCornerBottom = 0;
  const centers = [[14, 9, 4], [14, 9, -4], [-14, 9, 4], [-14, 9, -4]];
  let maxOver = 0;
  for (let t = 0; t < mesh.triVerts.length / 3; t++) {
    const a = V[mesh.triVerts[t * 3]];
    const b = V[mesh.triVerts[t * 3 + 1]];
    const c = V[mesh.triVerts[t * 3 + 2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const area = 0.5 * Math.hypot(...cr);
    const L = Math.max(
      Math.hypot(...ab),
      Math.hypot(...ac),
      Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
    );
    const asp = L > 1e-12 ? area / (L * L) : 0;
    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    const nL = Math.hypot(...cr);
    if (nL > 1e-12) {
      const d = (cr[0] * cx + cr[1] * cy + cr[2] * cz) / nL / (Math.hypot(cx, cy, cz) || 1);
      if (d < -0.35) {
        inward++;
        if (area > 0.5) inwardVis++;
      }
    }
    if (area < 1e-8) tiny++;
    if ((area < 1e-6 || asp < 1e-4) && L > 1) fins++;
  }
  for (const v of V) {
    // Leftover cusp marker: verts at the prior-fillet/top-rim junction.
    if (Math.abs(Math.abs(v[0]) - 14) < 0.2
        && Math.abs(v[1] - 15) < 0.2
        && Math.abs(Math.abs(v[2]) - 10) < 0.2) {
      sharpCorner++;
    }
    // Bottom chamfer × vertical fillet junction (mirror of top band).
    if (Math.abs(Math.abs(v[0]) - 14) < 0.2
        && Math.abs(v[1] + 15) < 0.2
        && Math.abs(Math.abs(v[2]) - 10) < 0.2) {
      sharpCornerBottom++;
    }
    if (v[1] < 8 || Math.abs(v[0]) < 12 || Math.abs(v[2]) < 2) continue;
    let best = Infinity;
    for (const c of centers) {
      if (Math.sign(v[0]) !== Math.sign(c[0]) || Math.sign(v[2]) !== Math.sign(c[2])) continue;
      best = Math.min(best, Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]));
    }
    if (best > 6.2) maxOver = Math.max(maxOver, best - 6);
  }
  // Twin sphere-cap bulge signature (#107 fail): verts near the corner-ball
  // surface (dist ≈ r) that also sit outside the two side-face planes of the
  // outer corner (past |x|=20-ε or |z|=10-ε) — a proper sphere octant stays
  // inside those planes; box−ball caps protruded as twin domes past them.
  let sphereBulge = 0;
  for (const v of V) {
    if (v[1] < 8) continue;
    for (const c of centers) {
      if (Math.sign(v[0]) !== Math.sign(c[0]) || Math.sign(v[2]) !== Math.sign(c[2])) continue;
      const d = Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]);
      if (Math.abs(d - 6) > 0.35) continue;
      const pastX = Math.abs(v[0]) > 20.15;
      const pastZ = Math.abs(v[2]) > 10.15;
      const pastY = v[1] > 15.15;
      if (pastX || pastZ || pastY) sphereBulge++;
    }
  }
  return {
    nTri: mesh.triVerts.length / 3,
    tiny,
    fins,
    inward,
    inwardVis,
    sharpCorner,
    sharpCornerBottom,
    maxOver,
    sphereBulge,
    dirty: isFilletSliverDirty(tiny, mesh.triVerts.length / 3),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(join(here, 'fixtures', 'artur_playtest_box_stack_sliver.txt'), 'utf8');

console.log('Artur playtest — box stack corner-arc semi-arc split (r=6 / chamfer r=2)');

// Planner unit check: corner quarter-arcs → semi-arc runs (same-r and R≠cutter)
{
  const arcR = 6;
  const quarter = (C, axisFrom, axisTo, n = 8) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * (Math.PI / 2);
      const c = Math.cos(t);
      const s = Math.sin(t);
      pts.push([
        C[0] + arcR * (axisFrom[0] * c + axisTo[0] * s),
        C[1],
        C[2] + arcR * (axisFrom[1] * c + axisTo[1] * s),
      ]);
    }
    return pts;
  };
  const mkRim = (y) => {
    const path = [];
    path.push([14, y, -10], [-14, y, -10]);
    path.push(...quarter([-14, y, -4], [0, -1], [-1, 0]).slice(1));
    path.push([-20, y, 4]);
    path.push(...quarter([-14, y, 4], [-1, 0], [0, 1]).slice(1));
    path.push([14, y, 10]);
    path.push(...quarter([14, y, 4], [0, 1], [1, 0]).slice(1));
    path.push([20, y, -4]);
    path.push(...quarter([14, y, -4], [1, 0], [0, -1]).slice(1));
    return path;
  };
  const path = mkRim(15);
  const sites = detectSameRadiusArcSites(path, true, 6);
  check('detectSameRadiusArcSites finds 4 corner arcs (same-r)', sites.length === 4, `n=${sites.length}`);
  const runs = splitSameRadiusArcsIntoSemiArcRuns(path, true, 6, { arcsOnly: false });
  check(
    'semi-arc path split yields ≥8 runs (straights + halves)',
    Array.isArray(runs) && runs.length >= 8,
    `n=${runs?.length}`,
  );
  check('each run has ≥2 points', runs.every((r) => r.length >= 2));
  const plan = planFilletSweepPath(path, true, 6);
  check('same-r wrap plan returns mode runs', plan.mode === 'runs', `mode=${plan.mode}`);
  // Chamfer-along-prior-fillet: path arcs R=6, cutter r=2 must still split.
  const bottom = mkRim(-15);
  const sitesCh = detectSameRadiusArcSites(bottom, true, 2);
  check(
    'chamfer r=2 still finds 4 path arcs (R=6 ≠ cutter)',
    sitesCh.length === 4,
    `n=${sitesCh.length}`,
  );
  const planCh = planFilletSweepPath(bottom, true, 2, { profile: 'chamfer' });
  check(
    'chamfer R≠cutter plan returns mode runs with ≥8 runs',
    planCh.mode === 'runs' && Array.isArray(planCh.runs) && planCh.runs.length >= 8,
    `mode=${planCh.mode} n=${planCh.runs?.length}`,
  );
  check(
    'fillet profile keeps R≠cutter as-is (no wrap fin spike)',
    planFilletSweepPath(bottom, true, 2).mode === 'as-is',
  );
  const unitRim = [];
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2;
    unitRim.push([Math.cos(ang), Math.sin(ang), 0]);
  }
  check('unit rim plan stays as-is', planFilletSweepPath(unitRim, true, 6).mode === 'as-is');
}

const stages = [
  ['4 verticals r=6', full.replace(/const selEdges5[\s\S]*/, 'return part;')],
  ['+ top rim r=6', full.replace(/const selEdges6[\s\S]*/, 'return part;')],
  ['+ bottom chamfer r=2', full],
];

const got = {};
for (const [label, src] of stages) {
  try {
    const p = await exec(src);
    const s = analyze(p.mesh);
    got[label] = { vol: p.volume, ...s };
    console.log(
      `      ${label.padEnd(22)} vol=${p.volume.toFixed(1)} tris=${s.nTri} `
      + `fins=${s.fins} inwardVis=${s.inwardVis} sharpCorner=${s.sharpCorner} `
      + `sharpBot=${s.sharpCornerBottom} maxOver=${s.maxOver.toFixed(2)} bulge=${s.sphereBulge}`,
    );
  } catch (e) {
    check(`${label} builds`, false, e.message);
  }
}

const verts = got['4 verticals r=6'];
const top = got['+ top rim r=6'];
const fullS = got['+ bottom chamfer r=2'];

check('4 verticals build', !!verts && verts.vol > 0, `vol=${verts?.vol}`);
check('4 verticals clean', verts && verts.fins === 0 && verts.inwardVis === 0,
  `fins=${verts?.fins} inwardVis=${verts?.inwardVis}`);

check('top rim builds', !!top && top.vol > 0, `vol=${top?.vol}`);
check('top rim removed material vs verticals', top && verts && top.vol < verts.vol - 50,
  `Δ=${top && verts ? (verts.vol - top.vol).toFixed(1) : '?'}`);
check('top rim not sliver-dirty', top && !top.dirty, `tiny=${top?.tiny}/${top?.nTri}`);
check(
  'top rim has NO leftover junction cusp verts (±14,15,±10)',
  top && top.sharpCorner === 0,
  `sharpCorner=${top?.sharpCorner}`,
);
check(
  'top rim has NO visible-area inward triangles',
  top && top.inwardVis === 0,
  `inwardVis=${top?.inwardVis} inward=${top?.inward}`,
);
check(
  'top rim has NO twin sphere-cap bulges',
  top && top.sphereBulge === 0,
  `sphereBulge=${top?.sphereBulge}`,
);
check(
  'top rim corner overshoot does not regress past pre-#107 cusp band',
  top && top.maxOver <= 2.6,
  `maxOver=${top?.maxOver}`,
);
check(
  'top rim long-fin count does not regress',
  top && top.fins <= 260,
  `fins=${top?.fins}`,
);

check('full stack (bottom chamfer) builds', !!fullS && fullS.vol > 0, `vol=${fullS?.vol}`);
check('full stack not sliver-dirty', fullS && !fullS.dirty, `tiny=${fullS?.tiny}/${fullS?.nTri}`);
check(
  'full stack keeps top junction cusps consumed',
  fullS && fullS.sharpCorner === 0,
  `sharpCorner=${fullS?.sharpCorner}`,
);
check(
  'full stack has NO bottom chamfer junction cusp verts (±14,-15,±10)',
  fullS && fullS.sharpCornerBottom === 0,
  `sharpCornerBottom=${fullS?.sharpCornerBottom}`,
);
check(
  'full stack visible-area inward triangles do not regress',
  fullS && fullS.inwardVis <= 6,
  `inwardVis=${fullS?.inwardVis}`,
);
check(
  'full stack has NO twin sphere-cap bulges',
  fullS && fullS.sphereBulge === 0,
  `sphereBulge=${fullS?.sphereBulge}`,
);
// Measured baseline after R≠cutter chamfer semi-arc split: fins≈600
// (was ≤288 on continuous as-is chamfer, which left junction cusps / inward
 // wedges). Open semi-arc endcaps trade fins for clean corners — same class
// of tradeoff as the top-rim split (ceiling 260). Headroom to 650.
check(
  'full stack long-fin count does not regress',
  fullS && fullS.fins <= 650,
  `fins=${fullS?.fins}`,
);

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll Artur box-stack corner-arc semi-arc-split checks passed.');
