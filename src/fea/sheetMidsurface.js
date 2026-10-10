/**
 * Sheet-metal mid-surface for the MITC6 shell.
 *
 * Parts built with `sheetMetalSolid` take the exact path. Panels and tabs
 * lie on the plane at w = t/2. Bends lie on the cylinder of radius r + t/2
 * (the mid-fibre of the solid annulus from r to r + t). Thickness is t
 * everywhere. The shell director follows the sheet normal N, so ζ = +1 is
 * the w = t fibre and ζ = -1 is the w = 0 fibre. Render faces map onto
 * those regions: a top or bottom face owns the whole panel, tab, or bend,
 * and an edge face owns the matching boundary. A hole or notch drops every
 * grid cell it intersects, so the opening is a stair-step around the true
 * cut. Manifold reuses a face id on disconnected coplanar walls; a pick
 * keeps the connected patch nearest the stored point.
 *
 * A general thin solid, with no sheet spec, does not get a midsurface here.
 * A medial-axis or paired-offset heuristic is intentionally not implemented.
 * It mis-classifies bends, holes, and coplanar unions, and the phone memory
 * budget is spent on this exact path instead. `SHELL_HEURISTIC` stays false.
 * `study.model: "shell"` on a non-sheet part falls back to TET10 with a
 * warning. `study.model: "solid"` always uses TET10. `study.model: "auto"`
 * uses this shell for a pure `sheetMetalSolid` part and TET10 otherwise.
 */

import { scriptOutsideFeaStudy } from './studyScript.js';
import { faceArea, faceTractionForces, quadShape } from './traction.js';
import { readSheetMetalSpec } from '../utils/sheetMetal/sheetMetalScript.js';
import {
  normalizeSheetSpec,
  solveSheet,
  vAdd,
  vDot,
  vMul,
  vSub,
} from '../utils/sheetMetal/sheetModel.js';

/** Paired-offset midsurface for arbitrary thin solids. Not implemented. */
export const SHELL_HEURISTIC = false;

/** Quad cells across the smallest flange or bend arc. Lands on 2 or 3. */
export const SHELL_ELEMENTS_ACROSS = 2.5;

const WELD_SCALE = 1e4;

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function panelById(solved, id) {
  return solved.panels.find((panel) => panel.id === id) || null;
}

function rotatedN(d, normal, phi, flip) {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return flip
    ? vAdd(vMul(s, d), vMul(c, normal))
    : vAdd(vMul(-s, d), vMul(c, normal));
}

function bendPoint(bend, phi, q, rMid) {
  const normal = rotatedN(bend.d, bend.N, phi, bend.flip);
  const axial = vAdd(bend.axis, vMul(q, bend.e));
  const radial = vMul(rMid, normal);
  return bend.flip ? vAdd(axial, radial) : vSub(axial, radial);
}

function bendPhi(bend, radial) {
  const ref = bend.flip ? bend.N : [-bend.N[0], -bend.N[1], -bend.N[2]];
  const refPerp = bend.d;
  const x = vDot(radial, ref);
  const y = vDot(radial, refPerp);
  return Math.atan2(y, x);
}

function coordOfQ(edge, q) {
  switch (edge) {
    case 'u+': return { axis: 'v', value: q };
    case 'u-': return { axis: 'v', value: -q };
    case 'v+': return { axis: 'u', value: -q };
    case 'v-': return { axis: 'u', value: q };
    default: return null;
  }
}

function qOfCoord(edge, u, v) {
  switch (edge) {
    case 'u+': return v;
    case 'u-': return -v;
    case 'v+': return -u;
    case 'v-': return u;
    default: return 0;
  }
}

/**
 * A pure `let part = sheetMetalSolid(sheetSpec)` script, or null.
 * A sheet unioned onto other geometry stays on TET10: the render mesh is
 * not the sheet alone.
 */
