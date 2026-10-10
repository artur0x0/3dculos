/**
 * Modal branch of solveSolid. Fixtures only. Loads are ignored and noted.
 * The mesh cache is the same TET10 mesh; the static E-rescale cache is not
 * written. Mode shapes are sampled onto the render surface here so the
 * tet vectors stay in the worker.
 */

import { SHELLS_AVAILABLE } from './deviceProfile.js';
import { sampleShellTranslation } from './sheetMidsurface.js';
import {
  fieldRange,
  sampleSurfaceDisplacement,
  sampleSurfaceVector,
} from './stressSample.js';
import { PHONE_WASM_BYTES } from './wasmMemory.js';

export function solveModal({
  study,
  positions,
  indices,
  faceIDs,
  material,
  profile,
  volume,
  edge,
  bcs,
  warnings,
  timings,
  started,
  meshReused,
  thin,
  modalTet10,
  progress,
  noteMemory,
  memory,
  peakMemory,
  cancelled,
}) {
  if (typeof modalTet10 !== 'function') {
    throw new Error('Modal analysis is not in this FEA build.');
  }
  const report = typeof progress === 'function' ? progress : () => {};
  const density = Number(material && material.density_kg_m3);
  if (!(density > 0)) {
    throw new Error('A modal study needs a material density (kg/m³).');
  }
  const loads = (study && study.loads) || [];
  if (loads.length || (bcs.forceNodes && bcs.forceNodes.length) || (bcs.pressureFaces && bcs.pressureFaces.length)) {
    warnings.push({
      code: 'modal-loads',
      msg: 'Loads are ignored. A modal study uses fixtures only.',
    });
  }
  const bcPayload = {};
  if (bcs.fixedNodes && bcs.fixedNodes.length) bcPayload.fixedNodes = bcs.fixedNodes;
  const yieldMPa = material && material.yield_MPa != null && Number.isFinite(Number(material.yield_MPa))
    ? Number(material.yield_MPa)
    : null;
  report({
    stage: 'solving',
    solver: 'lobpcg',
    blocking: true,
    fraction: 0.5,
  });
  if (cancelled()) throw abortError();
  const solveStarted = Date.now();
  let solved;
  try {
    solved = modalTet10(
      { nodes: volume.nodes, elements: volume.elements },
      {
        E_MPa: material.E_MPa,
        nu: material.nu,
        yield_MPa: yieldMPa,
        density_kg_m3: density,
      },
      bcPayload,
      { modes: 6 },
    );
  } finally {
    if (!solved) report({ stage: 'solving', solver: 'lobpcg', blocking: false });
  }
  timings.solving = Date.now() - solveStarted;
  const solvedStats = solved && solved.stats ? solved.stats : {};
  const solvedDofs = solvedStats.dofs != null ? solvedStats.dofs : volume.stats.dofs;
  report({
    stage: 'solving',
    solver: 'lobpcg',
    blocking: false,
    fraction: 1,
    dofs: solvedDofs,
  });
  if (typeof noteMemory === 'function') noteMemory(volume);
  if (cancelled()) throw abortError();

  report({ stage: 'post-processing', fraction: 0.9, dofs: solvedDofs });
  const postStarted = Date.now();
  const frequencies = Array.from(solved.frequenciesHz || []);
  const mass = Array.from(solved.effectiveMass || []);
  const nNodes = volume.nodes.length / 3;
  const nVerts = positions.length / 3;
  const k = frequencies.length;
  const modeMagnitudes = new Float32Array(k * nVerts);
  const modeVectors = new Float32Array(k * nVerts * 3);
  const tetModes = solved.modes;
  for (let mode = 0; mode < k; mode += 1) {
    const base = mode * nNodes * 3;
    const slice = tetModes.subarray(base, base + nNodes * 3);
    const magnitude = sampleSurfaceDisplacement(positions, indices, faceIDs, volume, slice);
    const vector = sampleSurfaceVector(positions, indices, faceIDs, volume, slice);
    modeMagnitudes.set(magnitude, mode * nVerts);
    modeVectors.set(vector, mode * nVerts * 3);
  }
  const displacement = modeMagnitudes.subarray(0, nVerts);
  const dispRange = fieldRange(displacement);
  const solverWarnings = plainWarnings(solved.warnings);
  for (const warning of solverWarnings) warnings.push(warning);
  timings['post-processing'] = Date.now() - postStarted;
  report({ stage: 'post-processing', fraction: 1, dofs: solvedDofs });

  const elapsed = Date.now() - started;
  return {
    source: 'modal',
    field: 'mode',
    units: '1',
    nodal: new Float32Array(displacement),
    displacement: new Float32Array(displacement),
    displacementMin: dispRange.min,
    displacementMax: dispRange.max,
    frequenciesHz: frequencies,
    effectiveMass: mass,
    modeMagnitudes,
    modeVectors,
    min: dispRange.min,
    max: dispRange.max,
    p95: dispRange.p95,
    safetyFactor: null,
    fos: null,
    warnings,
    solver: 'lobpcg',
    meshReused,
    rescaled: false,
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
      dofs: solvedDofs,
      freeDofs: solvedStats.freeDofs != null ? solvedStats.freeDofs : 0,
      ms: elapsed,
      meshMs: meshReused ? 0 : volume.stats.ms,
      solveMs: solvedStats.solveMs != null ? solvedStats.solveMs : timings.solving,
      vertices: nVerts,
      triangles: indices.length / 3,
      elements: volume.stats.elements,
      edgeLength: edge.edgeLength,
      modes: k,
      iterations: solvedStats.iterations,
      residual: solvedStats.residual,
      peakMemoryBytes: typeof peakMemory === 'function'
        ? peakMemory()
        : peakBytes(memory, volume),
      wasmMemoryMaxBytes: profile === 'phone' ? PHONE_WASM_BYTES : null,
    },
  };
}

