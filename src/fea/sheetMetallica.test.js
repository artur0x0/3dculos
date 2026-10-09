import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import * as fea from '../../packages/surfcad-fea/pkg/surfcad_fea.js';
import { chooseEdgeLength, isThinPart, partShape, PHONE_DOF_CAPS, THIN_ELEMENTS_THROUGH } from './deviceProfile.js';
import { SHEET_FLANGE_PROBE, SHEET_METALLICA_SCRIPT } from './fixtures/sheetMetallica.js';
import { formatDoneText } from './feaProgress.js';
import { countTetsAlong, jacobianAcceptable, meshVolume, tet10MinJacobian } from './meshVolume.js';
import { studyForSolve } from './renderFaceIds.js';
import { readFeaStudy } from './studyScript.js';
import { solveSolid } from './solveSolid.js';
import { meshArraysFromGeometry } from './studyPanel.js';
import { runScript } from '../lib/surfcad/index.js';
import { buildSolidGeometry } from '../utils/partSolidCache.js';

const wasmUrl = new URL('../../packages/surfcad-fea/pkg/surfcad_fea_bg.wasm', import.meta.url);
const initFea = fea.default ?? fea.init;
await initFea({ module_or_path: await readFile(wasmUrl) });

const study = readFeaStudy(SHEET_METALLICA_SCRIPT);
const aluminum = { E_MPa: 68900, nu: 0.33, yield_MPa: 276 };

function finiteField(values) {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
  }
  return values.length > 0;
}

async function surfaceOf() {
  const built = await runScript(SHEET_METALLICA_SCRIPT);
  const positions = Float32Array.from(built.mesh.vertProperties);
  const indices = Uint32Array.from(built.mesh.triVerts);
  const faceIDs = Uint32Array.from(built.mesh.faceID);
  try { built.manifold?.delete?.(); } catch { /* already freed */ }
  return { positions, indices, faceIDs };
}

describe('sheet metallica bracket', { concurrency: 1 }, () => {
  test('the auto mesh stays right-handed through the bends', { timeout: 180_000 }, async () => {
    const surface = await surfaceOf();
    const shape = partShape(surface.positions, surface.indices);
    assert.equal(isThinPart(shape), true);
    const shapeEdge = chooseEdgeLength(shape, 'auto', PHONE_DOF_CAPS.tet10Thin);
    const mesh = await meshVolume(surface, { edgeLength: shapeEdge.edgeLength, epsilon: 1e-3 });
    let worst = Infinity;
    let worstAt = -1;
    const n = mesh.elements.length / 10;
    for (let t = 0; t < n; t += 1) {
      const det = tet10MinJacobian(mesh.nodes, mesh.elements.subarray(t * 10, t * 10 + 10));
      if (det < worst) {
        worst = det;
        worstAt = t;
      }
      assert.equal(jacobianAcceptable(det), true, `element ${t} min Jacobian ${det}`);
    }
    const through = countTetsAlong(
      mesh.nodes,
      mesh.elements,
      SHEET_FLANGE_PROBE.at,
      SHEET_FLANGE_PROBE.inward,
      SHEET_FLANGE_PROBE.gaugeMm,
    );
    // Two isotropic elements through 3.175 mm want an edge near 1.5 mm, about
    // 960 000 degrees of freedom on this bracket. That is past the phone cap
    // and the thin-wall budget, and the cap's own edge (near the gauge) slivers.
    // The bbox edge stays. fTetWild still stacks several tets through the flange.
    console.log(`bracket mesh dofs ${mesh.stats.dofs} elements ${mesh.stats.elements} edge ${shapeEdge.edgeLength.toFixed(2)} mm through ${through} worstJ ${worst} at ${worstAt} straightened ${mesh.stats.straightenedMids} oriented ${mesh.stats.oriented} ms ${mesh.stats.ms}`);
    assert.equal(mesh.stats.positive, true);
    // Measured on the fixed flange: the ray through 3.175 mm crosses more
    // than one tet even at the bbox edge, because fTetWild refines to the
    // wall. Two isotropic elements (edge near 1.5 mm) would be about 960k
    // DOF and is not requested once the budget refuses it.
    assert.ok(through >= THIN_ELEMENTS_THROUGH, `flange ray crossed ${through} elements through ${SHEET_FLANGE_PROBE.gaugeMm} mm`);
    assert.equal(shapeEdge.coarsened, false);
  });

  test('phone and desktop solves finish with a finite stress field', { timeout: 300_000 }, async () => {
    const built = await runScript(SHEET_METALLICA_SCRIPT);
    const solid = buildSolidGeometry(built.mesh);
    const surface = meshArraysFromGeometry(solid.geometry, solid.faceIDs);
    const expanded = studyForSolve(study, solid.geometry, solid.faceIDs);
    try { built.manifold?.delete?.(); } catch { /* already freed */ }
    for (const profile of ['phone', 'desktop']) {
      const result = await solveSolid({
        study: expanded,
        positions: surface.positions,
        indices: surface.indices,
        faceIDs: surface.faceIDs,
        material: aluminum,
        profile,
        solveTet10: fea.solve_tet10,
        solveStub: fea.solve,
        meshVolume,
      });
      assert.equal(result.source, 'tet10');
      assert.equal(result.solver, 'cholesky');
      assert.equal(finiteField(result.nodal), true);
      assert.equal(result.nodal.length, surface.positions.length / 3);
      assert.ok(result.max > 0.05 && result.max < 5000, `max ${result.max} MPa`);
      assert.ok(result.p95 > 0 && result.p95 <= result.max);
      assert.ok(result.min >= 0 && result.min <= result.p95);
      const timing = formatDoneText({
        timings: result.stageTimings,
        dofs: result.stats.dofs,
        startedAt: 0,
        now: result.stats.ms,
      });
      assert.match(timing, /Meshed in .+ solved in .+ DOF.+total/);
      assert.equal(result.warnings.some((warning) => warning.code === 'mesh-coarse'), false);
      console.log(`${profile} dofs ${result.stats.dofs} mesh ${result.stats.meshMs} ms solve ${result.stageTimings.solving} ms max ${result.max.toFixed(2)} MPa p95 ${result.p95.toFixed(2)} ${timing}`);
    }
  });
});