export function shellSheetFromScript(script) {
  const raw = readSheetMetalSpec(script);
  if (!raw) return null;
  const body = scriptOutsideFeaStudy(String(script || ''));
  if (!/let\s+part\s*=\s*sheetMetalSolid\s*\(/.test(body)) return null;
  if (/part\s*=\s*part\.add\s*\(\s*sheetMetalSolid\s*\(/.test(body)) return null;
  const withoutSheet = body
    .replace(/\/\/ --- sheet-metal begin ---[\s\S]*?\/\/ --- sheet-metal end ---/g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\breturn\s+part\s*;?/g, '')
    .trim();
  if (withoutSheet.length > 0) return null;
  return normalizeSheetSpec(raw);
}

/**
 * `auto` selects the shell for a pure sheet and TET10 otherwise.
 * `solid` always selects TET10. `shell` without a sheet spec cannot build
 * a midsurface (`SHELL_HEURISTIC` is false) and falls back to TET10.
 */
export function chooseAnalysisModel(study, sheetSpec) {
  const requested = study && study.model ? study.model : 'auto';
  if (requested === 'solid') return { kind: 'solid', warning: null };
  if (sheetSpec) return { kind: 'shell', warning: null };
  if (requested === 'shell') {
    return {
      kind: 'solid',
      warning: {
        code: 'shell-heuristic-deferred',
        msg: 'Shell elements need a midsurface. This part was not built with sheetMetalSolid, and the general thin-solid midsurface is not implemented, so the solid was solved with TET10. Set model to "solid" to keep that choice.',
      },
    };
  }
  return { kind: 'solid', warning: null };
}

function featureSize(solved) {
  const sizes = [];
  const push = (value) => {
    if (value > 0.5) sizes.push(value);
  };
  for (const panel of solved.panels) {
    push(panel.u1 - panel.u0);
    push(panel.v1 - panel.v0);
  }
  for (const tab of solved.tabs) {
    push(tab.depth);
    push(tab.q1 - tab.q0);
  }
  const rMid = solved.r + solved.t / 2;
  for (const bend of solved.bends) {
    push(bend.theta * rMid);
  }
  if (!sizes.length) return solved.t > 0 ? solved.t : 1;
  return Math.min(...sizes);
}

function midsurfaceArea(solved) {
  let area = 0;
  for (const panel of solved.panels) area += Math.max(0, panel.u1 - panel.u0) * Math.max(0, panel.v1 - panel.v0);
  for (const tab of solved.tabs) area += Math.max(0, tab.depth) * Math.max(0, tab.q1 - tab.q0);
  const rMid = solved.r + solved.t / 2;
  for (const bend of solved.bends) area += Math.max(0, bend.theta) * rMid * Math.max(0, bend.q1 - bend.q0);
  for (const hole of solved.holes) {
    const radius = Number(hole.d) / 2;
    if (radius > 0) area -= Math.PI * radius * radius;
  }
  for (const notch of solved.notches) area -= Math.max(0, notch.u1 - notch.u0) * Math.max(0, notch.v1 - notch.v0);
  return Math.max(area, 1);
}

/** Quadratic shell: about 4 nodes per h² of area, 6 DOF each. */
export function shellEdgeForArea(area, preferredEdge, cap) {
  const preferred = preferredEdge > 0 ? preferredEdge : 1;
  if (!Number.isFinite(cap) || !(cap > 0) || !(area > 0)) {
    return { edgeLength: preferred, coarsened: false };
  }
  const capped = Math.sqrt((24 * area) / cap);
  if (capped > preferred * 1.02) return { edgeLength: capped, coarsened: true };
  return { edgeLength: preferred, coarsened: false };
}

function cornerLines(a, b, edge, cuts) {
  const span = b - a;
  if (!(span > 1e-9)) return [a, b];
  const eps = Math.max(1e-6, span * 1e-8);
  const inside = [];
  for (const cut of cuts || []) {
    if (cut > a + eps && cut < b - eps) inside.push(cut);
  }
  inside.sort((left, right) => left - right);
  const stops = [a];
  for (const cut of inside) {
    if (cut - stops[stops.length - 1] > eps) stops.push(cut);
  }
  if (b - stops[stops.length - 1] > eps) stops.push(b);
  else stops[stops.length - 1] = b;
  const corners = [stops[0]];
  for (let i = 0; i < stops.length - 1; i += 1) {
    const lo = stops[i];
    const hi = stops[i + 1];
    const n = Math.max(1, Math.round((hi - lo) / edge));
    for (let k = 1; k <= n; k += 1) corners.push(lo + (hi - lo) * (k / n));
  }
  return corners;
}

function withMids(corners) {
  if (corners.length < 2) return corners.slice();
  const out = [];
  for (let i = 0; i < corners.length - 1; i += 1) {
    out.push(corners[i]);
    out.push(0.5 * (corners[i] + corners[i + 1]));
  }
  out.push(corners[corners.length - 1]);
  return out;
}

function collectCuts(solved) {
  const cuts = new Map();
  const ensure = (id) => {
    if (!cuts.has(id)) cuts.set(id, { u: [], v: [] });
    return cuts.get(id);
  };
  for (const tab of solved.tabs) {
    const mapped0 = coordOfQ(tab.edge, tab.q0);
    const mapped1 = coordOfQ(tab.edge, tab.q1);
    if (!mapped0 || !mapped1) continue;
    const bucket = ensure(tab.panel);
    bucket[mapped0.axis].push(mapped0.value, mapped1.value);
  }
  for (const notch of solved.notches) {
    const bucket = ensure(notch.panel || 'base');
    bucket.u.push(notch.u0, notch.u1);
    bucket.v.push(notch.v0, notch.v1);
  }
  let guard = solved.bends.length + 2;
  let changed = true;
  while (changed && guard > 0) {
    changed = false;
    guard -= 1;
    for (const bend of solved.bends) {
      const child = cuts.get(bend.id);
      if (!child) continue;
      const bucket = ensure(bend.panel);
      for (const value of child.v) {
        const mapped = coordOfQ(bend.edge, value);
        if (!mapped) continue;
        const list = bucket[mapped.axis];
        if (!list.some((item) => Math.abs(item - mapped.value) < 1e-6)) {
          list.push(mapped.value);
          changed = true;
        }
      }
    }
  }
  return cuts;
}

function createBuilder() {
  const coords = [];
  const map = new Map();
  return {
    coords,
    add(point) {
      const key = `${Math.round(point[0] * WELD_SCALE)},${Math.round(point[1] * WELD_SCALE)},${Math.round(point[2] * WELD_SCALE)}`;
      const found = map.get(key);
      if (found !== undefined) return found;
      const id = coords.length / 3;
      coords.push(point[0], point[1], point[2]);
      map.set(key, id);
      return id;
    },
    at(id) {
      return [coords[id * 3], coords[id * 3 + 1], coords[id * 3 + 2]];
    },
  };
}

function orientElement(ids, builder, director) {
  const p0 = builder.at(ids[0]);
  const p1 = builder.at(ids[1]);
  const p2 = builder.at(ids[2]);
  const normal = cross(sub(p1, p0), sub(p2, p0));
  if (dot(normal, director) >= 0) return ids;
  return [ids[0], ids[2], ids[1], ids[5], ids[4], ids[3]];
}

function emitGrid(builder, sLines, tLines, pointAt, directorAt, blocked, regionIndex, bag) {
  const nu = sLines.length;
  const nv = tLines.length;
  if (nu < 3 || nv < 3) return;
  const cache = new Map();
  const at = (i, j) => {
    const key = `${i},${j}`;
    const found = cache.get(key);
    if (found !== undefined) return found;
    const id = builder.add(pointAt(sLines[i], tLines[j]));
    cache.set(key, id);
    return id;
  };
  for (let j = 0; j <= nv - 3; j += 2) {
    for (let i = 0; i <= nu - 3; i += 2) {
      const s0 = sLines[i];
      const s1 = sLines[i + 2];
      const t0 = tLines[j];
      const t1 = tLines[j + 2];
      if (blocked(s0, s1, t0, t1)) continue;
      const n00 = at(i, j);
      const n20 = at(i + 2, j);
      const n22 = at(i + 2, j + 2);
      const n02 = at(i, j + 2);
      const m10 = at(i + 1, j);
      const m21 = at(i + 2, j + 1);
      const m12 = at(i + 1, j + 2);
      const m01 = at(i, j + 1);
      const mid = at(i + 1, j + 1);
      const sc = 0.5 * (s0 + s1);
      const tc = 0.5 * (t0 + t1);
      const director = directorAt(sc, tc);
      const triA = orientElement([n00, n20, n22, m10, m21, mid], builder, director);
      const triB = orientElement([n00, n22, n02, mid, m12, m01], builder, director);
      for (const tri of [triA, triB]) {
        const element = bag.elements.length / 6;
        for (let k = 0; k < 6; k += 1) bag.elements.push(tri[k]);
        bag.elementRegion.push(regionIndex);
        bag.directors.push(director[0], director[1], director[2]);
        bag.regions[regionIndex].elements.push(element);
      }
    }
  }
}

function sliceParameter(lines, lo, hi) {
  const eps = 1e-6;
  const sorted = lines.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  let start = -1;
  let end = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (Math.abs(sorted[i].value - lo) <= eps) start = i;
    if (Math.abs(sorted[i].value - hi) <= eps) end = i;
  }
  if (start < 0 || end < 0 || end - start < 2 || (end - start) % 2 !== 0) return null;
  return sorted.slice(start, end + 1).map((item) => item.value);
}

function edgeQLines(edge, uLines, vLines) {
  let values;
  if (edge === 'u+' || edge === 'u-') values = vLines.map((v) => qOfCoord(edge, 0, v));
  else values = uLines.map((u) => qOfCoord(edge, u, 0));
  values.sort((a, b) => a - b);
  return values;
}

function buildAt(spec, solved, edge) {
  const t = solved.t;
  const rMid = solved.r + t / 2;
  const cuts = collectCuts(solved);
  const builder = createBuilder();
  const bag = { elements: [], elementRegion: [], directors: [], regions: [] };
  const panelLines = new Map();
  const margin = Math.max(0.75, t * 0.35);

  function holesFor(panelId) {
    const holes = [];
    for (const hole of solved.holes) {
      if (hole.panel !== panelId) continue;
      const radius = Number(hole.d) / 2;
      if (!(radius > 0)) continue;
      holes.push({ id: hole.id, u: Number(hole.u) || 0, v: Number(hole.v) || 0, r: radius });
    }
    return holes;
  }

  function notchesFor(panelId) {
    if (panelId !== 'base') return [];
    return solved.notches.filter((notch) => (notch.panel || 'base') === panelId);
  }

  function blockedFn(holes, notches) {
    return (s0, s1, t0, t1) => {
      const uc = 0.5 * (s0 + s1);
      const vc = 0.5 * (t0 + t1);
      for (const notch of notches) {
        if (uc > notch.u0 && uc < notch.u1 && vc > notch.v0 && vc < notch.v1) return true;
      }
      for (const hole of holes) {
        const closestU = Math.min(Math.max(hole.u, s0), s1);
        const closestV = Math.min(Math.max(hole.v, t0), t1);
        if (Math.hypot(closestU - hole.u, closestV - hole.v) <= hole.r) return true;
      }
      return false;
    };
  }

  function addPanelRegion(panel, kind) {
    const region = {
      id: `${kind}:${panel.id}`,
      kind,
      panelId: panel.id,
      o: panel.o,
      U: panel.U,
      V: panel.V,
      N: panel.N,
      u0: panel.u0,
      u1: panel.u1,
      v0: panel.v0,
      v1: panel.v1,
      t,
      margin,
      holes: holesFor(panel.id),
      elements: [],
    };
    const index = bag.regions.length;
    bag.regions.push(region);
    return index;
  }

  function meshPanel(panel, prescribedV) {
    const bucket = cuts.get(panel.id) || { u: [], v: [] };
    const uLines = withMids(cornerLines(panel.u0, panel.u1, edge, bucket.u));
    const vLines = prescribedV && prescribedV.length >= 3
      ? prescribedV
      : withMids(cornerLines(panel.v0, panel.v1, edge, bucket.v));
    panelLines.set(panel.id, { uLines, vLines });
    const index = addPanelRegion(panel, 'panel');
    const holes = holesFor(panel.id);
    const notches = notchesFor(panel.id);
    emitGrid(
      builder,
      uLines,
      vLines,
      (u, v) => vAdd(vAdd(vAdd(panel.o, vMul(u, panel.U)), vMul(v, panel.V)), vMul(t / 2, panel.N)),
      () => panel.N,
      blockedFn(holes, notches),
      index,
      bag,
    );
  }

  function meshBend(bend, qLines) {
    const arc = bend.theta * rMid;
    const cells = Math.max(2, Math.round(arc / edge));
    const phiLines = withMids(cornerLines(0, bend.theta, arc / cells, []));
    const lines = qLines && qLines.length >= 3 ? qLines : withMids(cornerLines(bend.q0, bend.q1, edge, []));
    const region = {
      id: `bend:${bend.id}`,
      kind: 'bend',
      panelId: bend.id,
      axis: bend.axis,
      d: bend.d,
      e: bend.e,
      N: bend.N,
      flip: bend.flip,
      q0: bend.q0,
      q1: bend.q1,
      theta: bend.theta,
      rMid,
      rIn: solved.r,
      rOut: solved.r + t,
      t,
      margin,
      holes: [],
      elements: [],
    };
    const index = bag.regions.length;
    bag.regions.push(region);
    emitGrid(
      builder,
      phiLines,
      lines,
      (phi, q) => bendPoint(bend, phi, q, rMid),
      (phi) => rotatedN(bend.d, bend.N, phi, bend.flip),
      () => false,
      index,
      bag,
    );
    return lines;
  }

  function meshTab(tab) {
    const parent = panelLines.get(tab.panel);
    if (!parent) return;
    const qLines = sliceParameter(edgeQLines(tab.edge, parent.uLines, parent.vLines), tab.q0, tab.q1)
      || withMids(cornerLines(tab.q0, tab.q1, edge, []));
    const depthLines = withMids(cornerLines(0, tab.depth, edge, []));
    const origin = vAdd(tab.E0, vMul(tab.q0, tab.e));
    const region = {
      id: `tab:${tab.id}`,
      kind: 'tab',
      panelId: tab.id,
      o: origin,
      U: tab.d,
      V: tab.e,
      N: tab.N,
      u0: 0,
      u1: tab.depth,
      v0: 0,
      v1: tab.q1 - tab.q0,
      t,
      margin,
      holes: [],
      elements: [],
    };
    const index = bag.regions.length;
    bag.regions.push(region);
    emitGrid(
      builder,
      depthLines,
      qLines.map((q) => q - tab.q0),
      (s, localQ) => vAdd(vAdd(vAdd(tab.E0, vMul(t / 2, tab.N)), vMul(s, tab.d)), vMul(tab.q0 + localQ, tab.e)),
      () => tab.N,
      () => false,
      index,
      bag,
    );
  }

  const base = panelById(solved, 'base');
  if (!base) throw new Error('The sheet has no base panel to mesh.');
  meshPanel(base, null);
  for (const bend of solved.bends) {
    const parent = panelLines.get(bend.panel);
    const full = parent ? edgeQLines(bend.edge, parent.uLines, parent.vLines) : [];
    const qLines = sliceParameter(full, bend.q0, bend.q1);
    const used = meshBend(bend, qLines);
    const child = panelById(solved, bend.id);
    if (child) meshPanel(child, used);
  }
  for (const tab of solved.tabs) meshTab(tab);

  if (!bag.elements.length) throw new Error('The sheet mid-surface has no shell elements.');
  const nodeCount = builder.coords.length / 3;
  return {
    nodes: Float64Array.from(builder.coords),
    elements: Uint32Array.from(bag.elements),
    elementRegion: Uint16Array.from(bag.elementRegion),
    directors: Float64Array.from(bag.directors),
    regions: bag.regions,
    thickness: t,
    builder,
    stats: {
      nodes: nodeCount,
      elements: bag.elements.length / 6,
      dofs: nodeCount * 6,
      edgeLength: edge,
      thickness: t,
      wasmBytes: builder.coords.length * 8 + bag.elements.length * 4,
    },
  };
}

/**
 * Mid-surface mesh at an auto edge (2–3 elements across the smallest flange
 * or bend), grown if `cap` degrees of freedom would be passed.
 */
export function buildSheetShell(spec, { target = 'auto', cap = Infinity } = {}) {
  const normalized = normalizeSheetSpec(spec);
  if (!normalized) throw new Error('The sheet spec needs t, width, and height.');
  const solved = solveSheet(normalized);
  if (solved.errors.length) throw new Error(solved.errors[0]);
  const feature = featureSize(solved);
  const explicit = typeof target === 'number' && Number.isFinite(target) && target > 0;
  const requested = explicit ? target : feature / SHELL_ELEMENTS_ACROSS;
  const area = midsurfaceArea(solved);
  let fitted = shellEdgeForArea(area, requested, cap);
  let edge = fitted.edgeLength;
  const started = Date.now();
  let mesh = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    mesh = buildAt(normalized, solved, edge);
    if (!Number.isFinite(cap) || mesh.stats.dofs <= cap) break;
    const grown = edge * Math.sqrt(mesh.stats.dofs / cap) * 1.08;
    if (!(grown > edge * 1.02)) break;
    edge = grown;
    fitted = { edgeLength: edge, coarsened: true };
  }
  mesh.stats.ms = Date.now() - started;
  mesh.stats.requested = requested;
  mesh.stats.feature = feature;
  mesh.stats.coarsened = fitted.coarsened || edge > requested * 1.02;
  mesh.stats.area = area;
  mesh.spec = normalized;
  delete mesh.builder;
  return mesh;
}

function localOf(region, point) {
  const rel = vSub(point, region.o);
  return [vDot(rel, region.U), vDot(rel, region.V), vDot(rel, region.N)];
}

function projectRegion(region, point) {
  if (region.kind === 'bend') {
    const rel = vSub(point, region.axis);
    const q = vDot(rel, region.e);
    const radial = vSub(rel, vMul(q, region.e));
    const radius = length(radial);
    const phi = radius > 1e-9 ? bendPhi(region, radial) : 0;
    const phiC = Math.min(Math.max(phi, 0), region.theta);
    const qC = Math.min(Math.max(q, region.q0), region.q1);
    const director = rotatedN(region.d, region.N, phiC, region.flip);
    const mid = bendPoint(region, phiC, qC, region.rMid);
    const zeta = region.flip
      ? (radius - region.rMid) / (region.t / 2)
      : (region.rMid - radius) / (region.t / 2);
    const inside = phi >= -0.08 && phi <= region.theta + 0.08
      && q >= region.q0 - region.margin && q <= region.q1 + region.margin
      && radius >= region.rIn - region.margin && radius <= region.rOut + region.margin;
    const dist = Math.hypot(radius - region.rMid, q - qC, (phi - phiC) * region.rMid);
    return { mid, zeta, inside, dist, director, phi, q };
  }
  const [u, v, w] = localOf(region, point);
  const uc = Math.min(Math.max(u, region.u0), region.u1);
  const vc = Math.min(Math.max(v, region.v0), region.v1);
  const mid = vAdd(region.o, vAdd(vMul(uc, region.U), vAdd(vMul(vc, region.V), vMul(region.t / 2, region.N))));
  const zeta = (w - region.t / 2) / (region.t / 2);
  const inside = u >= region.u0 - region.margin && u <= region.u1 + region.margin
    && v >= region.v0 - region.margin && v <= region.v1 + region.margin
    && w >= -region.margin && w <= region.t + region.margin;
  const dist = Math.hypot(u - uc, v - vc, w - region.t / 2);
  return { mid, zeta, inside, dist, director: region.N, u, v, w };
}

function nearestEdgeKey(region, proj) {
  if (region.kind === 'bend') {
    const scores = [
      ['phi0', Math.abs(proj.phi || 0) * region.rMid],
      ['phi1', Math.abs((proj.phi || 0) - region.theta) * region.rMid],
      ['q0', Math.abs((proj.q || 0) - region.q0)],
      ['q1', Math.abs((proj.q || 0) - region.q1)],
    ];
    scores.sort((a, b) => a[1] - b[1]);
    return `${region.id}:${scores[0][0]}`;
  }
  const u = proj.u;
  const v = proj.v;
  const scores = [
    ['u-', Math.abs(u - region.u0)],
    ['u+', Math.abs(u - region.u1)],
    ['v-', Math.abs(v - region.v0)],
    ['v+', Math.abs(v - region.v1)],
  ];
  for (const hole of region.holes || []) {
    const d = Math.hypot(u - hole.u, v - hole.v);
    scores.push([`hole:${hole.id}`, Math.abs(d - hole.r)]);
  }
  scores.sort((a, b) => a[1] - b[1]);
  return `${region.id}:${scores[0][0]}`;
}

function classifyPoint(mesh, point, normal) {
  let best = null;
  for (let i = 0; i < mesh.regions.length; i += 1) {
    const region = mesh.regions[i];
    const proj = projectRegion(region, point);
    if (!proj.inside) continue;
    if (Math.abs(proj.zeta) > 1.6) continue;
    if (best && proj.dist > best.proj.dist + 1e-6) continue;
    if (best && Math.abs(proj.dist - best.proj.dist) <= 1e-6 && region.kind === 'bend' && best.region.kind !== 'bend') {
      continue;
    }
    best = { region, index: i, proj };
  }
  if (!best) return null;
  const align = normal ? dot(normal, best.proj.director) : 0;
  let side = 'edge';
  if (align > 0.65) side = 'top';
  else if (align < -0.65) side = 'bottom';
  const edgeKey = side === 'edge' ? nearestEdgeKey(best.region, best.proj) : null;
  return { ...best, side, edgeKey, align };
}

function triangleGeometry(positions, indices, triangle) {
  const a = indices[triangle * 3];
  const b = indices[triangle * 3 + 1];
  const c = indices[triangle * 3 + 2];
  const pa = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
  const pb = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
  const pc = [positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]];
  const normal = cross(sub(pb, pa), sub(pc, pa));
  const norm = length(normal);
  const area = 0.5 * norm;
  return {
    centroid: [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3],
    normal: norm > 0 ? [normal[0] / norm, normal[1] / norm, normal[2] / norm] : [0, 0, 0],
    area,
  };
}

