// Camera aim after a face is picked as the contour sketch plane.
//
// The pose looks along the face's outward normal and frames that face, not
// the whole part. The highlight stays up during the tween and the caller
// clears it when the tween ends. Trackball is remounted at the end so
// damping cannot walk the pose back.
import { Box3, Vector3 } from 'three';
import { easeInOutCubic, fitView } from './viewCamera.js';
import {
  applyViewPose,
  captureViewPose,
  lerpPose,
  remountTrackball,
} from './featureSheetCamera.js';

export const FACE_SKETCH_TWEEN_MS = 320;
export const FACE_SKETCH_MARGIN = 1.15;

const _size = new Vector3();

/**
 * World box of the face highlight meshes. Empty when none qualify.
 * @param {Iterable<import('three').Object3D>} meshes
 * @returns {import('three').Box3|null}
 */
export function faceSketchBox(meshes) {
  const box = new Box3();
  let any = false;
  for (const mesh of meshes || []) {
    if (!mesh || (typeof mesh.updateWorldMatrix !== 'function')) continue;
    mesh.updateWorldMatrix(true, true);
    const next = new Box3().setFromObject(mesh);
    if (!next || next.isEmpty() || !Number.isFinite(next.min.x) || !Number.isFinite(next.max.z)) continue;
    if (!any) box.copy(next);
    else box.union(next);
    any = true;
  }
  if (!any) return null;
  box.getSize(_size);
  if (!(_size.lengthSq() > 1e-12)) return null;
  return box;
}

/**
 * Pose that looks along `normal` (target → camera) and frames `box`.
 * The clone drops any feature-card view offset so the face is centered.
 * @returns {object|null}
 */
export function faceSketchPose({ camera, controls, box, normal, margin = FACE_SKETCH_MARGIN }) {
  if (!camera || !box || box.isEmpty()) return null;
  const n = Array.isArray(normal) ? normal : null;
  if (!n || n.length < 3) return null;
  const dir = new Vector3(Number(n[0]), Number(n[1]), Number(n[2]));
  if (!(dir.lengthSq() > 1e-12)) return null;
  dir.normalize();
  const clone = camera.clone();
  if (clone.view?.enabled && typeof clone.clearViewOffset === 'function') {
    const aspect = clone.aspect;
    clone.clearViewOffset();
    clone.aspect = aspect;
    clone.updateProjectionMatrix();
  }
  const fake = {
    target: controls?.target?.clone?.() || new Vector3(),
    update() { clone.lookAt(this.target); },
  };
  const ok = fitView({
    camera: clone,
    controls: fake,
    box,
    dir: [dir.x, dir.y, dir.z],
    up: [0, 0, 1],
    margin,
  });
  if (!ok) return null;
  return captureViewPose(clone, fake);
}

/**
 * Tween the live camera onto a face-sketch pose. A later aim cancels the
 * earlier finish. `prefers-reduced-motion` jumps, then finishes.
 */
export function createFaceSketchAim({
  getCamera,
  getControls,
  setControls,
  remountControls = remountTrackball,
  reducedMotion = () => false,
  now = () => performance.now(),
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
  tweenMs = FACE_SKETCH_TWEEN_MS,
  onDone = () => {},
} = {}) {
  let generation = 0;
  let animating = false;
  let frame = 0;

  function cancel() {
    generation += 1;
    animating = false;
    if (frame) {
      cancelFrame(frame);
      frame = 0;
    }
  }

  function aim({ box, normal, margin } = {}) {
    const camera = getCamera?.();
    const controls = getControls?.();
    if (!camera || !controls?.target) return false;
    const pose = faceSketchPose({ camera, controls, box, normal, margin });
    if (!pose) return false;
    generation += 1;
    const gen = generation;
    if (frame) {
      cancelFrame(frame);
      frame = 0;
    }
    animating = true;
    const from = captureViewPose(camera, controls);
    const started = now();
    const ms = Math.max(0, Number(tweenMs) || FACE_SKETCH_TWEEN_MS);
    const reduced = reducedMotion() === true;

    const step = (tNow) => {
      if (gen !== generation) return;
      const cam = getCamera?.();
      const ctl = getControls?.();
      if (!cam || !ctl?.target) {
        animating = false;
        frame = 0;
        return;
      }
      const raw = reduced || ms <= 0 ? 1 : Math.min(1, (tNow - started) / ms);
      const t = raw >= 1 ? 1 : easeInOutCubic(raw);
      if (t >= 1) applyViewPose(cam, ctl, pose);
      else lerpPose(cam, ctl, from, pose, t);
      if (t < 1) {
        frame = requestFrame(step);
        return;
      }
      frame = 0;
      const next = remountControls(cam, ctl);
      if (next && next !== ctl) {
        applyViewPose(cam, next, pose);
        setControls?.(next);
      }
      animating = false;
      if (gen === generation) onDone();
    };

    if (reduced) {
      step(started);
      return true;
    }
    frame = requestFrame(step);
    return true;
  }

  return {
    aim,
    cancel,
    isAnimating: () => animating,
  };
}
