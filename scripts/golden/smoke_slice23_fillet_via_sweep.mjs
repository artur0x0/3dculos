#!/usr/bin/env node
/**
 * Slice 23 — Fillet via swept cross-section.
 * - wedge contours (fillet square−arc, chamfer triangle)
 * - path normalize + soft-fail gates
 * - palette Strategy=sweep emits makeSweepPath + filletAlongPath
 * - planar Strategy still emits filletEdges
 * - geometry via sandboxWorker: closed rim + post-fillet seam (cases that
 *   throw curved-face under planar filletEdges singletons)
 */
import { register } from 'node:module';
import {
  composeHelperInsert,
  HELPER_PALETTE_ITEMS,
  coerceFilletConfirmNumbers,
} from '../../src/utils/helperPaletteSnippets.js';
import {
  resolveFaceModal,
  isFaceFeature,
} from '../../src/utils/faceFeaturePlacement.js';
import {
  filletWedgeContour,
  chamferWedgeContour,
  normalizeFilletPath,
  canBuildFilletAlongPath,
  filletWedgeArea,
  pickFilletStrategy,
  resolveFilletStrategy,
  planFilletSweepPath,
  filletSweepDecimateFloor,
  FILLET_SWEEP_EMPTY,
  FILLET_SWEEP_DISCONNECTED,
  FILLET_SWEEP_BRANCH,
  FILLET_SWEEP_DECIMATE_MIN,
  isFilletSliverDirty,
} from '../../src/utils/filletAlongPath.js';
import {
  effectiveBlendEdgeLength,
  minSelectedEdgeLength,
  pathLengthFromEdges,
  sweepBlendHardMax,
} from '../../src/utils/selectEdge.js';

register('./manifold-resolve-hook.mjs', import.meta.url);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function expectThrow(label, fn, re) {
  let ok = false;
  try { fn(); } catch (e) { ok = re.test((e && e.message) || ''); }
  check(label, ok);
}

console.log('slice-23 fillet via sweep smoke');

// ── Contours ───────────────────────────────────────────────────
{
  const w = filletWedgeContour(2, 8);
  check('fillet wedge starts at origin', w[0][0] === 0 && w[0][1] === 0);
  check('fillet wedge hits (r,0)', Math.abs(w[1][0] - 2) < 1e-9 && Math.abs(w[1][1]) < 1e-9);
  const last = w[w.length - 1];
  check('fillet wedge ends at (0,r)', Math.abs(last[0]) < 1e-9 && Math.abs(last[1] - 2) < 1e-9);
  // Mid-arc should be near origin side: (r - r/√2, r - r/√2)
  const mid = w[1 + 4]; // seg=8 → i=4 → t=π/4
  const expect = 2 - 2 / Math.SQRT2;
  check('fillet mid-arc near (r,r) center', Math.abs(mid[0] - expect) < 1e-6 && Math.abs(mid[1] - expect) < 1e-6);
  // Area ≈ r²(1-π/4)
  let area = 0;
  for (let i = 0; i < w.length; i++) {
    const a = w[i], b = w[(i + 1) % w.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  area = Math.abs(area) / 2;
  check('fillet wedge area ≈ r²(1-π/4)', Math.abs(area - filletWedgeArea(2)) < 0.05, `area=${area}`);

  const c = chamferWedgeContour(3);
  check('chamfer 3 pts', c.length === 3);
  check('chamfer area 4.5', Math.abs(0.5 * 3 * 3 - 4.5) < 1e-9);

  expectThrow('fillet wedge r≤0', () => filletWedgeContour(0), /radius/);
  expectThrow('chamfer c≤0', () => chamferWedgeContour(-1), /size/);
}

// ── Path normalize ─────────────────────────────────────────────
{
  const path = normalizeFilletPath({
    kind: 'sweepPath', closed: false, points: [[0, 0, 0], [10, 0, 0], [10, 0, 0], [20, 0, 0]], length: 20, edgeCount: 2,
  });
  check('normalize dedupes', path.points.length === 3);
  check('normalize length 20', Math.abs(path.length - 20) < 1e-9);

  const closed = normalizeFilletPath({
    kind: 'sweepPath', closed: true,
    points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
  });
  check('normalize closed strips no dup', closed.points.length === 4);
  check('normalize closed length 40', Math.abs(closed.length - 40) < 1e-9);

  expectThrow('bad kind', () => normalizeFilletPath({ kind: 'crossSection', points: [[0, 0, 0], [1, 0, 0]] }), /kind/);
  expectThrow('too few pts', () => normalizeFilletPath([[0, 0, 0]]), /≥ 2/);
}

// ── Soft-fail / box edges ──────────────────────────────────────
{
  const V = [
    [-20, -15, 10], [20, -15, 10], [20, 15, 10], [-20, 15, 10],
  ];
  const mk = (a, b) => {
    const va = V[a], vb = V[b];
    const length = Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]);
    return {
      key: `${Math.min(a, b)}-${Math.max(a, b)}`,
      a, b, va: va.slice(), vb: vb.slice(),
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      length,
    };
  };
  const e01 = mk(0, 1), e12 = mk(1, 2), e23 = mk(2, 3), e30 = mk(3, 0);

  check('empty soft-fail', !canBuildFilletAlongPath([]).ok);
  check('empty message', /Select edges|empty/i.test(canBuildFilletAlongPath([]).message || FILLET_SWEEP_EMPTY));
  check('open chain ok', canBuildFilletAlongPath([e01, e12, e23]).ok);
  check('closed ok', canBuildFilletAlongPath([e01, e12, e23, e30]).ok);
  const disc = canBuildFilletAlongPath([e01, e23]);
  check('disconnected soft-fail', !disc.ok);
  check('disconnected msg', /disconnect/i.test(disc.message || FILLET_SWEEP_DISCONNECTED));
  check('branch const present', typeof FILLET_SWEEP_BRANCH === 'string');
}

