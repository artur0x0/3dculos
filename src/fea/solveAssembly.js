/**
 * Multi-part solve. Bonded pairs are projection MPCs in solve_bonded.
 * Frictionless and frictional pairs are a node-to-surface penalty in
 * solve_contact, and any bonded pairs in that study are still eliminated.
 * The part matrix (or position, quaternion, and scale) is baked into the
 * surface before the tet mesh, so a rotated or scaled part meets its
 * neighbour. The sampled field stays in render-vertex order.
 *
 * The phone mesh cache holds one entry. Both volumes live on that one
 * entry so the first mesh is not released while the second is built.
 * The phone DOF cap is split across the parts when the edge length is chosen.
 */

import { packProbeSurface } from './probeSample.js';
import { boundaryConditions } from './boundaryConditions.js';
import { buildTiePayload } from './bondedTies.js';
import { buildContactPayload, contactFaceIds, frictionalStudy } from './contactPairs.js';
import { contactTolerance } from './contactDetect.js';
import {
  chooseEdgeLength,
  chooseSolver,
  dofCap,
  frictionDofCap,
  isThinPart,
  partShape,
  THIN_ELEMENTS_THROUGH,
} from './deviceProfile.js';
import { placementMatrix, placeStudy, transformPositions } from './partTransform.js';
import { solverRequestMaterial } from './studyPanel.js';
import {
  fieldRange,
  sampleContactPressure,
  sampleSurfaceDisplacement,
  sampleSurfaceStress,
} from './stressSample.js';
import { PHONE_WASM_BYTES } from './wasmMemory.js';
import { releaseCachedMesh } from './solveSolid.js';

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

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function offsetIds(ids, offset) {
  const out = new Uint32Array(ids.length);
  for (let i = 0; i < ids.length; i += 1) out[i] = ids[i] + offset;
  return out;
}

function facesForBody(faces, partId, hostId) {
  return (faces || []).filter((face) => {
    if (face && face.part) return String(face.part) === String(partId);
    return String(partId) === String(hostId);
  });
}

function studyForBody(study, partId, hostId) {
  const mapEntry = (entry) => ({
    ...entry,
    faces: facesForBody(entry && entry.faces, partId, hostId),
  });
  return {
    ...study,
    fixtures: (study.fixtures || []).map(mapEntry).filter((entry) => entry.faces.length),
    loads: (study.loads || []).map(mapEntry).filter((entry) => entry.faces.length),
  };
}

function minEdge(positions, indices) {
  let shortest = Infinity;
  const triangles = Math.floor((indices?.length || 0) / 3);
  for (let t = 0; t < triangles; t += 1) {
    const ids = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    const p = ids.map((id) => [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]]);
    for (let k = 0; k < 3; k += 1) {
      const a = p[k];
      const b = p[(k + 1) % 3];
      const edge = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (edge > 0 && edge < shortest) shortest = edge;
    }
  }
  return Number.isFinite(shortest) ? shortest : 0;
}

function takeAssemblyEntry(cache, key, releaseMesh) {
  if (!cache?.entries || !key) return null;
  const index = cache.entries.findIndex((item) => item && item.key === key);
  if (index < 0) return null;
  const [entry] = cache.entries.splice(index, 1);
  const meshes = entry?.meshes;
  if (!Array.isArray(meshes) || !meshes.length || meshes.some((mesh) => !mesh?.nodes)) {
    releaseCachedMesh(entry, releaseMesh);
    return null;
  }
  cache.entries.push(entry);
  return entry;
}

function evictAssembly(cache, limit, releaseMesh) {
  const cap = limit > 0 ? limit : 1;
  while (cache.entries.length >= cap) releaseCachedMesh(cache.entries.shift(), releaseMesh);
}

function assemblyCacheKey(parts, study, profile, tools) {
  const target = study && study.mesh ? study.mesh.target : undefined;
  const device = profile === 'phone' ? 'phone' : 'desktop';
  const bodies = parts.map((part) => {
    const meshKey = tools.meshCacheKey(
      { positions: part.positions, indices: part.indices, faceIDs: part.faceIDs },
      target,
      device,
    );
    return meshKey;
  }).join('||');
  const law = frictionalStudy(study) ? 'friction' : 'bonded';
  return `${bodies}||${law}`;
}

