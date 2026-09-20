/**
 * Slice 24/25/26 — Contour-mode shell + Extrude / Revolve solid commit.
 *
 * Shared mode Extrude / Revolve / Loft own. Fillet-without-edges is Slice 27
 * (its own edge-pick mode — not a contour entry).
 * Slice 24: enter mode, ghost the part, swap the left rail, pick a workplane,
 * draw circle/rect/polygon/(cheap polyline), live makeCrossSection preview.
 * Slice 25: Extrude entry Confirm commits profile + makeExtrude solid (live
 * solid preview; second Confirm updates the same marked block).
 * Slice 26: Revolve entry Confirm commits profile + makeRevolve solid (live
 * solid preview; axis on the profile plane). Profile stays Profile-only.
 * Loft solid is a later slice.
 *
 * Reuses Slice 21: workplaneFromFace / makeCrossSection / profile* substrate.
 * Reuses C8 makeExtrude / makeRevolve + placeInFrame (frame-only, replace part).
 */

import {
  classifySelectedFace,
} from './faceFeaturePlacement.js';
import {
  assembleCrossSection,
  buildCrossSectionPreview,
  buildProfileFromParams,
  CROSS_SECTION_REFUSE_NON_PLANAR,
  defaultTopPlaneFrame,
  planeFrameFromFaceData,
} from './crossSectionSubstrate.js';
import {
  composeHelperInsert,
  CONTOUR_PROFILE_BEGIN,
  CONTOUR_PROFILE_END,
  CONTOUR_EXTRUDE_BEGIN,
  CONTOUR_EXTRUDE_END,
  CONTOUR_REVOLVE_BEGIN,
  CONTOUR_REVOLVE_END,
  isBufferEmpty,
} from './helperPaletteSnippets.js';

/** Palette ids that enter contour mode instead of one-shot insert. */
export const CONTOUR_ENTRY_IDS = new Set([
  'makeExtrude',
  'makeRevolve',
  'crossSection',
]);

export const CONTOUR_TOOLS = [
  { id: 'circle', label: 'Circle', title: 'Circle profile on the workplane' },
  { id: 'rectangle', label: 'Rect', title: 'Rectangle profile on the workplane' },
  { id: 'polygon', label: 'Polygon', title: 'Regular polygon profile on the workplane' },
  { id: 'polyline', label: 'Polyline', title: 'Tap points on the workplane (closed on Confirm)' },
];

export const CONTOUR_TOOL_IDS = CONTOUR_TOOLS.map((t) => t.id);

export const CONTOUR_NO_SOLID =
  'This Confirm writes Profile only (makeCrossSection). Extrude solids use the Extrude entry; Revolve solids use the Revolve entry; Loft solid is a later slice.';

export const EXTRUDE_SENSES = ['positive', 'negative', 'both'];
export const EXTRUDE_DIRECTIONS = ['normal', 'x', 'y', 'z'];
export const REVOLVE_SENSES = ['positive', 'negative', 'both'];
export const REVOLVE_AXES = ['u', 'v', 'x', 'y', 'z'];
export const REVOLVE_SEGMENTS = 96;

export function isContourEntry(id) {
  return CONTOUR_ENTRY_IDS.has(id);
}

export function isExtrudeEntry(id) {
  return id === 'makeExtrude';
}

export function isRevolveEntry(id) {
  return id === 'makeRevolve';
}

export function isContourTool(id) {
  return CONTOUR_TOOL_IDS.includes(id);
}

export function defaultContourParams(tool) {
  if (tool === 'rectangle') {
    return { width: 20, height: 12, centered: true };
  }
  if (tool === 'polygon') {
    return { polygonPreset: 'hexagon', radius: 8 };
  }
  if (tool === 'polyline') {
    return { points: [] };
  }
  return { radius: 5, segments: 32 };
}

/** Sane mobile defaults: 10 mm along the workplane normal, one-sided out. */
export function defaultExtrudeParams() {
  return { distance: 10, direction: 'normal', sense: 'positive' };
}

export function normalizeExtrudeParams(raw = {}) {
  const distance = Number(raw.distance);
  let sense = String(raw.sense ?? 'positive');
  if (sense === '+' || sense === 'out' || sense === 'along') sense = 'positive';
  if (sense === '-' || sense === 'in' || sense === 'opposite') sense = 'negative';
  if (sense === 'mid' || sense === '±' || sense === '+-' || sense === 'symmetric') sense = 'both';
  let direction = String(raw.direction ?? 'normal');
  if (direction === 'along' || direction === 'n' || direction === 'plane') direction = 'normal';
  return { distance, direction, sense };
}

