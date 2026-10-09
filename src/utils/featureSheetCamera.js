// Camera slide for the bottom feature card.
//
// On open, snapshot the full pose (position, target, up, quaternion, fov,
// near, far, zoom). Pan position and target together, the same way
// panViewByNdcY already does, just far enough that the selection or the
// part sits in the band above the card. Orbit and pinch stay enabled and
// are discarded on close: the camera tweens back to that snapshot, then
// TrackballControls is remounted so leftover damping cannot walk the pose
// off the snapshot along the new up vector.
import { Quaternion, Vector3 } from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { easeInOutCubic, panViewByNdcY } from './viewCamera.js';
import { applyTrackballFeel } from './trackballFeel.js';

export const FEATURE_SHEET_BAND_PAD = 0.06;
export const FEATURE_SHEET_SLIDE_MAX = 0.6;
export const FEATURE_SHEET_TWEEN_MS = 280;

const _v = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _up = new Vector3();

/**
 * NDC delta for panViewByNdcY. Positive pan moves content DOWN.
 * A point under the card needs to go UP, so the result is ≤ 0.
 * Already in the clear band, or above it: 0. Magnitude is clamped.
 *
 * @param {number} pointNdcY  NDC y of the point that must clear the card (+1 top)
 * @param {number} cardFraction  cardHeight / paneHeight, 0..1
 */
export function featureSheetSlideNdc(pointNdcY, cardFraction) {
  const y = Number(pointNdcY);
  const f = Number(cardFraction);
  if (!Number.isFinite(y) || !Number.isFinite(f)) return 0;
  const frac = Math.min(0.95, Math.max(0, f));
  const bandBottom = -1 + 2 * frac + FEATURE_SHEET_BAND_PAD;
  const bandTop = 1 - FEATURE_SHEET_BAND_PAD;
  if (y >= bandBottom && y <= bandTop) return 0;
  if (y > bandTop) return 0;
  const delta = -(bandBottom - y);
  return Math.max(-FEATURE_SHEET_SLIDE_MAX, delta);
}

/** Lowest finite NDC y drives one slide, so a box clears, not only its center. */
export function featureSheetSlideForYs(ys, cardFraction) {
  let low = Infinity;
  for (const y of ys || []) {
    if (Number.isFinite(y) && y < low) low = y;
  }
  if (!Number.isFinite(low)) return 0;
  return featureSheetSlideNdc(low, cardFraction);
}

/**
 * Pan amount that puts the lowest projected point on the clear band.
 * A 1:1 NDC estimate is short when the point is farther than the target,
 * so this searches a cloned camera. Still clamped to 0.6. Does not mutate
 * the live camera.
 */
export function featureSheetClearanceNdc({
  camera,
  controls,
  points,
  cardFraction,
  max = FEATURE_SHEET_SLIDE_MAX,
} = {}) {
  if (!camera || !controls?.target || !points?.length) return 0;
  const frac = Number(cardFraction);
  if (!Number.isFinite(frac)) return 0;
  const limit = Math.min(FEATURE_SHEET_SLIDE_MAX, Math.max(0, Number(max) || 0));
  const band = -1 + 2 * Math.min(0.95, Math.max(0, frac)) + FEATURE_SHEET_BAND_PAD;
  const live = Math.min(...selectionNdcYs(camera, points));
  if (!Number.isFinite(live) || live >= band) return 0;

  const probe = camera.clone();
  const fake = {
    target: controls.target.clone(),
    update() {},
  };
  const lowAfter = (ndc) => {
    probe.copy(camera);
    fake.target.copy(controls.target);
    if (Math.abs(ndc) > 1e-8) panViewByNdcY({ camera: probe, controls: fake, ndcY: ndc });
    probe.lookAt(fake.target);
    probe.updateMatrixWorld(true);
    const ys = selectionNdcYs(probe, points);
    let low = Infinity;
    for (const y of ys) if (y < low) low = y;
    return low;
  };

  if (!(lowAfter(-limit) >= band)) return -limit;
  let lo = 0;
  let hi = limit;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (lowAfter(-mid) >= band) hi = mid;
    else lo = mid;
  }
  return -hi;
}

/** Project world points. Points behind the camera are skipped. */
export function selectionNdcYs(camera, points) {
  const ys = [];
  if (!camera || !points) return ys;
  for (const p of points) {
    if (!p) continue;
    _v.set(p.x, p.y, p.z).project(camera);
    if (_v.z <= 1 && Number.isFinite(_v.y)) ys.push(_v.y);
  }
  return ys;
}