function scatterContactPressure(solved, total) {
  const pressure = new Float64Array(total);
  pressure.fill(NaN);
  const ids = solved?.contactNode;
  const values = solved?.contactPressure;
  const empty = { pressure, open: 0, stick: 0, slip: 0, min: 0, max: 0 };
  if (!ids || !values) return empty;
  const masters = solved.contactMasters;
  const weights = solved.contactWeights;
  const status = solved.contactStatus;
  let open = 0;
  let stick = 0;
  let slip = 0;
  let min = Infinity;
  let max = -Infinity;
  let closed = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const value = values[i];
    const code = status ? Number(status[i]) : 0;
    if (code === 1) stick += 1;
    else if (code === 2) slip += 1;
    else open += 1;
    if (id < total && Number.isFinite(value)) pressure[id] = value;
    if (code !== 0 && Number.isFinite(value)) {
      closed += 1;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!masters || !weights) continue;
    for (let k = 0; k < 6; k += 1) {
      const weight = weights[i * 6 + k];
      const master = masters[i * 6 + k];
      if (!(Math.abs(weight) > 1e-8) || master >= total) continue;
      if (!Number.isFinite(pressure[master]) && Number.isFinite(value)) pressure[master] = value;
    }
  }
  return { pressure, open, stick, slip, min: closed ? min : 0, max: closed ? max : 0 };
}

function plainWarnings(list) {
  if (!Array.isArray(list)) return [];
  return list.map((warning) => ({
    code: warning && warning.code ? String(warning.code) : 'warning',
    msg: warning && warning.msg ? String(warning.msg) : '',
  })).filter((warning) => warning.msg);
}

/**
 * `parts` are local `{ id, name, positions, indices, faceIDs }` plus a
 * placement: `matrix` (column-major 4x4), or `position` / `quaternion` /
 * `scale`. `translation` is the position-only form.
 * `solveBonded` is the wasm export. `cache` is the worker mesh cache.
 */
