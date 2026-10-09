/**
 * Analyze session. Owns the open study, writes it through studyScript,
 * and runs feaClient.solve(). The desktop chip and the phone sheet both
 * read the published snapshot. This module does not post a Manifold build
 * and does not call preemptInflight.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { fingerprintsFromGeometry, paintPickFromClick } from '../utils/facePaint.js';
import { createFeaClient } from './feaClient.js';
import { composeFeaStudy, readFeaStudy } from './studyScript.js';
import {
  applyFacePick,
  customSeed,
  emptyDraft,
  freshStudy,
  highlightIndicesForStudy,
  majorityFaceId,
  meshArraysFromGeometry,
  solverRequestMaterial,
  studyFaceFromPick,
  studyWithCustomMaterial,
  studyWithMaterialId,
  studyWithoutFixture,
  studyWithoutLoad,
} from './studyPanel.js';

const listeners = new Set();
let snapshot = { open: false };
let publishedToken = '';

function publish(next, token) {
  if (token === publishedToken) return;
  publishedToken = token;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFeaPanelSnapshot() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

const FACE_ANGLE_DEG = 3;

export function useFeaStudy({
  enabled = true,
  compact = false,
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
  const studyRef = useRef(freshStudy());
  const [study, setStudy] = useState(studyRef.current);
  const [draft, setDraft] = useState(emptyDraft);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const writtenRef = useRef(null);
  const clientRef = useRef(null);
  const draftRef = useRef(draft);
  const openRef = useRef(open);
  draftRef.current = draft;
  openRef.current = open;
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

  const replaceStudy = useCallback((next) => {
    studyRef.current = next;
    setStudy(next);
    setResult(null);
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
    setOpen(false);
    onHighlightRef.current?.([]);
  }, []);

  const openPanel = useCallback(() => {
    if (!enabled) return;
    onClaimRef.current?.();
    const text = typeof getScriptRef.current === 'function' ? (getScriptRef.current() || '') : '';
    const read = readFeaStudy(text) || freshStudy();
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
    setResult(null);
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
    const mesh = meshArraysFromGeometry(solid?.geometry, solid?.faceIDs);
    if (!mesh) {
      setResult({
        source: 'stub',
        min: null,
        p95: null,
        max: null,
        safetyFactor: null,
        warnings: [{ code: 'empty-mesh', msg: 'n/a' }],
      });
      setNotice('');
      return;
    }
    setRunning(true);
    setNotice('');
    try {
      if (!clientRef.current) clientRef.current = await createFeaClient();
      const solved = await clientRef.current.solve({
        study: studyRef.current,
        mesh,
        material: resolved.material,
        profile: compact ? 'phone' : 'desktop',
      });
      setResult(solved);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setNotice(err?.message || 'The study did not run');
    } finally {
      setRunning(false);
    }
  }, [compact]);

  useEffect(() => () => {
    const client = clientRef.current;
    clientRef.current = null;
    client?.dispose?.();
    publishedToken = '';
    publish({ open: false }, 'closed');
  }, []);

  const api = {
    open: !!open && !!enabled,
    study,
    draft,
    result,
    running,
    notice,
    toggle,
    close,
    setMaterialId,
    setCustomMode,
    setCustomField,
    setTarget,
    setMagnitude,
    setDirection,
    setPressure,
    removeFixture,
    removeLoad,
    pick: pickIfOpen,
    run,
  };

  const token = JSON.stringify({
    open: api.open,
    study,
    draft,
    result,
    running,
    notice,
  });

  useEffect(() => {
    publish(api, token);
    // `api` is the snapshot for this token. A matching token must not publish again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return api;
}