/** Local-Z start of makeExtrude on the workplane (sense → placeInFrame w). */
export function extrudeWOffset(distance, sense) {
  const d = Number(distance);
  if (sense === 'negative') return -d;
  if (sense === 'both') return -d / 2;
  return 0;
}

/**
 * World-axis direction must be parallel to the workplane normal.
 * `normal` always uses the plane normal (placeInFrame maps local Z → normal).
 */
export function resolveExtrudeAxis(plane, direction) {
  if (!plane?.normal) {
    return { ok: false, message: 'Extrude: workplane is missing a normal' };
  }
  const dir = direction || 'normal';
  if (dir === 'normal') {
    return { ok: true, axis: plane.normal.slice(), source: 'normal' };
  }
  const map = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const axis = map[dir];
  if (!axis) {
    return { ok: false, message: 'Extrude direction must be normal, x, y, or z' };
  }
  const d = _dot(axis, plane.normal);
  if (Math.abs(d) < 0.99) {
    return {
      ok: false,
      message:
        'Extrude direction must be along the workplane normal (or a world axis parallel to it).',
    };
  }
  return { ok: true, axis: plane.normal.slice(), source: dir };
}

export function validateExtrudeParams(raw) {
  const n = normalizeExtrudeParams(raw);
  if (!(n.distance > 0) || !Number.isFinite(n.distance)) {
    return { ok: false, message: 'makeExtrude: distance must be > 0' };
  }
  if (!EXTRUDE_DIRECTIONS.includes(n.direction)) {
    return { ok: false, message: 'Extrude direction must be normal, x, y, or z' };
  }
  if (!EXTRUDE_SENSES.includes(n.sense)) {
    return { ok: false, message: 'Extrude sense must be positive, negative, or both' };
  }
  return { ok: true, normalized: n };
}

/** Sane mobile defaults: full 360° around the plane V axis (on-plane). */
export function defaultRevolveParams() {
  return { angle: 360, axis: 'v', sense: 'positive' };
}

export function normalizeRevolveParams(raw = {}) {
  const angle = Number(raw.angle);
  let sense = String(raw.sense ?? 'positive');
  if (sense === '+' || sense === 'out' || sense === 'along' || sense === 'ccw') sense = 'positive';
  if (sense === '-' || sense === 'in' || sense === 'opposite' || sense === 'cw') sense = 'negative';
  if (sense === 'mid' || sense === '±' || sense === '+-' || sense === 'symmetric') sense = 'both';
  let axis = String(raw.axis ?? 'v');
  if (axis === 'plane-y' || axis === 'along-v' || axis === 'height' || axis === 'vy') axis = 'v';
  if (axis === 'plane-x' || axis === 'along-u' || axis === 'ux') axis = 'u';
  return { angle, axis, sense };
}

/** Start angle of makeRevolve (sense → rotate around the result Z axis). */
export function revolveStartDeg(angle, sense) {
  const a = Number(angle);
  if (sense === 'negative') return -a;
  if (sense === 'both') return -a / 2;
  return 0;
}

/**
 * Revolve axis must lie on the profile plane (inverse of Extrude's normal rule).
 * `u` / `v` are the workplane basis; world x/y/z must be parallel to the plane.
 */
export function resolveRevolveAxis(plane, axis) {
  if (!plane?.normal || !plane?.x || !plane?.y) {
    return { ok: false, message: 'Revolve: workplane is missing a frame' };
  }
  const dir = axis || 'v';
  if (dir === 'u') {
    return { ok: true, uv: [1, 0], world: plane.x.slice(), source: 'u' };
  }
  if (dir === 'v') {
    return { ok: true, uv: [0, 1], world: plane.y.slice(), source: 'v' };
  }
  const map = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const world = map[dir];
  if (!world) {
    return { ok: false, message: 'Revolve axis must be u, v, x, y, or z' };
  }
  if (Math.abs(_dot(world, plane.normal)) > 0.01) {
    return {
      ok: false,
      message:
        'Revolve axis must lie on the profile plane (or a world axis parallel to it).',
    };
  }
  const u = _dot(world, plane.x);
  const v = _dot(world, plane.y);
  const len = Math.hypot(u, v);
  if (len < 1e-9) {
    return { ok: false, message: 'Revolve axis must lie on the profile plane' };
  }
  return {
    ok: true,
    uv: [u / len, v / len],
    world: [
      (u / len) * plane.x[0] + (v / len) * plane.y[0],
      (u / len) * plane.x[1] + (v / len) * plane.y[1],
      (u / len) * plane.x[2] + (v / len) * plane.y[2],
    ],
    source: dir,
  };
}