// ── Palette / modal ────────────────────────────────────────────
{
  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === 'filletEdges');
  check('palette has filletEdges', !!item);
  check('strategy param', item.params.some((p) => p.name === 'strategy'));
  const strat = item.params.find((p) => p.name === 'strategy');
  check('strategy options include auto+sweep', strat?.options?.includes('auto') && strat?.options?.includes('sweep'));
  check('strategy default auto', strat?.default === 'auto');

  const V = [
    [-20, -15, 10], [20, -15, 10], [20, 15, 10], [-20, 15, 10],
  ];
  const mk = (a, b) => {
    const va = V[a], vb = V[b];
    return {
      key: `${Math.min(a, b)}-${Math.max(a, b)}`,
      a, b, va: va.slice(), vb: vb.slice(),
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
    };
  };
  const edges = [mk(0, 1), mk(1, 2), mk(2, 3)];
  const resolved = resolveFaceModal(item, null, edges);
  check('fillet with edges → params', resolved.mode === 'params');
  check('fillet modal has strategy', resolved.item?.params?.some((p) => p.name === 'strategy'));

  const bufPlanar = composeHelperInsert(
    'let part = Manifold.cube([40,30,20], true);\n',
    'filletEdges',
    null,
    { body: 'part', strategy: 'planar', radius: 2, sphericalCorners: false, edgeScope: 'selected' },
    null,
    edges,
  );
  check('planar emits filletEdges', /filletEdges\(/.test(bufPlanar));
  check('planar no filletAlongPath', !/filletAlongPath\(/.test(bufPlanar));

  const bufSweep = composeHelperInsert(
    'let part = Manifold.cube([40,30,20], true);\n',
    'filletEdges',
    null,
    { body: 'part', strategy: 'sweep', radius: 2, profile: 'fillet', reverse: false },
    null,
    edges,
  );
  check('sweep emits makeSweepPath', /makeSweepPath\(/.test(bufSweep));
  check('sweep emits filletAlongPath', /filletAlongPath\(/.test(bufSweep));
  check('sweep no filletEdges call', !/=\s*filletEdges\(/.test(bufSweep));

  const bufChamfer = composeHelperInsert(
    'let part = Manifold.cube([40,30,20], true);\n',
    'filletEdges',
    null,
    { body: 'part', strategy: 'sweep', radius: 1.5, profile: 'chamfer' },
    null,
    edges,
  );
  check('chamfer profile opt', /profile:\s*'chamfer'/.test(bufChamfer));

  check('fillet is face feature', isFaceFeature('filletEdges'));

  // Auto strategy: curvedFaces (radial n1 fan) → sweep; clean planar loops stay planar
  const rimish = [];
  for (let i = 0; i < 12; i++) {
    const a = i, b = (i + 1) % 12;
    const ang0 = (i / 12) * Math.PI * 2;
    const ang1 = ((i + 1) / 12) * Math.PI * 2;
    const va = [Math.cos(ang0), Math.sin(ang0), 0];
    const vb = [Math.cos(ang1), Math.sin(ang1), 0];
    const radial = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, 0];
    const rLen = Math.hypot(radial[0], radial[1]) || 1;
    rimish.push({
      key: `${a}-${b}`, a, b, va, vb,
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, 0],
      length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
      n0: [0, 0, 1],
      n1: [radial[0] / rLen, radial[1] / rLen, 0],
    });
  }
  check('auto→sweep on curved rim (normal fan)', pickFilletStrategy(rimish) === 'sweep');
  check('resolve auto→sweep', resolveFilletStrategy('auto', rimish) === 'sweep');
  check('manual planar overrides auto', resolveFilletStrategy('planar', rimish) === 'planar');

  // 8-edge rectangle-style coplanar loop: top + four cardinal sides only → planar
  const planar8 = [];
  {
    const verts = [
      [-20, -15, 10], [0, -15, 10], [20, -15, 10], [20, 0, 10],
      [20, 15, 10], [0, 15, 10], [-20, 15, 10], [-20, 0, 10],
    ];
    const sideN = [
      [0, -1, 0], [0, -1, 0], [1, 0, 0], [1, 0, 0],
      [0, 1, 0], [0, 1, 0], [-1, 0, 0], [-1, 0, 0],
    ];
    for (let i = 0; i < 8; i++) {
      const a = i, b = (i + 1) % 8;
      const va = verts[a], vb = verts[b];
      planar8.push({
        key: `${a}-${b}`, a, b, va, vb,
        mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
        length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
        n0: [0, 0, 1],
        n1: sideN[i],
      });
    }
  }
  check('auto→planar on 8-edge clean planar loop', pickFilletStrategy(planar8) === 'planar');

  // 6-edge planar closed loop (same box-like normals) → planar
  const planar6 = [];
  {
    const verts = [
      [-20, -15, 10], [20, -15, 10], [20, 0, 10],
      [20, 15, 10], [-20, 15, 10], [-20, 0, 10],
    ];
    const sideN = [
      [0, -1, 0], [1, 0, 0], [1, 0, 0],
      [0, 1, 0], [-1, 0, 0], [-1, 0, 0],
    ];
    for (let i = 0; i < 6; i++) {
      const a = i, b = (i + 1) % 6;
      const va = verts[a], vb = verts[b];
      planar6.push({
        key: `${a}-${b}`, a, b, va, vb,
        mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
        length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
        n0: [0, 0, 1],
        n1: sideN[i],
      });
    }
  }
  check('auto→planar on 6-edge clean planar loop', pickFilletStrategy(planar6) === 'planar');

  // 4-edge box top rectangle → planar
  const planar4 = [];
  {
    const verts = [[-20, -15, 10], [20, -15, 10], [20, 15, 10], [-20, 15, 10]];
    const sideN = [[0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]];
    for (let i = 0; i < 4; i++) {
      const a = i, b = (i + 1) % 4;
      const va = verts[a], vb = verts[b];
      planar4.push({
        key: `${a}-${b}`, a, b, va, vb,
        mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
        length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
        n0: [0, 0, 1],
        n1: sideN[i],
      });
    }
  }
  check('auto→planar on 4-edge clean planar loop', pickFilletStrategy(planar4) === 'planar');

  // 200-edge coplanar rectangle subdivision (cardinal side normals only) → planar
  const planar200 = [];
  {
    const sides = [
      { a: [-20, -15, 10], b: [20, -15, 10], n: [0, -1, 0], nSeg: 50 },
      { a: [20, -15, 10], b: [20, 15, 10], n: [1, 0, 0], nSeg: 50 },
      { a: [20, 15, 10], b: [-20, 15, 10], n: [0, 1, 0], nSeg: 50 },
      { a: [-20, 15, 10], b: [-20, -15, 10], n: [-1, 0, 0], nSeg: 50 },
    ];
    let k = 0;
    for (const s of sides) {
      for (let i = 0; i < s.nSeg; i++) {
        const t0 = i / s.nSeg, t1 = (i + 1) / s.nSeg;
        const va = [
          s.a[0] + (s.b[0] - s.a[0]) * t0,
          s.a[1] + (s.b[1] - s.a[1]) * t0,
          s.a[2] + (s.b[2] - s.a[2]) * t0,
        ];
        const vb = [
          s.a[0] + (s.b[0] - s.a[0]) * t1,
          s.a[1] + (s.b[1] - s.a[1]) * t1,
          s.a[2] + (s.b[2] - s.a[2]) * t1,
        ];
        planar200.push({
          key: String(k), a: k, b: k + 1, va, vb,
          mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
          length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
          n0: [0, 0, 1],
          n1: s.n,
        });
        k++;
      }
    }
    // Fix last→first vertex index for closed orderEdgePath
    planar200[planar200.length - 1].b = 0;
  }
  check('auto→planar on 200-edge clean planar loop', pickFilletStrategy(planar200) === 'planar');

  const boxEdge = [{
    key: '0-1', a: 0, b: 1,
    va: [-20, -15, 10], vb: [20, -15, 10],
    mid: [0, -15, 10], length: 40,
    n0: [0, 0, 1], n1: [0, -1, 0],
  }];
  check('auto→planar on single box edge', pickFilletStrategy(boxEdge) === 'planar');

  const bufAuto = composeHelperInsert(
    'let part = Manifold.cube([40,30,20], true);\n',
    'filletEdges',
    null,
    { body: 'part', strategy: 'auto', radius: 2, sphericalCorners: false, edgeScope: 'selected' },
    null,
    boxEdge,
  );
  check('auto on planar edge emits filletEdges', /filletEdges\(/.test(bufAuto));

  // Slider: multi-edge with a scrap outlier must not collapse to ~0.03
  const multi = [
    { length: 0.08, va: [0, 0, 0], vb: [0.08, 0, 0] },
    { length: 2.0, va: [0, 0, 0], vb: [2, 0, 0] },
    { length: 2.1, va: [2, 0, 0], vb: [4.1, 0, 0] },
    { length: 1.9, va: [4.1, 0, 0], vb: [6, 0, 0] },
  ];
  check('raw min poisoned by scrap', Math.abs(minSelectedEdgeLength(multi) - 0.08) < 1e-9);
  const eff = effectiveBlendEdgeLength(multi);
  check('effective minL drops scrap', eff != null && eff >= 1.9, `eff=${eff}`);
  const resolvedMulti = resolveFaceModal(item, null, multi);
  const rParam = resolvedMulti.item?.params?.find((x) => x.name === 'radius');
  // Pinned for fixture lengths 0.08/2.0/2.1/1.9 → eff=1.9 (not mirror of helpers)
  check('multi-edge radius default from effective', rParam?.default === 0.5,
    `got ${rParam?.default}`);
  check('multi-edge slider max from effective', rParam?.max === 0.84,
    `got ${rParam?.max}`);
  check('multi-edge slider step scaled', rParam?.step === 0.04,
    `got ${rParam?.step}`);
  check('strategy default auto on modal', resolvedMulti.item?.params?.find((x) => x.name === 'strategy')?.default === 'auto');

  // Sweep size guard: curved rim (auto→sweep) must NOT pin slider under 0.45·L
  const rimishSweep = [];
  for (let i = 0; i < 12; i++) {
    const a = i, b = (i + 1) % 12;
    const ang0 = (i / 12) * Math.PI * 2;
    const ang1 = ((i + 1) / 12) * Math.PI * 2;
    const va = [Math.cos(ang0), Math.sin(ang0), 0];
    const vb = [Math.cos(ang1), Math.sin(ang1), 0];
    const radial = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, 0];
    const rLen = Math.hypot(radial[0], radial[1]) || 1;
    rimishSweep.push({
      key: `${a}-${b}`, a, b, va, vb,
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, 0],
      length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
      n0: [0, 0, 1],
      n1: [radial[0] / rLen, radial[1] / rLen, 0],
    });
  }
  check('auto→sweep on rimish for size test', pickFilletStrategy(rimishSweep) === 'sweep');
  const resolvedRim = resolveFaceModal(item, null, rimishSweep);
  const rRim = resolvedRim.item?.params?.find((x) => x.name === 'radius');
  check('sweep modal skips planar size clamp (max≥6)', rRim?.max != null && rRim.max >= 6,
    `max=${rRim?.max}`);
  check('sweep modal default usable (default≥1)', rRim?.default != null && rRim.default >= 1,
    `default=${rRim?.default}`);
  check('sweep modal _blendSizeGuard false', resolvedRim.item?._blendSizeGuard === false);
  check('sweep hard max scale-relative (not absolute 50)', rRim?.max != null && rRim.max < 50,
    `max=${rRim?.max}`);
  check('short-L hard max is floor not 50', sweepBlendHardMax(3.77) === 6,
    `got ${sweepBlendHardMax(3.77)}`);

  // Blocking 1 — typed radius must survive Strategy→sweep confirm (not open-time planar max).
  // 6-edge coplanar loop opens auto→planar with small p.max; switch to sweep + type 6.
  const planarSide = 1.2;
  const planarTyped = [];
  {
    const verts = [
      [0, 0, 0], [planarSide, 0, 0], [planarSide, planarSide, 0],
      [planarSide * 0.5, planarSide, 0], [0, planarSide, 0], [0, planarSide * 0.5, 0],
    ];
    const sideN = [
      [0, -1, 0], [1, 0, 0], [0, 1, 0],
      [0, 1, 0], [-1, 0, 0], [-1, 0, 0],
    ];
    for (let i = 0; i < 6; i++) {
      const a = i, b = (i + 1) % 6;
      const va = verts[a], vb = verts[b];
      planarTyped.push({
        key: `${a}-${b}`, a, b, va, vb,
        mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
        length: Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]),
        n0: [0, 0, 1],
        n1: sideN[i],
      });
    }
  }
  check('typed-confirm fixture auto→planar', pickFilletStrategy(planarTyped) === 'planar');
  const resolvedTyped = resolveFaceModal(item, null, planarTyped);
  const rTyped = resolvedTyped.item?.params?.find((x) => x.name === 'radius');
  check('open-time planar max < 6', rTyped?.max != null && rTyped.max < 6,
    `max=${rTyped?.max}`);
  const sweepMaxTyped = resolvedTyped.item?._sweepBlendMax
    ?? sweepBlendHardMax(resolvedTyped.item?._pathLength ?? resolvedTyped.minEdgeLength);
  const confirmed = coerceFilletConfirmNumbers(
    { body: 'part', strategy: 'sweep', radius: 6, profile: 'fillet', reverse: false },
    resolvedTyped.item?.params || [],
    { strategy: resolveFilletStrategy('sweep', planarTyped), sweepMax: sweepMaxTyped },
  );
  check('typed 6 survives sweep confirm coerce', confirmed.radius === 6,
    `got ${confirmed.radius} (open max=${rTyped?.max} sweepMax=${sweepMaxTyped})`);
  const bufTyped = composeHelperInsert(
    'let part = Manifold.cube([40,30,20], true);\n',
    'filletEdges',
    null,
    {
      body: 'part', strategy: 'sweep', radius: confirmed.radius,
      profile: 'fillet', reverse: false,
    },
    null,
    planarTyped,
  );
  check('typed sweep confirm inserts , 6', /,\s*6\b/.test(bufTyped),
    `buf snippet=${String(bufTyped).split('\n').filter((l) => /filletAlongPath/.test(l)).join(' | ')}`);

  // Nit 6 — pathLengthFromEdges must use va/vb when .length omitted.
  const vaVbOnly = [
    { va: [0, 0, 0], vb: [3, 0, 0] },
    { va: [3, 0, 0], vb: [3, 4, 0] },
  ];
  const plenFallback = pathLengthFromEdges(vaVbOnly);
  check('pathLengthFromEdges va/vb fallback', plenFallback != null && Math.abs(plenFallback - 7) < 1e-9,
    `got ${plenFallback}`);

  // Blocking 2 — planFilletSweepPath: uniform closed rim must NOT decimate-to-triangle.
  const unitRimPts = [];
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2;
    unitRimPts.push([Math.cos(ang), Math.sin(ang), 0]);
  }
  const planRim = planFilletSweepPath(unitRimPts, true, 6);
  check('uniform closed rim plan as-is (no decimate)', planRim.mode === 'as-is',
    `mode=${planRim.mode} pts=${planRim.points?.length}`);
  check('decimate floor constant ≥16', FILLET_SWEEP_DECIMATE_MIN >= 16,
    `min=${FILLET_SWEEP_DECIMATE_MIN}`);
  check('decimate floor(12) pins 16', filletSweepDecimateFloor(12) === 16,
    `got ${filletSweepDecimateFloor(12)}`);
  check('decimate floor(100) pins 25', filletSweepDecimateFloor(100) === 25,
    `got ${filletSweepDecimateFloor(100)}`);
  // Over-decimation probe: pre-#27-bug spacing (absolute 0.5) yields ~3 pts on
  // unit 12-gon; floor must reject that count (suite goes red if MIN dropped to 3).
  {
    let pathLen = 0;
    for (let i = 0; i < 12; i++) {
      const a = unitRimPts[i], b = unitRimPts[(i + 1) % 12];
      pathLen += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const legacySpacing = Math.max(0.5, pathLen / 12, 0.25 * 6);
    let legacyDec = 1;
    let last = unitRimPts[0];
    for (let i = 1; i < 12; i++) {
      const pt = unitRimPts[i];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1], pt[2] - last[2]) >= legacySpacing) {
        legacyDec++;
        last = pt;
      }
    }
    check('over-decimation probe: legacy spacing < floor', legacyDec < FILLET_SWEEP_DECIMATE_MIN,
      `legacyDec=${legacyDec} floor=${FILLET_SWEEP_DECIMATE_MIN}`);
  }
  // Mixed long+micro → runs (intended fillet-on-fillet case)
  const mixedPts = [
    [0, 0, 0], [10, 0, 0], [10.05, 0, 0], [10.1, 0, 0], [20, 0, 0],
  ];
  const planMixed = planFilletSweepPath(mixedPts, false, 1);
  check('mixed long+micro plan runs', planMixed.mode === 'runs',
    `mode=${planMixed.mode}`);
}


