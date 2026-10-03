#!/usr/bin/env node
/**
 * Artur playtest 2026-10-02 — shell/hollow after vertical + top-rim fillets.
 *
 * Fixture `fixtures/artur_playtest_shell_after_fillets.txt`:
 *   cube(40×30×20) → 4 vertical fillets r=6 → top-rim wrap r=6 →
 *   hollow(2.5, { center:[0,-15,0], normal:[0,-1,0] }).
 *
 * Pre-#110: `_c4OffsetCavity` treated every tessellated fillet facet normal
 * as a distinct plane (1e-6 match). Junction verts got ~24 near-parallel
 * normals; SolvePlaneMoves shot them ~1000mm → "no cavity".
 *
 * #110: ~15° clustering + avg-normal fallback when |d|>4t. Hollow succeeded
 * but punched through at vertical×top-rim junctions (tri holes / slivers):
 * opposite-sheet normals cancelled in the avg fallback and shoved cavity
 * verts OUT through the wall (cavity AABB overshot ±X/±Z by up to ~2.7mm).
 *
 * #111: ~10° cluster; outward-hemisphere; clamp blown |d|; AABB-clamp closed
 * verts. Outer punch-through fixed, but inner walls still showed jagged
 * gaps at flat↔fillet mid-height: first-wins clustering let scraps own the
 * cone; ill-conditioned LS dragged verts; AABB-face verts missing their
 * plane normal froze/teared under clamp.
 *
 * FIX: area-weighted normal clusters; residual→mean-hemisphere inset
 * fallback; ensure AABB-face normals on closed verts; strip outward
 * component before AABB clamp.
 *
 * Asserts: hollow succeeds, open -Y, cavity stays inside on closed faces,
 * exterior junction thickness ~t, interior mid-height probes, AND interior
 * probes at the flat↔fillet under the top rim (not only mid-height).
 *
 * The remaining top-corner notch was not another shell heuristic. Hollow
 * stays closed only when a vertex's incident normals sit inside the ~10°
 * cluster. The default convex fillet never densified sweep frames
 * (FRAME_DENSIFY_MAX_TURN_DEG ran only for variableProfile), and
 * SWEEP_PATH_MIN_SEG=1.2 mm is ~11° of arc on r=6. Fillet consumption now
 * resamples those arcs to ≤5° (chord ≤ ~0.52 mm at r=6) without rounding
 * sharp corners or subdividing long straights.
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

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(here, 'fixtures/artur_playtest_shell_after_fillets.txt'),
  'utf8',
);

await import('../../src/workers/sandboxWorker.js');
await send('init');
const exec = async (s) =>
  (await send('execute', { script: s, importedModels: {}, memoryLimitMB: 512 })).payload;

console.log('Artur playtest — shell after fillets');

// ── Baseline: simple cube hollow with the same face pick must still work ──
{
  const simple = await exec(`
    let part = Manifold.cube([40, 30, 20], true);
    part = hollow(part, 2.5, { center: [0, -15, 0], normal: [0, -1, 0] });
    return part;
  `);
  // Open -Y: walls on ±X, ±Z, +Y. Cavity = (40-5)*(30-2.5)*(20-5) = 35*27.5*15.
  const expect = 40 * 30 * 20 - 35 * 27.5 * 15;
  check('simple cube hollow succeeds', simple.status === 'NoError' && simple.volume > 0,
    `status=${simple.status} vol=${simple.volume}`);
  check('simple cube hollow volume exact', Math.abs(simple.volume - expect) < 0.05,
    `got ${simple.volume.toFixed(4)} want ${expect.toFixed(4)}`);
}

// ── Filleted solid (no hollow) ───────────────────────────────────────────
const filletsOnly = fixture.replace(
  /\/\/ --- shell begin ---[\s\S]*\/\/ --- shell end ---/,
  '/* shell skipped */',
);
let solid;
{
  solid = await exec(filletsOnly);
  check('filleted solid builds', solid.status === 'NoError' && solid.volume > 20000,
    `status=${solid.status} vol=${solid.volume}`);
  check('filleted solid bbox intact',
    solid.boundingBox?.min?.[1] === -15 && solid.boundingBox?.max?.[1] === 15,
    JSON.stringify(solid.boundingBox));
}

