/**
 * Slice 09 — Helper insert palette snippets.
 * Source of truth: HELPER_FUNCTIONS.md allowlist + gamePuzzles / GameHintsModal.
 * Do NOT invent APIs. Named consts for dimensions; object options where helpers accept them.
 *
 * Sequential taps compose a runnable buffer via composeHelperInsert:
 * strip one trailing `return part;`, insert body (skipping const/let redeclarations),
 * re-append exactly one `return part;`.
 */

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
function declaredNames(buffer) {
  const names = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  const s = stripComments(buffer);
  while ((m = re.exec(s))) names.add(m[1]);
  return names;
}

/**
 * Drop starter / const lines whose binding already exists in the buffer
 * (and within earlier lines of the same snippet).
 */
function filterRedeclarations(snippetText, bufferText) {
  const existing = declaredNames(bufferText);
  const out = [];
  for (const line of String(snippetText || '').split('\n')) {
    const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m && existing.has(m[1])) continue;
    if (m) existing.add(m[1]);
    out.push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/** Minimal centered box — common puzzle starter. */
function starterBoxLines() {
  return [
    'const width = 40;',
    'const depth = 30;',
    'const height = 20;',
    'let part = Manifold.cube([width, depth, height], true);',
  ];
}

function wrapRunnable(bodyLines) {
  return `${bodyLines.join('\n')}\nreturn part;\n`;
}

function ensurePartPrefix(bufferEmpty) {
  if (!bufferEmpty) return [];
  return starterBoxLines();
}

/** Body lines only for non-empty; empty path may still stamp return (stripped by compose). */
function withReturn(lines, bufferEmpty) {
  if (bufferEmpty) return wrapRunnable(lines);
  return `${lines.join('\n')}\n`;
}

/**
 * Build insert text for a palette item (single-shot snippet, may include return).
 * Prefer composeHelperInsert for sequential taps.
 * @param {string} id
 * @param {{ bufferEmpty?: boolean }} opts
 * @returns {string|null}
 */
export function buildHelperSnippet(id, opts = {}) {
  const bufferEmpty = !!opts.bufferEmpty;
  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === id);
  if (!item) return null;
  return item.build(bufferEmpty);
}

/**
 * Template-aware compose: strip trailing return → insert snippet body at caret
 * (skipping redeclarations) → re-append one `return part;`.
 * @param {string} buffer current Monaco buffer
 * @param {string} id palette item id
 * @param {number|null} [caretOffset] offset into buffer; clamped into ops region.
 *   null / omitted → append at end of body (typical sequential taps).
 * @returns {string|null} full replacement buffer
 */