/**
 * Eight corners of an axis-aligned box, in world units.
 * @param {{ min: number[], max: number[] }} box
 * @param {{ x: number, y: number, z: number }|null} offset
 */
export function boxCornerPoints(box, offset = null) {
  if (!box?.min || !box?.max) return [];
  const ox = offset?.x || 0;
  const oy = offset?.y || 0;
  const oz = offset?.z || 0;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    pts.push(new Vector3(
      (i & 1 ? box.max[0] : box.min[0]) + ox,
      (i & 2 ? box.max[1] : box.min[1]) + oy,
      (i & 4 ? box.max[2] : box.min[2]) + oz,
    ));
  }
  return pts;
}

/** NDC y of the card's top edge. The card covers [-1, cardTopNdc]. */
export function featureSheetCardTopNdc(cardFraction) {
  const f = Number(cardFraction);
  const frac = Number.isFinite(f) ? Math.min(0.95, Math.max(0, f)) : 0;
  return -1 + 2 * frac;
}

export function captureViewPose(camera, controls) {
  return {
    position: camera.position.toArray(),
    up: camera.up.toArray(),
    quaternion: camera.quaternion.toArray(),
    target: controls.target.toArray(),
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    zoom: camera.zoom,
  };
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** True when two captured poses agree within epsilon (position, target, up, fov, zoom). */
export function posesMatch(a, b, eps = 1e-4) {
  if (!a || !b) return false;
  _qa.fromArray(a.quaternion);
  _qb.fromArray(b.quaternion);
  return dist3(a.position, b.position) <= eps
    && dist3(a.target, b.target) <= eps
    && dist3(a.up, b.up) <= eps
    && Math.abs(a.fov - b.fov) <= eps
    && Math.abs(a.near - b.near) <= eps
    && Math.abs(a.far - b.far) <= eps
    && Math.abs((a.zoom ?? 1) - (b.zoom ?? 1)) <= eps
    && Math.abs(_qa.angleTo(_qb)) <= 1e-3;
}

export function applyViewPose(camera, controls, pose) {
  camera.position.fromArray(pose.position);
  camera.up.fromArray(pose.up);
  camera.quaternion.fromArray(pose.quaternion);
  camera.fov = pose.fov;
  camera.near = pose.near;
  camera.far = pose.far;
  if (Number.isFinite(pose.zoom)) camera.zoom = pose.zoom;
  camera.updateProjectionMatrix();
  if (controls?.target) controls.target.fromArray(pose.target);
  camera.lookAt(controls.target);
  camera.quaternion.fromArray(pose.quaternion);
  camera.updateMatrixWorld();
}

function lerpPose(camera, controls, from, to, t) {
  const u = Math.min(1, Math.max(0, t));
  camera.position.set(
    from.position[0] + (to.position[0] - from.position[0]) * u,
    from.position[1] + (to.position[1] - from.position[1]) * u,
    from.position[2] + (to.position[2] - from.position[2]) * u,
  );
  _up.set(
    from.up[0] + (to.up[0] - from.up[0]) * u,
    from.up[1] + (to.up[1] - from.up[1]) * u,
    from.up[2] + (to.up[2] - from.up[2]) * u,
  );
  if (_up.lengthSq() > 1e-12) _up.normalize();
  camera.up.copy(_up);
  _qa.fromArray(from.quaternion);
  _qb.fromArray(to.quaternion);
  camera.quaternion.slerpQuaternions(_qa, _qb, u);
  if (controls?.target) {
    controls.target.set(
      from.target[0] + (to.target[0] - from.target[0]) * u,
      from.target[1] + (to.target[1] - from.target[1]) * u,
      from.target[2] + (to.target[2] - from.target[2]) * u,
    );
  }
  camera.fov = from.fov + (to.fov - from.fov) * u;
  camera.near = from.near + (to.near - from.near) * u;
  camera.far = from.far + (to.far - from.far) * u;
  if (Number.isFinite(from.zoom) && Number.isFinite(to.zoom)) {
    camera.zoom = from.zoom + (to.zoom - from.zoom) * u;
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/**
 * Fresh TrackballControls so a coasting drag cannot apply on the next update.
 * Public locks (noRotate / noPan / …) are copied. The camera and target are
 * already at the restored pose; the new controls adopt them.
 */
export function remountTrackball(camera, prev) {
  if (!camera || !prev?.domElement) return prev || null;
  const dom = prev.domElement;
  const target = prev.target.clone();
  const keep = {
    enabled: prev.enabled !== false,
    noRotate: !!prev.noRotate,
    noZoom: !!prev.noZoom,
    noPan: !!prev.noPan,
    noRoll: !!prev.noRoll,
    staticMoving: !!prev.staticMoving,
  };
  prev.dispose();
  const next = new TrackballControls(camera, dom);
  applyTrackballFeel(next);
  next.enabled = keep.enabled;
  next.noRotate = keep.noRotate;
  next.noZoom = keep.noZoom;
  next.noPan = keep.noPan;
  next.noRoll = keep.noRoll;
  next.staticMoving = keep.staticMoving;
  next.enableRotate = !keep.noRotate;
  next.target.copy(target);
  next.update();
  return next;
}

/**
 * One open sheet's camera. `slideBy` pans from the live pose (snapshot is
 * taken once). `restore` tweens back to that snapshot and remounts Trackball.
 */
export function createSheetCameraSession({
  getCamera,
  getControls,
  setControls,
  remountControls = remountTrackball,
  reducedMotion = () => false,
  flattenLift = () => {},
  now = () => performance.now(),
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
  tweenMs = FEATURE_SHEET_TWEEN_MS,
} = {}) {
  let snapshot = null;
  let generation = 0;
  let restoring = false;
  let frame = 0;

  function cancelTween() {
    generation += 1;
    if (frame) {
      cancelFrame(frame);
      frame = 0;
    }
  }

  function runTween(step, done) {
    const gen = generation;
    const reduced = reducedMotion() === true;
    if (reduced) {
      step(1);
      if (gen === generation) done();
      return;
    }
    const t0 = now();
    const ms = Math.max(0, Number(tweenMs) || FEATURE_SHEET_TWEEN_MS);
    const tick = (tNow) => {
      if (gen !== generation) return;
      const t = ms <= 0 ? 1 : Math.min(1, (tNow - t0) / ms);
      step(easeInOutCubic(t));
      if (t < 1) frame = requestFrame(tick);
      else {
        frame = 0;
        if (gen === generation) done();
      }
    };
    frame = requestFrame(tick);
  }

  return {
    isRestoring: () => restoring,
    hasSnapshot: () => snapshot != null,
    snapshotPose: () => (snapshot ? { ...snapshot, position: snapshot.position.slice() } : null),
    /**
     * Pan by `ndcDelta` from the current pose. The first call snapshots
     * after flattening any legacy under-title NDC lift.
     */
    slideBy(ndcDelta) {
      const camera = getCamera?.();
      const controls = getControls?.();
      if (!camera || !controls?.target) return false;
      cancelTween();
      restoring = false;
      if (!snapshot) {
        flattenLift();
        snapshot = captureViewPose(getCamera(), getControls());
      }
      const delta = Number(ndcDelta) || 0;
      if (Math.abs(delta) < 1e-6) return true;
      let applied = 0;
      runTween((t) => {
        const cam = getCamera();
        const ctl = getControls();
        if (!cam || !ctl) return;
        const want = delta * t;
        const slice = want - applied;
        if (Math.abs(slice) > 1e-8) {
          panViewByNdcY({ camera: cam, controls: ctl, ndcY: slice });
          applied = want;
        }
      }, () => {});
      return true;
    },
    /** Tween to the pre-open pose. Orbit during the sheet is discarded. */
    restore() {
      const shot = snapshot;
      const camera = getCamera?.();
      const controls = getControls?.();
      if (!shot || !camera || !controls?.target) {
        snapshot = null;
        restoring = false;
        return false;
      }
      cancelTween();
      const from = captureViewPose(camera, controls);
      restoring = true;
      runTween((t) => {
        const cam = getCamera();
        const ctl = getControls();
        if (!cam || !ctl) return;
        if (t >= 1) applyViewPose(cam, ctl, shot);
        else lerpPose(cam, ctl, from, shot, t);
      }, () => {
        const cam = getCamera();
        const ctl = getControls();
        if (cam && ctl) {
          applyViewPose(cam, ctl, shot);
          const next = remountControls(cam, ctl);
          if (next && next !== ctl) {
            applyViewPose(cam, next, shot);
            setControls?.(next);
          }
        }
        snapshot = null;
        restoring = false;
      });
      return true;
    },
  };
}
