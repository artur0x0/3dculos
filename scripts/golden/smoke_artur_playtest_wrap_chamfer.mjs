#!/usr/bin/env node
/**
 * Artur playtest golden — wrap fillet sliver + chamfer on a rounded loop.
 *
 * Fixture `fixtures/artur_playtest_wrap_chamfer.txt` is the script the app
 * emitted, verbatim, from the 2026-10-01 playtest: cube → one r=3 fillet →
 * three r=6 variable-profile fillets → a wrap fillet r=2.88 around the whole
 * y=+15 perimeter (selEdges5 carries dense pre-RDP `pts`) → chamfer c=2.
 *
 * It reproduces the two defects in the playtest screenshots:
 *
 *   (a) a dark surface sliver on the wrap fillet
 *   (b) ribbed/comb-tooth chamfer around the rounded corners
 *
 * MEASURED ROOT CAUSE of (a) — the fins are *coplanar boolean slivers*, not
 * bad geometry. Running the fixture stage by stage, the part is clean through
 * three fillets and the wrap step alone introduces them:
 *
 *   cube                      12 tris    0 fins
 *   + fillet r=3             108 tris    1 fin
 *   + 3x fillet r=6 varProf  396 tris    0 fins
 *   + WRAP r=2.88           6176 tris  143 fins   <-- here
 *   + chamfer c=2           6588 tris  196 fins
 *
 * and every fin lies exactly in one of three planes:
 *
 *   56  y=12.12   == 15 - 2.88, the fillet SETBACK plane (the cutter flank)
 *   53  y=15.00   the face being filleted
 *   28  z=10.00   the adjacent top face
 *
 * So the cutter's planar flanks are exactly coplanar with the part's faces and
 * Manifold re-triangulates the coplanar contact into long needles. The fix is
 * to keep cutter flanks off exact coplanarity (cf. the rear `(-e,-e)` bumper,
 * which is not covering the setback plane on this geometry) — NOT to drop path
 * samples, and NOT to loosen the sliver guard.
 *
 * This golden LOCKS the current numbers so the defect cannot silently worsen,
 * and so the fix shows up as the counts going to ~0. Thresholds are ceilings:
 * tighten them when the cutter fix lands.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

/** Needle/degenerate stats + which axis-plane each long fin lies in. */
function stats(mesh) {
  const np = mesh.numProp || 3;
  const V = [];
  for (let i = 0; i < mesh.vertProperties.length / np; i++) {
    V.push([mesh.vertProperties[i * np], mesh.vertProperties[i * np + 1], mesh.vertProperties[i * np + 2]]);
  }
  let bad = 0;
  let fins = 0;
  const planes = new Map();
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
    if (!(area < 1e-6 || asp < 1e-4)) continue;
    bad++;
    if (L <= 1.0) continue;
    fins++;
    for (const [ax, nm] of [[0, 'x'], [1, 'y'], [2, 'z']]) {
      if (Math.abs(a[ax] - b[ax]) < 1e-6 && Math.abs(a[ax] - c[ax]) < 1e-6) {
        const k = `${nm}=${a[ax].toFixed(2)}`;
        planes.set(k, (planes.get(k) || 0) + 1);
        break;
      }
    }
  }
  return { tris: mesh.triVerts.length / 3, bad, fins, planes };
}

const here = dirname(fileURLToPath(import.meta.url));
const full = readFileSync(join(here, 'fixtures', 'artur_playtest_wrap_chamfer.txt'), 'utf8');

/** Truncate the fixture after the nth occurrence of a block-end marker. */
function upTo(marker, nth) {
  let pos = 0;
  for (let i = 0; i < nth; i++) {
    const at = full.indexOf(marker, pos);
    if (at < 0) return null;
    pos = at + marker.length;
  }
  return full.slice(0, pos) + '\nreturn part;';
}

console.log('Artur playtest — wrap fillet sliver + rounded-loop chamfer');

const F = '// --- fillet-mode end ---';
const stages = [
  ['cube only', upTo('// --- cube end ---', 1)],
  ['+ fillet r=3', upTo(F, 1)],
  ['+ 3x fillet r=6 varProfile', upTo(F, 2)],
  ['+ top-loop wrap r=2.88', upTo(F, 3)],
  ['+ chamfer c=2', upTo('// --- chamfer-mode end ---', 1)],
];

const got = [];
for (const [label, src] of stages) {
  check(`fixture stage present: ${label}`, !!src, 'marker missing');
  if (!src) continue;
  let s = null;
  try {
    const p = await exec(src);
    s = stats(p.mesh);
  } catch (e) {
    check(`${label} builds`, false, e.message);
    continue;
  }
  got.push([label, s]);
  console.log(`      ${label.padEnd(28)} tris=${String(s.tris).padStart(5)} bad=${String(s.bad).padStart(4)} longFins=${String(s.fins).padStart(4)}`);
}

const by = Object.fromEntries(got.map(([k, v]) => [k, v]));

// The part is clean until the wrap step — this is the load-bearing assertion.
check('cube is clean', by['cube only']?.fins === 0, `fins=${by['cube only']?.fins}`);
check(
  'three r=6 variable-profile fillets stay clean',
  by['+ 3x fillet r=6 varProfile']?.fins === 0,
  `fins=${by['+ 3x fillet r=6 varProfile']?.fins}`,
);

// Ceilings on the known defect. Lower these when the cutter fix lands.
const WRAP_FIN_CEILING = 143;
const FULL_FIN_CEILING = 196;
const wrap = by['+ top-loop wrap r=2.88'];
const whole = by['+ chamfer c=2'];
check(
  'wrap fillet fin count does not regress',
  wrap && wrap.fins <= WRAP_FIN_CEILING,
  `fins=${wrap?.fins} ceiling=${WRAP_FIN_CEILING}`,
);
check(
  'whole-script fin count does not regress',
  whole && whole.fins <= FULL_FIN_CEILING,
  `fins=${whole?.fins} ceiling=${FULL_FIN_CEILING}`,
);
check('whole script still builds a solid', whole && whole.tris > 1000, `tris=${whole?.tris}`);

// Pin the DIAGNOSIS, not just the count: the fins are coplanar with the
// setback plane / the filleted face / the adjacent face. If a future change
// makes them non-planar, the cause moved and this golden should be re-read.
if (wrap) {
  const planar = [...wrap.planes.values()].reduce((a, b) => a + b, 0);
  check(
    'wrap fins are coplanar slivers (not scattered geometry)',
    planar >= wrap.fins * 0.9,
    `${planar}/${wrap.fins} lie in an axis plane`,
  );
  const hasSetback = [...wrap.planes.keys()].some((k) => k.startsWith('y=12.1'));
  check(
    'setback plane y=15-2.88 is among the sliver planes (root cause marker)',
    hasSetback,
    [...wrap.planes.keys()].join(' '),
  );
  console.log('      wrap fin planes: ' + [...wrap.planes.entries()]
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '));
}

if (failed) {
  console.error(`\n${failed} Artur playtest check(s) failed.`);
  process.exit(1);
}
console.log('\nAll Artur playtest wrap/chamfer checks passed.');
