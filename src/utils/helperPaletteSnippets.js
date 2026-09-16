/**
 * Slice 09/10/11 — Helper insert palette snippets.
 * Source of truth: HELPER_FUNCTIONS.md allowlist + gamePuzzles / GameHintsModal.
 * Do NOT invent APIs.
 *
 * Slice 10: params schema per button, unique var allocator, numbered body lets
 * (box1, tube2, …); features mutate a chosen body; no class inheritance.
 *
 * Slice 11/12: optional faceContext / edgeContext (from Viewport selectedFace) → face-aware
 * workplane via facesByNormal + closest center (never bare `top`).
 * Slice 21: crossSection plane+profile substrate (planar face → makeCrossSection).
 *
 * Sequential taps compose via composeHelperInsert:
 * strip one trailing `return part;`, insert body, re-append exactly one `return part;`.
 */

import {
  emitFaceWorkplaneLines,
  emitFaceEdgeLines,
  emitSelectedEdgeLines,
  emitSpanExpr,
  estimateCylinderAxis,
  roundFaceNum,
  resolveHoleUV,
} from './faceFeaturePlacement.js';

/** Metric fastener sizes commonly used in puzzles / hints. */
export const FASTENER_SIZE_OPTIONS = [
  'M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10',
];

export const FIT_OPTIONS = ['close', 'normal', 'loose'];
export const AXIS_OPTIONS = ['x', 'y', 'z'];
export const MIRROR_PLANE_OPTIONS = ['xy', 'yz', 'xz'];

/** Bases treated as body identifiers for the body selector. */
const BODY_BASES = [
  'part', 'box', 'cyl', 'sphere', 'tube', 'hex', 'rbox', 'extrude', 'revolve', 'bore',
];

/** Exact base or numbered form only (box, box1) — not prefix (boxCount). */
function isBodyName(n) {
  return BODY_BASES.some((b) => b === n || new RegExp('^' + b + '\\d+$').test(n));
}

/** Monotonic fallback for allocateUniqueName when the numbered loop is exhausted. */
let uniqueNameFallbackSeq = 0;

/** Strip line/block comments for emptiness / name scans. */
function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Detect empty / whitespace-only / comment-only Monaco buffer.
 * Comment-only counts as empty so feature taps still get ensurePartPrefix.
 */
export function isBufferEmpty(text) {
  if (!text || !String(text).trim()) return true;
  return !stripComments(text).trim();
}

/** Remove a single trailing `return part;` (plus trailing whitespace). */
export function stripTrailingReturnPart(text) {
  if (!text) return '';
  return String(text).replace(/\s*$/, '').replace(/(?:\r?\n)?return\s+part\s*;\s*$/, '');
}

/** Names already declared with const/let/var in buffer (comments ignored). */
export function declaredNames(buffer) {
  const names = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  const s = stripComments(buffer);
  while ((m = re.exec(s))) names.add(m[1]);
  return names;
}

/**
 * Allocate a unique identifier.
 * - Prefer bare `base` when free.
 * - Else `base2`, `base3`, … (never overwrite).
 * - For body-style bases in BODY_BASES (except part), prefer `base1` first
 *   when neither bare nor base1 exists — matches numbered body model (box1).
 * @param {Set<string>|string} existingOrBuffer
 * @param {string} base
 * @returns {string}
 */
export function allocateUniqueName(existingOrBuffer, base) {
  const existing =
    existingOrBuffer instanceof Set
      ? existingOrBuffer
      : declaredNames(existingOrBuffer);
  if (!base || typeof base !== 'string') base = 'tmp';

  // Numbered body lets: box1, tube2, … (never bare box/cyl when allocating).
  const isBodyBase = BODY_BASES.includes(base) && base !== 'part';
  if (isBodyBase) {
    for (let n = 1; n < 10000; n++) {
      const cand = `${base}${n}`;
      if (!existing.has(cand)) {
        existing.add(cand);
        return cand;
      }
    }
  } else if (!existing.has(base)) {
    existing.add(base);
    return base;
  } else {
    for (let n = 2; n < 10000; n++) {
      const cand = `${base}${n}`;
      if (!existing.has(cand)) {
        existing.add(cand);
        return cand;
      }
    }
  }
  const fallback = `${base}_${++uniqueNameFallbackSeq}`;
  existing.add(fallback);
  return fallback;
}

/**
 * Scan buffer for *mutable* body-like identifiers (let/var decls + known assigns).
 * Excludes const-declared names (assignment would throw). Offers `part` as a
 * fallback only when `part` is not const-declared.
 * @param {string} buffer
 * @returns {string[]}
 */