function allTriangles(positions, indices, faceIDs) {
  const count = Math.floor(Math.min(indices.length, (faceIDs ? faceIDs.length : 0) * 3) / 3);
  const triangles = [];
  for (let t = 0; t < count; t += 1) {
    const geom = triangleGeometry(positions, indices, t);
    triangles.push({
      index: t,
      faceId: faceIDs[t],
      ids: [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]],
      ...geom,
    });
  }
  return triangles;
}

/** Triangles that share a vertex are one wall. Coplanar Manifold ids are not. */
function connectedPatches(triangles) {
  const parent = triangles.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const byNode = new Map();
  for (let i = 0; i < triangles.length; i += 1) {
    for (const node of triangles[i].ids) {
      const previous = byNode.get(node);
      if (previous === undefined) byNode.set(node, i);
      else union(previous, i);
    }
  }
  const groups = new Map();
  for (let i = 0; i < triangles.length; i += 1) {
    const root = find(i);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(triangles[i]);
  }
  return [...groups.values()].map(summarizePatch);
}

function summarizePatch(triangles) {
  let area = 0;
  const centroid = [0, 0, 0];
  const normal = [0, 0, 0];
  for (const tri of triangles) {
    const weight = tri.area > 0 ? tri.area : 0;
    area += weight;
    centroid[0] += tri.centroid[0] * weight;
    centroid[1] += tri.centroid[1] * weight;
    centroid[2] += tri.centroid[2] * weight;
    normal[0] += tri.normal[0] * weight;
    normal[1] += tri.normal[1] * weight;
    normal[2] += tri.normal[2] * weight;
  }
  if (area > 0) {
    centroid[0] /= area;
    centroid[1] /= area;
    centroid[2] /= area;
  }
  const n = length(normal);
  return {
    triangles,
    area,
    centroid,
    normal: n > 0 ? [normal[0] / n, normal[1] / n, normal[2] / n] : [0, 0, 0],
  };
}

