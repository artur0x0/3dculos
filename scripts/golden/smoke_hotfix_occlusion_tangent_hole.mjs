#!/usr/bin/env node
/**
 * Hotfix — edge occlusion + G1 tangent prop + hole-after-fillet face pick.
 */
import { OrthographicCamera, Vector3 } from 'three';
import {
  pickNearestEdgeScreen,
  propagateTangentEdges,
  toggleEdgeSelectionPropagated,
  TANGENT_PROP_DEG,
  EDGE_PICK_SLOP_PX,
  edgeKey,
} from '../../src/utils/selectEdge.js';
import {
  emitFaceWorkplaneLines,
  classifySelectedFace,
} from '../../src/utils/faceFeaturePlacement.js';
import { allocateUniqueName } from '../../src/utils/helperPaletteSnippets.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('hotfix occlusion / tangent / hole-after-fillet smoke');

/** Regular N-gon ring (turn = 360/N° between successive tangents). */
const makeRing = (N) => {
  const ring = [];
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const va = [Math.cos(a0), Math.sin(a0), 0];
    const vb = [Math.cos(a1), Math.sin(a1), 0];
    const tx = vb[0] - va[0], ty = vb[1] - va[1];
    const L = Math.hypot(tx, ty) || 1;
    ring.push({
      key: `${i}-${(i + 1) % N}`,
      a: i,
      b: (i + 1) % N,
      va, vb,
      mid: [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, 0],
      length: L,
      tangent: [tx / L, ty / L, 0],
    });
  }
  return ring;
};



// ── Occlusion: back-face edge must lose to front when mesh hit is set ─
{
  console.log('\nocclusion filter');
  const cam = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  cam.position.set(0, 0, 100);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const W = 200, H = 200;
  // Front edge at z=0 and occluded twin at z=-40, same screen projection along X.
  const front = {
    key: 'f', a: 0, b: 1,
    va: [-20, 0, 0], vb: [20, 0, 0], mid: [0, 0, 0], length: 40, tangent: [1, 0, 0],
    n0: [0, 0, 1], n1: [0, 1, 0], // camera-facing / silhouette-capable
  };
  const back = {
    key: 'b', a: 2, b: 3,
    va: [-20, 0, -40], vb: [20, 0, -40], mid: [0, 0, -40], length: 40, tangent: [1, 0, 0],
    n0: [0, 0, -1], n1: [0, -1, 0], // both away from +Z camera
  };
  const scratchA = new Vector3();
  const scratchB = new Vector3();
  const noOcc = pickNearestEdgeScreen(
    [front, back], cam, W, H, 100, 100, EDGE_PICK_SLOP_PX,
    { projectScratchA: scratchA, projectScratchB: scratchB },
  );
  // Without occlusion, closer NDC depth (front) still wins on depth tie-break.
  check('no-occlusion prefers front (depth)', noOcc?.key === 'f');

  const withOcc = pickNearestEdgeScreen(
    [front, back], cam, W, H, 100, 100, EDGE_PICK_SLOP_PX,
    {
      projectScratchA: scratchA,
      projectScratchB: scratchB,
      cameraPosition: [0, 0, 100],
      meshHitPoint: [0, 0, 0], // hit on front face
    },
  );
  check('occlusion keeps front edge', withOcc?.key === 'f');

  // Only back edge in list + hit on front → back rejected → null
  const onlyBack = pickNearestEdgeScreen(
    [back], cam, W, H, 100, 100, EDGE_PICK_SLOP_PX,
    {
      projectScratchA: scratchA,
      projectScratchB: scratchB,
      cameraPosition: [0, 0, 100],
      meshHitPoint: [0, 0, 0],
    },
  );
  check('occlusion rejects sole back-face edge', onlyBack === null);

  // Silhouette (no mesh hit) still allows back edge
  const sil = pickNearestEdgeScreen(
    [back], cam, W, H, 100, 100, EDGE_PICK_SLOP_PX,
    { projectScratchA: scratchA, projectScratchB: scratchB, cameraPosition: [0, 0, 100] },
  );
  check('silhouette (no hit) still picks edge', sil?.key === 'b');

  // Reviewer probe class: opaque tap lands ON the solid beside a boundary edge.
  // Cam at [0,0,500], left silhouette mid=[-200,0,200], hit 6mm inside on front
  // face — edgeDist > hitDist+eps, but one normal faces camera → must KEEP.
  const silCam = new OrthographicCamera(-250, 250, 250, -250, 0.1, 2000);
  silCam.position.set(0, 0, 500);
  silCam.lookAt(0, 0, 0);
  silCam.updateMatrixWorld(true);
  silCam.updateProjectionMatrix();
  const wallEdge = {
    key: 'wall-L', a: 10, b: 11,
    va: [-200, -100, 200], vb: [-200, 100, 200],
    mid: [-200, 0, 200], length: 200, tangent: [0, 1, 0],
    n0: [0, 0, 1],   // front face toward camera
    n1: [-1, 0, 0],  // left face
  };
  const camPos = [0, 0, 500];
  const hitBeside = [-194, 0, 200];
  const hitDist = Math.hypot(hitBeside[0] - camPos[0], hitBeside[1] - camPos[1], hitBeside[2] - camPos[2]);
  const edgeDist = Math.hypot(wallEdge.mid[0] - camPos[0], wallEdge.mid[1] - camPos[1], wallEdge.mid[2] - camPos[2]);
  check('probe geometry: edge mid farther than hit+eps', edgeDist > hitDist + 0.75,
    `edgeDist=${edgeDist.toFixed(2)} hitDist=${hitDist.toFixed(2)}`);
  // Project mid to canvas so pick lands near the edge
  const midProj = (() => {
    const v = new Vector3(-200, 0, 200).project(silCam);
    return { x: (v.x * 0.5 + 0.5) * 400, y: (-v.y * 0.5 + 0.5) * 400 };
  })();
  const beside = pickNearestEdgeScreen(
    [wallEdge], silCam, 400, 400, midProj.x + 6, midProj.y, EDGE_PICK_SLOP_PX,
    {
      projectScratchA: scratchA,
      projectScratchB: scratchB,
      cameraPosition: camPos,
      meshHitPoint: hitBeside,
    },
  );
  check('silhouette-beside-solid kept despite farther mid', beside?.key === 'wall-L');

  // Same geometry but both normals face away → still reject (true back edge)
  const away = {
    ...wallEdge,
    key: 'away',
    // Both normals point away from cam at [0,0,500] (view from mid ≈ [+x,+z]).
    n0: [0, 0, -1],
    n1: [-1, 0, 0],
  };
  const awayPick = pickNearestEdgeScreen(
    [away], silCam, 400, 400, midProj.x + 6, midProj.y, EDGE_PICK_SLOP_PX,
    {
      projectScratchA: scratchA,
      projectScratchB: scratchB,
      cameraPosition: camPos,
      meshHitPoint: hitBeside,
    },
  );
  check('farther mid + normals away still rejected', awayPick === null);
}

