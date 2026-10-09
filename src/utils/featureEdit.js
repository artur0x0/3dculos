/**
 * Edit a marked feature by reopening the dialog that created it.
 *
 * The strip and the feature list share this path. Confirm rewrites that
 * one block. Cancel never calls confirm, so the script stays byte-identical.
 * A stored edge or face that the current graph cannot resolve stays in
 * `missing` until the user clears it — it is not dropped on open.
 */

import { parseFeatureMarkers } from './featureMarkers.js';
import { deleteFeatureBlock, featureBlockText, liveSheetFeature, inferExtrudeSense } from './featureSheetWriteback.js';
import { scriptWithFeatureCount } from './partHistory.js';
import { shellFaceKey } from './shellMode.js';

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';

/** Creation dialog each strip kind reopens. helperId is the palette item. */
export const FEATURE_EDIT_DIALOGS = Object.freeze({
  profile: { dialog: 'contour', entry: 'crossSection' },
  extrude: { dialog: 'contour', entry: 'makeExtrude' },
  revolve: { dialog: 'contour', entry: 'makeRevolve' },
  loft: { dialog: 'contour', entry: 'makeLoft' },
  sweep: { dialog: 'contour', entry: 'makeSweep' },
  workplane: { dialog: 'contour', entry: 'workplane' },
  fillet: { dialog: 'fillet', entry: 'filletEdges' },
  chamfer: { dialog: 'chamfer', entry: 'chamferEdges' },
  cube: { dialog: 'helper', helperId: 'cube' },
  roundedBox: { dialog: 'helper', helperId: 'roundedBox' },
  cylinder: { dialog: 'helper', helperId: 'cylinder' },
  sphere: { dialog: 'helper', helperId: 'sphere' },
  tube: { dialog: 'helper', helperId: 'tube' },
  hexPrism: { dialog: 'helper', helperId: 'hexPrism' },
  hole: { dialog: 'helper', helperId: 'hole' },
  holePattern: { dialog: 'helper', helperId: 'holePattern' },
  clearanceHole: { dialog: 'helper', helperId: 'clearanceHole' },
  tapDrillHole: { dialog: 'helper', helperId: 'tapDrillHole' },
  cboreHole: { dialog: 'helper', helperId: 'cboreHole' },
  cskHole: { dialog: 'helper', helperId: 'cskHole' },
  shell: { dialog: 'shell', entry: 'shell' },
  draft: { dialog: 'draft', entry: 'addDraft' },
  cut: { dialog: 'cut', entry: 'cut' },
  boolean: { dialog: 'boolean', entry: 'boolean' },
  move: { dialog: 'move', entry: 'move' },
  moveFace: { dialog: 'moveFace', entry: 'moveFace' },
  deleteFace: { dialog: 'deleteFace', entry: 'deleteFace' },
  center: { dialog: 'helper', helperId: 'center' },
  align: { dialog: 'helper', helperId: 'align' },
  mirror: { dialog: 'helper', helperId: 'mirror' },
  array: { dialog: 'helper', helperId: 'array3D' },
  polarArray: { dialog: 'helper', helperId: 'polarArray' },
  sheetMetal: { dialog: 'sheetMetal', entry: 'sheetMetal' },
});

/** One field the golden (and Accept) changes to prove an in-place update. */
export const FEATURE_EDIT_SAMPLE_KEY = Object.freeze({
  profile: 'radius',
  extrude: 'distance',
  revolve: 'angle',
  loft: 'radius',
  sweep: 'radius',
  workplane: 'cz',
  fillet: 'radius',
  chamfer: 'chamfer',
  cube: 'width',
  roundedBox: 'edgeRadius',
  cylinder: 'radius',
  sphere: 'radius',
  tube: 'height',
  hexPrism: 'radius',
  hole: 'u',
  holePattern: 'n',
  clearanceHole: 'u',
  tapDrillHole: 'u',
  cboreHole: 'diaThru',
  cskHole: 'diaThru',
  shell: 'wall',
  draft: 'angle',
  cut: 'originOffset',
  boolean: 'op',
  move: 'dy',
  moveFace: 'distance',
  deleteFace: 'faceCount',
  center: 'cz',
  align: 'body',
  mirror: 'plane',
  array: 'nx',
  polarArray: 'count',
  sheetMetal: 'width',
});

export function creationDialogFor(kind) {
  return FEATURE_EDIT_DIALOGS[kind] || null;
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function lit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || Object.is(v, -0)) return '0';
  if (Number.isInteger(v)) return String(v);
  const r = +v.toFixed(4);
  return String(Object.is(r, -0) ? 0 : r);
}

function grab(text, re) {
  const m = String(text || '').match(re);
  return m || null;
}

/** Top-level arguments of the first `name(` call. Nested commas stay inside an arg. */
function locateCall(src, fnName) {
  const m = String(src || '').match(new RegExp(`\\b${fnName}\\s*\\(`));
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let quote = null;
  const text = String(src);
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return { open, close: i, inner: text.slice(open + 1, i) };
    }
  }
  return null;
}

function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  const text = String(inner || '');
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

function topLevelArgs(src, fnName) {
  const loc = locateCall(src, fnName);
  if (!loc) return null;
  return splitArgs(loc.inner);
}

function replaceNthArg(block, fnName, index, literal) {
  const loc = locateCall(block, fnName);
  if (!loc) return block;
  const args = splitArgs(loc.inner);
  if (index < 0 || index >= args.length) return block;
  args[index] = literal;
  return `${block.slice(0, loc.open + 1)}${args.join(', ')}${block.slice(loc.close)}`;
}

function vec3(src) {
  const parts = String(src || '').split(',').map((s) => num(s.trim()));
  if (parts.length < 3 || parts.some((n) => n == null)) return null;
  return parts.slice(0, 3);
}

function parseProfile(block) {
  const circle = grab(block, new RegExp(`profileCircle\\s*\\(\\s*(${NUM})\\s*,\\s*(${NUM})`));
  if (circle) {
    return { tool: 'circle', radius: num(circle[1]), segments: num(circle[2]) };
  }
  const rect = grab(block, new RegExp(`profileRectangle\\s*\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(true|false)`));
  if (rect) {
    return {
      tool: 'rectangle',
      width: num(rect[1]),
      height: num(rect[2]),
      centered: rect[3] === 'true',
    };
  }
  const poly = grab(block, /profilePolygon\s*\(\s*'([^']+)'\s*,\s*([^)]+)\)/);
  if (poly) {
    const radius = grab(poly[2], new RegExp(NUM));
    return { tool: 'polygon', polygonPreset: poly[1], radius: radius ? num(radius[0]) : null };
  }
  return { tool: null };
}