function idsOfFace(face) {
  const ids = new Set();
  if (Array.isArray(face.triangleFaceIDs)) {
    for (const id of face.triangleFaceIDs) {
      if (Number.isInteger(id) && id >= 0) ids.add(id);
    }
  }
  if (Number.isInteger(face.faceID) && face.faceID >= 0) ids.add(face.faceID);
  return ids;
}

function matchGroups(triangles, faces, diagonal) {
  const byId = new Map();
  for (const tri of triangles) {
    let list = byId.get(tri.faceId);
    if (!list) {
      list = [];
      byId.set(tri.faceId, list);
    }
    list.push(tri);
  }
  const chosen = [];
  const used = new Set();
  const unmatched = [];
  const tol = Math.max(1, (diagonal || 1) * 0.02);
  for (const face of faces || []) {
    const ids = idsOfFace(face);
    const listed = [];
    for (const id of ids) {
      const group = byId.get(id);
      if (group) listed.push(...group);
    }
    const at = Array.isArray(face.at) ? face.at : null;
    const normal = Array.isArray(face.n) ? face.n : null;
    const pool = listed.length ? connectedPatches(listed) : connectedPatches(triangles);
    let best = null;
    let bestDist = Infinity;
    for (const patch of pool) {
      if (patch.triangles.some((tri) => used.has(tri.index))) continue;
      if (normal && dot(patch.normal, normal) < 0.85) continue;
      const dist = at
        ? Math.hypot(patch.centroid[0] - at[0], patch.centroid[1] - at[1], patch.centroid[2] - at[2])
        : 0;
      if (!listed.length && dist > tol) continue;
      if (dist >= bestDist) continue;
      best = patch;
      bestDist = dist;
    }
    if (!best) {
      unmatched.push(face);
      continue;
    }
    chosen.push(best);
    for (const tri of best.triangles) used.add(tri.index);
  }
  return { groups: chosen, unmatched };
}