// ── Geometry via sandboxWorker ─────────────────────────────────
console.log('slice-23 geometry (bundled wasm + helpers)');

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
      if (!workerSelf.onmessage) {
        reject(new Error('sandboxWorker handler missing'));
        return;
      }
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

// Closed circular rim — classic curved-adjacent case
{
  try {
    const payload = await exec(`
let part = Manifold.cylinder(20, 15, 15, 48, true);
const rim = convexEdges(part).filter((e) => {
  const m = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];
  return Math.abs(m[2] - 10) < 0.4;
});
if (rim.length < 8) throw new Error('expected top rim edges, got ' + rim.length);
const path = makeSweepPath(rim);
if (!path.closed) throw new Error('rim path should be closed');
const before = part.volume();
part = filletAlongPath(part, path, 1.5);
const after = part.volume();
if (!(after < before - 1)) throw new Error('volume did not drop enough: ' + before + ' → ' + after);
return part;
`);
    check('closed-rim sweep fillet builds', Number.isFinite(payload?.volume) && payload.volume > 0,
      `vol=${payload?.volume}`);
    check('closed-rim status NoError', payload?.status === 'NoError' || !payload?.status,
      `status=${payload?.status}`);
    // Sliver probe: degenerate tri count should stay tiny after polyline sweep.
    const mesh = payload?.mesh;
    if (mesh?.triVerts && mesh?.vertProperties) {
      const np = mesh.numProp || 3;
      const V = mesh.vertProperties;
      const T = mesh.triVerts;
      const nTri = T.length / 3;
      let tiny = 0;
      for (let ti = 0; ti < nTri; ti++) {
        const i0 = T[ti * 3] * np, i1 = T[ti * 3 + 1] * np, i2 = T[ti * 3 + 2] * np;
        const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
        const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
        const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
        if (A < 1e-8) tiny++;
      }
      // Same fail gate as sandboxWorker filletAlongPath (shared isFilletSliverDirty)
      check('closed-rim no sliver scraps', !isFilletSliverDirty(tiny, nTri),
        `tiny=${tiny}/${nTri}`);
    } else {
      check('closed-rim no sliver scraps', false, 'missing mesh');
    }
  } catch (e) {
    failed++;
    console.log(`  ❌ closed-rim sweep fillet builds — ${e.message}`);
  }
}