/** Modal branch for a sheet-metal mid-surface. Fixtures only. */
export function solveSheetModal({
  study,
  positions,
  indices,
  faceIDs,
  material,
  profile,
  shellMesh,
  bcs,
  warnings,
  assembling,
  meshMs,
  meshReused,
  started,
  modalShell,
  progress,
  noteMemory,
  memory,
  peakMemory,
  cancelled,
}) {
  if (typeof modalShell !== 'function') {
    throw new Error('Modal analysis is not in this FEA build.');
  }
  const report = typeof progress === 'function' ? progress : () => {};
  const density = Number(material && material.density_kg_m3);
  if (!(density > 0)) {
    throw new Error('A modal study needs a material density (kg/m³).');
  }
  const loads = (study && study.loads) || [];
  if (
    loads.length
    || (bcs.forceNodes && bcs.forceNodes.length)
    || (bcs.pressureElements && bcs.pressureElements.length)
  ) {
    warnings.push({
      code: 'modal-loads',
      msg: 'Loads are ignored. A modal study uses fixtures only.',
    });
  }
  const bcPayload = {};
  if (bcs.clampedNodes && bcs.clampedNodes.length) bcPayload.clampedNodes = bcs.clampedNodes;
  const yieldMPa = material && material.yield_MPa != null && Number.isFinite(Number(material.yield_MPa))
    ? Number(material.yield_MPa)
    : null;
  report({ stage: 'solving', solver: 'lobpcg', blocking: true, fraction: 0.5 });
  if (cancelled()) throw abortError();
  const solveStarted = Date.now();
  let solved;
  try {
    solved = modalShell(
      {
        nodes: shellMesh.nodes,
        elements: shellMesh.elements,
        thickness: new Float64Array([shellMesh.thickness]),
      },
      {
        E_MPa: material.E_MPa,
        nu: material.nu,
        yield_MPa: yieldMPa,
        density_kg_m3: density,
      },
      bcPayload,
      { modes: 6 },
    );
  } finally {
    if (!solved) report({ stage: 'solving', solver: 'lobpcg', blocking: false });
  }
  const solving = Date.now() - solveStarted;
  const solvedStats = solved && solved.stats ? solved.stats : {};
  const solvedDofs = solvedStats.dofs != null ? solvedStats.dofs : shellMesh.stats.dofs;
  report({
    stage: 'solving',
    solver: 'lobpcg',
    blocking: false,
    fraction: 1,
    dofs: solvedDofs,
  });
  if (typeof noteMemory === 'function') noteMemory({ stats: { wasmBytes: shellMesh.stats.wasmBytes || 0 } });
  if (cancelled()) throw abortError();

  report({ stage: 'post-processing', fraction: 0.9, dofs: solvedDofs });
  const postStarted = Date.now();
  const frequencies = Array.from(solved.frequenciesHz || []);
  const mass = Array.from(solved.effectiveMass || []);
  const nNodes = shellMesh.nodes.length / 3;
  const nVerts = positions.length / 3;
  const k = frequencies.length;
  const modeMagnitudes = new Float32Array(k * nVerts);
  const modeVectors = new Float32Array(k * nVerts * 3);
  const shellModes = solved.modes;
  for (let mode = 0; mode < k; mode += 1) {
    const base = mode * nNodes * 3;
    const slice = shellModes.subarray(base, base + nNodes * 3);
    const sampled = sampleShellTranslation(positions, indices, faceIDs, shellMesh, slice);
    modeMagnitudes.set(sampled.magnitude, mode * nVerts);
    modeVectors.set(sampled.vector, mode * nVerts * 3);
  }
  const displacement = modeMagnitudes.subarray(0, nVerts);
  const dispRange = fieldRange(displacement);
  for (const warning of plainWarnings(solved.warnings)) warnings.push(warning);
  const postMs = Date.now() - postStarted;
  report({ stage: 'post-processing', fraction: 1, dofs: solvedDofs });

  return {
    source: 'modal',
    field: 'mode',
    units: '1',
    nodal: new Float32Array(displacement),
    displacement: new Float32Array(displacement),
    displacementMin: dispRange.min,
    displacementMax: dispRange.max,
    frequenciesHz: frequencies,
    effectiveMass: mass,
    modeMagnitudes,
    modeVectors,
    min: dispRange.min,
    max: dispRange.max,
    p95: dispRange.p95,
    safetyFactor: null,
    fos: null,
    warnings,
    solver: 'lobpcg',
    meshReused,
    rescaled: false,
    stageTimings: {
      'loading-mesher': 0,
      meshing: meshMs,
      assembling,
      solving,
      'post-processing': postMs,
    },
    thin: true,
    shells: SHELLS_AVAILABLE,
    stats: {
      dofs: solvedDofs,
      freeDofs: solvedStats.freeDofs != null ? solvedStats.freeDofs : 0,
      ms: Date.now() - started,
      meshMs,
      solveMs: solvedStats.solveMs != null ? solvedStats.solveMs : solving,
      vertices: nVerts,
      triangles: indices.length / 3,
      elements: shellMesh.stats.elements,
      edgeLength: shellMesh.stats.edgeLength,
      modes: k,
      iterations: solvedStats.iterations,
      residual: solvedStats.residual,
      peakMemoryBytes: typeof peakMemory === 'function'
        ? peakMemory()
        : peakBytes(memory, shellMesh),
      wasmMemoryMaxBytes: profile === 'phone' ? PHONE_WASM_BYTES : null,
    },
  };
}

function abortError() {
  const error = new Error('FEA solve cancelled');
  error.name = 'AbortError';
  return error;
}

function plainWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((warning) => warning && warning.msg)
    .map((warning) => ({ code: warning.code || 'modal', msg: String(warning.msg) }));
}

function peakBytes(memory, volume) {
  const feaBytes = memory && memory.buffer ? memory.buffer.byteLength : 0;
  const meshBytes = (volume && volume.stats && volume.stats.wasmBytes) || 0;
  return feaBytes + meshBytes;
}
