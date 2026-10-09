#!/usr/bin/env node
/**
 * Slice Mobile C.2 — popup part-shift + fillet tangent restore + strip polish.
 *
 * 1) Feature sheet open/close lifts/returns the part (camera/target tween);
 *    edge-pick chips do NOT lift.
 * 2) Fillet Tangent-on chains again (64-seg rims; skipNormals on coherent graph).
 * 3) Script strip starts below ribbon; CAD strip is horizontal L→R.
 *
 * Non-goals: PWA (D), Fillet D/speed, AI-on-pill, fillet UI redesign.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildCoherentEdges,
  toggleEdgeSelectionPropagated,
  propagateTangentEdges,
  COHERENT_EDGE_MAX,
  TANGENT_PROP_FLOOD_MAX,
} from '../../src/utils/selectEdge.js';
import { isTrueG1 } from '../../src/utils/edgeTangencyField.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('mobile C.2: popup shift + fillet tangent + strip polish');

{
  const app = read('../../src/App.jsx');
  const strip = read('../../src/components/FeatureStrip.jsx');
  const viewport = read('../../src/components/Viewport.jsx');
  const camera = read('../../src/utils/viewCamera.js');
  const selectEdge = read('../../src/utils/selectEdge.js');
  const tangency = read('../../src/utils/edgeTangencyField.js');
  const sheet = read('../../src/components/FeatureEditSheet.jsx');
  const filletChip = read('../../src/components/FilletModeChip.jsx');

  // --- Sheet lift ---
  check(
    'viewCamera exports panViewByNdcY + easeInOutCubic',
    /export function panViewByNdcY/.test(camera) &&
      /export function easeInOutCubic/.test(camera),
  );
  check(
    'Viewport exposes setFeatureSheetLift tween API',
    /setFeatureSheetLift:/.test(viewport) &&
      /sheetLiftNdcRef/.test(viewport) &&
      /panViewByNdcY/.test(viewport),
  );
  check(
    'App tweens lift on featureSheet open/close (not edge chips)',
    /setFeatureSheetLift/.test(app) &&
      /data-feature-sheet/.test(app) &&
      /Edge-pick chips/.test(app),
  );
  check(
    'FeatureSheet still under-title (large sheet that lifts)',
    /data-feature-sheet-layout="under-title-horizontal"/.test(sheet) &&
      /top-14/.test(sheet),
  );
  check(
    'FilletModeChip / edge selector have no setFeatureSheetLift',
    !/setFeatureSheetLift/.test(filletChip) &&
      !/data-edge-selector[\s\S]{0,400}setFeatureSheetLift/.test(viewport),
  );
  const slide = read('../../src/utils/featureSheetCamera.js');
  const card = read('../../src/components/FeatureSheet.jsx');
  check(
    'bottom card slides content up and restores the pre-open pose',
    /export function featureSheetSlideNdc/.test(slide) &&
      /FEATURE_SHEET_SLIDE_MAX = 0\.6/.test(slide) &&
      /export function captureViewPose/.test(slide) &&
      /remountTrackball/.test(slide) &&
      /Positive pan moves content DOWN/.test(slide) &&
      /mode !== 'game' && !!contourMode/.test(viewport) &&
      /filletSheetOpen/.test(viewport) &&
      /edgeSheetOpen/.test(viewport) &&
      /onCancel=\{exitContourMode\}/.test(viewport) &&
      /featureSheetCameraOwned/.test(app) &&
      /data-feature-card/.test(card),
  );

  // --- Strip polish ---
  check(
    'CAD strip is horizontal under-ribbon',
    /data-feature-strip-placement="under-ribbon-horizontal"/.test(app) &&
      /orientation="horizontal"/.test(app) &&
      /data-feature-strip-orientation="horizontal"/.test(strip) &&
      /data-feature-strip-side="top"/.test(strip) &&
      !/right-0 top-14 bottom-36/.test(app),
  );
  check(
    'Script strip starts below ribbon (spacer + vertical rail)',
    /data-feature-strip-below-ribbon/.test(app) &&
      /data-feature-strip-ribbon-spacer/.test(app) &&
      /data-script-feature-strip/.test(app) &&
      /orientation="vertical"/.test(app) &&
      /data-feature-strip-orientation="vertical"/.test(strip),
  );

  // --- Tangent restore ---
  check(
    'TANGENT_PROP_FLOOD_MAX covers 64/128-seg defaults',
    /TANGENT_PROP_FLOOD_MAX = 128/.test(selectEdge) &&
      TANGENT_PROP_FLOOD_MAX === 128 &&
      TANGENT_PROP_FLOOD_MAX > COHERENT_EDGE_MAX,
  );
  check(
    'isTrueG1 supports skipNormals; propagateTangentEdges defaults to it',
    /skipNormals/.test(tangency) &&
      /skipNormals/.test(selectEdge) &&
      /opts\.skipNormals !== false/.test(selectEdge),
  );
  check(
    'FilletModeChip still has Tangent toggle wired (no redesign)',
    /Tangent \{tangentOn/.test(filletChip) &&
      /onToggleTangent/.test(filletChip) &&
      /tangentOn=\{tangentProp\}/.test(viewport),
  );
}

{
  console.log('\ntangent propagation (coherent + 64-gon)');
  const rimRaw = (N, R = 10) => {
    const edges = [];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2;
      const a1 = ((i + 1) / N) * Math.PI * 2;
      const va = [R * Math.cos(a0), R * Math.sin(a0), 0];
      const vb = [R * Math.cos(a1), R * Math.sin(a1), 0];
      const mid = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, 0];
      const tx = vb[0] - va[0];
      const ty = vb[1] - va[1];
      const L = Math.hypot(tx, ty) || 1;
      const nr = Math.hypot(mid[0], mid[1]) || 1;
      edges.push({
        key: `${i}`,
        a: i,
        b: (i + 1) % N,
        va,
        vb,
        mid,
        length: L,
        tangent: [tx / L, ty / L, 0],
        n0: [mid[0] / nr, mid[1] / nr, 0],
        n1: [0, 0, 1],
      });
    }
    return edges;
  };

  const coherent = buildCoherentEdges(rimRaw(64));
  check('64-seg rim stays in coherent pick graph', coherent.length >= 8, `n=${coherent.length}`);
  const viaChain = toggleEdgeSelectionPropagated([], coherent[0], {
    propagate: true,
    featureEdges: coherent,
  });
  check(
    'Tangent-on picks full coherent rim (chainId path)',
    viaChain.length === coherent.length && viaChain.length > 1,
    `got ${viaChain.length} / ${coherent.length}`,
  );

  // Regression: split chainIds + wall-normal gate used to soft-fail to ~4.
  const split = coherent.map((e, i) => ({ ...e, chainId: i }));
  const viaSplit = toggleEdgeSelectionPropagated([], split[0], {
    propagate: true,
    featureEdges: split,
  });
  check(
    'Tangent-on reconnects split chainIds via skipNormals G1 walk',
    viaSplit.length === coherent.length,
    `got ${viaSplit.length}`,
  );

  const noId = coherent.map((e) => {
    const { chainId: _chainId, ...rest } = e;
    return rest;
  });
  // With normals, true-G1 (skipNormals false) often fails on RDP chords —
  // document that edge-pick defaults skip them.
  let trueG1Count = 1;
  {
    const seed = noId[0];
    const walk = propagateTangentEdges(noId, seed, { skipNormals: false });
    trueG1Count = walk.length;
  }
  const skipWalk = propagateTangentEdges(noId, noId[0]);
  check(
    'default propagateTangentEdges (skipNormals) covers the rim',
    skipWalk.length === coherent.length,
    `got ${skipWalk.length}`,
  );
  check(
    'true-G1 with normals is stricter on simplified chords (root-cause pin)',
    trueG1Count < coherent.length,
    `trueG1=${trueG1Count} coherent=${coherent.length}`,
  );
  check(
    'isTrueG1 skipNormals accepts tangent-aligned pair',
    isTrueG1(noId[0], noId[1], { skipNormals: true }),
  );

  // Large radius must not drop the rim (pre-C.2 COHERENT_EDGE_MAX drop).
  const large = buildCoherentEdges(rimRaw(64, 100));
  check('large-R 64-seg rim is pickable', large.length >= 16, `n=${large.length}`);
  if (large.length) {
    const pick = toggleEdgeSelectionPropagated([], large[0], {
      propagate: true,
      featureEdges: large,
    });
    check('large-R rim tangent-on chains', pick.length === large.length, `got ${pick.length}`);
  }

  // Flood still refused
  const flood = [];
  for (let i = 0; i < 160; i++) {
    flood.push({
      key: `f-${i}`,
      a: i,
      b: i + 1,
      va: [i * 0.4, 0, 0],
      vb: [(i + 1) * 0.4, 0, 0],
      mid: [(i + 0.5) * 0.4, 0, 0],
      length: 0.4,
      tangent: [1, 0, 0],
      n0: [0, 0, 1],
      n1: [0, 1, 0],
    });
  }
  const refused = toggleEdgeSelectionPropagated([], flood[0], {
    propagate: true,
    featureEdges: flood,
  });
  check('160-edge flood still refuses to seed', refused.length === 1, `n=${refused.length}`);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll mobile C.2 checks passed.');
