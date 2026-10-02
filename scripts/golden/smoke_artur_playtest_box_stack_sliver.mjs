#!/usr/bin/env node
/**
 * Artur playtest 2026-10-02 — box stack corner cusp / leftover material.
 *
 * Fixture `fixtures/artur_playtest_box_stack_sliver.txt` is Artur's exact
 * script: cube → 4 vertical fillets r=6 → top-rim wrap r=6 (dense selEdges5
 * including prior-fillet arcs) → bottom chamfer r=2.
 *
 * Screenshots (fixtures/artur_playtest_box_stack_sliver{,_2,_chamfer_sliver}.png)
 * show a bright triangular leftover at the vertical×top-rim junction — PartGraph
 * colors the remaining material that the same-radius wrap failed to consume.
 *
 * ROOT CAUSE: same-radius fillet-on-fillet. The top-rim path rides the r=6
 * vertical-fillet arcs; a new fillet of r=6 has a collapsing rolling-ball
 * track (centers fall on the prior cylinder axis). The constant-r sweep along
 * those arcs is degenerate and leaves a cusp of leftover material at each
 * corner (verts at (±14,15,±10) outside the ideal corner sphere).
 *
 * FIX: detectSameRadiusArcSites + clipped sphere caps (cornerBox 1.5·r − ball)
 * applied after the sweep; keep the largest component when the boxes nick
 * thin walls and leave scrap.
 *
 * BEFORE (sweep only): sharpCorner≈14, inwardVis=6, faceSliverArea≈10.
 * AFTER: sharpCorner=0, inwardVis=0 on the top-rim stage.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isFilletSliverDirty } from '../../src/utils/filletSliverGuard.js';
import { detectSameRadiusArcSites } from '../../src/utils/filletAlongPath.js';

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
  let tiny = 0, fins = 0, inward = 0, inwardVis = 0, sharpCorner = 0;
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
    // Leftover cusp marker: verts at the prior-fillet/top-rim junction, outside sphere.
    if (Math.abs(Math.abs(v[0]) - 14) < 0.2
        && Math.abs(v[1] - 15) < 0.2
        && Math.abs(Math.abs(v[2]) - 10) < 0.2) {
      sharpCorner++;
    }
    if (v[1] < 8 || Math.abs(v[0]) < 12 || Math.abs(v[2]) < 2) continue;
    let best = Infinity;
    for (const c of centers) {
      if (Math.sign(v[0]) !== Math.sign(c[0]) || Math.sign(v[2]) !== Math.sign(c[2])) continue;
      best = Math.min(best, Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]));
    }
    if (best > 6.2) maxOver = Math.max(maxOver, best - 6);
  }
  return {
    nTri: mesh.triVerts.length / 3,
    tiny,
    fins,
    inward,
    inwardVis,
    sharpCorner,
    maxOver,
    dirty: isFilletSliverDirty(tiny, mesh.triVerts.length / 3),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(join(here, 'fixtures', 'artur_playtest_box_stack_sliver.txt'), 'utf8');

console.log('Artur playtest — box stack same-r corner cusp (r=6 / chamfer r=2)');

// Detector unit check on a synthetic quarter-arc of r=6
{
  const C = [-14, 15, -4];
  const arc = [];
  for (let i = 0; i <= 6; i++) {
    const t = (i / 6) * (Math.PI / 2);
    arc.push([C[0] - 6 * Math.sin(t), 15, C[2] - 6 * Math.cos(t)]);
  }
  // Closed-ish path: long straight + arc + long straight (simplified)
  const pts = [
    [14, 15, -10],
    [-14, 15, -10],
    ...arc.slice(1),
    [-20, 15, 4],
    [-20, 15, -4],
  ];
  // Just the arc alone as open polyline is enough for site detection
  const sites = detectSameRadiusArcSites(arc, false, 6);
  check(
    'detectSameRadiusArcSites finds the r=6 quarter-arc',
    sites.length >= 1 && Math.abs(sites[0].R - 6) < 0.5,
    `n=${sites.length} R=${sites[0]?.R}`,
  );
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
      + `fins=${s.fins} inwardVis=${s.inwardVis} sharpCorner=${s.sharpCorner} maxOver=${s.maxOver.toFixed(2)}`,
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
  'top rim corner-sphere overshoot does not regress',
  top && top.maxOver <= 0.85,
  `maxOver=${top?.maxOver}`,
);
check(
  'top rim long-fin count does not regress',
  top && top.fins <= 40,
  `fins=${top?.fins}`,
);

check('full stack (bottom chamfer) builds', !!fullS && fullS.vol > 0, `vol=${fullS?.vol}`);
check('full stack not sliver-dirty', fullS && !fullS.dirty, `tiny=${fullS?.tiny}/${fullS?.nTri}`);
check(
  'full stack keeps junction cusps consumed',
  fullS && fullS.sharpCorner === 0,
  `sharpCorner=${fullS?.sharpCorner}`,
);
check(
  'full stack visible-area inward triangles do not regress',
  fullS && fullS.inwardVis <= 6,
  `inwardVis=${fullS?.inwardVis}`,
);
check(
  'full stack long-fin count does not regress',
  fullS && fullS.fins <= 160,
  `fins=${fullS?.fins}`,
);

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll Artur box-stack corner-cusp checks passed.');
