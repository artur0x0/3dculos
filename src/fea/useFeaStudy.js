/**
 * Analyze session. Owns the open study, writes it through studyScript,
 * and runs feaClient.solve(). The desktop chip and the phone sheet both
 * read the panel this hook returns. This module does not post a Manifold build
 * and does not call preemptInflight.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fingerprintsFromGeometry, paintPickFromClick } from '../utils/facePaint.js';
import { boundingBox, detectFeaProfile } from './deviceProfile.js';
import { createFeaClient } from './feaClient.js';
import { initialFeaProgress, logFeaTiming, reduceFeaProgress } from './feaProgress.js';
import { studyForSolve } from './renderFaceIds.js';
import { shellSheetFromScript } from './sheetMidsurface.js';
import { activePlot, showResults } from './resultsView.js';
import { bindStressField, setStressSkinSource } from './stressMap.js';
import { composeFeaStudy, readFeaStudy, scriptOutsideFeaStudy } from './studyScript.js';
import {
  applyFacePick,
  customSeed,
  emptyDraft,
  freshStudy,
  highlightIndicesForStudy,
  libraryOptions,
  majorityFaceId,
  meshArraysFromGeometry,
  solverRequestMaterial,
  studyFaceFromPick,
  studyWithCustomMaterial,
  studyWithLoadVector,
  studyWithMaterialId,
  studyWithRefine,
  studyWithoutFixture,
  studyWithoutLoad,
} from './studyPanel.js';
import { sliderFromLoad, studyForPreview } from './preview/loadDrag.js';
import { createPreviewController } from './preview/previewController.js';
import { previewFits } from './preview/resolution.js';
import { probePreviewGpu, runGpuPreview } from './preview/webgpuPreview.js';

const FACE_ANGLE_DEG = 3;

function commitRunReport(prev, event) {
  const next = reduceFeaProgress(prev, event);
  if (next !== prev && prev.status !== next.status && (next.status === 'done' || next.status === 'stopped')) {
    logFeaTiming(next);
  }
  return next;
}

const EMPTY_PREVIEW = {
  available: false,
  showing: false,
  loadIndex: 0,
  magnitude: 200,
  angle: 0,
  materialIndex: 0,
  ms: null,
  bytes: null,
  resolution: null,
  nx: 0,
  ny: 0,
  nz: 0,
  min: null,
  p95: null,
  max: null,
  fast: false,
};

export function useFeaStudy({
  enabled = true,
  compact: _ = false,
  paintOpen = false,
  getScript,
  script = '',
  onCommit,
  assemblyLocked,
  getSolid,
  onHighlight,
  onClaim,
}) {
  const [open, setOpen] = useState(false);
  const studyRef = useRef(freshStudy(detectFeaProfile()));
  const [study, setStudy] = useState(studyRef.current);
  const [draft, setDraft] = useState(emptyDraft);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [runReport, setRunReport] = useState(() => initialFeaProgress());
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(EMPTY_PREVIEW);
  const [plot, setPlotState] = useState('stress');
  const [dismissed, setDismissed] = useState(false);
  const writtenRef = useRef(null);
  const clientRef = useRef(null);
  const runAbortRef = useRef(null);
  const stressFieldRef = useRef(null);
  const displacementFieldRef = useRef(null);
  const solvedOutsideRef = useRef(null);
  const markStaleRef = useRef(() => {});
  const draftRef = useRef(draft);
  const openRef = useRef(open);
  const previewRef = useRef(preview);
  const previewDragRef = useRef(false);
  const materialDirtyRef = useRef(false);
  const previewFieldRef = useRef(null);
  const previewNodalRef = useRef(null);
  const previewMeshRef = useRef(null);
  const previewRebindRef = useRef(false);
  const gpuRef = useRef(null);
  const controllerRef = useRef(null);
  const applyPreviewRef = useRef(() => {});
  draftRef.current = draft;
  openRef.current = open;
  previewRef.current = preview;
  const getScriptRef = useRef(getScript);
  const onCommitRef = useRef(onCommit);
  const lockedRef = useRef(assemblyLocked);
  const getSolidRef = useRef(getSolid);
  const onHighlightRef = useRef(onHighlight);
  const onClaimRef = useRef(onClaim);
  getScriptRef.current = getScript;
  onCommitRef.current = onCommit;
  lockedRef.current = assemblyLocked;
  getSolidRef.current = getSolid;
  onHighlightRef.current = onHighlight;
  onClaimRef.current = onClaim;

  const clearFields = () => {
    stressFieldRef.current = null;
    displacementFieldRef.current = null;
  };

  markStaleRef.current = () => {
    clearFields();
    setResult((prev) => (prev && !prev.stale ? { ...prev, stale: true } : prev));
  };

  const rebindPreview = useCallback(() => {
    if (previewRebindRef.current) return;
    const nodal = previewNodalRef.current;
    const solid = getSolidRef.current?.();
    const geometry = solid?.geometry;
    if (!nodal || !geometry || geometry === previewFieldRef.current?.geometry) return;
    const positions = geometry.attributes?.position?.array;
    const verts = positions ? positions.length / 3 : 0;
    if (verts && nodal.length !== verts) {
      previewFieldRef.current = null;
      setPreview((prev) => (prev.showing ? { ...prev, showing: false } : prev));
      return;
    }
    const bound = bindStressField(geometry, nodal, solid.faceIDs);
    if (!bound) return;
    const source = {
      geometry,
      field: bound,
      scale: previewFieldRef.current?.scale || { p95: null, yield_MPa: null },
      onStale: () => rebindPreview(),
    };
    previewRebindRef.current = true;
    previewFieldRef.current = source;
    setStressSkinSource(source);
    previewRebindRef.current = false;
  }, []);

  applyPreviewRef.current = (result) => {
    if (!openRef.current || !result?.nodal) return;
    const mesh = previewMeshRef.current;
    const solid = getSolidRef.current?.();
    const geometry = solid?.geometry || mesh?.geometry;
    const faceIDs = solid?.faceIDs || mesh?.faceIDs;
    if (!geometry) return;
    const bound = bindStressField(geometry, result.nodal, faceIDs);
    if (!bound) return;
    previewNodalRef.current = result.nodal;
    const source = {
      geometry,
      field: bound,
      scale: { p95: result.p95, yield_MPa: mesh?.yieldMPa ?? null },
      onStale: () => rebindPreview(),
    };
    previewFieldRef.current = source;
    setStressSkinSource(source);
    setPreview((prev) => ({
      ...prev,
      showing: true,
      ms: result.ms,
      bytes: result.bytes,
      resolution: result.resolution,
      nx: result.nx,
      ny: result.ny,
      nz: result.nz,
      min: result.min,
      p95: result.p95,
      max: result.max,
      fast: result.fast === true,
    }));
  };

  const previewJob = useCallback(() => {
    const solid = getSolidRef.current?.();
    const mesh = meshArraysFromGeometry(solid?.geometry, solid?.faceIDs);
    if (!mesh) return null;
    const state = previewRef.current;
    const options = libraryOptions();
    const currentId = studyRef.current?.material?.id || '';
    const pickedId = state.materialIndex >= 0 ? (options[state.materialIndex]?.id || '') : '';
    const materialId = materialDirtyRef.current ? pickedId : currentId;
    const drafted = studyForPreview(studyRef.current, {
      loadIndex: state.loadIndex,
      magnitude: state.magnitude,
      angle: state.angle,
      materialId,
    });
    if (!drafted) return null;
    const resolved = solverRequestMaterial(drafted);
    if (!resolved.ok) return null;
    previewMeshRef.current = {
      geometry: solid.geometry,
      faceIDs: solid.faceIDs,
      yieldMPa: resolved.material.yield_MPa ?? null,
    };
    return {
      positions: mesh.positions,
      indices: mesh.indices,
      faceIDs: mesh.faceIDs,
      study: drafted,
      material: resolved.material,
      bbox: boundingBox(mesh.positions),
    };
  }, []);

  const replaceStudy = useCallback((next) => {
    studyRef.current = next;
    setStudy(next);
    // Material, fixture, and load edits all come through here. The last
    // colours belong to the previous study, so they come off.
    clearFields();
    setResult((prev) => (prev && !prev.stale ? { ...prev, stale: true } : prev));
  }, []);

  const paintHighlight = useCallback((next) => {
    const solid = getSolidRef.current?.();
    const faces = fingerprintsFromGeometry(solid?.geometry, solid?.faceIDs);
    onHighlightRef.current?.(highlightIndicesForStudy(faces, next));
  }, []);

  const commitStudy = useCallback((next) => {
    replaceStudy(next);
    paintHighlight(next);
    const base = typeof getScriptRef.current === 'function' ? (getScriptRef.current() || '') : '';
    let composed;
    try {
      composed = composeFeaStudy(base, next);
    } catch (err) {
      setNotice(err?.message || 'Could not write the study');
      return false;
    }
    if (composed === base) return true;
    if (lockedRef.current?.()) {
      setNotice('An assembly is opening — save the study again once it finishes.');
      return false;
    }
    writtenRef.current = composed;
    const wrote = onCommitRef.current?.(composed);
    if (wrote === false) {
      writtenRef.current = null;
      setNotice('Could not write the study into the part script.');
      return false;
    }
    setNotice('');
    return true;
  }, [paintHighlight, replaceStudy]);

  const close = useCallback(() => {
    previewDragRef.current = false;
    controllerRef.current?.cancel();
    previewFieldRef.current = null;
    previewNodalRef.current = null;
    setPreview((prev) => ({ ...prev, showing: false }));
    setOpen(false);
    onHighlightRef.current?.([]);
  }, []);

  const openPanel = useCallback(() => {
    if (!enabled) return;
    onClaimRef.current?.();
    const text = typeof getScriptRef.current === 'function' ? (getScriptRef.current() || '') : '';
    const read = readFeaStudy(text) || freshStudy(detectFeaProfile());
    writtenRef.current = text.includes('// @fea-study ') ? text : null;
    studyRef.current = read;
    setStudy(read);
    setDraft((prev) => ({
      ...emptyDraft(),
      target: prev.target,
      magnitudeN: prev.magnitudeN,
      direction: prev.direction,
      pressureMPa: prev.pressureMPa,
      customMode: !read.material?.id,
      custom: customSeed(read),
    }));
    clearFields();
    previewFieldRef.current = null;
    previewNodalRef.current = null;
    previewDragRef.current = false;
    solvedOutsideRef.current = null;
    setPlotState('stress');
    setDismissed(false);
    setResult(null);
    setRunReport(initialFeaProgress());
    setPreview((prev) => ({ ...EMPTY_PREVIEW, available: prev.available }));
    setNotice('');
    setOpen(true);
    paintHighlight(read);
  }, [enabled, paintHighlight]);

  const toggle = useCallback(() => {
    if (open) close();
    else openPanel();
  }, [close, open, openPanel]);

  useEffect(() => {
    if (!enabled && open) close();
  }, [close, enabled, open]);

  useEffect(() => {
    if (paintOpen && open) close();
  }, [close, open, paintOpen]);

  useEffect(() => {
    if (!open) return;
    const text = typeof script === 'string' ? script : '';
    if (writtenRef.current != null && text === writtenRef.current) return;
    const live = typeof getScriptRef.current === 'function' ? (getScriptRef.current() || '') : text;
    if (writtenRef.current != null && live === writtenRef.current) return;
    const outside = scriptOutsideFeaStudy(live);
    if (solvedOutsideRef.current != null && outside !== solvedOutsideRef.current) {
      solvedOutsideRef.current = outside;
      clearFields();
      setResult((prev) => (prev && !prev.stale ? { ...prev, stale: true } : prev));
    }
    const read = readFeaStudy(live);
    if (!read) return;
    studyRef.current = read;
    setStudy(read);
    paintHighlight(read);
  }, [open, paintHighlight, script]);

  const setMaterialId = useCallback((id) => {
    const next = studyWithMaterialId(studyRef.current, id);
    if (!next.ok) {
      setNotice(next.errors[0] || 'Unknown material');
      return;
    }
    setDraft((prev) => ({ ...prev, customMode: false }));
    commitStudy(next.study);
  }, [commitStudy]);

  const setCustomMode = useCallback((on) => {
    setDraft((prev) => ({
      ...prev,
      customMode: !!on,
      custom: on ? customSeed(studyRef.current) : prev.custom,
    }));
    if (!on && studyRef.current.material && !studyRef.current.material.id) {
      const next = studyWithMaterialId(studyRef.current, 'al-6061-t6');
      if (next.ok) commitStudy(next.study);
    }
  }, [commitStudy]);

  const setCustomField = useCallback((field, value) => {
    const custom = { ...draftRef.current.custom, [field]: value };
    setDraft((prev) => ({ ...prev, customMode: true, custom }));
    const next = studyWithCustomMaterial(studyRef.current, custom);
    if (next.ok) commitStudy(next.study);
    else setNotice(next.errors[0] || 'Enter E, ν, and yield');
  }, [commitStudy]);

  const setTarget = useCallback((target) => {
    setDraft((prev) => ({ ...prev, target }));
  }, []);

  const setRefine = useCallback((refine) => {
    const next = studyWithRefine(studyRef.current, refine);
    if (next.ok) commitStudy(next.study);
    else setNotice(next.errors[0] || 'Could not set refine');
  }, [commitStudy]);

  const setMagnitude = useCallback((magnitudeN) => {
    setDraft((prev) => ({ ...prev, magnitudeN: Number(magnitudeN) }));
  }, []);

  const setDirection = useCallback((direction) => {
    setDraft((prev) => ({ ...prev, direction }));
  }, []);

  const setPressure = useCallback((pressureMPa) => {
    setDraft((prev) => ({ ...prev, pressureMPa: Number(pressureMPa) }));
  }, []);

  const removeFixture = useCallback((index) => {
    const next = studyWithoutFixture(studyRef.current, index);
    if (next.ok) commitStudy(next.study);
  }, [commitStudy]);

  const removeLoad = useCallback((index) => {
    const next = studyWithoutLoad(studyRef.current, index);
    if (next.ok) commitStudy(next.study);
  }, [commitStudy]);

  const pick = useCallback((clickData) => {
    if (!studyRef.current) return false;
    const solid = getSolidRef.current?.();
    const geometry = clickData?.geometry || solid?.geometry;
    const faceIDs = solid?.faceIDs;
    const picked = paintPickFromClick({
      geometry,
      faceIDs,
      seedFaceIndex: clickData?.seedFaceIndex,
      faceNormal: clickData?.faceNormal,
      angleTolerance: FACE_ANGLE_DEG,
    });
    if (!picked?.key) return false;
    const face = studyFaceFromPick(picked, majorityFaceId(picked.indices, faceIDs));
    if (!face) return false;
    const next = applyFacePick(studyRef.current, draftRef.current, face);
    if (!next.ok) {
      setNotice(next.errors[0] || 'Could not use that face');
      return false;
    }
    commitStudy(next.study);
    return true;
  }, [commitStudy]);

  const pickIfOpen = useCallback((clickData) => {
    if (!openRef.current) return false;
    return pick(clickData);
  }, [pick]);

  const run = useCallback(async () => {
    previewDragRef.current = false;
    controllerRef.current?.cancel();
    previewFieldRef.current = null;
    previewNodalRef.current = null;
    setPreview((prev) => (prev.showing ? { ...prev, showing: false } : prev));
    if (lockedRef.current?.()) {
      setNotice('An assembly is opening — run the study again once it finishes.');
      return;
    }
    const resolved = solverRequestMaterial(studyRef.current);
    if (!resolved.ok) {
      setNotice(resolved.errors[0] || 'Pick a material');
      return;
    }
    const solid = getSolidRef.current?.();
    const geometry = solid?.geometry || null;
    const mesh = meshArraysFromGeometry(geometry, solid?.faceIDs);
    setDismissed(false);
    if (!mesh) {
      clearFields();
      setResult({
        source: 'tet10',
        min: null,
        p95: null,
        max: null,
        safetyFactor: null,
        warnings: [{ code: 'empty-mesh', msg: 'The part has no triangles to mesh.' }],
        yield_MPa: resolved.material.yield_MPa ?? null,
        stale: false,
      });
      setNotice('');
      return;
    }
    const profile = detectFeaProfile();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const startedAt = Date.now();
    setRunReport(reduceFeaProgress(
      reduceFeaProgress(initialFeaProgress(startedAt), { type: 'start', now: startedAt }),
      { type: 'stage', stage: 'loading-mesher', now: startedAt },
    ));
    setRunning(true);
    setNotice('');
    try {
      if (!clientRef.current) clientRef.current = await createFeaClient({ profile });
      if (controller.signal.aborted) {
        const abort = new Error('FEA solve cancelled');
        abort.name = 'AbortError';
        throw abort;
      }
      const liveForShell = typeof getScriptRef.current === 'function' ? (getScriptRef.current() || '') : '';
      const solved = await clientRef.current.solve({
        study: studyForSolve(studyRef.current, geometry, solid?.faceIDs),
        mesh,
        material: resolved.material,
        profile,
        sheetSpec: shellSheetFromScript(liveForShell),
      }, {
        signal: controller.signal,
        onProgress: (event) => {
          setRunReport((prev) => commitRunReport(prev, event));
        },
      });
      const nodal = solved?.nodal instanceof Float32Array ? solved.nodal : null;
      const magnitude = solved?.displacement instanceof Float32Array ? solved.displacement : null;
      const now = getSolidRef.current?.()?.geometry;
      const moved = !geometry || now !== geometry;
      const bound = !moved && nodal ? bindStressField(geometry, nodal, solid?.faceIDs) : null;
      const dispBound = !moved && magnitude ? bindStressField(geometry, magnitude, solid?.faceIDs) : null;
      const liveScript = typeof getScriptRef.current === 'function' ? (getScriptRef.current() || '') : '';
      solvedOutsideRef.current = scriptOutsideFeaStudy(liveScript);
      const onStale = () => markStaleRef.current();
      stressFieldRef.current = bound ? {
        geometry,
        field: bound,
        scale: { p95: solved.p95, yield_MPa: resolved.material.yield_MPa },
        onStale,
      } : null;
      displacementFieldRef.current = dispBound ? {
        geometry,
        field: dispBound,
        ramp: 'displacement',
        scale: { min: solved.displacementMin, max: solved.displacementMax },
        onStale,
      } : null;
      setPlotState('stress');
      setDismissed(false);
      setResult({
        source: solved.source,
        field: solved.field,
        units: solved.units,
        min: solved.min,
        p95: solved.p95,
        max: solved.max,
        displacementMin: solved.displacementMin ?? null,
        displacementMax: solved.displacementMax ?? null,
        safetyFactor: solved.safetyFactor != null ? solved.safetyFactor : (solved.fos ?? null),
        warnings: Array.isArray(solved.warnings) ? solved.warnings : [],
        yield_MPa: resolved.material.yield_MPa ?? null,
        stale: moved || !bound,
        stats: solved.stats || null,
        solver: solved.solver || null,
      });
      setRunReport((prev) => commitRunReport(prev, {
        type: 'finish',
        now: Date.now(),
        dofs: solved?.stats?.dofs ?? null,
        stageTimings: solved?.stageTimings || null,
        meshReused: solved?.meshReused === true,
        source: solved?.source || '',
        refineCount: solved?.refineCount || 0,
        converged: solved?.converged === true,
      }));
    } catch (err) {
      if (err?.outcome === 'worker-died') {
        const dead = clientRef.current;
        clientRef.current = null;
        try { dead?.dispose?.(); } catch { /* worker already gone */ }
      }
      const outcome = err?.name === 'AbortError'
        ? 'cancelled'
        : (err?.outcome === 'worker-died' ? 'worker-died' : 'error');
      const error = outcome === 'cancelled' ? 'cancelled' : (err?.message || 'The study did not run');
      setRunReport((prev) => commitRunReport(prev, {
        type: 'stop',
        now: Date.now(),
        outcome,
        error,
      }));
    } finally {
      if (runAbortRef.current === controller) runAbortRef.current = null;
      setRunning(false);
    }
  }, []);

  const cancel = useCallback(() => {
    runAbortRef.current?.abort();
    clientRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (runReport.status !== 'running') return undefined;
    const id = setInterval(() => {
      setRunReport((prev) => reduceFeaProgress(prev, { type: 'tick', now: Date.now() }));
    }, 200);
    return () => clearInterval(id);
  }, [runReport.status]);

  const setPlot = useCallback((next) => {
    setPlotState(activePlot(next));
  }, []);

  const backToSetup = useCallback(() => {
    setPlotState('stress');
    setDismissed(true);
  }, []);

  const results = showResults({
    running,
    status: runReport.status,
    result,
    dismissed,
  });

  useEffect(() => {
    if (!open) {
      setStressSkinSource(null);
      return;
    }
    if (preview.showing && previewFieldRef.current) {
      setStressSkinSource(previewFieldRef.current);
      return;
    }
    if (!results) {
      setStressSkinSource(null);
      return;
    }
    const src = activePlot(plot) === 'displacement'
      ? displacementFieldRef.current
      : stressFieldRef.current;
    setStressSkinSource(src || null);
  }, [open, results, plot, result, preview.showing, preview.ms]);

  useEffect(() => {
    controllerRef.current = createPreviewController({
      profile: () => detectFeaProfile(),
      fits: (job) => {
        const limits = gpuRef.current?.limits;
        const box = job?.bbox;
        if (!limits || !box) return false;
        return previewFits(box.dx, box.dy, box.dz, 128, limits);
      },
      solve: (job) => runGpuPreview(gpuRef.current, {
        ...job,
        tol: job.phase === 'drag' ? 1e-3 : 1e-4,
        maxIter: job.phase === 'drag' ? 16 : 24,
      }),
      onResult: (solved) => applyPreviewRef.current(solved),
      onError: (err) => setNotice(err?.message || 'Preview failed'),
    });
    return () => controllerRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let dead = false;
    probePreviewGpu().then((hit) => {
      if (dead) return;
      gpuRef.current = hit?.ok ? hit : null;
      setPreview((prev) => ({ ...prev, available: !!hit?.ok }));
    });
    return () => {
      dead = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || previewDragRef.current) return;
    const ids = libraryOptions().map((option) => option.id);
    const slider = sliderFromLoad(study, previewRef.current.loadIndex, ids);
    setPreview((prev) => {
      if (
        prev.loadIndex === slider.loadIndex
        && prev.magnitude === slider.magnitude
        && prev.angle === slider.angle
        && prev.materialIndex === slider.materialIndex
      ) return prev;
      return { ...prev, ...slider };
    });
  }, [open, study]);

  const previewBegin = useCallback(() => {
    previewDragRef.current = true;
  }, []);

  const previewInput = useCallback((patch) => {
    if (!gpuRef.current?.ok) return;
    previewDragRef.current = true;
    if (Object.prototype.hasOwnProperty.call(patch, 'materialIndex')) materialDirtyRef.current = true;
    previewRef.current = { ...previewRef.current, ...patch };
    setPreview((prev) => ({ ...prev, ...patch }));
    const job = previewJob();
    if (!job) return;
    controllerRef.current?.push(job);
  }, [previewJob]);

  const previewCommit = useCallback(() => {
    previewDragRef.current = false;
    const state = previewRef.current;
    const options = libraryOptions();
    const materialId = options[state.materialIndex]?.id || '';
    const drafted = studyForPreview(studyRef.current, {
      loadIndex: state.loadIndex,
      magnitude: state.magnitude,
      angle: state.angle,
      materialId,
    });
    if (drafted) {
      let next = studyWithLoadVector(
        studyRef.current,
        state.loadIndex,
        drafted.loads[state.loadIndex].vector,
      );
      if (next.ok && materialDirtyRef.current && materialId) {
        next = studyWithMaterialId(next.study, materialId);
      }
      materialDirtyRef.current = false;
      if (next.ok) commitStudy(next.study);
    }
    const job = previewJob();
    if (job && gpuRef.current?.ok) controllerRef.current?.flush(job);
  }, [commitStudy, previewJob]);

  const selectPreviewLoad = useCallback((index) => {
    const ids = libraryOptions().map((option) => option.id);
    const slider = sliderFromLoad(studyRef.current, index, ids);
    previewRef.current = { ...previewRef.current, ...slider };
    setPreview((prev) => ({ ...prev, ...slider }));
  }, []);

  useEffect(() => () => {
    const client = clientRef.current;
    clientRef.current = null;
    client?.dispose?.();
    controllerRef.current?.cancel();
    openRef.current = false;
    stressFieldRef.current = null;
    displacementFieldRef.current = null;
    previewFieldRef.current = null;
    setStressSkinSource(null);
  }, []);

  const progress = running ? (runReport.stage || 'running') : '';

  const api = {
    open: !!open && !!enabled,
    study,
    draft,
    result,
    running,
    progress,
    runReport,
    notice,
    toggle,
    close,
    setMaterialId,
    setCustomMode,
    setCustomField,
    setTarget,
    refine: study?.mesh?.refine === 'off' || study?.mesh?.refine === 'auto'
      ? study.mesh.refine
      : (detectFeaProfile() === 'phone' ? 'off' : 'auto'),
    setRefine,
    setMagnitude,
    setDirection,
    setPressure,
    removeFixture,
    removeLoad,
    pick: pickIfOpen,
    run,
    cancel,
    preview,
    previewBegin,
    previewInput,
    previewCommit,
    selectPreviewLoad,
    results,
    plot: activePlot(plot),
    setPlot,
    dismissed,
    backToSetup,
  };

  return api;
}