function parseFaces(block) {
  const faces = [];
  const re = new RegExp(`\\{\\s*center:\\s*\\[([^\\]]+)\\]\\s*,\\s*normal:\\s*\\[([^\\]]+)\\]\\s*\\}`, 'g');
  let m;
  const text = String(block || '');
  while ((m = re.exec(text))) {
    const center = vec3(m[1]);
    const normal = vec3(m[2]);
    if (center && normal) faces.push({ center, normal });
  }
  return faces;
}

/**
 * Edge refs the block stored: boundary ids, a face pair, or a va/vb literal.
 * Opening edit does not drop any of these.
 */
export function parseStoredEdges(block) {
  const text = String(block || '');
  const edges = [];
  const seen = new Set();
  const push = (ref) => {
    const key = Number.isFinite(ref.id)
      ? `id:${ref.id}`
      : (ref.kind === 'pair' ? `pair:${ref.faceA}:${ref.faceB}` : `lit:${ref.a}:${ref.b}`);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(ref);
  };

  const between = /edgesBetween\s*\(\s*[^,]+,\s*(\d+)\s*,\s*(\d+)\s*\)([^\n]*)/g;
  let m;
  while ((m = between.exec(text))) {
    const fa = Number(m[1]);
    const fb = Number(m[2]);
    const comment = /boundary edge\s+(\d+)/.exec(m[3] || '');
    const id = comment ? Number(comment[1]) : null;
    push({
      kind: Number.isFinite(id) ? 'boundary' : 'pair',
      id: Number.isFinite(id) ? id : null,
      faceA: Math.min(fa, fb),
      faceB: Math.max(fa, fb),
    });
  }

  const flat = /\[([0-9,\s]+)\]\s*\.flatMap\s*\(/g;
  while ((m = flat.exec(text))) {
    for (const part of m[1].split(',')) {
      const id = Number(part.trim());
      if (Number.isFinite(id)) push({ kind: 'boundary', id });
    }
  }

  const literal = new RegExp(
    `\\{\\s*a:\\s*(\\d+)\\s*,\\s*b:\\s*(\\d+)\\s*,\\s*va:\\s*\\[([^\\]]+)\\]\\s*,\\s*vb:\\s*\\[([^\\]]+)\\]`,
    'g',
  );
  while ((m = literal.exec(text))) {
    const va = vec3(m[3]);
    const vb = vec3(m[4]);
    if (!va || !vb) continue;
    push({ kind: 'literal', id: null, a: Number(m[1]), b: Number(m[2]), va, vb });
  }
  return edges;
}

function nearVec(a, b, tol = 0.05) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
}

function samePair(edge, ref) {
  if (!Number.isFinite(edge?.faceA) || !Number.isFinite(ref?.faceA)) return false;
  const fa = Math.min(edge.faceA, edge.faceB);
  const fb = Math.max(edge.faceA, edge.faceB);
  return fa === ref.faceA && fb === ref.faceB;
}

/**
 * Match stored edge refs to the live feature-edge graph.
 * Unmatched refs are returned in `missing` and are not removed from `stored`.
 */
export function resolveStoredEdges(stored, liveEdges) {
  const live = Array.isArray(liveEdges) ? liveEdges : [];
  const byId = new Map();
  for (const edge of live) {
    if (!Number.isFinite(edge?.boundaryId)) continue;
    if (!byId.has(edge.boundaryId)) byId.set(edge.boundaryId, edge);
  }
  const resolved = [];
  const missing = [];
  const used = new Set();
  for (const ref of stored || []) {
    let hit = null;
    if (Number.isFinite(ref.id)) hit = byId.get(ref.id) || null;
    if (!hit && ref.kind === 'pair') hit = live.find((edge) => samePair(edge, ref)) || null;
    if (!hit && ref.kind === 'literal') {
      hit = live.find((edge) => nearVec(edge.va, ref.va) && nearVec(edge.vb, ref.vb))
        || live.find((edge) => nearVec(edge.va, ref.vb) && nearVec(edge.vb, ref.va))
        || null;
    }
    if (!hit || used.has(hit)) {
      missing.push(ref);
      continue;
    }
    used.add(hit);
    resolved.push(hit);
  }
  return { resolved, missing };
}

function faceMatch(stored, live) {
  if (!stored || !live) return false;
  if (shellFaceKey(stored) && shellFaceKey(stored) === shellFaceKey(live)) return true;
  if (!nearVec(stored.center, live.center, 1)) return false;
  const n0 = stored.normal;
  const n1 = live.normal;
  if (!n0 || !n1) return false;
  const dot = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
  return dot > 0.98;
}

/** Same contract as edges: a face the graph no longer has stays in `missing`. */
export function resolveStoredFaces(stored, liveFaces) {
  const live = Array.isArray(liveFaces) ? liveFaces : [];
  const resolved = [];
  const missing = [];
  const used = new Set();
  for (const ref of stored || []) {
    const hit = live.find((face) => !used.has(face) && faceMatch(ref, face)) || null;
    if (!hit) {
      missing.push(ref);
      continue;
    }
    used.add(hit);
    resolved.push(hit);
  }
  return { resolved, missing };
}

export function missingSelectionLabel(missing, noun = 'edge') {
  const n = Array.isArray(missing) ? missing.length : 0;
  if (!n) return '';
  const word = n === 1 ? noun : `${noun}s`;
  return `${n} ${word} not found`;
}

function fail(message) {
  return { ok: false, message, fields: {}, edges: [], faces: [] };
}

/**
 * Dialog fields for one marked block. `edges` / `faces` are the stored refs.
 */