export function composeHelperInsert(buffer, id, caretOffset = null) {
  const item = HELPER_PALETTE_ITEMS.find((h) => h.id === id);
  if (!item) return null;

  const strippedBuf = stripTrailingReturnPart(buffer || '');
  const empty = isBufferEmpty(strippedBuf);
  let snippet = item.build(empty);
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

/** @typedef {{ id: string, label: string, group: string, title: string, build: (empty: boolean) => string }} PaletteItem */

/** @type {PaletteItem[]} */
export const HELPER_PALETTE_ITEMS = [
  // ── Primitives ──────────────────────────────────────────────
  {
    id: 'cube',
    label: 'Cube',
    group: 'Primitives',
    title: 'Manifold.cube([x,y,z], center)',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const width = 40;',
        'const depth = 30;',
        'const height = 20;',
        `${decl} = Manifold.cube([width, depth, height], true);`,
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'cylinder',
    label: 'Cylinder',
    group: 'Primitives',
    title: 'Manifold.cylinder(height, rLow, rHigh, segments)',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const height = 20;',
        'const radius = 10;',
        'const segments = 64;',
        `${decl} = Manifold.cylinder(height, radius, radius, segments);`,
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'sphere',
    label: 'Sphere',
    group: 'Primitives',
    title: 'Manifold.sphere(radius, segments)',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const radius = 15;',
        'const segments = 32;',
        `${decl} = Manifold.sphere(radius, segments);`,
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'tube',
    label: 'Tube',
    group: 'Primitives',
    title: 'tube(outerRadius, innerRadius, height, segments?)',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const outerRadius = 15;',
        'const innerRadius = 10;',
        'const height = 40;',
        'const segments = 32;',
        `${decl} = tube(outerRadius, innerRadius, height, segments);`,
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'hexPrism',
    label: 'Hex',
    group: 'Primitives',
    title: 'hexPrism(radius, height)',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const radius = 12;',
        'const height = 8;',
        `${decl} = hexPrism(radius, height);`,
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'roundedBox',
    label: 'Round box',
    group: 'Primitives',
    title: 'roundedBox(size, radius, segments?)',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const size = [50, 30, 20];',
        'const edgeRadius = 4;',
        'const segments = 16;',
        `${decl} = roundedBox(size, edgeRadius, segments);`,
      ];
      return withReturn(lines, empty);
    },
  },

  // ── Features ────────────────────────────────────────────────
  {
    id: 'filletEdges',
    label: 'Fillet',
    group: 'Features',
    title: 'filletEdges(part, edges, r, opts?)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const radius = 3;',
        'part = filletEdges(part, convexEdges(part), radius, { sphericalCorners: true });',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'chamferEdges',
    label: 'Chamfer',
    group: 'Features',
    title: 'chamferEdges(part, edges, c)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const chamfer = 2;',
        'part = chamferEdges(part, convexEdges(part), chamfer);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'hole',
    label: 'Hole',
    group: 'Features',
    title: 'hole(part, frame, u, v, dia, span)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const dia = 6;',
        'const u = 0;',
        'const v = 0;',
        'const top = facesByNormal(part, [0, 0, 1])[0];',
        'const fr = workplaneFromFace(part, top);',
        'const span = holeSpan(part, fr);',
        'part = hole(part, fr, u, v, dia, span);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'holePattern',
    label: 'Hole grid',
    group: 'Features',
    title: 'holePattern(part, frame, { n, m, spacingU, spacingV, dia })',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const fr = workplaneFromFace(part, facesByNormal(part, [0, 0, 1])[0]);',
        'part = holePattern(part, fr, { n: 3, m: 2, spacingU: 18, spacingV: 14, dia: 4 });',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'clearanceHole',
    label: 'Clearance',
    group: 'Features',
    title: "clearanceHole(part, frame, u, v, size, span?, fit?)",
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        "const size = 'M3';",
        "const fit = 'normal';",
        'const top = facesByNormal(part, [0, 0, 1])[0];',
        'const fr = workplaneFromFace(part, top);',
        'const span = holeSpan(part, fr);',
        'part = clearanceHole(part, fr, 0, 0, size, span, fit);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'tapDrillHole',
    label: 'Tap drill',
    group: 'Features',
    title: 'tapDrillHole(part, frame, u, v, size, span?)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        "const size = 'M3';",
        'const top = facesByNormal(part, [0, 0, 1])[0];',
        'const fr = workplaneFromFace(part, top);',
        'part = tapDrillHole(part, fr, 0, 0, size);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'cboreHole',
    label: 'Cbore',
    group: 'Features',
    title: 'cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const diaThru = 5.5;',
        'const diaCbore = 10;',
        'const cboreDepth = 4;',
        'const u = 0;',
        'const v = 0;',
        'const fr = workplaneFromFace(part, facesByNormal(part, [0, 0, 1])[0]);',
        'const span = holeSpan(part, fr);',
        'part = cboreHole(part, fr, u, v, diaThru, diaCbore, cboreDepth, span);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'cskHole',
    label: 'Csk',
    group: 'Features',
    title: 'cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const diaThru = 3.4;',
        'const diaCsk = 6.5;',
        'const cskDepth = 2;',
        'const u = 0;',
        'const v = 0;',
        'const fr = workplaneFromFace(part, facesByNormal(part, [0, 0, 1])[0]);',
        'const span = holeSpan(part, fr);',
        'part = cskHole(part, fr, u, v, diaThru, diaCsk, cskDepth, span);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'shell',
    label: 'Shell',
    group: 'Features',
    title: "shell(manifold, thickness, axis) — subtract the tool",
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const wall = 2.5;',
        "const axis = 'z';",
        'part = part.subtract(shell(part, wall, axis));',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'addDraft',
    label: 'Draft',
    group: 'Features',
    title: "addDraft(manifold, draftDeg, axis)",
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const draftDeg = 2;',
        "const axis = 'z';",
        'part = addDraft(part, draftDeg, axis);',
      ];
      return withReturn(lines, empty);
    },
  },

  // ── Transforms / layout ─────────────────────────────────────
  {
    id: 'center',
    label: 'Center',
    group: 'Transforms',
    title: 'center(manifold, axes?)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'part = center(part, [true, true, false]);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'align',
    label: 'Align Z0',
    group: 'Transforms',
    title: 'align(manifold, { min / max / center })',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'part = align(part, { min: [undefined, undefined, 0] });',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'mirror',
    label: 'Mirror',
    group: 'Transforms',
    title: "mirror(manifold, plane, keepOriginal?)",
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        "const plane = 'yz';",
        'part = mirror(part, plane, true);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'array3D',
    label: 'Array',
    group: 'Transforms',
    title: 'array3D(manifold, counts, spacing)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const counts = [2, 2, 1];',
        'const spacing = [45, 35, 0];',
        'part = array3D(part, counts, spacing);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'polarArray',
    label: 'Polar',
    group: 'Transforms',
    title: "polarArray(manifold, count, radius, axis?)",
    build: (empty) => {
      // polarArray clones a feature (e.g. bore) — when empty, make a small
      // cylinder then polar-array it so the result is still a solid.
      if (empty) {
        return [
          'const boreRadius = 3;',
          'const boreHeight = 10;',
          'const count = 4;',
          'const boltCircleRadius = 20;',
          "const axis = 'z';",
          'const bore = Manifold.cylinder(boreHeight, boreRadius, boreRadius, 32);',
          'let part = polarArray(bore, count, boltCircleRadius, axis);',
          'return part;',
          '',
        ].join('\n');
      }
      return [
        'const count = 4;',
        'const boltCircleRadius = 20;',
        "const axis = 'z';",
        'part = polarArray(part, count, boltCircleRadius, axis);',
        '',
      ].join('\n');
    },
  },
  {
    id: 'workplane',
    label: 'Workplane',
    group: 'Transforms',
    title: 'facesByNormal + workplaneFromFace (top face)',
    build: (empty) => {
      const lines = [
        ...ensurePartPrefix(empty),
        'const top = facesByNormal(part, [0, 0, 1])[0];',
        'const fr = workplaneFromFace(part, top);',
        'const span = holeSpan(part, fr);',
      ];
      // workplane alone doesn't change the solid — still return part when empty
      return withReturn(lines, empty);
    },
  },
  {
    id: 'makeExtrude',
    label: 'Extrude',
    group: 'Transforms',
    title: 'makeExtrude(contours, height)',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const height = 10;',
        `${decl} = makeExtrude([`,
        '  [[-20, -15], [20, -15], [20, 15], [-20, 15]]',
        '], height);',
      ];
      return withReturn(lines, empty);
    },
  },
  {
    id: 'makeRevolve',
    label: 'Revolve',
    group: 'Transforms',
    title: 'makeRevolve(contours, segments?) — x=radial, y=height',
    build: (empty) => {
      const decl = empty ? 'let part' : 'part';
      const lines = [
        'const segments = 64;',
        `${decl} = makeRevolve([`,
        '  [[8, 0], [25, 0], [25, 6], [12, 6], [12, 40], [8, 40]]',
        '], segments);',
      ];
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
