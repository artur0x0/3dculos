#!/usr/bin/env node
/**
 * Slice 22 — Edge → ordered sweep path / wire.
 * - orderEdgePath / assembleSweepPath: open chain + closed loop
 * - soft-fail: empty, disconnected, branch
 * - palette compose emits makeSweepPath
 * - preview has gradient + arrows
 * - resolveFaceModal Path gating
 */
import {
  composeHelperInsert,
  HELPER_PALETTE_ITEMS,
} from '../../src/utils/helperPaletteSnippets.js';
import {
  resolveFaceModal,
  isFaceFeature,
  FACE_FEATURE_IDS,
} from '../../src/utils/faceFeaturePlacement.js';
import {
  orderEdgePath,
  assembleSweepPath,
  makeSweepPathLoud,
  buildSweepPathPreview,
  canBuildSweepPath,
  SWEEP_PATH_EMPTY,
  SWEEP_PATH_DISCONNECTED,
  SWEEP_PATH_BRANCH,
} from '../../src/utils/edgeSweepPath.js';
import { edgeKey } from '../../src/utils/selectEdge.js';

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

console.log('slice-22 edge → sweep path smoke');

/** Axis-aligned box top rectangle edges (open chain of 3 + closed loop of 4). */
function boxTopEdges() {
  // Square on z=10: verts 0..3
  const V = [
    [-20, -15, 10], // 0
    [20, -15, 10],  // 1
    [20, 15, 10],   // 2
    [-20, 15, 10],  // 3
  ];
  const mk = (a, b) => {
    const va = V[a], vb = V[b];
    const length = Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]);
    const tangent = [
      (vb[0] - va[0]) / length,
      (vb[1] - va[1]) / length,
      (vb[2] - va[2]) / length,
    ];
    return {
      key: `${Math.min(a, b)}-${Math.max(a, b)}`,
      a, b,
      va: va.slice(),
      vb: vb.slice(),
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      length,
      tangent,
    };
  };
  return {
    e01: mk(0, 1),
    e12: mk(1, 2),
    e23: mk(2, 3),
    e30: mk(3, 0),
  };
}

/** Tessellated circular rim (N segments) — closed loop. */
function circularRim(n = 16, r = 10, z = 5) {
  const edges = [];
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2;
    const t1 = ((i + 1) / n) * Math.PI * 2;
    const va = [r * Math.cos(t0), r * Math.sin(t0), z];
    const vb = [r * Math.cos(t1), r * Math.sin(t1), z];
    const length = Math.hypot(vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]);
    const a = i;
    const b = (i + 1) % n;
    edges.push({
      key: `${Math.min(a, b)}-${Math.max(a, b)}`,
      a, b,
      va, vb,
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2],
      length,
      tangent: [(vb[0] - va[0]) / length, (vb[1] - va[1]) / length, (vb[2] - va[2]) / length],
    });
  }
  return edges;
}

const box = boxTopEdges();

// ── Palette / modal ────────────────────────────────────────────
{
  check('sweepPath is face feature', isFaceFeature('sweepPath'));
  check('sweepPath in FACE_FEATURE_IDS', FACE_FEATURE_IDS.has('sweepPath'));

  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === 'sweepPath');
  check('palette has sweepPath', !!item);
  check('palette in Features group', item && item.group === 'Features');
  check('palette label Path', item && item.label === 'Path');

  const rEmpty = resolveFaceModal(item, null, null);
  check('no edges → refuse', rEmpty.mode === 'refuse');
  check('refuse mentions select/edge', /edge/i.test(rEmpty.message || ''));

  const openSel = [box.e01, box.e12, box.e23];
  const rOpen = resolveFaceModal(item, null, openSel);
  check('open chain → params', rOpen.mode === 'params');
  check('title mentions open', /open/i.test(rOpen.item?.title || ''));
  check('_sweepPathPlacement', !!rOpen.item?._sweepPathPlacement);

  const closedSel = [box.e01, box.e12, box.e23, box.e30];
  const rClosed = resolveFaceModal(item, null, closedSel);
  check('closed loop → params', rClosed.mode === 'params');
  check('title mentions closed', /closed/i.test(rClosed.item?.title || ''));

  // Disconnected: two opposite edges
  const rDisc = resolveFaceModal(item, null, [box.e01, box.e23]);
  check('disconnected → refuse', rDisc.mode === 'refuse');
  check('disconnected message', /disconnect/i.test(rDisc.message || ''));
}