export function validateRevolveParams(raw) {
  const n = normalizeRevolveParams(raw);
  if (!(n.angle > 0) || !Number.isFinite(n.angle) || n.angle > 360) {
    return { ok: false, message: 'makeRevolve: angle must be > 0 and ≤ 360' };
  }
  if (!REVOLVE_AXES.includes(n.axis)) {
    return { ok: false, message: 'Revolve axis must be u, v, x, y, or z' };
  }
  if (!REVOLVE_SENSES.includes(n.sense)) {
    return { ok: false, message: 'Revolve sense must be positive, negative, or both' };
  }
  return { ok: true, normalized: n };
}

/**
 * Map workplane UV contours into makeRevolve (radial, height) space.
 *
 * Identity (u,v)→(radial,height) in the axis/radial basis — axis through the
 * workplane origin, no min-radial shift. makeRevolve / Manifold then clips
 * x < 0 (positive-X half only), so a centered circle revolves about a
 * diameter → sphere. Shifting by minR was the opposite geometry: it parked
 * the axis on the profile's leftmost edge (horn torus / filled washer).
 *
 * Crossing (minR < 0 < maxR) is accepted and clipped. Profiles with no
 * +radial material (on-axis / entirely negative) loud-fail.
 */
export function mapContoursToRevolve(contours, uvAxis) {
  if (!Array.isArray(contours) || !contours.length) {
    return { ok: false, message: 'makeRevolve: expected an array of contours' };
  }
  const au = Number(uvAxis?.[0]);
  const av = Number(uvAxis?.[1]);
  if (!Number.isFinite(au) || !Number.isFinite(av) || Math.hypot(au, av) < 1e-9) {
    return { ok: false, message: 'makeRevolve: axis UV direction is missing' };
  }
  const inv = 1 / Math.hypot(au, av);
  const aU = au * inv;
  const aV = av * inv;
  // Radial = rotate axis 90° CW in the plane so V-axis → +U (x=radial, y=height).
  const rU = aV;
  const rV = -aU;
  let minR = Infinity;
  let maxR = -Infinity;
  const mapped = [];
  for (const ring of contours) {
    if (!Array.isArray(ring)) {
      return { ok: false, message: 'makeRevolve: expected an array of contours' };
    }
    const out = [];
    for (const p of ring) {
      const radial = rU * Number(p?.[0]) + rV * Number(p?.[1]);
      const height = aU * Number(p?.[0]) + aV * Number(p?.[1]);
      if (!Number.isFinite(radial) || !Number.isFinite(height)) {
        return { ok: false, message: 'makeRevolve: contour point is not finite' };
      }
      if (radial < minR) minR = radial;
      if (radial > maxR) maxR = radial;
      out.push([radial, height]);
    }
    mapped.push(out);
  }
  if (!Number.isFinite(minR) || maxR - minR < 1e-9) {
    return {
      ok: false,
      message: 'makeRevolve: profile has no width off the axis — would sit on the axis',
    };
  }
  // Reachable: entirely −radial has width but no +X material (empty revolve).
  // Gutting this arm must turn the entirely-negative golden red. Crossing
  // (minR < 0 < maxR) is accepted — Manifold clips to +radial (sphere case).
  if (maxR < 1e-6) {
    return {
      ok: false,
      message: 'makeRevolve: profile has no material on the +radial side of the axis',
    };
  }
  return { ok: true, mapped, shift: 0, rU, rV, aU, aV, minR, maxR };
}

/**
 * Seed mode state from a palette entry + current face pick.
 * Non-planar face → default +Z plane + loud enterRefuse (do not invent a plane).
 */