export async function solveAssembly({
  study,
  parts,
  profile,
  solveBonded,
  solveContact,
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
  if (typeof solveBonded !== 'function') {
    throw new Error('Bonded contact is not in this FEA build.');
  }
  const bodies = (Array.isArray(parts) ? parts : []).filter((part) => part && part.positions?.length).map((part) => {
    const matrix = placementMatrix(part);
    if (!matrix) return { ...part, matrix: null };
    return { ...part, matrix, positions: transformPositions(part.positions, matrix) };
  });
  if (bodies.length < 1) throw new Error('The study has no parts to mesh.');
  if (cancelled()) throw abortError();

  const hostId = String(bodies[0].id);
  const warnings = [];
  const materials = [];
  for (const part of bodies) {
    const stored = (study?.parts || []).find((row) => String(row.id) === String(part.id));
    const resolved = solverRequestMaterial({ material: stored?.material || study.material });
    if (!resolved.ok) throw new Error(resolved.errors[0] || `Pick a material for ${part.name || part.id}`);
    materials.push(resolved.material);
    warnings.push(...(resolved.warnings || []));
  }

  progress({ stage: 'loading-mesher' });
  await yieldTurn();
  const tools = await import('./meshVolume.js');
  const loadMesh = meshVolume || tools.meshVolume;
  const device = profile === 'phone' ? 'phone' : 'desktop';
  const cacheKey = cache ? assemblyCacheKey(bodies, study, device, tools) : '';
  let entry = cache ? takeAssemblyEntry(cache, cacheKey, tools.releaseMesh) : null;
  let volumes = entry?.meshes || null;
  let meshReused = false;
  const started = Date.now();
  const timings = { meshing: 0, assembling: 0, solving: 0 };

  const shapes = bodies.map((part) => partShape(part.positions, part.indices));
  const thin = shapes.some((shape) => isThinPart(shape));
  const solver = chooseSolver(shapes[0] || {});
  const frictional = frictionalStudy(study);
  const cap = frictional ? frictionDofCap(profile, thin) : dofCap(profile, thin, solver);
  const share = Number.isFinite(cap) ? cap / bodies.length : cap;
  const target = study && study.mesh ? study.mesh.target : undefined;

  if (volumes && volumes.length === bodies.length) {
    meshReused = true;
    timings.meshing = 0;
    progress({ stage: 'meshing', fraction: 1 });
  } else {
    entry = null;
    if (cache) evictAssembly(cache, tools.meshCacheLimit(device), tools.releaseMesh);
    volumes = [];
    const ceiling = profile === 'phone' ? PHONE_WASM_BYTES : 0;
    const meshStarted = Date.now();
    for (let i = 0; i < bodies.length; i += 1) {
      if (cancelled()) throw abortError();
      const shape = shapes[i];
      if (!(shape.volume > 0)) throw new Error(`${bodies[i].name || bodies[i].id} has no solid volume to mesh.`);
      const edge = chooseEdgeLength(shape, target, share);
      if (edge.coarsened) {
        const short = edge.elementsThrough != null && edge.elementsThrough < THIN_ELEMENTS_THROUGH;
        const throughText = short
          ? ` That is coarser than ${THIN_ELEMENTS_THROUGH} elements through the ${edge.wallMm.toFixed(2)} mm wall.`
          : '';
        const why = Number.isFinite(cap)
          ? (frictional
            ? `The phone frictional contact cap (${cap} DOF) is split across ${bodies.length} parts, so the edge is ${edge.edgeLength.toFixed(2)} mm.`
            : `The phone DOF cap (${cap}) is split across ${bodies.length} parts, so the edge is ${edge.edgeLength.toFixed(2)} mm.`)
          : `A ${edge.requested.toFixed(2)} mm edge does not fit, so the mesh keeps ${edge.edgeLength.toFixed(2)} mm edges.`;
        warnings.push({
          code: 'mesh-coarse',
          msg: `${bodies[i].name || bodies[i].id}: ${why}${throughText}`,
        });
      }
      progress({ stage: 'meshing', fraction: i / bodies.length });
      await yieldTurn();
      let volume;
      try {
        volume = await loadMesh(
          { positions: bodies[i].positions, indices: bodies[i].indices, faceIds: bodies[i].faceIDs },
          {
            edgeLength: edge.edgeLength,
            epsilon: 1e-3,
            maxTets: 0,
            memoryCeilingBytes: ceiling,
            onProgress: (update) => progress({ stage: 'meshing', ...(update || {}) }),
          },
        );
      } catch (err) {
        for (const mesh of volumes) tools.releaseMesh(mesh);
        throw err;
      }
      volumes.push(volume);
      if (typeof noteMemory === 'function') noteMemory(volume);
    }
    timings.meshing = Date.now() - meshStarted;
    if (cancelled()) {
      for (const volume of volumes) tools.releaseMesh(volume);
      throw abortError();
    }
    if (cache) {
      entry = { key: cacheKey, meshes: volumes, solution: null };
      cache.entries.push(entry);
    }
  }

  progress({ stage: 'assembling' });
  await yieldTurn();
  if (cancelled()) throw abortError();
  const assembleStarted = Date.now();

  const prepared = [];
  let nodeOffset = 0;
  const fixedNodes = [];
  const forceNodes = [];
  const forceValues = [];
  const pressureFaces = [];
  const pressures = [];
  let anyFixed = false;
  for (let i = 0; i < bodies.length; i += 1) {
    const local = volumes[i];
    const count = local.nodes.length / 3;
    const scoped = placeStudy(studyForBody(study, bodies[i].id, hostId), bodies[i].matrix);
    if (scoped.fixtures.length || scoped.loads.length) {
      const bcs = boundaryConditions(local, scoped, { diagonal: shapes[i].diagonal });
      warnings.push(...bcs.warnings);
      if (bcs.fixedNodes.length) anyFixed = true;
      for (let n = 0; n < bcs.fixedNodes.length; n += 1) fixedNodes.push(bcs.fixedNodes[n] + nodeOffset);
      for (let n = 0; n < bcs.forceNodes.length; n += 1) {
        forceNodes.push(bcs.forceNodes[n] + nodeOffset);
        forceValues.push(bcs.forceValues[n * 3], bcs.forceValues[n * 3 + 1], bcs.forceValues[n * 3 + 2]);
      }
      const shiftedFaces = offsetIds(bcs.pressureFaces, nodeOffset);
      for (let n = 0; n < shiftedFaces.length; n += 1) pressureFaces.push(shiftedFaces[n]);
      for (let n = 0; n < bcs.pressures.length; n += 1) pressures.push(bcs.pressures[n]);
    }
    prepared.push({
      id: String(bodies[i].id),
      name: bodies[i].name || bodies[i].id,
      nodeOffset,
      nodeCount: count,
      mesh: local,
      material: materials[i],
      worldNodes: local.nodes,
    });
    nodeOffset += count;
  }
  if (!anyFixed) throw new Error('Fix a face before running the study.');

  let shortest = Infinity;
  for (const part of bodies) {
    const edge = minEdge(part.positions, part.indices);
    if (edge > 0 && edge < shortest) shortest = edge;
  }
  const gap = contactTolerance(Number.isFinite(shortest) ? shortest : 0);
  const ties = buildTiePayload(prepared, study?.contacts || [], gap);
  const surfaces = buildContactPayload(prepared, study?.contacts || [], gap);
  if (frictional && !surfaces.length) {
    throw new Error('The frictional pair has no mesh faces to contact.');
  }
  timings.assembling = Date.now() - assembleStarted;

  const bcPayload = { fixedNodes: Uint32Array.from(fixedNodes) };
  if (forceNodes.length) {
    bcPayload.forceNodes = Uint32Array.from(forceNodes);
    bcPayload.forceValues = Float64Array.from(forceValues);
  }
  if (pressureFaces.length) {
    bcPayload.pressureFaces = Uint32Array.from(pressureFaces);
    bcPayload.pressures = Float64Array.from(pressures);
  }

  progress({
    stage: 'solving',
    solver,
    blocking: true,
    fraction: solver === 'cholesky' ? 0.5 : undefined,
  });
  await yieldTurn();
  if (cancelled()) throw abortError();
  const solveStarted = Date.now();
  const meshPayload = {
    bodies: prepared.map((body) => ({
      nodes: body.worldNodes,
      elements: body.mesh.elements,
      material: {
        E_MPa: body.material.E_MPa,
        nu: body.material.nu,
        yield_MPa: body.material.yield_MPa,
      },
    })),
    ties,
  };
  let solved;
  if (surfaces.length) {
    if (typeof solveContact !== 'function') {
      throw new Error('Frictional contact is not in this FEA build.');
    }
    meshPayload.contacts = surfaces;
    solved = solveContact(meshPayload, bcPayload, { solver });
  } else {
    solved = solveBonded(meshPayload, bcPayload, { solver });
  }
  timings.solving = Date.now() - solveStarted;
  if (typeof noteMemory === 'function') noteMemory(volumes[volumes.length - 1]);
  if (cancelled()) throw abortError();

  progress({ stage: 'post-processing', fraction: 0.9 });
  const postStarted = Date.now();
  const nodalAll = Float64Array.from(solved.nodal);
  const dispAll = solved.displacement;
  const contactField = surfaces.length ? scatterContactPressure(solved, nodeOffset) : null;
  const partStats = [];
  const sampledParts = [];
  let displacementMin = null;
  let displacementMax = null;
  for (let i = 0; i < prepared.length; i += 1) {
    const body = prepared[i];
    const offset = solved.partNodeOffset && solved.partNodeOffset.length > i
      ? Number(solved.partNodeOffset[i])
      : body.nodeOffset;
    const count = solved.partNodeCount && solved.partNodeCount.length > i
      ? Number(solved.partNodeCount[i])
      : body.nodeCount;
    const localNodal = nodalAll.subarray(offset, offset + count);
    const stress = sampleSurfaceStress(
      bodies[i].positions,
      bodies[i].indices,
      bodies[i].faceIDs,
      body.mesh,
      localNodal,
    );
    let displacement = null;
    if (dispAll && dispAll.length >= (offset + count) * 3) {
      const localDisp = dispAll.subarray(offset * 3, (offset + count) * 3);
      displacement = sampleSurfaceDisplacement(
        bodies[i].positions,
        bodies[i].indices,
        bodies[i].faceIDs,
        body.mesh,
        localDisp,
      );
      const range = fieldRange(displacement);
      if (range.min != null) displacementMin = displacementMin == null ? range.min : Math.min(displacementMin, range.min);
      if (range.max != null) displacementMax = displacementMax == null ? range.max : Math.max(displacementMax, range.max);
    }
    let contact = null;
    if (contactField) {
      const localContact = contactField.pressure.subarray(offset, offset + count);
      contact = sampleContactPressure(
        bodies[i].positions,
        bodies[i].indices,
        bodies[i].faceIDs,
        body.mesh,
        localContact,
        contactFaceIds(study, body.id),
      );
    }
    const p95 = solved.partP95 && solved.partP95.length > i ? asNumber(solved.partP95[i]) : null;
    const safety = solved.partSafety && solved.partSafety.length > i ? asNumber(solved.partSafety[i]) : null;
    partStats.push({
      id: body.id,
      name: body.name,
      p95,
      min: solved.partMin && solved.partMin.length > i ? asNumber(solved.partMin[i]) : null,
      max: solved.partMax && solved.partMax.length > i ? asNumber(solved.partMax[i]) : null,
      safetyFactor: safety,
      yield_MPa: body.material.yield_MPa ?? null,
    });
    const contactIds = contactField ? contactFaceIds(study, body.id) : null;
    sampledParts.push({
      id: body.id,
      nodal: stress,
      displacement,
      contact,
      probe: packProbeSurface(body.mesh, {
        stress: localNodal,
        displacement: dispAll && dispAll.length >= (offset + count) * 3
          ? dispAll.subarray(offset * 3, (offset + count) * 3)
          : null,
        contact: contactField ? contactField.pressure.subarray(offset, offset + count) : null,
        contactFaces: contactIds ? [...contactIds] : null,
      }, 'world'),
    });
  }
  const govIndex = solved.governingPart == null ? -1 : Number(solved.governingPart);
  const governing = Number.isInteger(govIndex) && partStats[govIndex] ? partStats[govIndex] : null;
  warnings.push(...plainWarnings(solved.warnings));
  timings['post-processing'] = Date.now() - postStarted;
  const solvedStats = solved.stats || {};
  const dofs = solvedStats.dofs != null ? solvedStats.dofs : nodeOffset * 3;
  progress({ stage: 'post-processing', fraction: 1, dofs });

  const first = sampledParts[0] || {};
  const factor = solved.safetyFactor != null ? asNumber(solved.safetyFactor) : (solved.fos != null ? asNumber(solved.fos) : null);
  return {
    source: 'tet10',
    field: 'von_mises',
    units: 'MPa',
    nodal: first.nodal || null,
    displacement: first.displacement || null,
    displacementMin,
    displacementMax,
    min: asNumber(solved.min),
    max: asNumber(solved.max),
    p95: asNumber(solved.p95),
    safetyFactor: factor,
    fos: factor,
    warnings,
    solver: solved.solver || solver,
    meshReused,
    rescaled: false,
    bonded: true,
    contactActive: !!contactField,
    contactOpen: contactField ? contactField.open : 0,
    contactStick: contactField ? contactField.stick : 0,
    contactSlip: contactField ? contactField.slip : 0,
    contactPressureMin: contactField ? contactField.min : null,
    contactPressureMax: contactField ? contactField.max : null,
    contactIterations: contactField && solvedStats.contactIterations != null
      ? solvedStats.contactIterations
      : null,
    governingPart: governing ? governing.id : null,
    governingName: governing ? governing.name : null,
    partStats,
    parts: sampledParts,
    stageTimings: {
      ...(meshReused ? { 'loading-mesher': 0 } : {}),
      meshing: timings.meshing,
      assembling: timings.assembling,
      solving: timings.solving,
      'post-processing': timings['post-processing'],
    },
    stats: {
      dofs,
      freeDofs: solvedStats.freeDofs != null ? solvedStats.freeDofs : 0,
      ms: Date.now() - started,
      meshMs: meshReused ? 0 : timings.meshing,
      solveMs: solvedStats.solveMs != null ? solvedStats.solveMs : timings.solving,
      elements: volumes.reduce((sum, volume) => sum + (volume.stats?.elements || 0), 0),
      peakMemoryBytes: typeof peakMemory === 'function' ? peakMemory() : (memory?.buffer?.byteLength || 0),
      wasmMemoryMaxBytes: profile === 'phone' ? PHONE_WASM_BYTES : null,
      missedSlaves: solvedStats.missedSlaves != null ? solvedStats.missedSlaves : 0,
    },
  };
}