function regionNodes(mesh, regionIndex) {
  const seen = new Set();
  const region = mesh.regions[regionIndex];
  for (const element of region.elements) {
    for (let k = 0; k < 6; k += 1) seen.add(mesh.elements[element * 6 + k]);
  }
  return seen;
}

function nodesForEdge(mesh, regionIndex, edgeKey) {
  const region = mesh.regions[regionIndex];
  const tag = edgeKey.slice(region.id.length + 1);
  const tol = Math.max(0.05, mesh.stats.edgeLength * 0.2);
  const nodes = new Set();
  for (const id of regionNodes(mesh, regionIndex)) {
    const point = [mesh.nodes[id * 3], mesh.nodes[id * 3 + 1], mesh.nodes[id * 3 + 2]];
    const proj = projectRegion(region, point);
    if (region.kind === 'bend') {
      const dPhi0 = Math.abs(proj.phi) * region.rMid;
      const dPhi1 = Math.abs(proj.phi - region.theta) * region.rMid;
      const dQ0 = Math.abs(proj.q - region.q0);
      const dQ1 = Math.abs(proj.q - region.q1);
      const hit = (tag === 'phi0' && dPhi0 <= tol)
        || (tag === 'phi1' && dPhi1 <= tol)
        || (tag === 'q0' && dQ0 <= tol)
        || (tag === 'q1' && dQ1 <= tol);
      if (hit) nodes.add(id);
      continue;
    }
    if (tag.startsWith('hole:')) {
      const holeId = tag.slice(5);
      const hole = (region.holes || []).find((item) => item.id === holeId);
      if (!hole) continue;
      const d = Math.hypot(proj.u - hole.u, proj.v - hole.v);
      if (Math.abs(d - hole.r) <= Math.max(tol, mesh.stats.edgeLength * 0.75)) nodes.add(id);
      continue;
    }
    const on = (tag === 'u-' && Math.abs(proj.u - region.u0) <= tol)
      || (tag === 'u+' && Math.abs(proj.u - region.u1) <= tol)
      || (tag === 'v-' && Math.abs(proj.v - region.v0) <= tol)
      || (tag === 'v+' && Math.abs(proj.v - region.v1) <= tol);
    if (on) nodes.add(id);
  }
  return nodes;
}