export function enterContourState(entry, faceData = null) {
  const resolved = resolveContourWorkplane(faceData);
  return {
    entry: CONTOUR_ENTRY_IDS.has(entry) ? entry : 'crossSection',
    tool: 'circle',
    params: defaultContourParams('circle'),
    extrude: defaultExtrudeParams(),
    revolve: defaultRevolveParams(),
    planeFace: resolved.ok ? resolved.face : null,
    enterRefuse: resolved.ok ? null : resolved.message,
  };
}

export function switchContourTool(state, tool) {
  const nextTool = isContourTool(tool) ? tool : 'circle';
  const next = defaultContourParams(nextTool);
  if (state?.params?.radius != null && next.radius != null) {
    next.radius = state.params.radius;
  }
  return { ...state, tool: nextTool, params: next };
}

/**
 * Map in-mode tool + params → Slice 21 buildProfileFromParams / compose shape.
 */
export function toolToProfileParams(tool, params = {}) {
  const p = params || {};
  if (tool === 'rectangle') {
    return {
      profileType: 'rectangle',
      width: p.width,
      height: p.height,
      centered: p.centered,
    };
  }
  if (tool === 'polygon') {
    return {
      profileType: 'polygon',
      polygonPreset: p.polygonPreset || 'hexagon',
      radius: p.radius,
    };
  }
  if (tool === 'polyline') {
    return {
      profileType: 'polygon',
      polygonPreset: 'custom',
      points: Array.isArray(p.points) ? p.points : [],
    };
  }
  return {
    profileType: 'circle',
    radius: p.radius,
    segments: p.segments,
  };
}

function _dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function _sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function _add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function _mul(s, a) {
  return [s * a[0], s * a[1], s * a[2]];
}

/**
 * Classify a Viewport face pick into a contour workplane.
 * Planar → workplaneFromFace frame (origin snapped to face center, Slice 21).
 * No face → default +Z top. Cylindrical / irregular → refuse (loud, no best-fit).
 *
 * @param {object|null} faceData
 * @returns {{ ok: boolean, face: object|null, plane: object|null, source: string, message?: string }}
 */
export function resolveContourWorkplane(faceData) {
  if (!faceData) {
    return {
      ok: true,
      face: null,
      plane: defaultTopPlaneFrame(),
      source: 'defaultTop',
    };
  }
  const face = classifySelectedFace(faceData);
  if (!face) {
    return {
      ok: true,
      face: null,
      plane: defaultTopPlaneFrame(),
      source: 'defaultTop',
    };
  }
  if (face.type !== 'planar') {
    return {
      ok: false,
      face,
      plane: null,
      source: face.type,
      message: face.type === 'irregular'
        ? (face.refuseMessage || CROSS_SECTION_REFUSE_NON_PLANAR)
        : CROSS_SECTION_REFUSE_NON_PLANAR,
    };
  }
  return {
    ok: true,
    face,
    plane: planeFromContourFace(face),
    source: 'face',
  };
}

/**
 * Plane frame used by live preview (same snap as buildCrossSectionPreview).
 */
export function planeFromContourFace(face) {
  if (!face || face.type !== 'planar') return defaultTopPlaneFrame(face?.center);
  const preview = buildCrossSectionPreview(face, { profileType: 'circle', radius: 1 });
  if (preview?.plane) return preview.plane;
  try {
    return planeFrameFromFaceData(face);
  } catch {
    return defaultTopPlaneFrame(face.center);
  }
}

export function workplaneOverlaySize(face, fallback = 36) {
  const area = Number(face?.area);
  if (Number.isFinite(area) && area > 1) {
    return Math.min(120, Math.max(16, Math.sqrt(area) * 1.15));
  }
  return fallback;
}

