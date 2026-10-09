/**
 * Manifold surface to a TET10 von Mises field.
 *
 * meshVolume turns the render triangles into a quadratic tet mesh and copies
 * face ids onto the boundary. Fixtures and loads on those face ids become
 * nodal constraints and consistent tractions. solve_tet10 returns nodal von
 * Mises and nodal displacement. Both are sampled onto the render vertices,
 * keyed by faceID and position. Displacement is the magnitude in millimetres.
 * The render mesh is not deformed.
 *
 * TODO: shells need a midsurface extraction before solve_shell. Solids always
 * use TET10 here. SHELLS_AVAILABLE stays false.
 */

import { boundaryConditions } from './boundaryConditions.js';
import {
  chooseEdgeLength,
  chooseSolver,
  dofCap,
  isThinPart,
  partShape,
  SHELLS_AVAILABLE,
  THIN_ELEMENTS_THROUGH,
} from './deviceProfile.js';
import {
  fieldRange,
  safetyFactor,
  sampleSurfaceDisplacement,
  sampleSurfaceStress,
} from './stressSample.js';
import { PHONE_WASM_BYTES } from './wasmMemory.js';

function abortError() {
  const error = new Error('FEA solve cancelled');
  error.name = 'AbortError';
  return error;
}

function yieldTurn() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function plainWarnings(list) {
  if (!Array.isArray(list)) return [];
  return list.map((warning) => ({
    code: warning && warning.code ? String(warning.code) : 'warning',
    msg: warning && warning.msg ? String(warning.msg) : '',
  })).filter((warning) => warning.msg);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * `solveTet10` and `solveStub` are the wasm exports. `meshVolume` is injected
 * in tests; the app loads it on the first call so the mesher stays out of the
 * initial bundle. `fallback: "stub"` is the dev-only placeholder.
 */
export async function solveSolid({
  study,
  positions,
  indices,
  faceIDs,
  material,
  profile,
  fallback,
  solveTet10,
  solveStub,
  meshVolume,
  isCancelled,
  onProgress,
  memory,
  noteMemory,
  peakMemory,
}) {
  const cancelled = () => (typeof isCancelled === 'function' ? isCancelled() : false);
  const progress = (update) => {
    if (typeof onProgress === 'function') onProgress(update);
  };
  const timings = {};
  if (cancelled()) throw abortError();

  if (fallback === 'stub') {
    const stubStarted = Date.now();
    progress({ stage: 'meshing', fraction: 0 });
    const result = solveStub(study, positions, indices, faceIDs, material, profile || 'desktop');
    timings.meshing = Date.now() - stubStarted;
    timings.solving = 0;
    timings['post-processing'] = 0;
    progress({ stage: 'post-processing', fraction: 1, dofs: result && result.stats ? result.stats.dofs : null });
    if (typeof noteMemory === 'function') noteMemory();
    if (result && typeof result === 'object') result.stageTimings = timings;
    return result;
  }

  const shape = partShape(positions, indices);
  if (!(shape.volume > 0) || !(indices && indices.length)) {
    throw new Error('The part has no solid volume to mesh.');
  }
  const thin = isThinPart(shape);
  const solver = chooseSolver(shape);
  const cap = dofCap(profile, thin, solver);
  const target = study && study.mesh ? study.mesh.target : undefined;
  const edge = chooseEdgeLength(shape, target, cap);
  const warnings = [];
  if (study && study.model === 'shell') {
    warnings.push({
      code: 'shell-unsupported',
      msg: 'Shells need a midsurface extraction, which this build does not do. The solid was solved with TET10.',
    });
  }
  if (edge.coarsened) {
    const short = edge.elementsThrough != null && edge.elementsThrough < THIN_ELEMENTS_THROUGH;
    const throughText = short
      ? ` That is coarser than ${THIN_ELEMENTS_THROUGH} elements through the ${edge.wallMm.toFixed(2)} mm wall.`
      : '';
    const why = Number.isFinite(cap)
      ? `The phone DOF cap (${cap}) coarsened the mesh from ${edge.requested.toFixed(2)} mm to ${edge.edgeLength.toFixed(2)} mm edges.`
      : `A ${edge.requested.toFixed(2)} mm edge (2 through the ${edge.wallMm.toFixed(2)} mm wall) does not fit in memory, so the mesh keeps ${edge.edgeLength.toFixed(2)} mm edges.`;
    warnings.push({
      code: 'mesh-coarse',
      msg: `${why}${throughText}`,
    });
  }

  progress({ stage: 'loading-mesher' });
  await yieldTurn();
  if (cancelled()) throw abortError();
  const loadStarted = Date.now();
  const loadMesh = meshVolume || (await import('./meshVolume.js')).meshVolume;
  timings['loading-mesher'] = Date.now() - loadStarted;

  progress({ stage: 'meshing' });
  await yieldTurn();
  if (cancelled()) throw abortError();
  const ceiling = profile === 'phone' ? PHONE_WASM_BYTES : 0;
  const started = Date.now();
  const volume = await loadMesh(
    { positions, indices, faceIds: faceIDs },
    {
      edgeLength: edge.edgeLength,
      epsilon: 1e-3,
      maxTets: 0,
      memoryCeilingBytes: ceiling,
      onProgress: (update) => progress({ stage: 'meshing', ...(update || {}) }),
    },
  );
  timings.meshing = Date.now() - started;
  if (typeof noteMemory === 'function') noteMemory(volume);
  if (cancelled()) throw abortError();
  if (Number.isFinite(cap) && volume.stats.dofs > cap * 1.25) {
    warnings.push({
      code: 'dof-cap',
      msg: `The mesh has ${volume.stats.dofs} degrees of freedom, above the phone cap of ${cap}.`,
    });
  }

  progress({ stage: 'assembling' });
  await yieldTurn();
  if (cancelled()) throw abortError();
  const assembleStarted = Date.now();
  const bcs = boundaryConditions(volume, study || {}, { diagonal: shape.diagonal });
  timings.assembling = Date.now() - assembleStarted;
  warnings.push(...bcs.warnings);
  if (!bcs.fixedNodes.length) {
    throw new Error('Fix a face before running the study.');
  }
  const bcPayload = { fixedNodes: bcs.fixedNodes };
  if (bcs.forceNodes.length) {
    bcPayload.forceNodes = bcs.forceNodes;
    bcPayload.forceValues = bcs.forceValues;
  }
  if (bcs.pressureFaces.length) {
    bcPayload.pressureFaces = bcs.pressureFaces;
    bcPayload.pressures = bcs.pressures;
  }
  const yieldMPa = material && material.yield_MPa != null && Number.isFinite(Number(material.yield_MPa))
    ? Number(material.yield_MPa)
    : null;
  progress({
    stage: 'solving',
    solver,
    blocking: true,
    choleskyStep: solver === 'cholesky' ? 'factor' : undefined,
    fraction: solver === 'cholesky' ? 0.5 : undefined,
  });
  await yieldTurn();
  if (cancelled()) throw abortError();
  const solveStarted = Date.now();
  let solved;
  try {
    solved = solveTet10(
      { nodes: volume.nodes, elements: volume.elements },
      { E_MPa: material.E_MPa, nu: material.nu, yield_MPa: yieldMPa },
      bcPayload,
      { solver },
    );
  } finally {
    if (!solved) progress({ stage: 'solving', solver, blocking: false });
  }
  timings.solving = Date.now() - solveStarted;
  const solvedStats = solved && solved.stats ? solved.stats : {};
  const solvedDofs = solvedStats.dofs != null ? solvedStats.dofs : volume.stats.dofs;
  if (solver === 'cholesky') {
    progress({
      stage: 'solving',
      solver,
      blocking: false,
      choleskyStep: 'solve',
      fraction: 1,
      dofs: solvedDofs,
    });
  } else {
    progress({
      stage: 'solving',
      solver,
      blocking: false,
      iteration: solvedStats.iterations,
      residual: solvedStats.residual,
      residual0: Number.isFinite(solvedStats.residual) ? 1 : undefined,
      tol: 1e-8,
      dofs: solvedDofs,
    });
  }
  if (typeof noteMemory === 'function') noteMemory(volume);
  if (cancelled()) throw abortError();

  progress({ stage: 'post-processing', fraction: 0.9, dofs: solvedDofs });
  const postStarted = Date.now();
  const tetField = Float64Array.from(solved.nodal);
  const nodal = sampleSurfaceStress(positions, indices, faceIDs, volume, tetField);
  let displacement = null;
  let displacementMin = null;
  let displacementMax = null;
  const nodeCount = volume.nodes.length / 3;
  const nodalDisp = solved.displacement;
  if (nodalDisp && nodalDisp.length >= nodeCount * 3) {
    displacement = sampleSurfaceDisplacement(positions, indices, faceIDs, volume, nodalDisp);
    const dispRange = fieldRange(displacement);
    displacementMin = dispRange.min;
    displacementMax = dispRange.max;
  }
  const tetRange = fieldRange(tetField);
  const min = asNumber(solved.min) ?? tetRange.min;
  const max = asNumber(solved.max) ?? tetRange.max;
  const p95 = asNumber(solved.p95) ?? tetRange.p95;
  const factor = solved.safetyFactor != null ? solved.safetyFactor : safetyFactor(yieldMPa, p95);
  const solverWarnings = plainWarnings(solved.warnings);
  for (const warning of solverWarnings) {
    if (warning.code === 'missing-yield' || warning.code === 'zero-stress') warnings.push(warning);
  }
  timings['post-processing'] = Date.now() - postStarted;
  progress({ stage: 'post-processing', fraction: 1, dofs: solvedDofs });

  const elapsed = Date.now() - started;
  return {
    source: 'tet10',
    field: 'von_mises',
    units: 'MPa',
    nodal,
    displacement,
    displacementMin,
    displacementMax,
    min,
    max,
    p95,
    safetyFactor: factor == null ? null : factor,
    fos: factor == null ? null : factor,
    warnings,
    solver: solved.solver || solver,
    // Loading the worker is timed on the main thread. These four are the
    // worker's own clocks.
    stageTimings: {
      meshing: timings.meshing,
      assembling: timings.assembling,
      solving: timings.solving,
      'post-processing': timings['post-processing'],
    },
    thin,
    shells: SHELLS_AVAILABLE,
    stats: {
      dofs: solved.stats ? solved.stats.dofs : volume.stats.dofs,
      freeDofs: solved.stats ? solved.stats.freeDofs : 0,
      ms: elapsed,
      meshMs: volume.stats.ms,
      solveMs: solved.stats ? solved.stats.solveMs : 0,
      vertices: positions.length / 3,
      triangles: indices.length / 3,
      elements: volume.stats.elements,
      edgeLength: edge.edgeLength,
      peakMemoryBytes: typeof peakMemory === 'function'
        ? peakMemory()
        : peakBytes(memory, volume),
      wasmMemoryMaxBytes: profile === 'phone' ? PHONE_WASM_BYTES : null,
    },
  };
}

function peakBytes(memory, volume) {
  const feaBytes = memory && memory.buffer ? memory.buffer.byteLength : 0;
  const meshBytes = (volume && volume.stats && volume.stats.wasmBytes) || 0;
  return feaBytes + meshBytes;
}