// ── Exact playtest: hollow open toward -Y ────────────────────────────────
let hollowed;
{
  try {
    hollowed = await exec(fixture);
    check('playtest hollow succeeds', true);
  } catch (e) {
    check('playtest hollow succeeds', false, e.message);
  }
  if (hollowed) {
    check('playtest status NoError', hollowed.status === 'NoError',
      `status=${hollowed.status}`);
    check('playtest positive volume', hollowed.volume > 1e3,
      `vol=${hollowed.volume}`);
    check('playtest cavity exists (vol << solid)',
      hollowed.volume < solid.volume - 1000,
      `hollow=${hollowed.volume.toFixed(1)} solid=${solid.volume.toFixed(1)}`);
    check('playtest outer bbox still on y=-15 (open face plane)',
      Math.abs(hollowed.boundingBox.min[1] + 15) < 1e-6
        && Math.abs(hollowed.boundingBox.max[1] - 15) < 1e-6,
      JSON.stringify(hollowed.boundingBox));
    // Opening toward -Y removes the bottom wall → less material than closed.
    let closed;
    try {
      closed = await exec(filletsOnly.replace(
        '/* shell skipped */',
        "part = hollow(part, 2.5, 'none');",
      ));
    } catch (e) {
      check('closed hollow on same body (for open compare)', false, e.message);
    }
    if (closed) {
      check('open -Y removes the bottom wall vs closed',
        hollowed.volume < closed.volume - 200,
        `open=${hollowed.volume.toFixed(1)} closed=${closed.volume.toFixed(1)}`);
    }
    // Opening probe: rim verts still sit on the -Y plane, but no large -Y-facing
    // triangle covers the face center (that would be a closed bottom wall).
    const np = hollowed.mesh.numProp || 3;
    const vp = hollowed.mesh.vertProperties;
    const tv = hollowed.mesh.triVerts;
    let rimAtOpen = 0;
    for (let i = 0; i < vp.length; i += np) {
      if (Math.abs(vp[i + 1] + 15) < 0.15) rimAtOpen++;
    }
    let centerCapArea = 0;
    for (let t = 0; t < tv.length; t += 3) {
      const ia = tv[t], ib = tv[t + 1], ic = tv[t + 2];
      const ax = vp[ia * np], ay = vp[ia * np + 1], az = vp[ia * np + 2];
      const bx = vp[ib * np], by = vp[ib * np + 1], bz = vp[ib * np + 2];
      const cx = vp[ic * np], cy = vp[ic * np + 1], cz = vp[ic * np + 2];
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      if (Math.abs(my + 15) > 0.5) continue;
      if (Math.abs(mx) > 8 || Math.abs(mz) > 5) continue;
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      const crx = aby * acz - abz * acy;
      const cry = abz * acx - abx * acz;
      const crz = abx * acy - aby * acx;
      const nL = Math.hypot(crx, cry, crz);
      if (nL < 1e-12) continue;
      if (cry / nL < -0.85) centerCapArea += 0.5 * nL;
    }
    check('open-face rim verts exist at y≈-15', rimAtOpen > 0, `rim=${rimAtOpen}`);
    check('no -Y wall covers the opening center',
      centerCapArea < 1,
      `centerCapArea=${centerCapArea.toFixed(3)}`);
  }
}

// ── Punch-through guard: cavity must stay inside on closed faces ─────────
{
  const shellScript = fixture.replace(
    'part = hollow(part, 2.5, { center: [0, -15, 0], normal: [0, -1, 0] });',
    "part = shell(part, 2.5, { center: [0, -15, 0], normal: [0, -1, 0] });",
  );
  let cav;
  try {
    cav = await exec(shellScript);
  } catch (e) {
    check('cavity (shell) builds for overshoot probe', false, e.message);
  }
  if (cav && solid) {
    const sb = solid.boundingBox;
    const cb = cav.boundingBox;
    const overX = Math.max(0, cb.max[0] - sb.max[0], sb.min[0] - cb.min[0]);
    const overYplus = Math.max(0, cb.max[1] - sb.max[1]);
    const overZ = Math.max(0, cb.max[2] - sb.max[2], sb.min[2] - cb.min[2]);
    // Open -Y intentionally overshoots by ~t; closed faces must not.
    check('cavity does not overshoot closed ±X faces',
      overX < 0.05, `overX=${overX.toFixed(4)}`);
    check('cavity does not overshoot +Y face',
      overYplus < 0.05, `overY+=${overYplus.toFixed(4)}`);
    check('cavity does not overshoot closed ±Z faces',
      overZ < 0.05, `overZ=${overZ.toFixed(4)}`);
    check('cavity still overshoots open -Y by ~t',
      (sb.min[1] - cb.min[1]) > 2.0 && (sb.min[1] - cb.min[1]) < 3.5,
      `over-Y=${(sb.min[1] - cb.min[1]).toFixed(4)}`);
  }
}