/** Four world corners of a size×size quad centered on the plane. */
export function workplaneQuadCorners(plane, size) {
  const h = Number(size) / 2;
  if (!plane?.center || !plane?.x || !plane?.y || !Number.isFinite(h)) {
    throw new Error('workplaneQuadCorners: need plane center/x/y and finite size');
  }
  const at = (u, v) => [
    plane.center[0] + u * plane.x[0] + v * plane.y[0],
    plane.center[1] + u * plane.x[1] + v * plane.y[1],
    plane.center[2] + u * plane.x[2] + v * plane.y[2],
  ];
  return [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
}

/**
 * Ray ↔ plane intersection. Returns world point or null (parallel / non-finite).
 */
export function intersectRayPlane(origin, dir, plane) {
  if (!origin || !dir || !plane?.center || !plane?.normal) return null;
  const denom = _dot(dir, plane.normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = _dot(_sub(plane.center, origin), plane.normal) / denom;
  if (!Number.isFinite(t)) return null;
  return _add(origin, _mul(t, dir));
}

export function worldToPlaneUV(world, plane) {
  if (!world || !plane?.center || !plane?.x || !plane?.y) {
    throw new Error('worldToPlaneUV: need world point and plane center/x/y');
  }
  const d = _sub(world, plane.center);
  return [_dot(d, plane.x), _dot(d, plane.y)];
}

/**
 * Loud-fail gate for Confirm. Never returns ok with degenerate contours.
 */
export function validateContourProfile(tool, params) {
  try {
    const p = params || {};
    if (tool === 'circle') {
      const r = Number(p.radius);
      if (!(r > 0) || !Number.isFinite(r)) {
        return { ok: false, message: 'profileCircle: radius must be > 0' };
      }
    } else if (tool === 'rectangle') {
      const w = Number(p.width);
      const h = Number(p.height);
      if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
        return { ok: false, message: 'profileRectangle: width and height must be > 0' };
      }
    } else if (tool === 'polygon') {
      const r = Number(p.radius);
      if (!(r > 0) || !Number.isFinite(r)) {
        return { ok: false, message: 'profilePolygon: radius must be > 0 for regular polygon' };
      }
    } else if (tool === 'polyline') {
      const pts = p.points;
      if (!Array.isArray(pts) || pts.length < 3) {
        return {
          ok: false,
          message:
            'profilePolygon: need ≥ 3 points for a closed polyline — tap the workplane, then Confirm.',
        };
      }
    }
    const built = buildProfileFromParams(toolToProfileParams(tool, p));
    if (!built?.contours?.length) {
      return { ok: false, message: 'buildProfileFromParams: empty contours' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
}

/**
 * Live preview via Slice 21 makeCrossSection mirror. Null when params are
 * incomplete (e.g. polyline with fewer than 3 points) — caller may draft.
 */
export function buildContourPreview(face, tool, params) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) return null;
  return buildCrossSectionPreview(face || null, toolToProfileParams(tool, params));
}

/** Assemble a reusable cross-section value (goldens / Extrude). */
export function assembleContourCrossSection(face, tool, params) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) {
    throw new Error(gate.message);
  }
  const plane = planeFromContourFace(face);
  return assembleCrossSection(plane, toolToProfileParams(tool, params));
}

/**
 * Live Extrude solid preview payload (plane + UV contours + sense offset).
 * Null when profile or extrude params are incomplete / invalid.
 */
export function buildExtrudeSolidPreview(face, tool, params, extrude) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) return null;
  const extGate = validateExtrudeParams(extrude);
  if (!extGate.ok) return null;
  const prev = buildContourPreview(face, tool, params);
  if (!prev?.plane) return null;
  const axis = resolveExtrudeAxis(prev.plane, extGate.normalized.direction);
  if (!axis.ok) return null;
  let contours;
  try {
    contours = buildProfileFromParams(toolToProfileParams(tool, params)).contours;
  } catch {
    return null;
  }
  if (!contours?.length) return null;
  const w0 = extrudeWOffset(extGate.normalized.distance, extGate.normalized.sense);
  return {
    plane: prev.plane,
    rings: prev.rings,
    contours,
    profile: prev.profile,
    extrude: extGate.normalized,
    axis: axis.axis,
    w0,
    distance: extGate.normalized.distance,
  };
}

/**
 * Live Revolve solid preview payload (plane + remapped radial/height contours).
 * Null when profile or revolve params are incomplete / invalid.
 */
export function buildRevolveSolidPreview(face, tool, params, revolve) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) return null;
  const revGate = validateRevolveParams(revolve);
  if (!revGate.ok) return null;
  const prev = buildContourPreview(face, tool, params);
  if (!prev?.plane) return null;
  const axis = resolveRevolveAxis(prev.plane, revGate.normalized.axis);
  if (!axis.ok) return null;
  let contours;
  try {
    contours = buildProfileFromParams(toolToProfileParams(tool, params)).contours;
  } catch {
    return null;
  }
  if (!contours?.length) return null;
  const mapped = mapContoursToRevolve(contours, axis.uv);
  if (!mapped.ok) return null;
  const startDeg = revolveStartDeg(revGate.normalized.angle, revGate.normalized.sense);
  const plane = prev.plane;
  const radialWorld = [
    mapped.rU * plane.x[0] + mapped.rV * plane.y[0],
    mapped.rU * plane.x[1] + mapped.rV * plane.y[1],
    mapped.rU * plane.x[2] + mapped.rV * plane.y[2],
  ];
  const axisWorld = axis.world.slice();
  // Axis through the workplane origin (identity remap — no min-radial shift).
  const center = plane.center.slice();
  return {
    plane,
    rings: prev.rings,
    contours: mapped.mapped,
    profile: prev.profile,
    revolve: revGate.normalized,
    axis: axisWorld,
    radial: radialWorld,
    center,
    shift: 0,
    startDeg,
    angle: revGate.normalized.angle,
  };
}

