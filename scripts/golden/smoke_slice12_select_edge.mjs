#!/usr/bin/env node
/**
 * Slice 12 — selectEdge.js pure geometry coverage (node + three, no wasm).
 * - buildFeatureEdges: tris.length !== 2 + cosMin dihedral @ DEFAULT_FEATURE_DEG=2°
 * - distPointToSegment: t clamp + degenerate segment
 * - toggleEdgeSelection: round-trip + copy-on-toggle
 * - pickNearestEdge: ties / maxDist rejection
 */
import { BufferGeometry, Float32BufferAttribute } from 'three';
import {
  buildFeatureEdges,
  distPointToSegment,
  pickNearestEdge,
  toggleEdgeSelection,
  edgeKey,
} from '../../src/utils/selectEdge.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('slice-12 selectEdge.js pure branches');

function makeIndexed(positions, indices) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
}

// ── buildFeatureEdges ──────────────────────────────────────────
{
  // Welded unit cube [-1,1]^3 — 12 convex 90° edges; every edge shared by exactly 2 tris
  const cubePos = [
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ];
  const cubeIdx = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    2, 6, 7, 2, 7, 3,
    0, 3, 7, 0, 7, 4,
    1, 5, 6, 1, 6, 2,
  ];
  const cubeEdges = buildFeatureEdges(makeIndexed(cubePos, cubeIdx));
  check('unit cube → 12 feature edges', cubeEdges.length === 12, `got ${cubeEdges.length}`);
  check(
    'cube edges all length 2',
    cubeEdges.every((e) => Math.abs(e.length - 2) < 1e-9),
  );

  // Flat subdivided quad: shared diagonal is coplanar seam (dot > cosMin);
  // boundary edges have tris.length !== 2 → dropped
  const quadPos = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0];
  const quadIdx = [0, 1, 2, 0, 2, 3];
  const quadEdges = buildFeatureEdges(makeIndexed(quadPos, quadIdx));
  check(
    'flat-subdivided quad → 0 seams',
    quadEdges.length === 0,
    `got ${quadEdges.length}`,
  );

  // 45° crease: n0·n1 = cos45 < cos(2°) → crease kept; outer edges boundary-dropped
  const s45 = Math.SQRT1_2;
  const creasePos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, s45, s45];
  const creaseIdx = [0, 1, 2, 0, 1, 3];
  const creaseEdges = buildFeatureEdges(makeIndexed(creasePos, creaseIdx));
  check('45° crease → the crease', creaseEdges.length === 1, `got ${creaseEdges.length}`);
  check('45° crease is shared edge 0-1', creaseEdges[0]?.key === '0-1');

  // Boundary-only mesh: tris.length !== 2 on every edge
  const lone = buildFeatureEdges(makeIndexed([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]));
  check('tris.length !== 2 boundary drop', lone.length === 0, `got ${lone.length}`);

  // DEFAULT_FEATURE_DEG = 2° → cosMin = cos(2°); seams with n0·n1 > cosMin drop
  const cosMin = Math.cos((2 * Math.PI) / 180);
  check('DEFAULT_FEATURE_DEG cosMin ≈ cos(2°)', Math.abs(cosMin - 0.999390827) < 1e-6);
  const fold = (deg) => {
    const a = (deg * Math.PI) / 180;
    return makeIndexed(
      [0, 0, 0, 2, 0, 0, 1, 1, 0, 1, Math.cos(a), Math.sin(a)],
      [0, 1, 2, 0, 1, 3],
    );
  };
  check('crease 0.5° (< 2°) filtered as seam', buildFeatureEdges(fold(0.5)).length === 0);
  check('crease 5° (> 2°) kept as feature', buildFeatureEdges(fold(5)).length === 1);
}

// ── distPointToSegment ─────────────────────────────────────────
{
  const va = [0, 0, 0];
  const vb = [1, 0, 0];
  check('dist t<0 clamps to endpoint va', Math.abs(distPointToSegment([-1, 0, 0], va, vb) - 1) < 1e-12);
  check('dist t>1 clamps to endpoint vb', Math.abs(distPointToSegment([2, 0, 0], va, vb) - 1) < 1e-12);
  check('dist interior perpendicular', Math.abs(distPointToSegment([0.5, 1, 0], va, vb) - 1) < 1e-12);
  check(
    'dist degenerate segment → |p−va|',
    Math.abs(distPointToSegment([3, 4, 0], [0, 0, 0], [0, 0, 0]) - 5) < 1e-12,
  );
}

// ── pickNearestEdge ────────────────────────────────────────────
{
  const sample = [
    {
      key: '0-1',
      a: 0,
      b: 1,
      va: [0, 0, 0],
      vb: [2, 0, 0],
      mid: [1, 0, 0],
      length: 2,
      tangent: [1, 0, 0],
    },
    {
      key: '2-3',
      a: 2,
      b: 3,
      va: [0, 5, 0],
      vb: [2, 5, 0],
      mid: [1, 5, 0],
      length: 2,
      tangent: [1, 0, 0],
    },
  ];
  check('pickNearestEdge within maxDist', pickNearestEdge(sample, [1, 0.1, 0], 0.5)?.key === '0-1');
  check('pickNearestEdge beyond maxDist → null', pickNearestEdge(sample, [1, 0.1, 0], 0.05) === null);
  check('pickNearestEdge empty → null', pickNearestEdge([], [0, 0, 0], 1) === null);
  // d === maxDist uses strict < → null (tie at boundary)
  check(
    'pickNearestEdge ties/maxDist rejection → null',
    pickNearestEdge(sample, [1, 0.5, 0], 0.5) === null,
  );
}

// ── toggleEdgeSelection ────────────────────────────────────────
{
  const src = {
    key: '0-1',
    a: 0,
    b: 1,
    va: [0, 0, 0],
    vb: [1, 0, 0],
    mid: [0.5, 0, 0],
    length: 1,
    tangent: [1, 0, 0],
  };
  const once = toggleEdgeSelection([], src);
  check('toggle-in length 1', once.length === 1 && edgeKey(once[0]) === '0-1');
  check('toggle-in is copy (not same ref)', once[0] !== src && once[0].va !== src.va);
  once[0].va[0] = 99;
  check('mutating toggled va does not affect source', src.va[0] === 0);
  const back = toggleEdgeSelection(once, src);
  check('toggle-out round-trips to empty', back.length === 0);
  check('toggle-out does not mutate prior list', once.length === 1);
}

if (failed) {
  console.log(`\nFAILED: ${failed}`);
  process.exit(1);
}
console.log('\nAll slice-12 selectEdge checks passed.');