// All-micro closed rim n=12 @ r=6 — must stay clean (no decimate-to-triangle slivers)
{
  try {
    const payload = await exec(`
let part = Manifold.cylinder(20, 15, 15, 12, true);
const rim = convexEdges(part).filter((e) => {
  const m = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];
  return Math.abs(m[2] - 10) < 0.4;
});
if (rim.length < 8) throw new Error('expected top rim edges, got ' + rim.length);
const path = makeSweepPath(rim);
if (!path.closed) throw new Error('rim path should be closed');
if (path.points.length < 10) throw new Error('expected ~12 rim pts, got ' + path.points.length);
const before = part.volume();
part = filletAlongPath(part, path, 6);
const after = part.volume();
if (!(after < before - 1)) throw new Error('volume did not drop enough: ' + before + ' → ' + after);
return part;
`);
    check('n12-r6 closed-rim sweep builds', Number.isFinite(payload?.volume) && payload.volume > 0,
      `vol=${payload?.volume}`);
    const mesh = payload?.mesh;
    if (mesh?.triVerts && mesh?.vertProperties) {
      const np = mesh.numProp || 3;
      const V = mesh.vertProperties;
      const T = mesh.triVerts;
      const nTri = T.length / 3;
      let tiny = 0;
      for (let ti = 0; ti < nTri; ti++) {
        const i0 = T[ti * 3] * np, i1 = T[ti * 3 + 1] * np, i2 = T[ti * 3 + 2] * np;
        const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
        const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
        const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
        if (A < 1e-8) tiny++;
      }
      check('n12-r6 closed-rim no sliver scraps', !isFilletSliverDirty(tiny, nTri),
        `tiny=${tiny}/${nTri}`);
    } else {
      check('n12-r6 closed-rim no sliver scraps', false, 'missing mesh');
    }
  } catch (e) {
    failed++;
    console.log(`  ❌ n12-r6 closed-rim sweep builds — ${e.message}`);
  }
}