export function hasContourProfileBlock(buffer) {
  const t = String(buffer || '');
  return t.includes(CONTOUR_PROFILE_BEGIN) && t.includes(CONTOUR_PROFILE_END);
}

/** Text this composer owns — between CONTOUR_PROFILE_BEGIN and CONTOUR_PROFILE_END. */
export function contourProfileOwnedRegion(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(CONTOUR_PROFILE_BEGIN);
  if (i < 0) return '';
  const j = text.indexOf(CONTOUR_PROFILE_END, i);
  if (j < 0) return '';
  return text.slice(i, j + CONTOUR_PROFILE_END.length);
}

/**
 * Remove the in-mode Profile region so Confirm can replace it.
 * If markers are missing/unbalanced, leave the buffer unchanged (loud later).
 */
export function stripContourProfileBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(CONTOUR_PROFILE_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(CONTOUR_PROFILE_END, i);
  if (j < 0) return text;
  const after = text.slice(j + CONTOUR_PROFILE_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

/**
 * Confirm → insert or replace in-mode Profile (makeCrossSection).
 * Never emits makeExtrude / makeRevolve / loft.
 *
 * @returns {{ ok: true, buffer: string } | { ok: false, message: string }}
 */
export function composeContourProfile(buffer, { face = null, tool = 'circle', params = {} } = {}) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) return gate;

  const planar = face && face.type === 'planar' ? face : null;
  const stripped = stripContourProfileBlock(buffer);
  const profileParams = {
    ...toolToProfileParams(tool, params),
    body: params.body || 'part',
    _contourMode: true,
  };
  const composed = composeHelperInsert(
    stripped,
    'crossSection',
    null,
    profileParams,
    planar,
    null,
  );
  if (typeof composed !== 'string') {
    return {
      ok: false,
      message: 'Could not compose Profile — need a part and a planar workplane.',
    };
  }
  // Only the contour block is this composer's responsibility. Pre-existing
  // makeExtrude / makeRevolve / loft in the user's script must not block Confirm.
  const owned = contourProfileOwnedRegion(composed);
  if (/makeExtrude\s*\(|makeRevolve\s*\(|\bloft\s*\(/.test(owned)) {
    return {
      ok: false,
      message: CONTOUR_NO_SOLID,
    };
  }
  if (!/makeCrossSection\s*\(/.test(composed)) {
    return {
      ok: false,
      message: 'composeContourProfile: makeCrossSection missing — refusing silent no-op.',
    };
  }
  if (!hasContourProfileBlock(composed)) {
    return {
      ok: false,
      message: 'composeContourProfile: contour-mode markers missing — refusing unscoped insert.',
    };
  }
  return { ok: true, buffer: composed };
}

export function countMakeCrossSection(buffer) {
  const m = String(buffer || '').match(/makeCrossSection\s*\(/g);
  return m ? m.length : 0;
}

export function countMakeExtrude(buffer) {
  const m = String(buffer || '').match(/makeExtrude\s*\(/g);
  return m ? m.length : 0;
}

export function countMakeRevolve(buffer) {
  const m = String(buffer || '').match(/makeRevolve\s*\(/g);
  return m ? m.length : 0;
}

function markersUnbalanced(text, begin, end) {
  const i = text.lastIndexOf(begin);
  const j = text.indexOf(end, i < 0 ? 0 : i);
  if (text.includes(begin) && i < 0) return true;
  if (i >= 0 && j < 0) return true;
  if (i < 0 && text.includes(end)) return true;
  return false;
}

export function hasContourExtrudeBlock(buffer) {
  const t = String(buffer || '');
  return t.includes(CONTOUR_EXTRUDE_BEGIN) && t.includes(CONTOUR_EXTRUDE_END);
}

export function contourExtrudeOwnedRegion(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(CONTOUR_EXTRUDE_BEGIN);
  if (i < 0) return '';
  const j = text.indexOf(CONTOUR_EXTRUDE_END, i);
  if (j < 0) return '';
  return text.slice(i, j + CONTOUR_EXTRUDE_END.length);
}

export function stripContourExtrudeBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(CONTOUR_EXTRUDE_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(CONTOUR_EXTRUDE_END, i);
  if (j < 0) return text;
  const after = text.slice(j + CONTOUR_EXTRUDE_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

/**
 * Confirm → insert or replace in-mode Extrude (profile + makeExtrude + placeInFrame).
 * New-body path replaces `part` (no host add). Second Confirm updates the same block.
 *
 * @returns {{ ok: true, buffer: string, run: true } | { ok: false, message: string }}
 */
export function composeContourExtrude(buffer, {
  face = null,
  tool = 'circle',
  params = {},
  extrude = {},
} = {}) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) return gate;

  const extGate = validateExtrudeParams(extrude);
  if (!extGate.ok) return extGate;

  const plane = planeFromContourFace(face);
  const axis = resolveExtrudeAxis(plane, extGate.normalized.direction);
  if (!axis.ok) return axis;

  const text = String(buffer || '');
  if (markersUnbalanced(text, CONTOUR_EXTRUDE_BEGIN, CONTOUR_EXTRUDE_END)) {
    return {
      ok: false,
      message: 'composeContourExtrude: unbalanced extrude markers — refusing silent no-op.',
    };
  }

  const planar = face && face.type === 'planar' ? face : null;
  const stripped = stripContourRevolveBlock(
    stripContourExtrudeBlock(stripContourProfileBlock(buffer)),
  );
  const profileParams = {
    ...toolToProfileParams(tool, params),
    body: params.body || 'part',
    _contourExtrude: {
      ...extGate.normalized,
      plane,
    },
  };
  const composed = composeHelperInsert(
    stripped,
    'crossSection',
    null,
    profileParams,
    planar,
    null,
  );
  if (typeof composed !== 'string') {
    return {
      ok: false,
      message: 'Could not compose Extrude — need a part and a planar workplane.',
    };
  }
  const owned = contourExtrudeOwnedRegion(composed);
  if (!/makeCrossSection\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourExtrude: makeCrossSection missing — refusing silent no-op.',
    };
  }
  if (!/makeExtrude\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourExtrude: makeExtrude missing — refusing silent no-op.',
    };
  }
  if (!/placeInFrame\s*\(|transformByFrame\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourExtrude: placeInFrame missing — refusing unscoped insert.',
    };
  }
  if (/placeOnFace\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourExtrude: placeOnFace is the host path — refusing leftover host.',
    };
  }
  if (/part\s*=\s*part\.add\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourExtrude: host-add is not the new-body path — refusing leftover host.',
    };
  }
  if (!hasContourExtrudeBlock(composed)) {
    return {
      ok: false,
      message: 'composeContourExtrude: contour-mode extrude markers missing — refusing unscoped insert.',
    };
  }
  if (/makeRevolve\s*\(|\bloft\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourExtrude: unexpected Revolve/Loft in the Extrude block.',
    };
  }
  if (isBufferEmpty(String(buffer || '')) && /Manifold\.cube\s*\(/.test(composed)) {
    return {
      ok: false,
      message: 'composeContourExtrude: unexpected starter box on empty buffer — refusing extra solid.',
    };
  }
  return { ok: true, buffer: composed, run: true };
}

export function hasContourRevolveBlock(buffer) {
  const t = String(buffer || '');
  return t.includes(CONTOUR_REVOLVE_BEGIN) && t.includes(CONTOUR_REVOLVE_END);
}

export function contourRevolveOwnedRegion(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(CONTOUR_REVOLVE_BEGIN);
  if (i < 0) return '';
  const j = text.indexOf(CONTOUR_REVOLVE_END, i);
  if (j < 0) return '';
  return text.slice(i, j + CONTOUR_REVOLVE_END.length);
}

export function stripContourRevolveBlock(buffer) {
  const text = String(buffer || '');
  const i = text.lastIndexOf(CONTOUR_REVOLVE_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(CONTOUR_REVOLVE_END, i);
  if (j < 0) return text;
  const after = text.slice(j + CONTOUR_REVOLVE_END.length).replace(/^\r?\n/, '');
  const before = text.slice(0, i).replace(/\s+$/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

/**
 * Confirm → insert or replace in-mode Revolve (profile + makeRevolve + placeInFrame).
 * New-body path replaces `part` (no host add). Second Confirm updates the same block.
 *
 * @returns {{ ok: true, buffer: string, run: true } | { ok: false, message: string }}
 */
export function composeContourRevolve(buffer, {
  face = null,
  tool = 'circle',
  params = {},
  revolve = {},
} = {}) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) return gate;

  const revGate = validateRevolveParams({ ...defaultRevolveParams(), ...revolve });
  if (!revGate.ok) return revGate;

  const plane = planeFromContourFace(face);
  const axis = resolveRevolveAxis(plane, revGate.normalized.axis);
  if (!axis.ok) return axis;

  let contours;
  try {
    contours = buildProfileFromParams(toolToProfileParams(tool, params)).contours;
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
  const mapped = mapContoursToRevolve(contours, axis.uv);
  if (!mapped.ok) return mapped;

  const text = String(buffer || '');
  if (markersUnbalanced(text, CONTOUR_REVOLVE_BEGIN, CONTOUR_REVOLVE_END)) {
    return {
      ok: false,
      message: 'composeContourRevolve: unbalanced revolve markers — refusing silent no-op.',
    };
  }

  const planar = face && face.type === 'planar' ? face : null;
  const stripped = stripContourRevolveBlock(
    stripContourExtrudeBlock(stripContourProfileBlock(buffer)),
  );
  const profileParams = {
    ...toolToProfileParams(tool, params),
    body: params.body || 'part',
    _contourRevolve: {
      ...revGate.normalized,
      segments: REVOLVE_SEGMENTS,
      startDeg: revolveStartDeg(revGate.normalized.angle, revGate.normalized.sense),
      rU: mapped.rU,
      rV: mapped.rV,
      aU: mapped.aU,
      aV: mapped.aV,
      plane,
    },
  };
  const composed = composeHelperInsert(
    stripped,
    'crossSection',
    null,
    profileParams,
    planar,
    null,
  );
  if (typeof composed !== 'string') {
    return {
      ok: false,
      message: 'Could not compose Revolve — need a part and a planar workplane.',
    };
  }
  const owned = contourRevolveOwnedRegion(composed);
  if (!/makeCrossSection\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourRevolve: makeCrossSection missing — refusing silent no-op.',
    };
  }
  if (!/makeRevolve\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourRevolve: makeRevolve missing — refusing silent no-op.',
    };
  }
  if (!/placeInFrame\s*\(|transformByFrame\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourRevolve: placeInFrame missing — refusing unscoped insert.',
    };
  }
  if (/placeOnFace\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourRevolve: placeOnFace is the host path — refusing leftover host.',
    };
  }
  if (/part\s*=\s*part\.add\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourRevolve: host-add is not the new-body path — refusing leftover host.',
    };
  }
  if (!hasContourRevolveBlock(composed)) {
    return {
      ok: false,
      message: 'composeContourRevolve: contour-mode revolve markers missing — refusing unscoped insert.',
    };
  }
  if (/makeExtrude\s*\(|\bloft\s*\(/.test(owned)) {
    return {
      ok: false,
      message: 'composeContourRevolve: unexpected Extrude/Loft in the Revolve block.',
    };
  }
  if (isBufferEmpty(String(buffer || '')) && /Manifold\.cube\s*\(/.test(composed)) {
    return {
      ok: false,
      message: 'composeContourRevolve: unexpected starter box on empty buffer — refusing extra solid.',
    };
  }
  return { ok: true, buffer: composed, run: true };
}

/**
 * Confirm router: Extrude / Revolve entry → solid; Profile stays Profile-only.
 */
export function composeContourCommit(buffer, payload = {}) {
  const entry = payload.entry || 'crossSection';
  if (isExtrudeEntry(entry)) {
    return composeContourExtrude(buffer, payload);
  }
  if (isRevolveEntry(entry)) {
    return composeContourRevolve(buffer, payload);
  }
  const result = composeContourProfile(buffer, payload);
  if (result.ok) result.run = false;
  return result;
}