// ── Open chain ordering ────────────────────────────────────────
{
  const sel = [box.e12, box.e01, box.e23]; // shuffled
  const r = orderEdgePath(sel);
  check('open ok', r.ok === true);
  check('open not closed', r.ok && r.closed === false);
  check('open 3 edges', r.ok && r.orderedEdges.length === 3);
  check('open 4 points', r.ok && r.points.length === 4);

  // Contiguous: each tip matches next start
  if (r.ok) {
    let contig = true;
    for (let i = 0; i < r.orderedEdges.length - 1; i++) {
      const a = r.orderedEdges[i].vb;
      const b = r.orderedEdges[i + 1].va;
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-6) contig = false;
    }
    check('open contiguous', contig);
  }

  const val = assembleSweepPath(sel);
  check('assemble open kind', val.ok && val.value.kind === 'sweepPath');
  check('assemble open edgeCount', val.ok && val.value.edgeCount === 3);
  check('assemble open length ~110', val.ok && Math.abs(val.value.length - 110) < 1e-6);

  const loud = makeSweepPathLoud(sel);
  check('loud open points', loud.points.length === 4);

  const rev = assembleSweepPath(sel, { reverse: true });
  check('reverse flips ends', rev.ok
    && Math.hypot(
      rev.value.points[0][0] - loud.points[loud.points.length - 1][0],
      rev.value.points[0][1] - loud.points[loud.points.length - 1][1],
      rev.value.points[0][2] - loud.points[loud.points.length - 1][2],
    ) < 1e-6);
}

// ── Closed / circular ──────────────────────────────────────────
{
  const sel = [box.e23, box.e01, box.e30, box.e12];
  const r = orderEdgePath(sel);
  check('closed ok', r.ok === true);
  check('closed flag', r.ok && r.closed === true);
  check('closed 4 edges', r.ok && r.orderedEdges.length === 4);
  // orderEdgePath keeps duplicated close point; assemble strips it
  check('closed walk points n+1', r.ok && r.points.length === 5);

  const val = assembleSweepPath(sel);
  check('assemble closed strips dup', val.ok && val.value.points.length === 4);
  check('assemble closed flag', val.ok && val.value.closed === true);
  check('assemble closed length ~140', val.ok && Math.abs(val.value.length - 140) < 1e-6);

  const rim = circularRim(16, 12, 8);
  const rimOrd = orderEdgePath(rim);
  check('circular rim ok', rimOrd.ok === true);
  check('circular rim closed', rimOrd.ok && rimOrd.closed === true);
  check('circular rim 16 edges', rimOrd.ok && rimOrd.orderedEdges.length === 16);

  const rimVal = makeSweepPathLoud(rim);
  check('circular makeSweepPath closed', rimVal.closed === true);
  check('circular points == N', rimVal.points.length === 16);

  // Contiguous around the circle
  if (rimOrd.ok) {
    let contig = true;
    for (let i = 0; i < rimOrd.orderedEdges.length; i++) {
      const e0 = rimOrd.orderedEdges[i];
      const e1 = rimOrd.orderedEdges[(i + 1) % rimOrd.orderedEdges.length];
      if (Math.hypot(e0.vb[0] - e1.va[0], e0.vb[1] - e1.va[1], e0.vb[2] - e1.va[2]) > 1e-5) {
        contig = false;
      }
    }
    check('circular contiguous loop', contig);
  }
}

// ── Soft-fail cases ────────────────────────────────────────────
{
  check('empty not ok', orderEdgePath([]).ok === false);
  check('empty code', orderEdgePath([]).code === 'empty');
  check('empty message constant', orderEdgePath([]).message === SWEEP_PATH_EMPTY);
  check('canBuild false empty', canBuildSweepPath([]) === false);

  const disc = orderEdgePath([box.e01, box.e23]);
  check('disconnected not ok', disc.ok === false);
  check('disconnected code', disc.code === 'disconnected');
  check('disconnected message', disc.message.startsWith(SWEEP_PATH_DISCONNECTED));
  check('disconnected names components', /2 components, largest 1 of 2/.test(disc.message));

  // Largest-component recovery: 3-edge chain + 1 stray (3/4 = 0.75).
  const stray = {
    key: '90-91', a: 90, b: 91,
    va: [100, 0, 0], vb: [101, 0, 0],
    mid: [100.5, 0, 0], length: 1,
  };
  const rec = orderEdgePath([box.e01, box.e12, box.e23, stray]);
  check('recovers largest chain from strays', rec.ok === true && rec.orderedEdges.length === 3);
  check('recovery flag set', rec.recovered === true);
  const twoPlusStray = orderEdgePath([box.e01, box.e12, stray]);
  check('2+1 below 75% still refuse', twoPlusStray.ok === false && twoPlusStray.code === 'disconnected');

  // Branch: add a spur from mid of chain — invent vertex 99 sharing with e01.a
  const spur = {
    key: '0-99',
    a: 0,
    b: 99,
    va: box.e01.va.slice(),
    vb: [box.e01.va[0], box.e01.va[1] - 10, box.e01.va[2]],
    mid: [box.e01.va[0], box.e01.va[1] - 5, box.e01.va[2]],
    length: 10,
    tangent: [0, -1, 0],
  };
  const branch = orderEdgePath([box.e01, box.e12, box.e30, spur]);
  // e01+e12+e30: vertex 0 has e01 + e30 + spur = degree 3
  check('branch not ok', branch.ok === false);
  check('branch code', branch.code === 'branch');
  check('branch message', branch.message === SWEEP_PATH_BRANCH);

  expectThrow('loud empty throws', () => makeSweepPathLoud([]), /edge/i);
  expectThrow('loud disconnected throws', () => makeSweepPathLoud([box.e01, box.e23]), /disconnect/i);
}