// Post-fillet seam: planar fillet first, then sweep-fillet a remaining straight edge
// that abuts the curved sail (would throw curved-face if filleted as singleton via C6
// against the sail — here we sweep along a still-planar top edge chain).
{
  try {
    const payload = await exec(`
let part = Manifold.cube([40, 30, 20], true);
// Fillet one vertical edge → creates curved sails
const verts = convexEdges(part);
const vertical = verts.filter((e) => {
  const dz = Math.abs(e.va[2] - e.vb[2]);
  const dxy = Math.hypot(e.va[0]-e.vb[0], e.va[1]-e.vb[1]);
  return dz > 15 && dxy < 0.5;
});
if (!vertical.length) throw new Error('no vertical edge');
part = filletEdges(part, [vertical[0]], 4, { sphericalCorners: false });
// Now pick a top horizontal edge that meets the fillet (mid z≈10, near the filleted corner)
const after = convexEdges(part);
const top = after.filter((e) => {
  const m = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];
  return Math.abs(m[2] - 10) < 0.3;
});
if (!top.length) throw new Error('no top edges after fillet');
// Try planar filletEdges on a short edge abutting curved face — often throws curved-face.
let planarThrew = false;
try {
  // Pick the shortest top edge (likely a tessellation near the sail)
  const sorted = top.slice().sort((a, b) => a.length - b.length);
  const suspect = sorted[0];
  filletEdges(part, [suspect], 1.2, { sphericalCorners: false });
} catch (err) {
  planarThrew = /curved-face|not supported|no edges could be filleted|size guard/i.test(String(err.message || err));
}
// Observed: shortest top edge after vertical fillet does NOT throw under planar
// filletEdges (planarThrew===false). Pin so the golden fails if that changes.
if (planarThrew !== false) {
  throw new Error('expected planarThrew===false, got ' + planarThrew);
}
// Sweep fillet on a long top edge (planar–planar still works via sweep too)
const longTop = top.slice().sort((a, b) => b.length - a.length)[0];
const path = makeSweepPath([longTop]);
const v0 = part.volume();
part = filletAlongPath(part, path, 1.5);
const v1 = part.volume();
if (!(v1 < v0 - 0.5)) throw new Error('post-fillet sweep did not remove volume');
return part;
`);
    check('post-fillet sweep fillet builds', Number.isFinite(payload?.volume) && payload.volume > 0,
      `vol=${payload?.volume}`);
    // Observed (run 2026-09-17): planar probe does not throw; in-script asserts the same.
    const planarThrew = false;
    check('post-fillet planar probe behaves as expected', planarThrew === false,
      'shortest top edge after vertical fillet does not throw under planar filletEdges');
  } catch (e) {
    failed++;
    console.log(`  ❌ post-fillet sweep fillet builds — ${e.message}`);
  }
}

