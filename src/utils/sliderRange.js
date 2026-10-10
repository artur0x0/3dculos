/**
 * Feature-card length ranges. Millimetres in, millimetres out.
 * The thumb curve and the snap live in sliderMap.js.
 */
import { Vector3 } from 'three';
import { REFERENCE_LENGTH_MM } from './characteristicLength.js';
import { fallbackOffscreenDistance, offscreenRange, shape } from './sliderMap.js';

export function partLengthMm(lengthMm) {
  const n = Number(lengthMm);
  return Number.isFinite(n) && n > 0 ? n : REFERENCE_LENGTH_MM;
}

/** Scale a millimetre that was written against the 100 mm reference. */
export function scaleFromReference(mm, lengthMm) {
  const n = Number(mm);
  if (!Number.isFinite(n)) return n;
  return Math.round(n * (partLengthMm(lengthMm) / REFERENCE_LENGTH_MM) * 100) / 100;
}

export function growToFit(min, max, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { min, max };
  return { min: Math.min(min, n), max: Math.max(max, n) };
}

export function shellWallRange(lengthMm, minExtent) {
  const L = partLengthMm(lengthMm);
  let maxMm = 0.25 * L;
  const thin = Number(minExtent);
  if (Number.isFinite(thin) && thin > 0) maxMm = Math.min(maxMm, 0.45 * thin);
  maxMm = Math.max(maxMm, 0.1);
  const defaultMm = Math.min(0.025 * L, maxMm);
  return {
    minMm: Math.min(0.1, maxMm),
    maxMm: Math.round(maxMm * 100) / 100,
    defaultMm: Math.round(defaultMm * 100) / 100,
  };
}

export function moveFaceRange(lengthMm, minExtent) {
  const L = partLengthMm(lengthMm);
  let maxMm = 0.5 * L;
  const thin = Number(minExtent);
  if (Number.isFinite(thin) && thin > 0) maxMm = Math.min(maxMm, 0.45 * thin);
  maxMm = Math.max(maxMm, 0.1);
  const defaultMm = Math.min(0.02 * L, maxMm);
  return {
    maxMm: Math.round(maxMm * 100) / 100,
    defaultMm: Math.round(defaultMm * 100) / 100,
  };
}

function cornersOf(bounds) {
  const out = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

function unit3(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-12)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Smallest translation along `direction` that carries every bbox corner
 * outside NDC x/y. Null when the camera or the box is missing.
 */
export function directionOffscreenMm(camera, bounds, direction) {
  const dir = unit3(direction);
  if (!camera?.isCamera || !bounds?.min || !bounds?.max || !dir) return null;
  const corners = cornersOf(bounds).map((p) => new Vector3(p[0], p[1], p[2]));
  const delta = new Vector3();
  const scratch = new Vector3();
  const outside = (t) => {
    delta.set(dir[0] * t, dir[1] * t, dir[2] * t);
    return corners.every((corner) => {
      scratch.copy(corner).add(delta);
      scratch.project(camera);
      return Math.abs(scratch.x) > 1 || Math.abs(scratch.y) > 1;
    });
  };
  if (outside(0)) return 0;
  const span = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    1,
  );
  let lo = 0;
  let hi = span;
  let guard = 0;
  while (!outside(hi) && guard < 16) {
    hi *= 2;
    guard += 1;
  }
  if (!outside(hi)) return null;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (outside(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Slider end R so two-thirds of the thumb reaches `dOff`, or 1.5 L. */
export function travelRangeMm(dOff, lengthMm) {
  const d = Number(dOff);
  const travel = Number.isFinite(d) && d > 0 ? d : fallbackOffscreenDistance(partLengthMm(lengthMm));
  return offscreenRange(travel);
}

/**
 * Distance from the cut plane to the farther side of the box.
 * The slider end is past that, via the same 2/3-travel rule.
 */
export function cutTravelMm(bounds, plane) {
  const normal = unit3(plane?.normal);
  if (!bounds?.min || !bounds?.max || !normal) return null;
  const origin = Array.isArray(plane.center)
    ? plane.center
    : [normal[0] * (plane.originOffset || 0), normal[1] * (plane.originOffset || 0), normal[2] * (plane.originOffset || 0)];
  let far = 0;
  for (const corner of cornersOf(bounds)) {
    const d = normal[0] * (corner[0] - origin[0])
      + normal[1] * (corner[1] - origin[1])
      + normal[2] * (corner[2] - origin[2]);
    far = Math.max(far, Math.abs(d));
  }
  return far > 0 ? far : null;
}

/**
 * Fresh contour defaults were written at L = 100. Scale them once, on enter,
 * when this part is a different size. Saved contours are applied after this.
 */
export function scaleFreshContour(state, lengthMm) {
  if (!state) return state;
  const L = Number(lengthMm);
  if (!Number.isFinite(L) || L <= 0 || Math.abs(L - REFERENCE_LENGTH_MM) < 1e-6) return state;
  const s = (n) => scaleFromReference(n, L);
  const params = { ...(state.params || {}) };
  for (const key of ['radius', 'width', 'height']) {
    if (Number.isFinite(Number(params[key]))) params[key] = s(params[key]);
  }
  const extrude = state.extrude && Number.isFinite(Number(state.extrude.distance))
    ? { ...state.extrude, distance: s(state.extrude.distance) }
    : state.extrude;
  const loft = state.loft?.profiles
    ? {
      ...state.loft,
      profiles: state.loft.profiles.map((profile) => ({
        ...profile,
        offset: Number.isFinite(Number(profile.offset)) ? s(profile.offset) : profile.offset,
        params: profile.params && Number.isFinite(Number(profile.params.radius))
          ? { ...profile.params, radius: s(profile.params.radius) }
          : profile.params,
      })),
    }
    : state.loft;
  return { ...state, params, extrude, loft };
}

/**
 * Cross-section thumb ends, in millimetres.
 * The box edge sits at two-thirds of the thumb (`shape(2/3)`). The outer
 * third continues past the box. `reach` is the signed end from `center`.
 */
export function sectionThumbRange(boxMin, boxMax) {
  const a = Number(boxMin);
  const b = Number(boxMax);
  const lo = Number.isFinite(a) ? a : -100;
  const hi = Number.isFinite(b) ? b : 100;
  const center = (lo + hi) / 2;
  const half = Math.abs(hi - lo) / 2;
  const reach = half / shape(2 / 3);
  return { min: center - reach, max: center + reach, center, reach };
}
