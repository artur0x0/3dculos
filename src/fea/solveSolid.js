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
 * The worker passes a mesh cache. The key is the surface hash plus the mesh
 * target and the device profile, so a material, load, or fixture change
 * reuses the TET10 mesh. Boundary conditions are mapped again on that mesh.
 * When only E and/or yield change, with the same ν and the same force and
 * pressure loads, the cached solution is rescaled and solve_tet10 is not
 * called: stress stays put, displacement is multiplied by E_old / E_new,
 * and the safety factor is yield / p95. Anything else re-solves on the
 * cached mesh. The phone cache holds one mesh; desktop holds two. Evicting
 * an entry releases its arrays.
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
 * `cache` is the worker's mesh cache (`createMeshCache`). Without it, every
 * call meshes.
 */
export function createMeshCache() {
  return { entries: [] };
}

/** Drop every cached mesh and its saved solution. */
export function releaseMeshCache(cache) {
  if (!cache?.entries) return;
  while (cache.entries.length) freeCacheEntry(cache.entries.pop());
}

/** Keep the meshes and forget the saved solutions, so the next run re-solves. */
export function dropCachedSolutions(cache) {
  if (!cache?.entries) return;
  for (const entry of cache.entries) clearSolution(entry);
}

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
  cache,
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
  const tools = (cache || !meshVolume) ? await import('./meshVolume.js') : null;
  const loadMesh = meshVolume || tools.meshVolume;
  timings['loading-mesher'] = Date.now() - loadStarted;

  const device = profile === 'phone' ? 'phone' : 'desktop';
  const cacheKey = cache
    ? tools.meshCacheKey({ positions, indices, faceIDs }, target, device)
    : '';
  let entry = cache ? takeCacheEntry(cache, cacheKey) : null;
  let volume = entry?.mesh?.nodes ? entry.mesh : null;
  let meshReused = false;
  let started;
  if (volume) {
    meshReused = true;
    timings['loading-mesher'] = 0;
    timings.meshing = 0;
    started = Date.now();
    progress({ stage: 'meshing', fraction: 1 });
  } else {
    entry = null;
    if (cache) evictCache(cache, tools.meshCacheLimit(device), tools.releaseMesh);
    progress({ stage: 'meshing' });
    await yieldTurn();
    if (cancelled()) throw abortError();
    const ceiling = profile === 'phone' ? PHONE_WASM_BYTES : 0;
    started = Date.now();
    volume = await loadMesh(
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
    if (cancelled()) {
      tools?.releaseMesh?.(volume);
      throw abortError();
    }
    if (cache) entry = pushCacheEntry(cache, cacheKey, volume);
  }
  if (typeof noteMemory === 'function') noteMemory(volume);
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
  const signature = bcSignature(study);
  let solved = rescaleSolution(entry, material, yieldMPa, signature);
  let rescaled = !!solved;
  if (!solved) {
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
  } else {
    timings.solving = 0;
    progress({
      stage: 'solving',
      solver: solved.solver || solver,
      blocking: false,
      fraction: 1,
      dofs: solved.stats ? solved.stats.dofs : volume.stats.dofs,
    });
  }
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
  if (entry && !rescaled) rememberSolution(entry, material, signature, solved, linearLoads(study));

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
    meshReused,
    rescaled,
    // Loading the worker is timed on the main thread. These four are the
    // worker's own clocks. A reused mesh reports meshing as zero; the
    // timing line says "Mesh reused" from meshReused.
    stageTimings: {
      ...(meshReused ? { 'loading-mesher': 0 } : {}),
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
      meshMs: meshReused ? 0 : volume.stats.ms,
      solveMs: rescaled ? 0 : (solved.stats ? solved.stats.solveMs : 0),
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

function takeCacheEntry(cache, key) {
  if (!cache?.entries || !key) return null;
  const index = cache.entries.findIndex((item) => item && item.key === key);
  if (index < 0) return null;
  const [entry] = cache.entries.splice(index, 1);
  if (!entry?.mesh?.nodes) {
    freeCacheEntry(entry);
    return null;
  }
  cache.entries.push(entry);
  return entry;
}

function evictCache(cache, limit, releaseMesh) {
  const cap = limit > 0 ? limit : 1;
  while (cache.entries.length >= cap) freeCacheEntry(cache.entries.shift(), releaseMesh);
}

function pushCacheEntry(cache, key, mesh) {
  const entry = { key, mesh, solution: null };
  cache.entries.push(entry);
  return entry;
}

function freeCacheEntry(entry, releaseMesh) {
  if (!entry) return;
  const mesh = entry.mesh;
  entry.mesh = null;
  entry.key = '';
  clearSolution(entry);
  if (typeof releaseMesh === 'function') releaseMesh(mesh);
  else blankMesh(mesh);
}

function clearSolution(entry) {
  if (!entry) return;
  const solution = entry.solution;
  entry.solution = null;
  if (!solution) return;
  solution.nodal = null;
  solution.displacement = null;
}

function blankMesh(mesh) {
  if (!mesh || typeof mesh !== 'object') return;
  mesh.nodes = null;
  mesh.elements = null;
  mesh.faces = null;
  mesh.faceIds = null;
  if (mesh.stats && typeof mesh.stats === 'object') mesh.stats.wasmBytes = 0;
}

function bcSignature(study) {
  return JSON.stringify({
    fixtures: (study && study.fixtures) || [],
    loads: (study && study.loads) || [],
  });
}

function linearLoads(study) {
  const loads = (study && study.loads) || [];
  for (const load of loads) {
    if (!load || (load.kind !== 'force' && load.kind !== 'pressure')) return false;
  }
  const fixtures = (study && study.fixtures) || [];
  for (const fixture of fixtures) {
    if (!fixture || fixture.kind !== 'fixed') return false;
  }
  return true;
}

function rememberSolution(entry, material, signature, solved, linear) {
  clearSolution(entry);
  const E = Number(material && material.E_MPa);
  const nu = Number(material && material.nu);
  if (!(E > 0) || !Number.isFinite(nu) || !solved || !solved.nodal || !solved.displacement) return;
  entry.solution = {
    E,
    nu,
    linear: linear === true,
    bcKey: signature,
    nodal: Float64Array.from(solved.nodal),
    displacement: Float64Array.from(solved.displacement),
    min: asNumber(solved.min),
    max: asNumber(solved.max),
    p95: asNumber(solved.p95),
    solver: solved.solver || null,
    dofs: solved.stats && solved.stats.dofs != null ? solved.stats.dofs : null,
    freeDofs: solved.stats && solved.stats.freeDofs != null ? solved.stats.freeDofs : 0,
  };
}

function rescaleSolution(entry, material, yieldMPa, signature) {
  const saved = entry && entry.solution;
  if (!saved || saved.linear !== true || !saved.nodal || !saved.displacement || !(saved.E > 0)) return null;
  const E = Number(material && material.E_MPa);
  const nu = Number(material && material.nu);
  if (!(E > 0) || !Number.isFinite(nu) || nu !== saved.nu) return null;
  if (saved.bcKey !== signature) return null;
  const ratio = saved.E / E;
  if (!Number.isFinite(ratio) || !(ratio > 0)) return null;
  const displacement = new Float64Array(saved.displacement.length);
  for (let i = 0; i < displacement.length; i += 1) displacement[i] = saved.displacement[i] * ratio;
  const p95 = saved.p95;
  const factor = safetyFactor(yieldMPa, p95);
  const warnings = [];
  if (yieldMPa == null) {
    warnings.push({
      code: 'missing-yield',
      msg: 'material.yield_MPa is null, so safetyFactor is null',
    });
  } else if (!(p95 > 0)) {
    warnings.push({
      code: 'zero-stress',
      msg: 'p95 is 0, so safetyFactor is null (yield / p95 is undefined)',
    });
  }
  return {
    nodal: saved.nodal,
    displacement,
    min: saved.min,
    max: saved.max,
    p95,
    safetyFactor: factor,
    solver: saved.solver,
    warnings,
    stats: {
      dofs: saved.dofs,
      freeDofs: saved.freeDofs,
      iterations: 0,
      residual: 0,
      solveMs: 0,
    },
  };
}