export function listBodyNames(buffer) {
  const names = new Set();
  const constNames = new Set();
  const s = stripComments(buffer || '');
  const decl = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = decl.exec(s))) {
    const kind = m[1];
    const n = m[2];
    if (kind === 'const') {
      constNames.add(n);
      continue;
    }
    if (isBodyName(n)) names.add(n);
  }
  // Fallback only when part is mutable (or undeclared).
  if (!constNames.has('part')) names.add('part');
  // Also catch `part = …` / `box1 = …` mutations without fresh decl.
  const assign = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:Manifold\.|tube\(|hexPrism\(|roundedBox\(|makeExtrude\(|makeRevolve\(|filletEdges\(|chamferEdges\(|hole\(|clearanceHole\(|tapDrillHole\(|cboreHole\(|cskHole\(|holePattern\(|shell\(|addDraft\(|center\(|align\(|mirror\(|array3D\(|polarArray\()/g;
  while ((m = assign.exec(s))) {
    const n = m[1];
    if (constNames.has(n)) continue;
    if (isBodyName(n)) names.add(n);
  }
  return [...names];
}

/**
 * Drop top-level starter / const lines whose binding already exists in the buffer
 * (and within earlier top-level lines of the same snippet).
 *
 * Only depth-0 declarations are filtered. Nested `const` inside an IIFE is a
 * new block scope and must be kept — stripping mid-block lines (e.g. the opener
 * of `const _hit = _all.filter((e) => {`) previously left orphan `});` / `}})();`
 * and caused Monaco Parser errors on the second fillet/hole insert.
 *
 * When skipping a top-level decl that opens a block, consume through the matching
 * close so we never leave a half-IIFE behind.
 */
function filterRedeclarations(snippetText, bufferText) {
  const existing = declaredNames(bufferText);
  const out = [];
  const lines = String(snippetText || '').split('\n');
  let depth = 0;
  let i = 0;

  const braceDelta = (line) => {
    let d = 0;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '{') d += 1;
      else if (ch === '}') d -= 1;
    }
    return d;
  };

  while (i < lines.length) {
    const line = lines[i];
    const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    const atTop = depth === 0;

    if (atTop && m && existing.has(m[1])) {
      // Skip whole declaration (including multi-line IIFE / .filter bodies).
      let skipDepth = braceDelta(line);
      i += 1;
      while (skipDepth > 0 && i < lines.length) {
        skipDepth += braceDelta(lines[i]);
        i += 1;
      }
      continue;
    }

    if (m) existing.add(m[1]);
    out.push(line);
    depth += braceDelta(line);
    if (depth < 0) depth = 0;
    i += 1;
  }

  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

function wrapRunnable(bodyLines) {
  return `${bodyLines.join('\n')}\nreturn part;\n`;
}

function withReturn(lines, bufferEmpty) {
  if (bufferEmpty) return wrapRunnable(lines);
  return `${lines.join('\n')}\n`;
}

function num(v, fallback) {
  // Number('') === 0 is finite — treat blank/nullish as fallback (defense in depth).
  if (v === '' || v === null || v === undefined || v === '-' || v === '.') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce a modal/raw number field: blank/nullish/in-progress/NaN → default, then clamp min/max.
 * @param {*} raw
 * @param {{ default: number, min?: number, max?: number }} p
 * @returns {number}
 */
export function coerceNumberParam(raw, p) {
  let n;
  if (raw === '' || raw === null || raw === undefined || raw === '-' || raw === '.') {
    n = p.default;
  } else {
    n = Number(raw);
    if (!Number.isFinite(n)) n = p.default;
  }
  if (typeof p.min === 'number' && Number.isFinite(p.min) && n < p.min) n = p.min;
  if (typeof p.max === 'number' && Number.isFinite(p.max) && n > p.max) n = p.max;
  return n;
}

function bool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

function str(v, fallback) {
  return v == null || v === '' ? fallback : String(v);
}

function mergeParams(item, params) {
  const out = {};
  for (const p of item.params || []) {
    out[p.name] = p.default;
  }
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/**
 * Ensure a working `part` exists (empty / comment-only buffer).
 * Uses numbered body let + `let part = boxN`.
 */
function ensurePartPrefix(empty, names) {
  if (!empty) return [];
  const w = allocateUniqueName(names, 'width');
  const d = allocateUniqueName(names, 'depth');
  const h = allocateUniqueName(names, 'height');
  const box = allocateUniqueName(names, 'box');
  const partName = allocateUniqueName(names, 'part');
  return [
    `const ${w} = 40;`,
    `const ${d} = 30;`,
    `const ${h} = 20;`,
    `let ${box} = Manifold.cube([${w}, ${d}, ${h}], true);`,
    partName === 'part'
      ? `let part = ${box};`
      : `let ${partName} = ${box};\npart = ${partName};`,
  ];
}

/** After mutating a non-part body, keep `part` in sync when it already exists. */
function syncPartLines(bodyName, names, bufferHasPart) {
  if (bodyName === 'part') return [];
  if (bufferHasPart || names.has('part')) {
    return [`part = ${bodyName};`];
  }
  const partName = allocateUniqueName(names, 'part');
  return partName === 'part'
    ? [`let part = ${bodyName};`]
    : [`let ${partName} = ${bodyName};`, `part = ${partName};`];
}

function resolveBody(params, names, buffer) {
  const bodies = listBodyNames(buffer); // mutable only (const bodies excluded)
  let body = str(params.body, 'part');
  // Const-declared or unknown → fall back to part if available, else first mutable.
  if (!bodies.includes(body)) {
    body = bodies.includes('part') ? 'part' : (bodies[0] || 'part');
  }
  // Touch names set so later allocs see body if it was only assigned, not decl'd.
  if (!names.has(body)) names.add(body);
  return body;
}

function hasPartDecl(lines, empty) {
  return /(?:let|const|var)\s+part\b/.test(lines.join('\n')) || !empty;
}

/**
 * Default (no face) top-face workplane — facesByNormal(+Z), never bare `top`.
 */
function emitDefaultTopWorkplane(body, names) {
  const topFace = allocateUniqueName(names, 'topFace');
  const fr = allocateUniqueName(names, 'fr');
  return {
    lines: [
      `const ${topFace} = facesByNormal(${body}, [0, 0, 1])[0];`,
      `if (${topFace} == null) throw new Error('No +Z face for default workplane');`,
      `const ${fr} = workplaneFromFace(${body}, ${topFace});`,
    ],
    frVar: fr,
  };
}

/**
 * Resolve workplane for a hole-like feature. With faceContext, uses selected
 * face normal/center (cylindrical: rebuild normal from angleDeg + axis).
 */
function resolveFeatureWorkplane(body, p, names, faceCtx) {
  if (faceCtx && faceCtx.type === 'cylindrical') {
    const { axis } = estimateCylinderAxis(faceCtx.normal);
    const angleDeg = num(p.angleDeg, 0);
    const rad = (angleDeg * Math.PI) / 180;
    let n;
    if (axis === 'z') n = [Math.cos(rad), Math.sin(rad), 0];
    else if (axis === 'y') n = [Math.sin(rad), 0, Math.cos(rad)];
    else n = [0, Math.cos(rad), Math.sin(rad)];
    const syn = {
      ...faceCtx,
      normal: n,
      // Keep pick center; axial adjusts v later
    };
    return emitFaceWorkplaneLines(body, syn, names, allocateUniqueName);
  }
  if (faceCtx && (faceCtx.type === 'planar' || faceCtx.type === 'cylindrical')) {
    return emitFaceWorkplaneLines(body, faceCtx, names, allocateUniqueName);
  }
  return emitDefaultTopWorkplane(body, names);
}

function uvForFace(p, faceCtx) {
  if (faceCtx && faceCtx.type === 'cylindrical') {
    // On cylinder wall workplane: u ~ hoop, v ~ axial relative to face center
    const axial = num(p.axial, faceCtx.center
      ? (estimateCylinderAxis(faceCtx.normal).axis === 'z' ? faceCtx.center[2]
        : estimateCylinderAxis(faceCtx.normal).axis === 'y' ? faceCtx.center[1]
          : faceCtx.center[0])
      : 0);
    // Face already at axial from selection; offset = axial - faceCenterAxis
    const { axis } = estimateCylinderAxis(faceCtx.normal);
    const faceAx = axis === 'z' ? faceCtx.center[2] : axis === 'y' ? faceCtx.center[1] : faceCtx.center[0];
    const vOff = roundFaceNum(axial - faceAx, 3);
    return { u: 0, v: vOff };
  }
  // Planar Center / custom via resolveHoleUV
  const uv = resolveHoleUV(p, faceCtx, num);
  return { u: uv.u, v: uv.v };
}

/**
 * Build insert text for a palette item (single-shot snippet, may include return).
 * Prefer composeHelperInsert for sequential taps.
 * @param {string} id
 * @param {{ bufferEmpty?: boolean, params?: object, buffer?: string }} opts
 * @returns {string|null}
 */
export function buildHelperSnippet(id, opts = {}) {
  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === id);
  if (!item) return null;
  const buffer = opts.buffer || '';
  const bufferEmpty = opts.bufferEmpty != null ? !!opts.bufferEmpty : isBufferEmpty(buffer);
  const params = mergeParams(item, opts.params);
  const names = declaredNames(buffer);
  return item.build(bufferEmpty, params, names, buffer, opts.faceContext || null, opts.edgeContext || null);
}

/**
 * Template-aware compose: strip trailing return → insert snippet body at caret
 * (skipping redeclarations) → re-append one `return part;`.
 * @param {string} buffer current Monaco buffer
 * @param {string} id palette item id
 * @param {number|null} [caretOffset] offset into buffer; clamped into ops region.
 *   null / omitted → append at end of body (typical sequential taps).
 * @param {object|null} [params] values from HelperParamModal (defaults if null)
 * @param {object|null} [faceContext] Slice 11 classified selected face (or null)
 * @param {object[]|null} [edgeContext] Slice 12 selected edges for fillet/chamfer
 * @returns {string|null} full replacement buffer
 */
export function composeHelperInsert(buffer, id, caretOffset = null, params = null, faceContext = null, edgeContext = null) {
  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === id);
  if (!item) return null;

  const strippedBuf = stripTrailingReturnPart(buffer || '');
  const empty = isBufferEmpty(strippedBuf);
  const merged = mergeParams(item, params);
  const names = declaredNames(strippedBuf);
  let snippet = item.build(empty, merged, names, strippedBuf, faceContext, edgeContext);
  if (snippet == null) return null;

  snippet = stripTrailingReturnPart(snippet);
  const filtered = filterRedeclarations(snippet, strippedBuf);

  let insertAt = caretOffset == null ? strippedBuf.length : caretOffset;
  if (insertAt < 0) insertAt = 0;
  if (insertAt > strippedBuf.length) insertAt = strippedBuf.length;

  if (!filtered.trim()) {
    const body = strippedBuf.replace(/\s+$/, '');
    return body ? `${body}\nreturn part;\n` : 'return part;\n';
  }

  const before = strippedBuf.slice(0, insertAt);
  const after = strippedBuf.slice(insertAt);

  let body = '';
  if (before) {
    body = before.endsWith('\n') ? before : `${before}\n`;
  }
  body += filtered.endsWith('\n') ? filtered : `${filtered}\n`;
  if (after) {
    body += after.replace(/^\n+/, '');
  }
  body = body.replace(/\s+$/, '');
  return `${body}\nreturn part;\n`;
}

/** Default params object for an item (for modal initial state). */
export function defaultParamsFor(id) {
  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === id);
  if (!item) return {};
  return mergeParams(item, null);
}

/**
 * @typedef {{ name: string, type: 'number'|'bool'|'select'|'body', default: any, label: string, options?: string[], step?: number, min?: number }} ParamDef
 * @typedef {{ id: string, label: string, group: string, title: string, bodyBase?: string, params: ParamDef[], build: Function }} PaletteItem
 */

/** @type {PaletteItem[]} */
export const HELPER_PALETTE_ITEMS = [
  // ── Primitives ──────────────────────────────────────────────
  {
    id: 'cube',
    label: 'Cube',
    group: 'Primitives',
    title: 'Manifold.cube([x,y,z], center)',
    bodyBase: 'box',
    params: [
      { name: 'width', type: 'number', default: 40, label: 'Width', min: 0.1, step: 1 },
      { name: 'depth', type: 'number', default: 30, label: 'Depth', min: 0.1, step: 1 },
      { name: 'height', type: 'number', default: 20, label: 'Height', min: 0.1, step: 1 },
      { name: 'center', type: 'bool', default: true, label: 'Centered' },
    ],
    build: (empty, p, names) => {
      const box = allocateUniqueName(names, 'box');
      const w = num(p.width, 40);
      const d = num(p.depth, 30);
      const h = num(p.height, 20);
      const c = bool(p.center, true);
      const lines = [`let ${box} = Manifold.cube([${w}, ${d}, ${h}], ${c});`];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${box};` : `let ${partName} = ${box};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${box};`);
      }
      return withReturn(lines, empty);
    },
  },
  {
    id: 'cylinder',
    label: 'Cylinder',
    group: 'Primitives',
    title: 'Manifold.cylinder(height, rLow, rHigh, segments)',
    bodyBase: 'cyl',
    params: [
      { name: 'height', type: 'number', default: 20, label: 'Height', min: 0.1, step: 1 },
      { name: 'radius', type: 'number', default: 10, label: 'Radius', min: 0.1, step: 0.5 },
      { name: 'segments', type: 'number', default: 64, label: 'Segments', min: 3, step: 1 },
    ],
    build: (empty, p, names) => {
      const cyl = allocateUniqueName(names, 'cyl');
      const h = num(p.height, 20);
      const r = num(p.radius, 10);
      const seg = Math.max(3, Math.round(num(p.segments, 64)));
      const lines = [`let ${cyl} = Manifold.cylinder(${h}, ${r}, ${r}, ${seg});`];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${cyl};` : `let ${partName} = ${cyl};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${cyl};`);
      }
      return withReturn(lines, empty);
    },
  },
  {
    id: 'sphere',
    label: 'Sphere',
    group: 'Primitives',
    title: 'Manifold.sphere(radius, segments)',
    bodyBase: 'sphere',
    params: [
      { name: 'radius', type: 'number', default: 15, label: 'Radius', min: 0.1, step: 0.5 },
      { name: 'segments', type: 'number', default: 32, label: 'Segments', min: 3, step: 1 },
    ],
    build: (empty, p, names) => {
      const sph = allocateUniqueName(names, 'sphere');
      const r = num(p.radius, 15);
      const seg = Math.max(3, Math.round(num(p.segments, 32)));
      const lines = [`let ${sph} = Manifold.sphere(${r}, ${seg});`];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${sph};` : `let ${partName} = ${sph};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${sph};`);
      }
      return withReturn(lines, empty);
    },
  },
  {
    id: 'tube',
    label: 'Tube',
    group: 'Primitives',
    title: 'tube(outerRadius, innerRadius, height, segments?)',
    bodyBase: 'tube',
    params: [
      { name: 'outerRadius', type: 'number', default: 15, label: 'Outer R', min: 0.1, step: 0.5 },
      { name: 'innerRadius', type: 'number', default: 10, label: 'Inner R', min: 0, step: 0.5 },
      { name: 'height', type: 'number', default: 40, label: 'Height', min: 0.1, step: 1 },
      { name: 'segments', type: 'number', default: 32, label: 'Segments', min: 3, step: 1 },
    ],
    build: (empty, p, names) => {
      const tube = allocateUniqueName(names, 'tube');
      const o = num(p.outerRadius, 15);
      const i = num(p.innerRadius, 10);
      const h = num(p.height, 40);
      const seg = Math.max(3, Math.round(num(p.segments, 32)));
      const lines = [`let ${tube} = tube(${o}, ${i}, ${h}, ${seg});`];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${tube};` : `let ${partName} = ${tube};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${tube};`);
      }
      return withReturn(lines, empty);
    },
  },
  {
    id: 'hexPrism',
    label: 'Hex',
    group: 'Primitives',
    title: 'hexPrism(radius, height)',
    bodyBase: 'hex',
    params: [
      { name: 'radius', type: 'number', default: 12, label: 'Radius', min: 0.1, step: 0.5 },
      { name: 'height', type: 'number', default: 8, label: 'Height', min: 0.1, step: 0.5 },
    ],
    build: (empty, p, names) => {
      const hex = allocateUniqueName(names, 'hex');
      const r = num(p.radius, 12);
      const h = num(p.height, 8);
      const lines = [`let ${hex} = hexPrism(${r}, ${h});`];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${hex};` : `let ${partName} = ${hex};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${hex};`);
      }
      return withReturn(lines, empty);
    },
  },
  {
    id: 'roundedBox',
    label: 'Round box',
    group: 'Primitives',
    title: 'roundedBox(size, radius, segments?)',
    bodyBase: 'rbox',
    params: [
      { name: 'sx', type: 'number', default: 50, label: 'Size X', min: 0.1, step: 1 },
      { name: 'sy', type: 'number', default: 30, label: 'Size Y', min: 0.1, step: 1 },
      { name: 'sz', type: 'number', default: 20, label: 'Size Z', min: 0.1, step: 1 },
      { name: 'edgeRadius', type: 'number', default: 4, label: 'Edge R', min: 0, step: 0.5 },
      { name: 'segments', type: 'number', default: 16, label: 'Segments', min: 1, step: 1 },
    ],
    build: (empty, p, names) => {
      const rbox = allocateUniqueName(names, 'rbox');
      const sx = num(p.sx, 50);
      const sy = num(p.sy, 30);
      const sz = num(p.sz, 20);
      const er = num(p.edgeRadius, 4);
      const seg = Math.max(1, Math.round(num(p.segments, 16)));
      const lines = [`let ${rbox} = roundedBox([${sx}, ${sy}, ${sz}], ${er}, ${seg});`];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${rbox};` : `let ${partName} = ${rbox};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${rbox};`);
      }
      return withReturn(lines, empty);
    },
  },

  // ── Features ────────────────────────────────────────────────
  {
    id: 'filletEdges',
    label: 'Fillet',
    group: 'Features',
    title: 'filletEdges(part, edges, r, opts?)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'radius', type: 'number', default: 3, label: 'Radius', min: 0.01, step: 0.5 },
      { name: 'sphericalCorners', type: 'bool', default: true, label: 'Spherical corners' },
    ],
    build: (empty, p, names, buffer, faceCtx = null, edgeCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const r = num(p.radius, 3);
      const sc = bool(p.sphericalCorners, true);
      let edgesExpr = `convexEdges(${body})`;
      const scope = p.edgeScope || (edgeCtx && edgeCtx.length ? 'selected' : (faceCtx ? 'face' : 'allConvex'));
      if (scope === 'selected' || (edgeCtx && edgeCtx.length && scope !== 'face' && scope !== 'allConvex')) {
        const edge = emitSelectedEdgeLines(body, edgeCtx || [], names, allocateUniqueName);
        // Soft-fail: never write throw/partial JS — caller clears stale selection.
        if (!edge.ok) return null;
        lines.push(...edge.lines);
        edgesExpr = edge.edgesExpr;
      } else if (faceCtx && faceCtx.type !== 'irregular' && scope !== 'allConvex') {
        const edge = emitFaceEdgeLines(body, faceCtx, { ...p, edgeScope: 'face' }, names, allocateUniqueName);
        lines.push(...edge.lines);
        edgesExpr = edge.edgesExpr;
      } else if (scope === 'allConvex') {
        edgesExpr = `convexEdges(${body})`;
      }
      lines.push(
        `${body} = filletEdges(${body}, ${edgesExpr}, ${r}, { sphericalCorners: ${sc} });`,
      );
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'chamferEdges',
    label: 'Chamfer',
    group: 'Features',
    title: 'chamferEdges(part, edges, c)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'chamfer', type: 'number', default: 2, label: 'Chamfer', min: 0.01, step: 0.5 },
    ],
    build: (empty, p, names, buffer, faceCtx = null, edgeCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const c = num(p.chamfer, 2);
      let edgesExpr = `convexEdges(${body})`;
      const scope = p.edgeScope || (edgeCtx && edgeCtx.length ? 'selected' : (faceCtx ? 'face' : 'allConvex'));
      if (scope === 'selected' || (edgeCtx && edgeCtx.length && scope !== 'face' && scope !== 'allConvex')) {
        const edge = emitSelectedEdgeLines(body, edgeCtx || [], names, allocateUniqueName);
        if (!edge.ok) return null;
        lines.push(...edge.lines);
        edgesExpr = edge.edgesExpr;
      } else if (faceCtx && faceCtx.type !== 'irregular' && scope !== 'allConvex') {
        const edge = emitFaceEdgeLines(body, faceCtx, { ...p, edgeScope: 'face' }, names, allocateUniqueName);
        lines.push(...edge.lines);
        edgesExpr = edge.edgesExpr;
      } else if (scope === 'allConvex') {
        edgesExpr = `convexEdges(${body})`;
      }
      lines.push(`${body} = chamferEdges(${body}, ${edgesExpr}, ${c});`);
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },

  {
    id: 'crossSection',
    label: 'Profile',
    group: 'Features',
    title: 'makeCrossSection(plane, profile) — reusable plane + 2D profile',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      {
        name: 'profileType', type: 'select', default: 'circle', label: 'Profile',
        options: ['circle', 'rectangle', 'polygon'],
      },
      { name: 'radius', type: 'number', default: 5, label: 'Radius', min: 0.1, step: 0.5, slider: true },
      { name: 'segments', type: 'number', default: 32, label: 'Segments', min: 3, step: 1 },
      { name: 'width', type: 'number', default: 20, label: 'Width', min: 0.1, step: 1, slider: true },
      { name: 'height', type: 'number', default: 12, label: 'Height', min: 0.1, step: 1, slider: true },
      { name: 'centered', type: 'bool', default: true, label: 'Centered' },
      {
        name: 'polygonPreset', type: 'select', default: 'hexagon', label: 'Polygon',
        options: ['triangle', 'square', 'pentagon', 'hexagon', 'quarterCircle'],
      },
    ],
    build: (empty, p, names, buffer, faceCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      // Planar face → selected workplane; else default +Z top face.
      const planarCtx = faceCtx && faceCtx.type === 'planar' ? faceCtx : null;
      const wp = planarCtx
        ? emitFaceWorkplaneLines(body, planarCtx, names, allocateUniqueName)
        : emitDefaultTopWorkplane(body, names);
      lines.push(...wp.lines);
      const fr = wp.frVar;
      const xs = allocateUniqueName(names, 'xs');
      const type = str(p.profileType, 'circle');
      let profileExpr;
      if (type === 'rectangle') {
        const w = num(p.width, 20);
        const h = num(p.height, 12);
        const c = bool(p.centered, true);
        profileExpr = `profileRectangle(${w}, ${h}, ${c})`;
      } else if (type === 'polygon') {
        const preset = str(p.polygonPreset, 'hexagon');
        const r = num(p.radius, 8);
        if (preset === 'quarterCircle') {
          // First-quadrant fillet-style closed polyline (origin→(r,0)→arc→(0,r)).
          const seg = 8;
          const pts = ['[0, 0]', `[${r}, 0]`];
          for (let i = 1; i <= seg; i++) {
            const t = (i / seg) * (Math.PI / 2);
            const u = +(r * Math.cos(t)).toFixed(4);
            const v = +(r * Math.sin(t)).toFixed(4);
            pts.push(`[${u}, ${v}]`);
          }
          profileExpr = `profilePolygon([${pts.join(', ')}])`;
        } else {
          const sides = preset === 'triangle' ? 3 : preset === 'square' ? 4 : 6;
          const pts = [];
          for (let i = 0; i < sides; i++) {
            const t = (i / sides) * Math.PI * 2 - Math.PI / 2;
            const u = +(r * Math.cos(t)).toFixed(4);
            const v = +(r * Math.sin(t)).toFixed(4);
            pts.push(`[${u}, ${v}]`);
          }
          profileExpr = `profilePolygon([${pts.join(', ')}])`;
        }
      } else {
        const r = num(p.radius, 5);
        const seg = Math.max(3, Math.round(num(p.segments, 32)));
        profileExpr = `profileCircle(${r}, ${seg})`;
      }
      // Substrate only — named let for later edge→sweep / fillet / extrude slices.
      lines.push(`const ${xs} = makeCrossSection(${fr}, ${profileExpr}); // plane+profile substrate`);
      return withReturn(lines, empty);
    },
  },
  {
    id: 'hole',
    label: 'Hole',
    group: 'Features',
    title: 'hole(part, frame, u, v, dia, span)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'dia', type: 'number', default: 6, label: 'Diameter', min: 0.1, step: 0.5 },
      { name: 'u', type: 'number', default: 0, label: 'U', step: 1 },
      { name: 'v', type: 'number', default: 0, label: 'V', step: 1 },
    ],
    build: (empty, p, names, buffer, faceCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const dia = num(p.dia, 6);
      const wp = resolveFeatureWorkplane(body, p, names, faceCtx);
      lines.push(...wp.lines);
      const fr = wp.frVar;
      const usePattern = faceCtx && faceCtx.type === 'planar' && bool(p.usePattern, false);
      if (usePattern) {
        const n = Math.max(1, Math.round(num(p.n, 3)));
        const m = Math.max(1, Math.round(num(p.m, 2)));
        const su = num(p.spacingU, 18);
        const sv = num(p.spacingV, 14);
        lines.push(
          `${body} = holePattern(${body}, ${fr}, { n: ${n}, m: ${m}, spacingU: ${su}, spacingV: ${sv}, dia: ${dia} });`,
        );
      } else {
        const { u, v } = faceCtx ? uvForFace(p, faceCtx) : { u: num(p.u, 0), v: num(p.v, 0) };
        const span = emitSpanExpr(body, fr, faceCtx ? p : { through: true }, names, allocateUniqueName, num);
        lines.push(...span.lines);
        lines.push(`${body} = hole(${body}, ${fr}, ${u}, ${v}, ${dia}, ${span.spanExpr});`);
      }
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'holePattern',
    label: 'Hole grid',
    group: 'Features',
    title: 'holePattern(part, frame, { n, m, spacingU, spacingV, dia })',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
      { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
      { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1 },
      { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1 },
      { name: 'dia', type: 'number', default: 4, label: 'Diameter', min: 0.1, step: 0.5 },
    ],
    build: (empty, p, names, buffer, faceCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const n = Math.max(1, Math.round(num(p.n, 3)));
      const m = Math.max(1, Math.round(num(p.m, 2)));
      const su = num(p.spacingU, 18);
      const sv = num(p.spacingV, 14);
      const dia = num(p.dia, 4);
      const wp = resolveFeatureWorkplane(body, p, names, faceCtx);
      lines.push(...wp.lines);
      lines.push(
        `${body} = holePattern(${body}, ${wp.frVar}, { n: ${n}, m: ${m}, spacingU: ${su}, spacingV: ${sv}, dia: ${dia} });`,
      );
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'clearanceHole',
    label: 'Clearance',
    group: 'Features',
    title: "clearanceHole(part, frame, u, v, size, span?, fit?)",
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'size', type: 'select', default: 'M3', label: 'Size', options: FASTENER_SIZE_OPTIONS },
      { name: 'fit', type: 'select', default: 'normal', label: 'Fit', options: FIT_OPTIONS },
      { name: 'u', type: 'number', default: 0, label: 'U', step: 1 },
      { name: 'v', type: 'number', default: 0, label: 'V', step: 1 },
    ],
    build: (empty, p, names, buffer, faceCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const size = str(p.size, 'M3');
      const fit = str(p.fit, 'normal');
      const wp = resolveFeatureWorkplane(body, p, names, faceCtx);
      lines.push(...wp.lines);
      const fr = wp.frVar;
      const usePattern = faceCtx && faceCtx.type === 'planar' && bool(p.usePattern, false);
      if (usePattern) {
        const n = Math.max(1, Math.round(num(p.n, 3)));
        const m = Math.max(1, Math.round(num(p.m, 2)));
        const su = num(p.spacingU, 18);
        const sv = num(p.spacingV, 14);
        const cdVar = allocateUniqueName(names, '_cd');
        lines.push(`const ${cdVar} = fastenerClearanceDia('${size}', '${fit}');`);
        lines.push(
          `${body} = holePattern(${body}, ${fr}, { n: ${n}, m: ${m}, spacingU: ${su}, spacingV: ${sv}, dia: ${cdVar} });`,
        );
      } else {
        const { u, v } = faceCtx ? uvForFace(p, faceCtx) : { u: num(p.u, 0), v: num(p.v, 0) };
        const span = emitSpanExpr(body, fr, faceCtx ? p : { through: true }, names, allocateUniqueName, num);
        lines.push(...span.lines);
        lines.push(`${body} = clearanceHole(${body}, ${fr}, ${u}, ${v}, '${size}', ${span.spanExpr}, '${fit}');`);
      }
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'tapDrillHole',
    label: 'Tap drill',
    group: 'Features',
    title: 'tapDrillHole(part, frame, u, v, size, span?)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'size', type: 'select', default: 'M3', label: 'Size', options: FASTENER_SIZE_OPTIONS },
      { name: 'u', type: 'number', default: 0, label: 'U', step: 1 },
      { name: 'v', type: 'number', default: 0, label: 'V', step: 1 },
    ],
    build: (empty, p, names, buffer, faceCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const size = str(p.size, 'M3');
      const { u, v } = faceCtx ? uvForFace(p, faceCtx) : { u: num(p.u, 0), v: num(p.v, 0) };
      const wp = resolveFeatureWorkplane(body, p, names, faceCtx);
      lines.push(...wp.lines);
      const fr = wp.frVar;
      if (faceCtx && p.through === false) {
        const span = emitSpanExpr(body, fr, p, names, allocateUniqueName, num);
        lines.push(...span.lines);
        lines.push(`${body} = tapDrillHole(${body}, ${fr}, ${u}, ${v}, '${size}', ${span.spanExpr});`);
      } else {
        lines.push(`${body} = tapDrillHole(${body}, ${fr}, ${u}, ${v}, '${size}');`);
      }
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'cboreHole',
    label: 'Cbore',
    group: 'Features',
    title: 'cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'diaThru', type: 'number', default: 5.5, label: 'Thru Ø', min: 0.1, step: 0.1 },
      { name: 'diaCbore', type: 'number', default: 10, label: 'Cbore Ø', min: 0.1, step: 0.1 },
      { name: 'cboreDepth', type: 'number', default: 4, label: 'Cbore depth', min: 0.1, step: 0.5 },
      { name: 'u', type: 'number', default: 0, label: 'U', step: 1 },
      { name: 'v', type: 'number', default: 0, label: 'V', step: 1 },
    ],
    build: (empty, p, names, buffer, faceCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const diaThru = num(p.diaThru, 5.5);
      const diaCbore = num(p.diaCbore, 10);
      const cboreDepth = num(p.cboreDepth, 4);
      const { u, v } = faceCtx ? uvForFace(p, faceCtx) : { u: num(p.u, 0), v: num(p.v, 0) };
      const wp = resolveFeatureWorkplane(body, p, names, faceCtx);
      lines.push(...wp.lines);
      const fr = wp.frVar;
      const span = emitSpanExpr(body, fr, faceCtx ? p : { through: true }, names, allocateUniqueName, num);
      lines.push(...span.lines);
      lines.push(
        `${body} = cboreHole(${body}, ${fr}, ${u}, ${v}, ${diaThru}, ${diaCbore}, ${cboreDepth}, ${span.spanExpr});`,
      );
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'cskHole',
    label: 'Csk',
    group: 'Features',
    title: 'cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'diaThru', type: 'number', default: 3.4, label: 'Thru Ø', min: 0.1, step: 0.1 },
      { name: 'diaCsk', type: 'number', default: 6.5, label: 'Csk Ø', min: 0.1, step: 0.1 },
      { name: 'cskDepth', type: 'number', default: 2, label: 'Csk depth', min: 0.1, step: 0.5 },
      { name: 'u', type: 'number', default: 0, label: 'U', step: 1 },
      { name: 'v', type: 'number', default: 0, label: 'V', step: 1 },
    ],
    build: (empty, p, names, buffer, faceCtx = null) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const diaThru = num(p.diaThru, 3.4);
      const diaCsk = num(p.diaCsk, 6.5);
      const cskDepth = num(p.cskDepth, 2);
      const { u, v } = faceCtx ? uvForFace(p, faceCtx) : { u: num(p.u, 0), v: num(p.v, 0) };
      const wp = resolveFeatureWorkplane(body, p, names, faceCtx);
      lines.push(...wp.lines);
      const fr = wp.frVar;
      const span = emitSpanExpr(body, fr, faceCtx ? p : { through: true }, names, allocateUniqueName, num);
      lines.push(...span.lines);
      lines.push(
        `${body} = cskHole(${body}, ${fr}, ${u}, ${v}, ${diaThru}, ${diaCsk}, ${cskDepth}, ${span.spanExpr});`,
      );
      lines.push(...syncPartLines(body, names, hasPartDecl(lines, empty)));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'shell',
    label: 'Shell',
    group: 'Features',
    title: "shell(manifold, thickness, axis) — subtract the tool",
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'wall', type: 'number', default: 2.5, label: 'Wall', min: 0.1, step: 0.5 },
      { name: 'axis', type: 'select', default: 'z', label: 'Axis', options: AXIS_OPTIONS },
    ],
    build: (empty, p, names, buffer) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const wall = num(p.wall, 2.5);
      const axis = str(p.axis, 'z');
      lines.push(`${body} = ${body}.subtract(shell(${body}, ${wall}, '${axis}'));`);
      lines.push(...syncPartLines(body, names, /(?:let|const|var)\s+part\b/.test(lines.join('\n')) || !empty));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'addDraft',
    label: 'Draft',
    group: 'Features',
    title: "addDraft(manifold, draftDeg, axis)",
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'draftDeg', type: 'number', default: 2, label: 'Draft °', min: 0, step: 0.5 },
      { name: 'axis', type: 'select', default: 'z', label: 'Axis', options: AXIS_OPTIONS },
    ],
    build: (empty, p, names, buffer) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const deg = num(p.draftDeg, 2);
      const axis = str(p.axis, 'z');
      lines.push(`${body} = addDraft(${body}, ${deg}, '${axis}');`);
      lines.push(...syncPartLines(body, names, /(?:let|const|var)\s+part\b/.test(lines.join('\n')) || !empty));
      return withReturn(lines, empty);
    },
  },

  // ── Transforms / layout ─────────────────────────────────────
  {
    id: 'center',
    label: 'Center',
    group: 'Transforms',
    title: 'center(manifold, axes?)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'cx', type: 'bool', default: true, label: 'Center X' },
      { name: 'cy', type: 'bool', default: true, label: 'Center Y' },
      { name: 'cz', type: 'bool', default: false, label: 'Center Z' },
    ],
    build: (empty, p, names, buffer) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const cx = bool(p.cx, true);
      const cy = bool(p.cy, true);
      const cz = bool(p.cz, false);
      lines.push(`${body} = center(${body}, [${cx}, ${cy}, ${cz}]);`);
      lines.push(...syncPartLines(body, names, /(?:let|const|var)\s+part\b/.test(lines.join('\n')) || !empty));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'align',
    label: 'Align Z0',
    group: 'Transforms',
    title: 'align(manifold, { min / max / center })',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
    ],
    build: (empty, p, names, buffer) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      lines.push(`${body} = align(${body}, { min: [undefined, undefined, 0] });`);
      lines.push(...syncPartLines(body, names, /(?:let|const|var)\s+part\b/.test(lines.join('\n')) || !empty));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'mirror',
    label: 'Mirror',
    group: 'Transforms',
    title: "mirror(manifold, plane, keepOriginal?)",
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'plane', type: 'select', default: 'yz', label: 'Plane', options: MIRROR_PLANE_OPTIONS },
      { name: 'keepOriginal', type: 'bool', default: true, label: 'Keep original' },
    ],
    build: (empty, p, names, buffer) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const plane = str(p.plane, 'yz');
      const keep = bool(p.keepOriginal, true);
      lines.push(`${body} = mirror(${body}, '${plane}', ${keep});`);
      lines.push(...syncPartLines(body, names, /(?:let|const|var)\s+part\b/.test(lines.join('\n')) || !empty));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'array3D',
    label: 'Array',
    group: 'Transforms',
    title: 'array3D(manifold, counts, spacing)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'nx', type: 'number', default: 2, label: 'Count X', min: 1, step: 1 },
      { name: 'ny', type: 'number', default: 2, label: 'Count Y', min: 1, step: 1 },
      { name: 'nz', type: 'number', default: 1, label: 'Count Z', min: 1, step: 1 },
      { name: 'sx', type: 'number', default: 45, label: 'Spacing X', step: 1 },
      { name: 'sy', type: 'number', default: 35, label: 'Spacing Y', step: 1 },
      { name: 'sz', type: 'number', default: 0, label: 'Spacing Z', step: 1 },
    ],
    build: (empty, p, names, buffer) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const nx = Math.max(1, Math.round(num(p.nx, 2)));
      const ny = Math.max(1, Math.round(num(p.ny, 2)));
      const nz = Math.max(1, Math.round(num(p.nz, 1)));
      const sx = num(p.sx, 45);
      const sy = num(p.sy, 35);
      const sz = num(p.sz, 0);
      lines.push(`${body} = array3D(${body}, [${nx}, ${ny}, ${nz}], [${sx}, ${sy}, ${sz}]);`);
      lines.push(...syncPartLines(body, names, /(?:let|const|var)\s+part\b/.test(lines.join('\n')) || !empty));
      return withReturn(lines, empty);
    },
  },
  {
    id: 'polarArray',
    label: 'Polar',
    group: 'Transforms',
    title: "polarArray(manifold, count, radius, axis?)",
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
      { name: 'count', type: 'number', default: 4, label: 'Count', min: 1, step: 1 },
      { name: 'boltCircleRadius', type: 'number', default: 20, label: 'Bolt circle R', min: 0, step: 1 },
      { name: 'axis', type: 'select', default: 'z', label: 'Axis', options: AXIS_OPTIONS },
      { name: 'boreRadius', type: 'number', default: 3, label: 'Bore R (empty)', min: 0.1, step: 0.5 },
      { name: 'boreHeight', type: 'number', default: 10, label: 'Bore H (empty)', min: 0.1, step: 0.5 },
    ],
    build: (empty, p, names, buffer) => {
      const count = Math.max(1, Math.round(num(p.count, 4)));
      const bcr = num(p.boltCircleRadius, 20);
      const axis = str(p.axis, 'z');
      if (empty) {
        const bore = allocateUniqueName(names, 'bore');
        const br = num(p.boreRadius, 3);
        const bh = num(p.boreHeight, 10);
        const partName = allocateUniqueName(names, 'part');
        return [
          `const ${bore} = Manifold.cylinder(${bh}, ${br}, ${br}, 32);`,
          partName === 'part'
            ? `let part = polarArray(${bore}, ${count}, ${bcr}, '${axis}');`
            : `let ${partName} = polarArray(${bore}, ${count}, ${bcr}, '${axis}');\npart = ${partName};`,
          'return part;',
          '',
        ].join('\n');
      }
      const lines = [];
      const body = resolveBody(p, names, buffer);
      lines.push(`${body} = polarArray(${body}, ${count}, ${bcr}, '${axis}');`);
      lines.push(...syncPartLines(body, names, true));
      return `${lines.join('\n')}\n`;
    },
  },
  {
    id: 'workplane',
    label: 'Workplane',
    group: 'Transforms',
    title: 'facesByNormal + workplaneFromFace (top face)',
    params: [
      { name: 'body', type: 'body', default: 'part', label: 'Body' },
    ],
    build: (empty, p, names, buffer) => {
      const lines = [...ensurePartPrefix(empty, names)];
      const body = resolveBody(p, names, empty ? lines.join('\n') : buffer);
      const topFace = allocateUniqueName(names, 'topFace');
      const fr = allocateUniqueName(names, 'fr');
      const span = allocateUniqueName(names, 'span');
      lines.push(`const ${topFace} = facesByNormal(${body}, [0, 0, 1])[0];`);
      lines.push(`const ${fr} = workplaneFromFace(${body}, ${topFace});`);
      lines.push(`const ${span} = holeSpan(${body}, ${fr});`);
      return withReturn(lines, empty);
    },
  },
  {
    id: 'makeExtrude',
    label: 'Extrude',
    group: 'Transforms',
    title: 'makeExtrude(contours, height)',
    bodyBase: 'extrude',
    params: [
      { name: 'height', type: 'number', default: 10, label: 'Height', min: 0.1, step: 1 },
    ],
    build: (empty, p, names) => {
      const extrude = allocateUniqueName(names, 'extrude');
      const h = num(p.height, 10);
      const lines = [
        `let ${extrude} = makeExtrude([`,
        '  [[-20, -15], [20, -15], [20, 15], [-20, 15]]',
        `], ${h});`,
      ];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${extrude};` : `let ${partName} = ${extrude};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${extrude};`);
      }
      return withReturn(lines, empty);
    },
  },
  {
    id: 'makeRevolve',
    label: 'Revolve',
    group: 'Transforms',
    title: 'makeRevolve(contours, segments?) — x=radial, y=height',
    bodyBase: 'revolve',
    params: [
      { name: 'segments', type: 'number', default: 64, label: 'Segments', min: 3, step: 1 },
    ],
    build: (empty, p, names) => {
      const revolve = allocateUniqueName(names, 'revolve');
      const seg = Math.max(3, Math.round(num(p.segments, 64)));
      const lines = [
        `let ${revolve} = makeRevolve([`,
        '  [[8, 0], [25, 0], [25, 6], [12, 6], [12, 40], [8, 40]]',
        `], ${seg});`,
      ];
      if (empty || !names.has('part')) {
        const partName = allocateUniqueName(names, 'part');
        lines.push(partName === 'part' ? `let part = ${revolve};` : `let ${partName} = ${revolve};`);
        if (partName !== 'part') lines.push(`part = ${partName};`);
      } else {
        lines.push(`part = ${revolve};`);
      }
      return withReturn(lines, empty);
    },
  },
];

/** Group order for the palette UI. */
export const HELPER_PALETTE_GROUPS = ['Primitives', 'Features', 'Transforms'];

export function itemsByGroup() {
  const map = Object.fromEntries(HELPER_PALETTE_GROUPS.map((g) => [g, []]));
  for (const item of HELPER_PALETTE_ITEMS) {
    if (!map[item.group]) map[item.group] = [];
    map[item.group].push(item);
  }
  return map;
}