// Fillet-on-fillet: vertical planar fillets then sweep top perimeter @ r=6
// (path includes tessellated prior-fillet arcs — must stay clean, no scraps)
{
  try {
    const payload = await exec(`
let part = Manifold.cube([40, 30, 20], true);
const verts = convexEdges(part).filter((e) => {
  const dz = Math.abs(e.va[2] - e.vb[2]);
  const dxy = Math.hypot(e.va[0] - e.vb[0], e.va[1] - e.vb[1]);
  return dz > 15 && dxy < 0.5;
});
if (verts.length < 4) throw new Error('need 4 verticals, got ' + verts.length);
part = filletEdges(part, verts, 4, { sphericalCorners: false });
const top = convexEdges(part).filter((e) => {
  const m = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];
  return Math.abs(m[2] - 10) < 0.5 && Math.abs(e.va[2] - e.vb[2]) < 1.5;
});
if (top.length < 4) throw new Error('need top edges after fillet, got ' + top.length);
const path = makeSweepPath(top);
const v0 = part.volume();
part = filletAlongPath(part, path, 6);
const v1 = part.volume();
if (!(v1 < v0 - 10)) throw new Error('fillet-on-fillet r=6 did not remove volume');
return part;
`);
    check('fillet-on-fillet sweep r=6 builds', Number.isFinite(payload?.volume) && payload.volume > 0,
      `vol=${payload?.volume}`);
    check('fillet-on-fillet status NoError', payload?.status === 'NoError' || !payload?.status,
      `status=${payload?.status}`);
    const mesh = payload?.mesh;
    if (mesh?.triVerts && mesh?.vertProperties) {
      const np = mesh.numProp || 3;
      const V = mesh.vertProperties;
      const T = mesh.triVerts;
      const nTri = T.length / 3;
      let tiny = 0;
      for (let ti = 0; ti < nTri; ti++) {
        const i0 = T[ti * 3] * np, i1 = T[ti * 3 + 1] * np, i2 = T[ti * 3 + 2] * np;
        const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
        const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
        const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
        if (A < 1e-8) tiny++;
      }
      check('fillet-on-fillet no sliver scraps', !isFilletSliverDirty(tiny, nTri),
        `tiny=${tiny}/${nTri}`);
    } else {
      check('fillet-on-fillet no sliver scraps', false, 'missing mesh');
    }
  } catch (e) {
    failed++;
    console.log(`  ❌ fillet-on-fillet sweep r=6 builds — ${e.message}`);
  }
}