// ── Wall-thickness probes at vertical×top-rim junctions ──────────────────
if (hollowed) {
  const np = hollowed.mesh.numProp || 3;
  const vp = hollowed.mesh.vertProperties;
  const tv = hollowed.mesh.triVerts;
  const vert = (i) => [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
  const rayTri = (orig, dir, a, b, c) => {
    const EPS = 1e-9;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [
      dir[1] * e2[2] - dir[2] * e2[1],
      dir[2] * e2[0] - dir[0] * e2[2],
      dir[0] * e2[1] - dir[1] * e2[0],
    ];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < EPS) return null;
    const inv = 1 / det;
    const tvec = [orig[0] - a[0], orig[1] - a[1], orig[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < 0 || u > 1) return null;
    const q = [
      tvec[1] * e1[2] - tvec[2] * e1[1],
      tvec[2] * e1[0] - tvec[0] * e1[2],
      tvec[0] * e1[1] - tvec[1] * e1[0],
    ];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) return null;
    const tHit = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    return tHit > EPS ? tHit : null;
  };
  const firstTwoHits = (orig, dir) => {
    const dn = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / dn, dir[1] / dn, dir[2] / dn];
    const hits = [];
    for (let t = 0; t < tv.length; t += 3) {
      const ht = rayTri(orig, d, vert(tv[t]), vert(tv[t + 1]), vert(tv[t + 2]));
      if (ht != null && ht < 40) hits.push(ht);
    }
    hits.sort((a, b) => a - b);
    // Coincident tris from a ≤5° sweep share a hit distance. A 0-gap
    // duplicate is not a thin wall — collapse it before the thickness test.
    const uniq = [];
    for (const h of hits) {
      if (!uniq.length || h - uniq[uniq.length - 1] > 0.08) uniq.push(h);
    }
    return uniq;
  };
  let thinCorners = 0;
  let seeThrough = 0;
  const tWall = 2.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // From outside the top-rim × vertical fillet junction, cast inward.
      const hits = firstTwoHits([sx * 22, 16, sz * 12], [-sx, -0.5, -sz]);
      if (hits.length < 2) {
        seeThrough++;
        continue;
      }
      const gap = hits[1] - hits[0];
      // Along this diagonal, wall thickness projects to ≳ t*0.7; a punch-through
      // leaves gap ≈ 0 or a single hit / huge empty span before the far wall.
      if (gap < tWall * 0.55) thinCorners++;
      // Far-wall gap (see-through hole): second hit jumps across the interior.
      if (gap > 12) seeThrough++;
    }
  }
  check('fillet-junction wall probes find front+back faces',
    seeThrough === 0, `seeThroughCorners=${seeThrough}`);
  check('fillet-junction wall thickness ≳ 0.55·t along probes',
    thinCorners === 0, `thinCorners=${thinCorners}`);
}

// ── Interior mid-height see-through probes (flat↔fillet inner walls) ─────
if (hollowed) {
  const np = hollowed.mesh.numProp || 3;
  const vp = hollowed.mesh.vertProperties;
  const tv = hollowed.mesh.triVerts;
  const vert = (i) => [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
  const rayTri = (orig, dir, a, b, c) => {
    const EPS = 1e-9;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [
      dir[1] * e2[2] - dir[2] * e2[1],
      dir[2] * e2[0] - dir[0] * e2[2],
      dir[0] * e2[1] - dir[1] * e2[0],
    ];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < EPS) return null;
    const inv = 1 / det;
    const tvec = [orig[0] - a[0], orig[1] - a[1], orig[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < 0 || u > 1) return null;
    const q = [
      tvec[1] * e1[2] - tvec[2] * e1[1],
      tvec[2] * e1[0] - tvec[0] * e1[2],
      tvec[0] * e1[1] - tvec[1] * e1[0],
    ];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) return null;
    const tHit = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    return tHit > EPS ? tHit : null;
  };
  const hitsDedup = (orig, dir) => {
    const dn = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / dn, dir[1] / dn, dir[2] / dn];
    const hits = [];
    for (let t = 0; t < tv.length; t += 3) {
      const ht = rayTri(orig, d, vert(tv[t]), vert(tv[t + 1]), vert(tv[t + 2]));
      if (ht != null && ht < 50) hits.push(ht);
    }
    hits.sort((a, b) => a - b);
    const uniq = [];
    for (const h of hits) {
      if (!uniq.length || h - uniq[uniq.length - 1] > 0.08) uniq.push(h);
    }
    return uniq;
  };
  const wallGap = (hs) => {
    if (hs.length < 2) return null;
    let h0 = hs[0];
    let h1 = hs[1];
    // Skip double-surface scrap on the inner wall.
    if (h1 - h0 < 0.5) {
      const next = hs.find((h) => h > h0 + 1.0);
      if (next != null) h1 = next;
    }
    return h1 - h0;
  };
  let interiorSee = 0;
  let interiorThin = 0;
  const tWall = 2.5;
  for (const y of [-5, 0, 5]) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        // Stand inside the cavity, cast toward a vertical-fillet corner.
        const hs = hitsDedup([sx * 8, y, sz * 2.5], [sx, 0, sz]);
        const gap = wallGap(hs);
        if (gap == null) {
          interiorSee++;
          continue;
        }
        // See-through: first hit is a scrap / far wall, second jumps the interior.
        if (gap > 12) interiorSee++;
        else if (gap < tWall * 0.45) interiorThin++;
      }
    }
  }
  check('interior mid-height fillet probes find front+back faces',
    interiorSee === 0, `interiorSeeThrough=${interiorSee}`);
  check('interior mid-height wall thickness ≳ 0.45·t',
    interiorThin === 0, `interiorThin=${interiorThin}`);
}

