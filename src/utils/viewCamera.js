// utils/viewCamera.js — camera framing shared by the UI (Zoom to Fit, view snaps) and
// the headless review harness, so a manual snap and an automated capture agree exactly.
//
// The app models parts in a Z-up world (sketches in XY, extruded along +Z), so the
// canonical view directions below are stated in that frame.
import { Vector3 } from 'three';

const DEG2RAD = Math.PI / 180;

/**
 * Canonical orthographic-style view directions.
 * dir = unit vector from the look-at target toward the camera.
 * up  = the camera's up hint; for TOP the view axis IS +Z, so up must not be +Z.
 */
export const VIEW_PRESETS = {
  iso: { dir: [1, 1, 1], up: [0, 0, 1], label: 'Isometric' },
  front: { dir: [0, -1, 0], up: [0, 0, 1], label: 'Front' },
  right: { dir: [1, 0, 0], up: [0, 0, 1], label: 'Right' },
  top: { dir: [0, 0, 1], up: [0, -1, 0], label: 'Top' },
  // Opposite faces, for reviewing the sides a part usually hides.
  back: { dir: [0, 1, 0], up: [0, 0, 1], label: 'Back' },
  left: { dir: [-1, 0, 0], up: [0, 0, 1], label: 'Left' },
  bottom: { dir: [0, 0, -1], up: [0, 1, 0], label: 'Bottom' },
};

const EPS = 1e-9;

/**
 * Frame a geometry so it fills the viewport, optionally along a fixed view direction.
 *
 * Distance is solved exactly for the bounding box (not the bounding sphere), per
 * camera-space axis, so tall-thin and flat-wide parts both come out properly filled
 * instead of shrunken to their diagonal. Safe on empty/degenerate geometry: it
 * declines to fit and reports false rather than moving the camera to a NaN.
 *
 * @param {Object} o
 * @param {import('three').PerspectiveCamera} o.camera
 * @param {import('three').TrackballControls} [o.controls]
 * @param {import('three').BufferGeometry} o.geometry
 * @param {number[]} [o.dir]  view direction; omit to keep the current orientation
 * @param {number[]} [o.up]   camera up hint; omit to keep the current up
 * @param {number}   [o.margin=1.15] >1 leaves breathing room around the part
 * @returns {boolean} true when the camera was moved
 */
export function fitView({ camera, controls, geometry, dir, up, margin = 1.15 }) {
  if (!camera || !geometry?.attributes?.position) return false;

  // Recompute every time: the mesh may have been replaced or edited since the last fit,
  // and a stale box silently frames the wrong volume.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.z)) return false;

  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  if (!(size.lengthSq() > EPS)) return false; // a single point has no frame

  // --- view direction: explicit preset, else the direction we are already looking ---
  let d = null;
  if (dir) {
    d = new Vector3(dir[0], dir[1], dir[2]);
  } else if (controls?.target) {
    d = camera.position.clone().sub(controls.target);
  }
  if (!d || d.lengthSq() < EPS) d = new Vector3(1, 1, 1);
  d.normalize();

  // --- up hint: explicit, else the camera's, re-squared against the view axis ---
  let u = up ? new Vector3(up[0], up[1], up[2]) : camera.up.clone();
  if (u.lengthSq() < EPS) u.set(0, 0, 1);
  if (Math.abs(u.dot(d)) > 1 - 1e-6) {
    // up parallel to the view axis is unusable; fall back to the world axis least aligned with it
    const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
    u = axes.reduce((best, a) => (Math.abs(a.dot(d)) < Math.abs(best.dot(d)) ? a : best), axes[0]).clone();
  }
  u.sub(d.clone().multiplyScalar(u.dot(d))).normalize();

  // --- camera basis (same construction as lookAt: z points at the eye) ---
  const zAxis = d.clone();
  const xAxis = new Vector3().crossVectors(u, zAxis).normalize();
  const yAxis = new Vector3().crossVectors(zAxis, xAxis);

  // --- half-angles of the frustum, including the horizontal one via aspect ---
  const fovY = (camera.fov || 45) * DEG2RAD;
  const tanY = Math.tan(fovY / 2) || 1e-6;
  const aspect = camera.aspect > 0 ? camera.aspect : 1;
  const tanX = tanY * aspect;

  // --- the farthest of the 8 box corners decides the distance on each axis ---
  let dist = 0;
  const corner = new Vector3();
  for (let i = 0; i < 8; i++) {
    corner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z
    ).sub(center);
    dist = Math.max(
      dist,
      Math.abs(corner.dot(xAxis)) / tanX,
      Math.abs(corner.dot(yAxis)) / tanY
    );
  }
  dist = (dist || 1) * (Number.isFinite(margin) && margin > 0 ? margin : 1.15);
  if (!Number.isFinite(dist) || dist <= 0) return false;

  // --- commit. near/far bracket the part so it is never clipped or depth-starved ---
  camera.near = Math.max(dist / 1000, 1e-4);
  camera.far = Math.max(dist * 10, camera.far || 2000);
  camera.up.copy(u);
  camera.position.copy(center).addScaledVector(d, dist);
  camera.updateProjectionMatrix();
  camera.lookAt(center);

  if (controls) {
    controls.target.copy(center);
    controls.update(); // re-applies lookAt(target) using the up we just set
  }
  return true;
}