// ── G1 tangent propagation ─────────────────────────────────────
{
  console.log('\ntangent propagation');
  check('TANGENT_PROP_DEG in 15–30', TANGENT_PROP_DEG >= 15 && TANGENT_PROP_DEG <= 30);

  // Regular octagon in XY — successive edges turn 45°, so with 12° tol they do NOT chain.
  // With collinear chain they do.
  const chain = [
    { key: '0-1', a: 0, b: 1, va: [0, 0, 0], vb: [1, 0, 0], mid: [0.5, 0, 0], length: 1, tangent: [1, 0, 0] },
    { key: '1-2', a: 1, b: 2, va: [1, 0, 0], vb: [2, 0, 0], mid: [1.5, 0, 0], length: 1, tangent: [1, 0, 0] },
    { key: '2-3', a: 2, b: 3, va: [2, 0, 0], vb: [3, 0, 0], mid: [2.5, 0, 0], length: 1, tangent: [1, 0, 0] },
    // Sharp corner — should NOT propagate
    { key: '3-4', a: 3, b: 4, va: [3, 0, 0], vb: [3, 1, 0], mid: [3, 0.5, 0], length: 1, tangent: [0, 1, 0] },
  ];
  const prop = propagateTangentEdges(chain, chain[0]);
  check('collinear chain propagates 3', prop.length === 3, `got ${prop.length}`);
  check('sharp corner excluded', !prop.some((e) => edgeKey(e) === '3-4'));

  // Soft-fail: isolated edge → just seed
  const alone = propagateTangentEdges(chain, chain[3]);
  check('isolated soft-fails to seed only', alone.length === 1 && edgeKey(alone[0]) === '3-4');

  // Production tessellation: sandboxWorker documents 16-seg circles (22.5° steps).
  // TANGENT_PROP_DEG must be >= 23 (we use 25) so the full rim propagates.
  check('TANGENT_PROP_DEG >= 23 for 16-seg', TANGENT_PROP_DEG >= 23, `got ${TANGENT_PROP_DEG}`);
  const ring16 = makeRing(16);
  const loop16 = propagateTangentEdges(ring16, ring16[0]);
  check('16-gon (production) loop fully propagates', loop16.length === 16, `got ${loop16.length}`);

  // N=12 → 30° corners: deliberately seed-only (per-segment pick desired).
  const ring12 = makeRing(12);
  const loop12 = propagateTangentEdges(ring12, ring12[0]);
  check('12-gon stays seed-only (30° corners)', loop12.length === 1, `got ${loop12.length}`);

  // 24-gon still fully propagates (finer than production).
  const ring24 = makeRing(24);
  const loop24 = propagateTangentEdges(ring24, ring24[0]);
  check('24-gon loop fully propagates', loop24.length === 24, `got ${loop24.length}`);

  const added = toggleEdgeSelectionPropagated([], ring16[0], { propagate: true, featureEdges: ring16 });
  check('toggle propagated adds full 16-loop', added.length === 16, `got ${added.length}`);
  const off = toggleEdgeSelectionPropagated([], ring16[0], { propagate: false, featureEdges: ring16 });
  check('toggle propagate:false adds seed only', off.length === 1);
}

// ── Hole emit: wider tol + clearer miss message ────────────────
{
  console.log('\nhole-after-fillet emit');
  const face = classifySelectedFace({
    center: [0, 0, 10],
    normal: [0, 0, 1],
    area: 1000,
    triangleCount: 2,
    selectionMode: 'coplanar',
  });
  const names = new Set();
  const { lines } = emitFaceWorkplaneLines('part', face, names, allocateUniqueName);
  const joined = lines.join('\n');
  check('emit uses wide tol 25', /facesByNormal\([^)]*,\s*25\)/.test(joined));
  check('emit has 45° fallback', /facesByNormal\([^)]*,\s*45\)/.test(joined));
  check('emit clear re-pick message', /re-pick the planar face/i.test(joined));
  check('emit no cryptic No face near', !/No face near selected normal/.test(joined));
  check('emit still snaps center', /_off/.test(joined) && /_pc/.test(joined));
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall hotfix checks passed');