function addForce(into, node, force) {
  const prev = into.get(node) || [0, 0, 0];
  prev[0] += force[0];
  prev[1] += force[1];
  prev[2] += force[2];
  into.set(node, prev);
}

function elementXyz(mesh, element) {
  const xyz = [];
  for (let k = 0; k < 6; k += 1) {
    const node = mesh.elements[element * 6 + k];
    xyz.push([mesh.nodes[node * 3], mesh.nodes[node * 3 + 1], mesh.nodes[node * 3 + 2]]);
  }
  return xyz;
}

function interpretFace(mesh, group) {
  let surfaceArea = 0;
  let edgeArea = 0;
  const regions = new Map();
  const edges = new Map();
  let align = 0;
  let alignArea = 0;
  for (const tri of group.triangles) {
    const found = classifyPoint(mesh, tri.centroid, tri.normal);
    if (!found) continue;
    if (found.side === 'edge') {
      edgeArea += tri.area;
      edges.set(found.edgeKey, (edges.get(found.edgeKey) || 0) + tri.area);
    } else {
      surfaceArea += tri.area;
      const prev = regions.get(found.index) || { area: 0, align: 0 };
      prev.area += tri.area;
      prev.align += found.align * tri.area;
      regions.set(found.index, prev);
      align += found.align * tri.area;
      alignArea += tri.area;
    }
  }
  const surface = surfaceArea >= edgeArea && regions.size > 0;
  return {
    surface,
    regions: [...regions.entries()].map(([index, value]) => ({
      index,
      sign: value.align >= 0 ? 1 : -1,
    })),
    edges: [...edges.keys()],
    sign: alignArea > 0 && align < 0 ? -1 : 1,
  };
}

function distributeEdgeForce(mesh, nodes, vector) {
  const forces = new Map();
  const ids = [...nodes];
  if (!ids.length) return forces;
  if (ids.length === 1) {
    forces.set(ids[0], [vector[0], vector[1], vector[2]]);
    return forces;
  }
  const share = 1 / ids.length;
  for (const id of ids) forces.set(id, [vector[0] * share, vector[1] * share, vector[2] * share]);
  return forces;
}

/**
 * Fixtures and loads picked on the solid, written as shell clamps, nodal
 * forces, and element pressures.
 */
export function shellBoundaryConditions(mesh, positions, indices, faceIDs, study, { diagonal = 1 } = {}) {
  const warnings = [];
  const triangles = allTriangles(positions, indices, faceIDs);
  const clamped = new Set();
  const fixtures = (study && study.fixtures) || [];
  for (const fixture of fixtures) {
    const matched = matchGroups(triangles, fixture.faces || [], diagonal);
    if (!matched.groups.length || matched.unmatched.length) {
      throw new Error('A fixed face is not on this sheet. Pick the face again.');
    }
    for (const group of matched.groups) {
      const use = interpretFace(mesh, group);
      if (!use.surface && !use.edges.length) {
        throw new Error('A fixed face did not land on the sheet mid-surface.');
      }
      if (use.surface) {
        for (const region of use.regions) {
          for (const node of regionNodes(mesh, region.index)) clamped.add(node);
        }
      } else {
        for (const edgeKey of use.edges) {
          const region = mesh.regions.find((item) => edgeKey.startsWith(`${item.id}:`));
          const index = region ? mesh.regions.indexOf(region) : -1;
          if (index < 0) continue;
          for (const node of nodesForEdge(mesh, index, edgeKey)) clamped.add(node);
        }
      }
    }
  }

  const forces = new Map();
  const pressureElements = [];
  const pressures = [];
  for (const load of (study && study.loads) || []) {
    const matched = matchGroups(triangles, load.faces || [], diagonal);
    if (!matched.groups.length || matched.unmatched.length) {
      throw new Error('A loaded face is not on this sheet. Pick the face again.');
    }
    const uses = matched.groups.map((group) => interpretFace(mesh, group));
    if (load.kind === 'pressure') {
      const pressure = Number(load.pressure_MPa);
      const seen = new Set();
      for (const use of uses) {
        if (!use.surface) {
          warnings.push({
            code: 'shell-edge-pressure',
            msg: 'Pressure on a sheet edge is applied to the adjoining mid-surface region.',
          });
        }
        for (const region of (use.surface ? use.regions : [])) {
          const sign = region.sign;
          for (const element of mesh.regions[region.index].elements) {
            if (seen.has(element)) continue;
            seen.add(element);
            pressureElements.push(element);
            pressures.push(pressure * sign);
          }
        }
        if (!use.surface) {
          for (const edgeKey of use.edges) {
            const region = mesh.regions.find((item) => edgeKey.startsWith(`${item.id}:`));
            const index = region ? mesh.regions.indexOf(region) : -1;
            if (index < 0) continue;
            for (const element of mesh.regions[index].elements) {
              if (seen.has(element)) continue;
              seen.add(element);
              pressureElements.push(element);
              pressures.push(pressure * use.sign);
            }
          }
        }
      }
      continue;
    }
    const vector = load.vector || [0, 0, 0];
    const surfaceRegions = new Set();
    const edgeNodes = new Set();
    for (const use of uses) {
      if (use.surface) {
        for (const region of use.regions) surfaceRegions.add(region.index);
      } else {
        for (const edgeKey of use.edges) {
          const region = mesh.regions.find((item) => edgeKey.startsWith(`${item.id}:`));
          const index = region ? mesh.regions.indexOf(region) : -1;
          if (index < 0) continue;
          for (const node of nodesForEdge(mesh, index, edgeKey)) edgeNodes.add(node);
        }
      }
    }
    if (surfaceRegions.size) {
      const seen = new Set();
      let surfaceArea = 0;
      const elements = [];
      for (const index of surfaceRegions) {
        for (const element of mesh.regions[index].elements) {
          if (seen.has(element)) continue;
          seen.add(element);
          elements.push(element);
          surfaceArea += faceArea(elementXyz(mesh, element));
        }
      }
      if (!(surfaceArea > 0)) throw new Error('A loaded face has no shell area.');
      const traction = [vector[0] / surfaceArea, vector[1] / surfaceArea, vector[2] / surfaceArea];
      for (const element of elements) {
        const xyz = elementXyz(mesh, element);
        const nodal = faceTractionForces(xyz, traction);
        for (let k = 0; k < 6; k += 1) addForce(forces, mesh.elements[element * 6 + k], nodal[k]);
      }
    } else if (edgeNodes.size) {
      for (const [node, force] of distributeEdgeForce(mesh, edgeNodes, vector)) addForce(forces, node, force);
    } else {
      throw new Error('A loaded face did not land on the sheet mid-surface.');
    }
  }

  if (fixtures.length && clamped.size === 0) {
    throw new Error('Fix a face before running the study.');
  }
  return {
    clampedNodes: Uint32Array.from(clamped),
    forceNodes: Uint32Array.from(forces.keys()),
    forceValues: Float64Array.from([...forces.values()].flat()),
    pressureElements: Uint32Array.from(pressureElements),
    pressures: Float64Array.from(pressures),
    warnings,
  };
}