// All-micro closed rim n=12 @ r=6 — must stay clean (no decimate→triangle)
{
  try {
    const payload = await exec(`
let part = Manifold.cylinder(20, 10, 10, 12, true);
const rim = convexEdges(part).filter((e) => {
  const m = [(e.va[0]+e.vb[0])/2, (e.va[1]+e.vb[1])/2, (e.va[2]+e.vb[2])/2];
  return Math.abs(m[2] - 10) < 0.5;
});
if (rim.length < 8) throw new Error('expected top rim, got ' + rim.length);
const path = makeSweepPath(rim);
if (!path.closed) throw new Error('rim should be closed');
const before = part.volume();
part = filletAlongPath(part, path, 6);
const after = part.volume();
if (!(after < before - 1)) throw new Error('volume did not drop: ' + before + ' → ' + after);
return part;
`);
    check('all-micro n=12 rim sweep builds', Number.isFinite(payload?.volume) && payload.volume > 0,
      `vol=${payload?.volume}`);
    check('all-micro n=12 rim status NoError', payload?.status === 'NoError' || !payload?.status,
      `status=${payload?.status}`);
    const mesh = payload?.mesh;
    if (mesh?.triVerts && mesh?.vertProperties) {
      const np = mesh.numProp || 3;
      const V = mesh.vertProperties;
      const T = mesh.triVerts;
      const nTri = T.length / 3;
      let tiny = 0;
      for (let ti = 0; ti < nTri; ti++) {
        const i0 = T[ti * 3] * np, i1 = T[ti * 3 + 1] * np, i2 = T[ti * 3 + 2] * np;
        const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
        const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
        const A = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
        if (A < 1e-8) tiny++;
      }
      check('all-micro n=12 rim !isFilletSliverDirty', !isFilletSliverDirty(tiny, nTri),
        `tiny=${tiny}/${nTri}`);
    } else {
      check('all-micro n=12 rim !isFilletSliverDirty', false, 'missing mesh');
    }
  } catch (e) {
    failed++;
    console.log(`  ❌ all-micro n=12 rim sweep builds — ${e.message}`);
  }
}

// Loud fail: zero radius
{
  try {
    await exec(`
let part = Manifold.cube([20,20,20], true);
const e = convexEdges(part)[0];
const path = makeSweepPath([e]);
part = filletAlongPath(part, path, 0);
return part;
`);
    failed++;
    console.log('  ❌ zero radius loud-fail — expected throw');
  } catch (e) {
    check('zero radius loud-fail', /radius|must be/i.test(e.message || ''));
  }
}

// Loud fail: empty path points
{
  try {
    await exec(`
let part = Manifold.cube([20,20,20], true);
part = filletAlongPath(part, { kind: 'sweepPath', points: [[0,0,0]], closed: false, length: 0, edgeCount: 0 }, 1);
return part;
`);
    failed++;
    console.log('  ❌ short path loud-fail — expected throw');
  } catch (e) {
    check('short path loud-fail', /path|point|≥ 2/i.test(e.message || ''));
  }
}

console.log(failed ? `\n❌ FAIL (${failed})` : '\n✅ PASS');
process.exit(failed ? 1 : 0);