export function parseFeatureEdit(kind, blockText) {
  const block = String(blockText || '');
  const dialog = creationDialogFor(kind);
  if (!dialog) return fail(`No creation dialog for ${kind || 'feature'}`);
  if (!block.trim()) return fail('Empty feature block');

  const base = { ok: true, kind, dialog: dialog.dialog, entry: dialog.entry || null, helperId: dialog.helperId || null };
  const faces = parseFaces(block);
  const edges = parseStoredEdges(block);

  if (kind === 'extrude') {
    const dist = grab(block, new RegExp(`makeExtrude\\s*\\(\\s*[^,]+,\\s*(${NUM})\\s*\\)`));
    if (!dist) return fail('No makeExtrude distance');
    const distance = num(dist[1]);
    const wM = grab(block, new RegExp(
      `placeInFrame\\s*\\([^\\]]*makeExtrude[\\s\\S]*?\\[\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*(${NUM})\\s*\\]`,
    ));
    const w = wM ? num(wM[1], 0) : 0;
    const profile = parseProfile(block);
    return {
      ...base,
      fields: { distance, sense: inferExtrudeSense(distance, w), ...profileFields(profile) },
      edges,
      faces,
    };
  }

  if (kind === 'revolve') {
    const args = topLevelArgs(block, 'makeRevolve');
    const angle = args ? num(args[2]) : null;
    if (angle == null) return fail('No makeRevolve angle');
    return { ...base, fields: { angle, ...profileFields(parseProfile(block)) }, edges, faces };
  }

  if (kind === 'profile' || kind === 'loft' || kind === 'sweep') {
    const profile = parseProfile(block);
    if (!profile.tool) return fail(`No profile in ${kind}`);
    const fields = profileFields(profile);
    if (kind === 'loft') {
      const radii = [...block.matchAll(new RegExp(`profileCircle\\s*\\(\\s*(${NUM})`, 'g'))].map((m) => num(m[1]));
      if (radii.length) fields.radius = radii[0];
      fields.radii = radii;
    }
    if (kind === 'sweep') fields.reverse = /reverse:\s*true/.test(block);
    return { ...base, fields, edges, faces };
  }

  if (kind === 'workplane') {
    const center = grab(block, /center:\s*\[([^\]]+)\]/);
    const c = center ? vec3(center[1]) : [0, 0, 0];
    return { ...base, fields: { cx: c[0], cy: c[1], cz: c[2] }, edges, faces };
  }

  if (kind === 'fillet' || kind === 'chamfer') {
    const along = grab(block, new RegExp(`filletAlongPath\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*(${NUM})`));
    const classic = grab(block, new RegExp(
      kind === 'chamfer'
        ? `chamferEdges\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*(${NUM})`
        : `filletEdges\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*(${NUM})`,
    ));
    const m = along || classic;
    if (!m) return fail(kind === 'chamfer' ? 'No chamfer size' : 'No fillet radius');
    const value = num(m[1]);
    const fields = kind === 'chamfer'
      ? { chamfer: value }
      : { radius: value, variableProfile: /variableProfile:\s*true/.test(block) };
    return { ...base, fields, edges, faces };
  }

  if (kind === 'cube') {
    const m = grab(block, new RegExp(`Manifold\\.cube\\(\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]\\s*,\\s*(true|false)`));
    if (!m) return fail('No cube');
    return {
      ...base,
      fields: { width: num(m[1]), depth: num(m[2]), height: num(m[3]), center: m[4] === 'true', ...poseFields(block) },
      edges, faces,
    };
  }
  if (kind === 'roundedBox') {
    const m = grab(block, new RegExp(`roundedBox\\(\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})`));
    if (!m) return fail('No rounded box');
    return {
      ...base,
      fields: { sx: num(m[1]), sy: num(m[2]), sz: num(m[3]), edgeRadius: num(m[4]), segments: num(m[5]), ...poseFields(block) },
      edges, faces,
    };
  }
  if (kind === 'cylinder') {
    const m = grab(block, new RegExp(`Manifold\\.cylinder\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})`));
    if (!m) return fail('No cylinder');
    return { ...base, fields: { height: num(m[1]), radius: num(m[2]), segments: num(m[4]), ...poseFields(block) }, edges, faces };
  }
  if (kind === 'sphere') {
    const m = grab(block, new RegExp(`Manifold\\.sphere\\(\\s*(${NUM})\\s*,\\s*(${NUM})`));
    if (!m) return fail('No sphere');
    return { ...base, fields: { radius: num(m[1]), segments: num(m[2]), ...poseFields(block) }, edges, faces };
  }
  if (kind === 'tube') {
    const rect = grab(block, new RegExp(`tube\\(\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})`));
    if (rect) {
      const corner = grab(block, /cornerRadius:\s*([-+\d.eE]+)/);
      return {
        ...base,
        fields: {
          section: 'rect', width: num(rect[1]), depth: num(rect[2]), wall: num(rect[3]), height: num(rect[4]),
          cornerRadius: corner ? num(corner[1], 0) : 0,
          ...poseFields(block),
        },
        edges, faces,
      };
    }
    const round = grab(block, new RegExp(`tube\\(\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})`));
    if (!round) return fail('No tube');
    return {
      ...base,
      fields: {
        section: 'round', outerRadius: num(round[1]), innerRadius: num(round[2]), height: num(round[3]), segments: num(round[4]),
        ...poseFields(block),
      },
      edges, faces,
    };
  }
  if (kind === 'hexPrism') {
    const m = grab(block, new RegExp(`hexPrism\\(\\s*(${NUM})\\s*,\\s*(${NUM})`));
    if (!m) return fail('No hex');
    return { ...base, fields: { radius: num(m[1]), height: num(m[2]), ...poseFields(block) }, edges, faces };
  }

  if (kind === 'hole' || kind === 'clearanceHole') {
    const c = grab(block, new RegExp(`clearanceHole\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*'([^']+)'\\s*,\\s*[^,]+,\\s*'([^']+)'`));
    if (c) {
      return { ...base, fields: { holeType: 'clearance', u: num(c[1]), v: num(c[2]), size: c[3], fit: c[4] }, edges, faces };
    }
    const t = grab(block, new RegExp(`tapDrillHole\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*'([^']+)'`));
    if (t) return { ...base, fields: { holeType: 'tapDrill', u: num(t[1]), v: num(t[2]), size: t[3] }, edges, faces };
    return fail('No hole call');
  }
  if (kind === 'tapDrillHole') {
    const t = grab(block, new RegExp(`tapDrillHole\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*'([^']+)'`));
    if (!t) return fail('No tap drill');
    return { ...base, fields: { u: num(t[1]), v: num(t[2]), size: t[3] }, edges, faces };
  }
  if (kind === 'holePattern') {
    const n = grab(block, /n:\s*(\d+)/);
    const m = grab(block, /m:\s*(\d+)/);
    const su = grab(block, new RegExp(`spacingU:\\s*(${NUM})`));
    const sv = grab(block, new RegExp(`spacingV:\\s*(${NUM})`));
    const dia = grab(block, new RegExp(`dia:\\s*(${NUM})`));
    if (!n || !dia) return fail('No hole pattern');
    return {
      ...base,
      fields: { n: num(n[1]), m: m ? num(m[1]) : 2, spacingU: su ? num(su[1]) : 18, spacingV: sv ? num(sv[1]) : 14, dia: num(dia[1]) },
      edges, faces,
    };
  }
  if (kind === 'cboreHole' || kind === 'cskHole') {
    const fn = kind === 'cboreHole' ? 'cboreHole' : 'cskHole';
    const m = grab(block, new RegExp(`${fn}\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})`));
    if (!m) return fail(`No ${fn}`);
    const depthKey = kind === 'cboreHole' ? 'cboreDepth' : 'cskDepth';
    const diaKey = kind === 'cboreHole' ? 'diaCbore' : 'diaCsk';
    return {
      ...base,
      fields: { u: num(m[1]), v: num(m[2]), diaThru: num(m[3]), [diaKey]: num(m[4]), [depthKey]: num(m[5]) },
      edges, faces,
    };
  }

  if (kind === 'shell') {
    const wall = grab(block, new RegExp(`hollow\\s*\\(\\s*[^,]+,\\s*(${NUM})`));
    if (!wall) return fail('No hollow');
    const closed = /hollow\s*\(\s*[^,]+,\s*[^,]+,\s*'none'\s*\)/.test(block);
    return {
      ...base,
      fields: { wall: num(wall[1]), openingMode: closed ? 'none' : 'face' },
      edges,
      faces: closed ? [] : faces,
    };
  }

  if (kind === 'draft') {
    const args = topLevelArgs(block, 'draftFaces');
    const angle = args ? num(args[2]) : null;
    if (angle == null) return fail('No draft angle');
    const refM = block.match(/reference:\s*\{\s*center:\s*\[([^\]]+)\]\s*,\s*normal:\s*\[([^\]]+)\]/);
    const reference = refM && vec3(refM[1]) && vec3(refM[2])
      ? { center: vec3(refM[1]), normal: vec3(refM[2]) }
      : null;
    const drafts = reference
      ? faces.filter((face) => !(nearVec(face.center, reference.center, 0.01) && nearVec(face.normal, reference.normal, 0.01)))
      : faces;
    return {
      ...base,
      fields: { angle, flip: /pull:\s*\[-[^\]]+\]/.test(block) },
      edges,
      faces: drafts,
      reference,
    };
  }

  if (kind === 'cut') {
    const off = grab(block, new RegExp(`originOffset:\\s*(${NUM})`));
    const keep = grab(block, /keep:\s*'([+-])'/);
    return {
      ...base,
      fields: { originOffset: off ? num(off[1]) : 0, keep: keep ? keep[1] : 'both' },
      edges,
      faces,
    };
  }

  if (kind === 'boolean') {
    const op = grab(block, /op:\s*'(\w+)'/);
    if (!op) return fail('No boolean op');
    return { ...base, fields: { op: op[1] }, edges, faces };
  }

  if (kind === 'move') {
    const m = grab(block, new RegExp(`move\\s*\\(\\s*[^,]+,\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]`));
    if (!m) return fail('No move');
    const at = grab(block, new RegExp(`at:\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})`));
    return {
      ...base,
      fields: {
        dx: num(m[1]),
        dy: num(m[2]),
        dz: num(m[3]),
        at: at ? [num(at[1]), num(at[2]), num(at[3])] : null,
      },
      edges,
      faces,
    };
  }

  if (kind === 'moveFace') {
    const m = grab(block, new RegExp(`moveFace\\s*\\(\\s*[^,]+,\\s*\\[[\\s\\S]*?\\]\\s*,\\s*(${NUM})`));
    if (!m) return fail('No moveFace');
    return { ...base, fields: { distance: num(m[1]), flip: /flip:\s*true/.test(block) }, edges, faces };
  }

  if (kind === 'deleteFace') {
    if (!/deleteFace\s*\(/.test(block)) return fail('No deleteFace');
    return { ...base, fields: { faceCount: faces.length }, edges, faces };
  }

  if (kind === 'center') {
    const m = grab(block, /center\s*\(\s*[^,]+,\s*\[\s*(true|false)\s*,\s*(true|false)\s*,\s*(true|false)\s*\]/);
    if (!m) return fail('No center');
    return { ...base, fields: { cx: m[1] === 'true', cy: m[2] === 'true', cz: m[3] === 'true', body: bodyOf(block, 'center') }, edges, faces };
  }

  if (kind === 'align') {
    if (!/align\s*\(/.test(block)) return fail('No align');
    return { ...base, fields: { body: bodyOf(block, 'align') }, edges, faces };
  }

  if (kind === 'mirror') {
    const m = grab(block, /mirror\s*\(\s*[^,]+,\s*'(\w+)'\s*,\s*(true|false)/);
    if (!m) return fail('No mirror');
    return { ...base, fields: { plane: m[1], keepOriginal: m[2] === 'true' }, edges, faces };
  }

  if (kind === 'array') {
    const m = grab(block, new RegExp(`array3D\\s*\\(\\s*[^,]+,\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]\\s*,\\s*\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]`));
    if (!m) return fail('No array');
    return {
      ...base,
      fields: { arrayType: 'grid', nx: num(m[1]), ny: num(m[2]), nz: num(m[3]), sx: num(m[4]), sy: num(m[5]), sz: num(m[6]) },
      edges, faces,
    };
  }

  if (kind === 'polarArray') {
    const m = grab(block, new RegExp(`polarArray\\s*\\(\\s*[^,]+,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*'(\\w+)'`));
    if (!m) return fail('No polar array');
    return { ...base, fields: { count: num(m[1]), boltCircleRadius: num(m[2]), axis: m[3] }, edges, faces };
  }

  if (kind === 'sheetMetal') {
    const m = grab(block, /const sheetSpec\s*=\s*(\{.*\});/);
    if (!m) return fail('No sheet spec');
    try {
      const spec = JSON.parse(m[1]);
      return {
        ...base,
        fields: { width: num(spec.width), height: num(spec.height), sku: spec.sku || '', t: num(spec.t) },
        spec,
        edges, faces,
      };
    } catch {
      return fail('Sheet spec is not JSON');
    }
  }

  return fail(`No parser for ${kind}`);
}

function profileFields(profile) {
  const out = {};
  if (!profile) return out;
  if (profile.tool) out.tool = profile.tool;
  if (profile.radius != null) out.radius = profile.radius;
  if (profile.segments != null) out.segments = profile.segments;
  if (profile.width != null) out.width = profile.width;
  if (profile.height != null) out.height = profile.height;
  if (profile.centered != null) out.centered = profile.centered;
  if (profile.polygonPreset) out.polygonPreset = profile.polygonPreset;
  return out;
}

function poseFields(block) {
  const t = grab(block, new RegExp(`\\.translate\\(\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]\\)`));
  const r = grab(block, new RegExp(`\\.rotate\\(\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]\\)`));
  return {
    x: t ? num(t[1]) : 0,
    y: t ? num(t[2]) : 0,
    z: t ? num(t[3]) : 0,
    rx: r ? num(r[1]) : 0,
    ry: r ? num(r[2]) : 0,
    rz: r ? num(r[3]) : 0,
  };
}

function bodyOf(block, fn) {
  const m = grab(block, new RegExp(`(\\w+)\\s*=\\s*${fn}\\s*\\(\\s*\\1`));
  return m ? m[1] : 'part';
}

function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

export function fieldsEqual(a, b) {
  const left = a || {};
  const right = b || {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const av = left[key];
    const bv = right[key];
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
      continue;
    }
    if (!sameValue(av, bv)) return false;
  }
  return true;
}

function edgeIdList(edges) {
  return (edges || []).map((edge) => (Number.isFinite(edge.id) ? edge.id : edge.boundaryId)).filter((id) => Number.isFinite(id));
}

/**
 * Script of the solid this feature was applied to (this block and later
 * ones removed). The viewport rebuilds face and edge graphs on that mesh
 * before it resolves stored ids.
 */
export function editPreviewScript(script, feature) {
  if (!feature || !Number.isInteger(feature.index)) return typeof script === 'string' ? script : '';
  return scriptWithFeatureCount(script, feature.index);
}

/**
 * Open-edit snapshot: dialog id, pre-filled fields, resolved and missing refs.
 * `graphs.edges` / `graphs.faces` are the current (or prefix) graphs.
 */
export function openFeatureEdit(script, feature, graphs = null) {
  if (!feature) return fail('No feature');
  const live = liveSheetFeature(script, feature) || feature;
  const block = featureBlockText(script, live);
  const parsed = parseFeatureEdit(live.kind, block);
  if (!parsed.ok) return parsed;
  const edgeRes = resolveStoredEdges(parsed.edges, graphs?.edges);
  const faceRes = resolveStoredFaces(parsed.faces, graphs?.faces);
  return {
    ...parsed,
    feature: live,
    block,
    resolvedEdges: edgeRes.resolved,
    missingEdges: edgeRes.missing,
    resolvedFaces: faceRes.resolved,
    missingFaces: faceRes.missing,
    missingEdgeLabel: missingSelectionLabel(edgeRes.missing, 'edge'),
    missingFaceLabel: missingSelectionLabel(faceRes.missing, 'face'),
  };
}

function bump(value, key) {
  if (typeof value === 'number') {
    if (key === 'sense') return value;
    const step = Number.isInteger(value) ? 1 : 0.5;
    return +(value + step).toFixed(4);
  }
  if (typeof value === 'boolean') return !value;
  if (key === 'sense') return value === 'negative' ? 'positive' : 'negative';
  if (key === 'op') return value === 'union' ? 'difference' : 'union';
  if (key === 'plane') return value === 'yz' ? 'xy' : 'yz';
  if (key === 'size') return value === 'M4' ? 'M5' : 'M4';
  if (key === 'body') return value === 'part' ? 'part2' : 'part';
  if (key === 'keep') return value === '+' ? 'both' : '+';
  if (key === 'openingMode') return value === 'none' ? 'face' : 'none';
  if (key === 'section') return value === 'rect' ? 'round' : 'rect';
  if (key === 'axis') return value === 'z' ? 'x' : 'z';
  if (key === 'sku') return `${value || 'sku'}-edit`;
  if (key === 'tool') return value === 'circle' ? 'rectangle' : 'circle';
  return value;
}

/** Draft with exactly one dialog field changed. Face-count drops one face. */
export function withSampleChange(session) {
  const key = FEATURE_EDIT_SAMPLE_KEY[session.kind];
  const fields = { ...(session.fields || {}) };
  if (session.kind === 'deleteFace') {
    const faces = (session.faces || []).slice(0, Math.max(0, (session.faces || []).length - 1));
    return { fields: { ...fields, faceCount: faces.length }, faces, clearMissing: false };
  }
  if (key && Object.prototype.hasOwnProperty.call(fields, key)) {
    fields[key] = bump(fields[key], key);
  }
  return { fields, clearMissing: false };
}

function replaceNum(block, re, value) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  return block.replace(global, (full, head) => `${head}${lit(value)}`);
}

function rewriteEdges(block, ids) {
  const lines = block.split('\n');
  const decl = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/edgesBetween\s*\(/.test(lines[i]) || /\.flatMap\s*\(/.test(lines[i])) decl.push(i);
  }
  if (!decl.length) return block;
  const name = (lines[decl[0]].match(/const\s+(\w+)\s*=/) || [])[1] || 'selEdges';
  const body = (lines[decl[0]].match(/edgesBetween\s*\(\s*(\w+)/) || lines[decl[0]].match(/edge\s*\(\s*(\w+)/) || [])[1] || 'part';
  const list = ids.filter((id) => Number.isFinite(id));
  const droppedNames = decl.slice(1).map((i) => (lines[i].match(/const\s+(\w+)\s*=/) || [])[1]).filter(Boolean);
  lines[decl[0]] = `const ${name} = [${list.join(', ')}].flatMap((id) => edge(${body}, id));`;
  const drop = new Set(decl.slice(1));
  const pathNames = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (drop.has(i)) continue;
    for (const dropped of droppedNames) {
      if (new RegExp(`makeSweepPath\\s*\\(\\s*${dropped}\\b`).test(lines[i])) {
        drop.add(i);
        const pathName = (lines[i].match(/const\s+(\w+)\s*=/) || [])[1];
        if (pathName) pathNames.add(pathName);
      }
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (drop.has(i)) continue;
    for (const pathName of pathNames) {
      if (new RegExp(`filletAlongPath\\s*\\([^\\n]*\\b${pathName}\\b`).test(lines[i])) drop.add(i);
    }
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

function rewriteFaces(block, faces) {
  const body = faces.map((face) => {
    const c = face.center.map((n) => lit(n)).join(', ');
    const n = face.normal.map((v) => lit(v)).join(', ');
    return `{ center: [${c}], normal: [${n}] }`;
  }).join(', ');
  return block.replace(/(\[\s*)\{[\s\S]*?\}(\s*\])/, `$1${body}$2`);
}

function rewriteBlock(block, session, draft) {
  const kind = session.kind;
  const fields = draft.fields || {};
  const prev = session.fields || {};
  let next = block;

  const setNum = (re, key) => {
    if (sameValue(fields[key], prev[key]) || fields[key] == null) return;
    if (!new RegExp(re.source).test(next)) return;
    next = replaceNum(next, re, fields[key]);
  };

  if (kind === 'extrude') {
    setNum(new RegExp(`(makeExtrude\\s*\\(\\s*[^,]+,\\s*)(${NUM})`), 'distance');
    if (!sameValue(fields.sense, prev.sense) && fields.distance != null) {
      const d = Math.max(0.1, num(fields.distance, prev.distance));
      const sense = fields.sense === 'negative' || fields.sense === 'both' ? fields.sense : 'positive';
      const w = sense === 'negative' ? -d : sense === 'both' ? -d / 2 : 0;
      next = next.replace(
        new RegExp(`(placeInFrame\\s*\\([\\s\\S]*?\\[\\s*)(${NUM})(\\s*,\\s*)(${NUM})(\\s*,\\s*)(${NUM})(\\s*\\])`),
        `$10$30$5${lit(w)}$7`,
      );
    }
  } else if (kind === 'revolve') {
    if (!sameValue(fields.angle, prev.angle) && fields.angle != null) {
      next = replaceNthArg(next, 'makeRevolve', 2, lit(fields.angle));
    }
  } else if (kind === 'profile' || kind === 'loft' || kind === 'sweep') {
    setNum(new RegExp(`(profileCircle\\s*\\(\\s*)(${NUM})`), 'radius');
    setNum(new RegExp(`(profileRectangle\\s*\\(\\s*)(${NUM})`), 'width');
  } else if (kind === 'workplane') {
    if (!sameValue(fields.cz, prev.cz)) {
      next = next.replace(
        new RegExp(`(center:\\s*\\[\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*)(${NUM})`),
        `$1${lit(fields.cz)}`,
      );
    }
  } else if (kind === 'fillet') {
    setNum(new RegExp(`(filletAlongPath\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*)(${NUM})`), 'radius');
    setNum(new RegExp(`(filletEdges\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*)(${NUM})`), 'radius');
  } else if (kind === 'chamfer') {
    setNum(new RegExp(`(filletAlongPath\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*)(${NUM})`), 'chamfer');
    setNum(new RegExp(`(chamferEdges\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*)(${NUM})`), 'chamfer');
  } else if (kind === 'cube') {
    setNum(new RegExp(`(Manifold\\.cube\\(\\s*\\[\\s*)(${NUM})`), 'width');
    setNum(new RegExp(`(Manifold\\.cube\\(\\s*\\[\\s*${NUM}\\s*,\\s*)(${NUM})`), 'depth');
    setNum(new RegExp(`(Manifold\\.cube\\(\\s*\\[\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*)(${NUM})`), 'height');
  } else if (kind === 'roundedBox') {
    setNum(new RegExp(`(roundedBox\\(\\s*\\[[^\\]]+\\]\\s*,\\s*)(${NUM})`), 'edgeRadius');
  } else if (kind === 'cylinder' || kind === 'sphere' || kind === 'hexPrism') {
    const fn = kind === 'cylinder' ? 'Manifold\\.cylinder' : kind === 'sphere' ? 'Manifold\\.sphere' : 'hexPrism';
    if (kind === 'cylinder') setNum(new RegExp(`(${fn}\\(\\s*${NUM}\\s*,\\s*)(${NUM})`), 'radius');
    else setNum(new RegExp(`(${fn}\\(\\s*)(${NUM})`), 'radius');
  } else if (kind === 'tube') {
    setNum(new RegExp(`(tube\\(\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*)(${NUM})`), 'height');
    setNum(new RegExp(`(tube\\(\\s*\\[[^\\]]+\\]\\s*,\\s*${NUM}\\s*,\\s*)(${NUM})`), 'height');
  } else if (kind === 'hole' || kind === 'clearanceHole' || kind === 'tapDrillHole') {
    const fn = /tapDrillHole\s*\(/.test(next) && kind !== 'clearanceHole' && !/clearanceHole\s*\(/.test(next)
      ? 'tapDrillHole'
      : (/clearanceHole\s*\(/.test(next) ? 'clearanceHole' : 'tapDrillHole');
    setNum(new RegExp(`(${fn}\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*)(${NUM})`), 'u');
  } else if (kind === 'holePattern') {
    setNum(/(n:\s*)(\d+)/, 'n');
  } else if (kind === 'cboreHole' || kind === 'cskHole') {
    const fn = kind === 'cboreHole' ? 'cboreHole' : 'cskHole';
    setNum(new RegExp(`(${fn}\\s*\\(\\s*[^,]+,\\s*[^,]+,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*)(${NUM})`), 'diaThru');
  } else if (kind === 'shell') {
    setNum(new RegExp(`(hollow\\s*\\(\\s*[^,]+,\\s*)(${NUM})`), 'wall');
  } else if (kind === 'draft') {
    if (!sameValue(fields.angle, prev.angle) && fields.angle != null) {
      next = replaceNthArg(next, 'draftFaces', 2, lit(fields.angle));
    }
  } else if (kind === 'cut') {
    setNum(new RegExp(`(originOffset:\\s*)(${NUM})`), 'originOffset');
  } else if (kind === 'boolean') {
    if (!sameValue(fields.op, prev.op) && fields.op) {
      next = next.replace(/op:\s*'(\w+)'/, `op: '${fields.op}'`);
    }
  } else if (kind === 'move') {
    setNum(new RegExp(`(move\\s*\\(\\s*[^,]+,\\s*\\[\\s*${NUM}\\s*,\\s*)(${NUM})`), 'dy');
    setNum(new RegExp(`(move\\s*\\(\\s*[^,]+,\\s*\\[\\s*)(${NUM})`), 'dx');
  } else if (kind === 'moveFace') {
    setNum(new RegExp(`(moveFace\\s*\\(\\s*[^,]+,\\s*\\[[\\s\\S]*?\\]\\s*,\\s*)(${NUM})`), 'distance');
  } else if (kind === 'deleteFace') {
    if (Array.isArray(draft.faces) && draft.faces.length !== (session.faces || []).length) {
      next = rewriteFaces(next, draft.faces);
    }
  } else if (kind === 'center') {
    if (!sameValue(fields.cz, prev.cz)) {
      const cx = fields.cx != null ? fields.cx : prev.cx;
      const cy = fields.cy != null ? fields.cy : prev.cy;
      const cz = fields.cz;
      next = next.replace(
        /center\s*\(\s*([^,]+),\s*\[\s*(?:true|false)\s*,\s*(?:true|false)\s*,\s*(?:true|false)\s*\]/,
        `center($1, [${cx}, ${cy}, ${cz}]`,
      );
    }
  } else if (kind === 'align') {
    if (fields.body && fields.body !== prev.body) {
      const from = prev.body || 'part';
      next = next.replace(
        new RegExp(`\\b${from}\\s*=\\s*align\\(\\s*${from}`),
        `${fields.body} = align(${fields.body}`,
      );
    }
  } else if (kind === 'mirror') {
    if (fields.plane && fields.plane !== prev.plane) {
      next = next.replace(/mirror\s*\(\s*([^,]+),\s*'(\w+)'/, `mirror($1, '${fields.plane}'`);
    }
  } else if (kind === 'array') {
    setNum(new RegExp(`(array3D\\s*\\(\\s*[^,]+,\\s*\\[\\s*)(${NUM})`), 'nx');
  } else if (kind === 'polarArray') {
    setNum(new RegExp(`(polarArray\\s*\\(\\s*[^,]+,\\s*)(${NUM})`), 'count');
  } else if (kind === 'sheetMetal') {
    if (!sameValue(fields.width, prev.width)) {
      next = next.replace(/("width"\s*:\s*)(-?\d+(?:\.\d+)?)/, `$1${lit(fields.width)}`);
    }
  }

  if (Array.isArray(draft.edgeIds)) {
    next = rewriteEdges(next, draft.edgeIds);
  }
  return next;
}

function draftEdgeIds(session, draft) {
  if (Array.isArray(draft.edgeIds)) return draft.edgeIds;
  const stored = edgeIdList(session.edges);
  if (!draft.clearMissing) return null;
  const missing = new Set(edgeIdList(session.missingEdges || []));
  return stored.filter((id) => !missing.has(id));
}

/**
 * Rewrite `feature` inside `script`. Unchanged fields and refs return the
 * original string. A change replaces that block only.
 */
export function confirmFeatureEdit(script, feature, draft = {}) {
  const text = typeof script === 'string' ? script : '';
  const live = liveSheetFeature(text, feature);
  if (!live) return { ok: false, message: 'That feature is not in this part\'s script any more — pick it again.' };
  const session = openFeatureEdit(text, live);
  if (!session.ok) return session;
  const fields = draft.fields || session.fields;
  const edgeIds = draftEdgeIds(session, draft);
  const edgesSame = edgeIds == null || JSON.stringify(edgeIds) === JSON.stringify(edgeIdList(session.edges));
  const facesSame = !Array.isArray(draft.faces)
    || JSON.stringify(draft.faces) === JSON.stringify(session.faces);
  if (fieldsEqual(fields, session.fields) && edgesSame && facesSame && !draft.clearMissing) {
    return { ok: true, buffer: text, changed: false, run: false };
  }
  const beforeCount = parseFeatureMarkers(text).length;
  const rewritten = rewriteBlock(session.block, session, { ...draft, fields, edgeIds: edgesSame ? null : edgeIds });
  if (rewritten === session.block) {
    return { ok: true, buffer: text, changed: false, run: false };
  }
  const buffer = text.slice(0, live.startOffset) + rewritten + text.slice(live.endOffset);
  const after = parseFeatureMarkers(buffer);
  if (after.length !== beforeCount) {
    return { ok: false, message: 'Edit would add or drop a feature — refusing.' };
  }
  const again = after.find((f) => f.kind === live.kind && f.index === live.index)
    || after.find((f) => f.id === live.id);
  if (!again) return { ok: false, message: 'Edit lost the feature block — refusing.' };
  return { ok: true, buffer, changed: true, run: true, feature: again };
}

const STALE_FEATURE = 'That feature is not in this part\'s script any more — pick it again.';

function markerBlocks(script) {
  return parseFeatureMarkers(script).map((feature) => script.slice(feature.startOffset, feature.endOffset));
}

/**
 * Drop one marked feature. The block is the same span Confirm rewrites
 * (`liveSheetFeature`: id and kind, else kind and index). One bordering
 * newline is collapsed so neighbours do not gain a blank row. Every other
 * marked block stays byte-identical, including comments outside the span.
 */
export function deleteFeatureEdit(script, feature) {
  const text = typeof script === 'string' ? script : '';
  const live = liveSheetFeature(text, feature);
  if (!live) return { ok: false, message: STALE_FEATURE };
  const features = parseFeatureMarkers(text);
  const kept = features
    .filter((item) => item.startOffset !== live.startOffset)
    .map((item) => text.slice(item.startOffset, item.endOffset));
  const result = deleteFeatureBlock(text, live);
  if (!result.ok) return result;
  const after = markerBlocks(result.buffer);
  if (after.length !== kept.length || after.some((block, i) => block !== kept[i])) {
    return { ok: false, message: 'Delete would change another feature — refusing.' };
  }
  if (result.buffer === text) {
    return { ok: false, message: 'Delete did not remove the feature — refusing.' };
  }
  return { ok: true, buffer: result.buffer, changed: true, run: true, feature: live };
}

function codeText(block) {
  let src = String(block || '').replace(/\/\*[\s\S]*?\*\//g, '');
  src = src.replace(/'(?:\\.|[^'\n])*'|"(?:\\.|[^"\n])*"|`(?:\\.|[^`])*`/g, '""');
  src = src.replace(/\/\/[^\n]*/g, '');
  return src;
}

function declaredNamesIn(block) {
  const names = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  const src = codeText(block);
  while ((match = re.exec(src))) names.add(match[1]);
  return names;
}

/** Bodies this block creates or writes. Later edge and face calls name these. */
function assignedBodies(block) {
  const names = new Set();
  const re = /(?:^|[\n;])\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=/g;
  let match;
  const src = codeText(block);
  while ((match = re.exec(src))) names.add(match[1]);
  return names;
}

function callBodies(block, fns) {
  const names = new Set();
  const re = new RegExp(`\\b(?:${fns})\\s*\\(\\s*([A-Za-z_$][\\w$]*)`, 'g');
  let match;
  const src = codeText(block);
  while ((match = re.exec(src))) names.add(match[1]);
  return names;
}

function mentionsName(block, name) {
  if (declaredNamesIn(block).has(name)) return false;
  return new RegExp(`\\b${name}\\b`).test(codeText(block));
}

function dependentMessage(label, reason, name) {
  const who = label || 'A later feature';
  if (reason === 'edges') return `${who} uses this feature's edges and may fail`;
  if (reason === 'faces') return `${who} uses this feature's faces and may fail`;
  return `${who} uses ${name} from this feature and may fail`;
}

function suffixOutsideFeatures(script, endOffset, later) {
  let out = '';
  let cursor = endOffset;
  for (const feature of later) {
    if (feature.startOffset < cursor) continue;
    out += script.slice(cursor, feature.startOffset);
    cursor = Math.max(cursor, feature.endOffset);
  }
  out += script.slice(cursor);
  return out;
}

/**
 * Later features that reference this one.
 *
 * The mesh feature graph names edges and faces, not which block created
 * them, so this reads the script. A later fillet, chamfer, or sweep that
 * calls `edgesBetween` / `edge` / `filletAlongPath` on a body this block
 * writes is an edge dependent. A later cut, Move Face, Delete Face, shell,
 * or draft that stores a face (`center:`) on that body is a face dependent.
 * A `const` / `let` / `var` this block declares (other than `part`) that
 * later code uses is a variable dependent. Earlier features are ignored.
 */
export function featureDependents(script, feature) {
  const text = typeof script === 'string' ? script : '';
  const live = liveSheetFeature(text, feature);
  if (!live) return [];
  const block = text.slice(live.startOffset, live.endOffset);
  const owns = assignedBodies(block);
  const vars = [...declaredNamesIn(block)].filter((name) => name !== 'part');
  const later = parseFeatureMarkers(text).filter((item) => item.startOffset >= live.endOffset);
  const out = [];
  const push = (item, reason, name) => {
    const label = item?.chipLabel || item?.label || 'Later code';
    out.push({
      id: item?.id || null,
      kind: item?.kind || null,
      label,
      reason,
      name: name || null,
      message: dependentMessage(label, reason, name),
    });
  };
  for (const next of later) {
    const chunk = text.slice(next.startOffset, next.endOffset);
    const edgeBodies = callBodies(chunk, 'edgesBetween|edge|filletEdges|chamferEdges|filletAlongPath');
    if ([...edgeBodies].some((body) => owns.has(body))) push(next, 'edges');
    const faceBodies = callBodies(chunk, 'moveFace|deleteFace|cut|hollow|draftFaces');
    const targetsFace = /center\s*:/.test(codeText(chunk)) || /facesByNormal\s*\(/.test(codeText(chunk));
    if (targetsFace && [...faceBodies].some((body) => owns.has(body))) push(next, 'faces');
    for (const name of vars) {
      if (mentionsName(chunk, name)) push(next, 'variable', name);
    }
  }
  const gap = suffixOutsideFeatures(text, live.endOffset, later);
  for (const name of vars) {
    if (mentionsName(gap, name)) push(null, 'variable', name);
  }
  return out;
}

/** Lines for the post-delete toast. An empty list means no toast. */
export function dependentToastLines(dependents) {
  if (!Array.isArray(dependents)) return [];
  return dependents
    .map((item) => item?.message)
    .filter((line) => typeof line === 'string' && line.length > 0);
}

/**
 * Seed passed to the contour chip so its fields match the saved block.
 */
export function contourSeedFromEdit(session) {
  if (!session?.ok) return null;
  const f = session.fields || {};
  const seed = {};
  if (f.tool) seed.tool = f.tool;
  if (f.radius != null || f.segments != null || f.width != null) {
    seed.params = {};
    if (f.radius != null) seed.params.radius = f.radius;
    if (f.segments != null) seed.params.segments = f.segments;
    if (f.width != null) seed.params.width = f.width;
    if (f.height != null) seed.params.height = f.height;
    if (f.centered != null) seed.params.centered = f.centered;
  }
  if (session.kind === 'extrude') {
    seed.extrude = { distance: f.distance, sense: f.sense || 'positive', direction: 'normal' };
  }
  if (session.kind === 'revolve') {
    seed.revolve = { angle: f.angle };
  }
  if (session.kind === 'sweep') {
    seed.sweep = { reverse: !!f.reverse };
  }
  if (session.kind === 'workplane') {
    seed.planeOffset = f.cz || 0;
  }
  return seed;
}

/** Overlay a saved contour block onto the chip state the creator just opened. */
export function applyContourEditSeed(state, session) {
  if (!state || !session?.ok) return state;
  const seed = contourSeedFromEdit(session) || {};
  let next = { ...state };
  if (seed.tool) next.tool = seed.tool;
  if (seed.params) next.params = { ...(next.params || {}), ...seed.params };
  if (seed.extrude) next.extrude = { ...(next.extrude || {}), ...seed.extrude };
  if (seed.revolve) next.revolve = { ...(next.revolve || {}), ...seed.revolve };
  if (seed.sweep) next.sweep = { ...(next.sweep || {}), ...seed.sweep };
  if (seed.planeOffset != null) next.planeOffset = seed.planeOffset;
  if (session.kind === 'loft' && Array.isArray(session.fields?.radii) && next.loft?.profiles) {
    const profiles = next.loft.profiles.map((prof, i) => {
      const radius = session.fields.radii[i];
      if (radius == null) return prof;
      return { ...prof, tool: prof.tool || 'circle', params: { ...(prof.params || {}), radius } };
    });
    next = {
      ...next,
      loft: { ...next.loft, profiles },
      params: { ...(next.params || {}), radius: session.fields.radii[0] },
    };
  }
  return next;
}

/** Dialog fields read back from the open contour chip. */
export function contourFieldsFromState(state) {
  if (!state) return {};
  const f = {};
  const p = state.params || {};
  if (state.tool) f.tool = state.tool;
  if (p.radius != null && p.radius !== '') f.radius = Number(p.radius);
  if (p.segments != null && p.segments !== '') f.segments = Number(p.segments);
  if (p.width != null && p.width !== '') f.width = Number(p.width);
  if (p.height != null && p.height !== '') f.height = Number(p.height);
  if (p.centered != null) f.centered = !!p.centered;
  if (state.entry === 'makeExtrude') {
    f.distance = Number(state.extrude?.distance);
    f.sense = state.extrude?.sense || 'positive';
  }
  if (state.entry === 'makeRevolve') f.angle = Number(state.revolve?.angle);
  if (state.entry === 'makeSweep') f.reverse = !!state.sweep?.reverse;
  if (state.entry === 'makeLoft' && Array.isArray(state.loft?.profiles)) {
    const radii = state.loft.profiles
      .map((prof) => Number(prof?.params?.radius))
      .filter((n) => Number.isFinite(n));
    if (radii.length) {
      f.radius = radii[0];
      f.radii = radii;
    }
  }
  if (state.entry === 'workplane') {
    f.cz = Number(state.planeOffset) || 0;
  }
  return f;
}