// ── Preview ────────────────────────────────────────────────────
{
  const openSel = [box.e01, box.e12, box.e23];
  const prev = buildSweepPathPreview(openSel);
  check('preview open', !!prev);
  check('preview points ≥ 2', prev && prev.points.length >= 2);
  check('preview colors match points', prev && prev.colors.length === prev.points.length);
  check('preview has arrows', prev && prev.arrows.length >= 1);
  check('preview has markers', prev && prev.markers.length >= 1);
  check('preview not closed', prev && prev.closed === false);

  const closedPrev = buildSweepPathPreview([box.e01, box.e12, box.e23, box.e30]);
  check('preview closed', closedPrev && closedPrev.closed === true);
  check('preview closed repeats first', closedPrev
    && Math.hypot(
      closedPrev.points[0][0] - closedPrev.points[closedPrev.points.length - 1][0],
      closedPrev.points[0][1] - closedPrev.points[closedPrev.points.length - 1][1],
      closedPrev.points[0][2] - closedPrev.points[closedPrev.points.length - 1][2],
    ) < 1e-6);

  check('preview null on empty', buildSweepPathPreview([]) === null);
  check('preview null on disconnected', buildSweepPathPreview([box.e01, box.e23]) === null);
}

// ── Compose ────────────────────────────────────────────────────
{
  const edges = [box.e01, box.e12];
  const buf = composeHelperInsert(
    'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n',
    'sweepPath',
    null,
    { reverse: false },
    null,
    edges,
  );
  check('compose returns buffer', typeof buf === 'string' && buf.length > 0);
  check('compose has makeSweepPath', /makeSweepPath\s*\(/.test(buf || ''));
  check('compose has named path', /const path\d*\s*=\s*makeSweepPath/.test(buf || ''));
  check('compose keeps return part', /return part;/.test(buf || ''));
  check('compose has literal selEdges', /selEdges\s*=\s*\[/.test(buf || ''));
  check('compose sweep does not rematch convexEdges', !/convexEdges\(/.test(buf || ''));

  const revBuf = composeHelperInsert(
    'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n',
    'sweepPath',
    null,
    { reverse: true },
    null,
    edges,
  );
  check('compose reverse opt', /reverse:\s*true/.test(revBuf || ''));

  const nullBuf = composeHelperInsert(
    'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n',
    'sweepPath',
    null,
    {},
    null,
    [],
  );
  check('compose empty soft-fails null', nullBuf === null);

  // Dedup keys
  const dup = orderEdgePath([box.e01, box.e01, box.e12]);
  check('dedupes duplicate keys', dup.ok && dup.orderedEdges.length === 2);
  check('edgeKey stable', edgeKey(box.e01) === box.e01.key);

  // Unindexed edge payloads must be skipped rather than collapsing as NaN-NaN.
  const unindexed = [
    { va: [0, 0, 0], vb: [1, 0, 0], length: 1 },
    { va: [1, 0, 0], vb: [2, 0, 0], length: 1 },
    { va: [2, 0, 0], vb: [3, 0, 0], length: 1 },
  ];
  const unindexedPath = assembleSweepPath(unindexed);
  check('unindexed edges soft-fail empty', !unindexedPath.ok && unindexedPath.code === 'empty');
  check('unindexed edges do not collapse to closed one-edge path',
    !(unindexedPath.ok && unindexedPath.value.closed && unindexedPath.value.edgeCount === 1));
  expectThrow('loud unindexed edges fail empty', () => makeSweepPathLoud(unindexed), /Select edges first|empty/i);
}

if (failed) {
  console.log(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll slice-22 checks passed.');
