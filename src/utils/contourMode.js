/**
 * Slice 24 — Contour-mode shell (Profile-in-mode only).
 *
 * Shared mode Extrude / Revolve / Loft (later Fillet-without-edges) will own.
 * This slice: enter mode, ghost the part, swap the left rail, pick a workplane,
 * draw circle/rect/polygon/(cheap polyline), live makeCrossSection preview,
 * Confirm writes/updates in-mode Profile only. No solid Extrude commit.
 *
 * Reuses Slice 21: workplaneFromFace / makeCrossSection / profile* substrate.
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
  'Contour mode commits Profile only (makeCrossSection). Extrude / Revolve / Loft solid commit is a later slice.';

export function isContourEntry(id) {
  return CONTOUR_ENTRY_IDS.has(id);
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

/** Assemble a reusable cross-section value (goldens / later Extrude). */
export function assembleContourCrossSection(face, tool, params) {
  const gate = validateContourProfile(tool, params);
  if (!gate.ok) {
    throw new Error(gate.message);
  }
  const plane = planeFromContourFace(face);
  return assembleCrossSection(plane, toolToProfileParams(tool, params));
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