// ── Interior flat↔fillet under the top rim (see-through notch) ───────────
if (hollowed) {
  const np = hollowed.mesh.numProp || 3;
  const vp = hollowed.mesh.vertProperties;
  const tv = hollowed.mesh.triVerts;
  const vert = (i) => [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
  const rayTri = (orig, dir, a, b, c) => {
    const EPS = 1e-9;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [
      dir[1] * e2[2] - dir[2] * e2[1],
      dir[2] * e2[0] - dir[0] * e2[2],
      dir[0] * e2[1] - dir[1] * e2[0],
    ];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < EPS) return null;
    const inv = 1 / det;
    const tvec = [orig[0] - a[0], orig[1] - a[1], orig[2] - a[2]];
    const u = (tvec[0] * p[0] + tvec[1] * p[1] + tvec[2] * p[2]) * inv;
    if (u < 0 || u > 1) return null;
    const q = [
      tvec[1] * e1[2] - tvec[2] * e1[1],
      tvec[2] * e1[0] - tvec[0] * e1[2],
      tvec[0] * e1[1] - tvec[1] * e1[0],
    ];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) return null;
    const tHit = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    return tHit > EPS ? tHit : null;
  };
  const hitsDedup = (orig, dir) => {
    const dn = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / dn, dir[1] / dn, dir[2] / dn];
    const hits = [];
    for (let t = 0; t < tv.length; t += 3) {
      const ht = rayTri(orig, d, vert(tv[t]), vert(tv[t + 1]), vert(tv[t + 2]));
      if (ht != null && ht < 50) hits.push(ht);
    }
    hits.sort((a, b) => a - b);
    const uniq = [];
    for (const h of hits) {
      if (!uniq.length || h - uniq[uniq.length - 1] > 0.08) uniq.push(h);
    }
    return uniq;
  };
  let topSee = 0;
  let topThin = 0;
  const detail = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Inside the cavity, below the top skin, aimed at the inner
      // flat↔fillet under that top corner (y≈12.5, not mid-height).
      const origins = [[sx * 6, 9.5, sz * 1.2]];
      const aims = [[sx * 15.7, 12.5, sz * 8.2], [sx * 14.5, 12.2, sz * 6.5]];
      for (const o of origins) {
        for (const a of aims) {
          const hs = hitsDedup(o, [a[0] - o[0], a[1] - o[1], a[2] - o[2]]);
          if (!hs.length || hs[0] > 14) {
            topSee++;
            detail.push(`miss/far h0=${hs[0]}`);
            continue;
          }
          const h0 = hs[0];
          const back = hs.find((h) => h > h0 + 1.4);
          const gap = back == null ? null : back - h0;
          if (gap == null || gap > 12) {
            topSee++;
            detail.push(`see gap=${gap == null ? 'none' : gap.toFixed(2)} hs=${hs.slice(0, 4).map((h) => h.toFixed(2)).join(',')}`);
          } else if (gap < 1.6) {
            topThin++;
            detail.push(`thin gap=${gap.toFixed(2)}`);
          }
        }
      }
    }
  }
  check('top-corner interior probes hit the near wall (no far-wall jump)',
    topSee === 0, `topSee=${topSee} ${detail.join('; ')}`);
  check('top-corner interior wall closes (no notch / see-through)',
    topThin === 0 && topSee === 0, `topThin=${topThin} ${detail.join('; ')}`);
}

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll Artur shell-after-fillets checks passed.');