function closestPointOnTriangle(p, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, scale(ac, w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }
  const denom = va + vb + vc;
  if (denom === 0) return a;
  const inv = 1 / denom;
  return add(a, add(scale(ab, vb * inv), scale(ac, vc * inv)));
}

function barycentric(p, a, b, c) {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denom = d00 * d11 - d01 * d01;
  if (denom === 0) return [1, 0, 0];
  const l1 = (d11 * d20 - d01 * d21) / denom;
  const l2 = (d00 * d21 - d01 * d20) / denom;
  return [1 - l1 - l2, l1, l2];
}

function interpolate(bary, values) {
  const n = quadShape(bary[0], bary[1], bary[2]);
  let value = 0;
  for (let i = 0; i < 6; i += 1) value += n[i] * values[i];
  return value;
}

function elementCorners(mesh, element) {
  const ids = mesh.elements;
  const base = element * 6;
  const corner = (slot) => {
    const node = ids[base + slot];
    return [mesh.nodes[node * 3], mesh.nodes[node * 3 + 1], mesh.nodes[node * 3 + 2]];
  };
  return [corner(0), corner(1), corner(2)];
}

function locate(mesh, regionIndex, point) {
  const region = mesh.regions[regionIndex];
  let bestDist = Infinity;
  let best = null;
  for (const element of region.elements) {
    const corners = elementCorners(mesh, element);
    const q = closestPointOnTriangle(point, corners[0], corners[1], corners[2]);
    const dist = length(sub(point, q));
    if (dist < bestDist) {
      bestDist = dist;
      best = { element, bary: barycentric(q, corners[0], corners[1], corners[2]), dist };
    }
  }
  return best;
}

function fibreValue(top, mid, bottom, zeta) {
  const z = Math.max(-1, Math.min(1, zeta));
  if (z >= 0) return mid + (top - mid) * z;
  return mid + (bottom - mid) * (-z);
}

function shellNodeVector(disp, node, director, offset) {
  const base = node * 6;
  const u = [disp[base] || 0, disp[base + 1] || 0, disp[base + 2] || 0];
  const th = [disp[base + 3] || 0, disp[base + 4] || 0, disp[base + 5] || 0];
  const rot = cross(th, director);
  return [
    u[0] + offset * rot[0],
    u[1] + offset * rot[1],
    u[2] + offset * rot[2],
  ];
}

/**
 * One probe on a shell mid-surface. Same region projection and 6-node
 * shape functions as the stress skin. `record` is a packShellProbe result.
 */
export function probeShellAt(record, point, normal, quantity, modeIndex = 0) {
  if (!record || record.kind !== 'shell' || !point) return null;
  const mesh = {
    nodes: record.nodes,
    elements: record.elements,
    regions: record.regions,
    thickness: record.thickness,
  };
  const found = classifyPoint(mesh, point, normal);
  if (!found) return null;
  const hit = locate(mesh, found.index, found.proj.mid);
  if (!hit) return null;
  const ids = [];
  for (let k = 0; k < 6; k += 1) ids.push(mesh.elements[hit.element * 6 + k]);
  const weights = Array.from(quadShape(hit.bary[0], hit.bary[1], hit.bary[2]));
  const zeta = found.proj.zeta;
  if (quantity === 'stress') {
    if (!record.top || !record.mid || !record.bottom) return null;
    const nodal = ids.map((id) => fibreValue(record.top[id], record.mid[id], record.bottom[id], zeta));
    if (nodal.some((value) => !Number.isFinite(value))) return null;
    let value = 0;
    for (let k = 0; k < 6; k += 1) value += weights[k] * nodal[k];
    return { value, weights, nodal, mix: 'scalar' };
  }
  if (quantity === 'mode') {
    const count = mesh.nodes.length / 3;
    const mode = Math.max(0, modeIndex | 0);
    if (!record.modes || mode >= (record.modeCount || 0)) return null;
    const base = mode * count * 3;
    const nodal = [[], [], []];
    for (let axis = 0; axis < 3; axis += 1) {
      for (let k = 0; k < 6; k += 1) {
        const value = record.modes[base + ids[k] * 3 + axis];
        nodal[axis].push(Number.isFinite(value) ? value : 0);
      }
    }
    const acc = [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      for (let k = 0; k < 6; k += 1) acc[axis] += weights[k] * nodal[axis][k];
    }
    return {
      value: Math.hypot(acc[0], acc[1], acc[2]),
      weights,
      nodal: nodal[0].concat(nodal[1], nodal[2]),
      mix: 'magnitude',
    };
  }
  if (quantity === 'displacement') {
    if (!record.displacement) return null;
    const director = found.proj.director || [0, 0, 1];
    const offset = zeta * ((mesh.thickness || 0) / 2);
    const nodal = [[], [], []];
    for (let k = 0; k < 6; k += 1) {
      const vec = shellNodeVector(record.displacement, ids[k], director, offset);
      nodal[0].push(vec[0]);
      nodal[1].push(vec[1]);
      nodal[2].push(vec[2]);
    }
    const acc = [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      for (let k = 0; k < 6; k += 1) acc[axis] += weights[k] * nodal[axis][k];
    }
    return {
      value: Math.hypot(acc[0], acc[1], acc[2]),
      weights,
      nodal: nodal[0].concat(nodal[1], nodal[2]),
      mix: 'magnitude',
    };
  }
  return null;
}

/**
 * Top fibre on the +N side, bottom fibre on the w = 0 side, and a blend
 * through the thickness on edges. Displacement includes the rotation of the
 * director, then the magnitude in millimetres.
 */
export function sampleShellSurface(positions, indices, faceIDs, mesh, fields) {
  const vertexCount = positions.length / 3;
  const stress = new Float32Array(vertexCount);
  const displacement = new Float32Array(vertexCount);
  stress.fill(NaN);
  displacement.fill(NaN);
  const top = fields.top;
  const mid = fields.mid;
  const bottom = fields.bottom;
  const disp = fields.displacement;
  if (!top || !mid || !bottom || !disp) return { stress, displacement };
  const incident = new Map();
  const triangles = Math.floor(Math.min(indices.length, (faceIDs ? faceIDs.length : 0) * 3) / 3);
  for (let t = 0; t < triangles; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const vertex = indices[t * 3 + k];
      let list = incident.get(vertex);
      if (!list) {
        list = [];
        incident.set(vertex, list);
      }
      list.push(t);
    }
  }
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
    let normal = null;
    const tris = incident.get(vertex);
    if (tris && tris.length) {
      const acc = [0, 0, 0];
      for (const triangle of tris) {
        const geom = triangleGeometry(positions, indices, triangle);
        acc[0] += geom.normal[0];
        acc[1] += geom.normal[1];
        acc[2] += geom.normal[2];
      }
      const n = length(acc);
      if (n > 0) normal = [acc[0] / n, acc[1] / n, acc[2] / n];
    }
    const found = classifyPoint(mesh, point, normal);
    if (!found) continue;
    const hit = locate(mesh, found.index, found.proj.mid);
    if (!hit) continue;
    const ids = mesh.elements.subarray(hit.element * 6, hit.element * 6 + 6);
    const sample = (field) => interpolate(hit.bary, [0, 1, 2, 3, 4, 5].map((k) => field[ids[k]]));
    const zeta = found.proj.zeta;
    stress[vertex] = fibreValue(sample(top), sample(mid), sample(bottom), zeta);
    const ux = [0, 0, 0, 0, 0, 0];
    const uy = [0, 0, 0, 0, 0, 0];
    const uz = [0, 0, 0, 0, 0, 0];
    const tx = [0, 0, 0, 0, 0, 0];
    const ty = [0, 0, 0, 0, 0, 0];
    const tz = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 6; k += 1) {
      const base = ids[k] * 6;
      ux[k] = disp[base];
      uy[k] = disp[base + 1];
      uz[k] = disp[base + 2];
      tx[k] = disp[base + 3];
      ty[k] = disp[base + 4];
      tz[k] = disp[base + 5];
    }
    const uu = [interpolate(hit.bary, ux), interpolate(hit.bary, uy), interpolate(hit.bary, uz)];
    const th = [interpolate(hit.bary, tx), interpolate(hit.bary, ty), interpolate(hit.bary, tz)];
    const rot = cross(th, found.proj.director);
    const offset = zeta * (mesh.thickness / 2);
    const sx = uu[0] + offset * rot[0];
    const sy = uu[1] + offset * rot[1];
    const sz = uu[2] + offset * rot[2];
    displacement[vertex] = Math.hypot(sx, sy, sz);
  }
  return { stress, displacement };
}

/**
 * Sample a translational shell mode (ux, uy, uz per mid-surface node) onto
 * the render vertices. Unmatched vertices stay NaN.
 */
export function sampleShellTranslation(positions, indices, faceIDs, mesh, field) {
  const vertexCount = positions.length / 3;
  const magnitude = new Float32Array(vertexCount);
  const vector = new Float32Array(vertexCount * 3);
  magnitude.fill(NaN);
  vector.fill(NaN);
  if (!field) return { magnitude, vector };
  const incident = new Map();
  const triangles = Math.floor(Math.min(indices.length, (faceIDs ? faceIDs.length : 0) * 3) / 3);
  for (let t = 0; t < triangles; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const vertex = indices[t * 3 + k];
      let list = incident.get(vertex);
      if (!list) {
        list = [];
        incident.set(vertex, list);
      }
      list.push(t);
    }
  }
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
    let normal = null;
    const tris = incident.get(vertex);
    if (tris && tris.length) {
      const acc = [0, 0, 0];
      for (const triangle of tris) {
        const geom = triangleGeometry(positions, indices, triangle);
        acc[0] += geom.normal[0];
        acc[1] += geom.normal[1];
        acc[2] += geom.normal[2];
      }
      const n = length(acc);
      if (n > 0) normal = [acc[0] / n, acc[1] / n, acc[2] / n];
    }
    const found = classifyPoint(mesh, point, normal);
    if (!found) continue;
    const hit = locate(mesh, found.index, found.proj.mid);
    if (!hit) continue;
    const ids = mesh.elements.subarray(hit.element * 6, hit.element * 6 + 6);
    const ux = [0, 0, 0, 0, 0, 0];
    const uy = [0, 0, 0, 0, 0, 0];
    const uz = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 6; k += 1) {
      const base = ids[k] * 3;
      ux[k] = field[base];
      uy[k] = field[base + 1];
      uz[k] = field[base + 2];
    }
    const x = interpolate(hit.bary, ux);
    const y = interpolate(hit.bary, uy);
    const z = interpolate(hit.bary, uz);
    vector[vertex * 3] = x;
    vector[vertex * 3 + 1] = y;
    vector[vertex * 3 + 2] = z;
    magnitude[vertex] = Math.hypot(x, y, z);
  }
  return { magnitude, vector };
}
