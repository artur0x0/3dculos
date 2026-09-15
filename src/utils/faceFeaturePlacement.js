/**
 * Slice 11 — Face-select → feature placement.
 *
 * Classify Viewport selectedFace → planar | cylindrical | irregular.
 * Face-aware param schemas + workplane / edge snippet helpers.
 *
 * Classification (from Viewport faceData):
 *   - planar:      selectionMode === 'coplanar' (single-click coplanar region)
 *                  OR angular-tolerance with few triangles (near-flat)
 *   - cylindrical: selectionMode === 'angular-tolerance' and triangleCount >= 8
 *                  (double-click walk along a curved / tessellated wall)
 *   - irregular:   selectionMode === 'all-connected' (triple-click) or unknown
 *
 * Irregular policy (v1): refuse with a clear message — no best-fit plane.
 * Generated snippets never use illegal bare `top`; they query via
 * facesByNormal(body, normal) + closest-to-center pick, then workplaneFromFace.
 */

/** Features that place relative to a selected face when one is active. */
export const FACE_FEATURE_IDS = new Set([
  'hole',
  'holePattern',
  'clearanceHole',
  'tapDrillHole',
  'cboreHole',
  'cskHole',
  'filletEdges',
  'chamferEdges',
]);

export function isFaceFeature(id) {
  return FACE_FEATURE_IDS.has(id);
}

/**
 * @typedef {'planar'|'cylindrical'|'irregular'} FaceType
 * @typedef {{
 *   type: FaceType,
 *   center: number[],
 *   normal: number[],
 *   area: number,
 *   triangleCount: number,
 *   selectionMode?: string,
 *   refuseMessage?: string,
 * }} FaceClassification
 */

/**
 * Classify Viewport selectedFace payload.
 * @param {object|null|undefined} faceData
 * @returns {FaceClassification|null}
 */
export function classifySelectedFace(faceData) {
  if (!faceData || !Array.isArray(faceData.normal) || !Array.isArray(faceData.center)) {
    return null;
  }
  const normal = faceData.normal.map((v) => Number(v));
  const center = faceData.center.map((v) => Number(v));
  if (normal.some((v) => !Number.isFinite(v)) || center.some((v) => !Number.isFinite(v))) {
    return null;
  }
  const nLen = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const unit = [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen];
  const triangleCount = Number(faceData.triangleCount) || 0;
  const area = Number(faceData.area) || 0;
  const mode = faceData.selectionMode || 'coplanar';

  let type = 'planar';
  if (mode === 'all-connected') {
    type = 'irregular';
  } else if (mode === 'angular-tolerance' && triangleCount >= 8) {
    type = 'cylindrical';
  } else if (mode === 'angular-tolerance' && triangleCount > 0 && triangleCount < 8) {
    type = 'planar'; // near-flat tolerance walk
  } else if (mode === 'coplanar') {
    type = 'planar';
  } else {
    type = 'irregular';
  }

  const out = {
    type,
    center,
    normal: unit,
    area,
    triangleCount,
    selectionMode: mode,
  };
  if (type === 'irregular') {
    out.refuseMessage =
      'Selected face is irregular (multi-region / non-developable). ' +
      'Pick a planar face (single-click) or a cylindrical wall (double-click), ' +
      'or clear the selection to use the default top-face workplane.';
  }
  return out;
}

/** Round a number for stable snippet literals. */
export function roundFaceNum(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function formatVec3(arr, digits = 4) {
  const a = Array.isArray(arr) ? arr : [0, 0, 0];
  return `[${roundFaceNum(a[0], digits)}, ${roundFaceNum(a[1], digits)}, ${roundFaceNum(a[2], digits)}]`;
}

/**
 * Estimate cylinder axis from face normal (axis ⟂ average radial normal).
 * For common axis-aligned cylinders: pick world axis most orthogonal to normal.
 * @param {number[]} normal
 * @returns {{ axis: 'x'|'y'|'z', axisVec: number[] }}
 */
export function estimateCylinderAxis(normal) {
  const n = normal || [0, 0, 1];
  // Axis most orthogonal to radial normal = smallest |n·axis|
  const axes = [
    { axis: 'x', axisVec: [1, 0, 0], score: Math.abs(n[0]) },
    { axis: 'y', axisVec: [0, 1, 0], score: Math.abs(n[1]) },
    { axis: 'z', axisVec: [0, 0, 1], score: Math.abs(n[2]) },
  ];
  axes.sort((a, b) => a.score - b.score);
  return { axis: axes[0].axis, axisVec: axes[0].axisVec };
}

/**
 * Extra / replacement params for face-aware modal by face type + feature id.
 * Returns null for non-face features. Merges over base item.params in the UI.
 * @param {string} id
 * @param {FaceType} faceType
 * @returns {object[]|null}
 */
export function faceAwareParams(id, faceType) {
  if (!isFaceFeature(id)) return null;

  if (faceType === 'irregular') return [];

  const body = { name: 'body', type: 'body', default: 'part', label: 'Body' };
  const through = { name: 'through', type: 'bool', default: true, label: 'Through' };
  const depth = {
    name: 'depth', type: 'number', default: 12, label: 'Depth', min: 0.1, step: 0.5, slider: true,
  };

  if (id === 'filletEdges') {
    return [
      body,
      { name: 'radius', type: 'number', default: 3, label: 'Radius', min: 0.01, step: 0.5, slider: true },
      { name: 'sphericalCorners', type: 'bool', default: true, label: 'Spherical corners' },
      {
        name: 'edgeScope',
        type: 'select',
        default: 'face',
        label: 'Edges',
        options: ['face', 'allConvex'],
      },
    ];
  }
  if (id === 'chamferEdges') {
    return [
      body,
      { name: 'chamfer', type: 'number', default: 2, label: 'Chamfer', min: 0.01, step: 0.5, slider: true },
      {
        name: 'edgeScope',
        type: 'select',
        default: 'face',
        label: 'Edges',
        options: ['face', 'allConvex'],
      },
    ];
  }

  if (faceType === 'cylindrical') {
    const cylCommon = [
      body,
      { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
      { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
      through,
      depth,
    ];
    if (id === 'hole') {
      return [
        ...cylCommon.slice(0, 3),
        { name: 'dia', type: 'number', default: 6, label: 'Diameter', min: 0.1, step: 0.5, slider: true },
        through,
        depth,
      ];
    }
    if (id === 'holePattern') {
      // Pattern on cylinder wall is awkward; keep axial/angle as origin + planar-style grid in tangent uv
      return [
        body,
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
        { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
        { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1, slider: true },
        { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1, slider: true },
        { name: 'dia', type: 'number', default: 4, label: 'Diameter', min: 0.1, step: 0.5, slider: true },
      ];
    }
    if (id === 'clearanceHole') {
      return [
        body,
        { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
        { name: 'fit', type: 'select', default: 'normal', label: 'Fit', options: ['close', 'normal', 'loose'] },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
    if (id === 'tapDrillHole') {
      return [
        body,
        { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
    if (id === 'cboreHole') {
      return [
        body,
        { name: 'diaThru', type: 'number', default: 5.5, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'diaCbore', type: 'number', default: 10, label: 'Cbore Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'cboreDepth', type: 'number', default: 4, label: 'Cbore depth', min: 0.1, step: 0.5, slider: true },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
    if (id === 'cskHole') {
      return [
        body,
        { name: 'diaThru', type: 'number', default: 3.4, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'diaCsk', type: 'number', default: 6.5, label: 'Csk Ø', min: 0.1, step: 0.1, slider: true },
        { name: 'cskDepth', type: 'number', default: 2, label: 'Csk depth', min: 0.1, step: 0.5, slider: true },
        { name: 'angleDeg', type: 'number', default: 0, label: 'Angle °', step: 1, slider: true },
        { name: 'axial', type: 'number', default: 0, label: 'Axial height', step: 0.5, slider: true },
        through,
        depth,
      ];
    }
  }

  // ── planar ───────────────────────────────────────────────────
  const uv = [
    { name: 'u', type: 'number', default: 0, label: 'U', step: 0.5, slider: true },
    { name: 'v', type: 'number', default: 0, label: 'V', step: 0.5, slider: true },
  ];
  const patternOpts = [
    { name: 'usePattern', type: 'bool', default: false, label: 'n×m pattern' },
    { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
    { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
    { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1, slider: true },
    { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1, slider: true },
  ];

  if (id === 'hole') {
    return [
      body,
      ...uv,
      { name: 'dia', type: 'number', default: 6, label: 'Diameter', min: 0.1, step: 0.5, slider: true },
      through,
      depth,
      ...patternOpts,
    ];
  }
  if (id === 'holePattern') {
    return [
      body,
      ...uv.map((p) => ({ ...p, label: p.name === 'u' ? 'Origin U' : 'Origin V' })),
      { name: 'n', type: 'number', default: 3, label: 'Count U', min: 1, step: 1 },
      { name: 'm', type: 'number', default: 2, label: 'Count V', min: 1, step: 1 },
      { name: 'spacingU', type: 'number', default: 18, label: 'Spacing U', min: 0.1, step: 1, slider: true },
      { name: 'spacingV', type: 'number', default: 14, label: 'Spacing V', min: 0.1, step: 1, slider: true },
      { name: 'dia', type: 'number', default: 4, label: 'Diameter', min: 0.1, step: 0.5, slider: true },
    ];
  }
  if (id === 'clearanceHole') {
    return [
      body,
      { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
      { name: 'fit', type: 'select', default: 'normal', label: 'Fit', options: ['close', 'normal', 'loose'] },
      ...uv,
      through,
      depth,
      ...patternOpts,
    ];
  }
  if (id === 'tapDrillHole') {
    return [
      body,
      { name: 'size', type: 'select', default: 'M3', label: 'Size', options: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'] },
      ...uv,
      through,
      depth,
    ];
  }
  if (id === 'cboreHole') {
    return [
      body,
      { name: 'diaThru', type: 'number', default: 5.5, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'diaCbore', type: 'number', default: 10, label: 'Cbore Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'cboreDepth', type: 'number', default: 4, label: 'Cbore depth', min: 0.1, step: 0.5, slider: true },
      ...uv,
      through,
      depth,
    ];
  }
  if (id === 'cskHole') {
    return [
      body,
      { name: 'diaThru', type: 'number', default: 3.4, label: 'Thru Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'diaCsk', type: 'number', default: 6.5, label: 'Csk Ø', min: 0.1, step: 0.1, slider: true },
      { name: 'cskDepth', type: 'number', default: 2, label: 'Csk depth', min: 0.1, step: 0.5, slider: true },
      ...uv,
      through,
      depth,
    ];
  }
  return null;
}

/**
 * Seed face-aware defaults from classification (cylindrical angle/axial from pick).
 * @param {string} id
 * @param {FaceClassification} face
 * @returns {object}
 */
export function seedFaceParams(id, face) {
  const base = {};
  if (!face) return base;
  if (face.type === 'cylindrical') {
    // Angle in XY (or plane ⊥ axis) from face normal
    const { axis } = estimateCylinderAxis(face.normal);
    let angleDeg = 0;
    let axial = 0;
    if (axis === 'z') {
      angleDeg = (Math.atan2(face.normal[1], face.normal[0]) * 180) / Math.PI;
      axial = face.center[2];
    } else if (axis === 'y') {
      angleDeg = (Math.atan2(face.normal[0], face.normal[2]) * 180) / Math.PI;
      axial = face.center[1];
    } else {
      angleDeg = (Math.atan2(face.normal[2], face.normal[1]) * 180) / Math.PI;
      axial = face.center[0];
    }
    base.angleDeg = roundFaceNum(angleDeg, 1);
    base.axial = roundFaceNum(axial, 2);
  }
  // Planar u/v default to face center (0,0 on workplane = face center)
  if (face.type === 'planar') {
    base.u = 0;
    base.v = 0;
  }
  void id;
  return base;
}

/**
 * Emit lines that resolve selected face → workplane frame.
 * Prefers facesByNormal + closest center (stable, no illegal `top`).
 *
 * @param {string} body
 * @param {FaceClassification} face
 * @param {Set<string>} names
 * @param {(existing: Set<string>, base: string) => string} allocateUniqueName
 * @returns {{ lines: string[], faceVar: string, frVar: string }}
 */
export function emitFaceWorkplaneLines(body, face, names, allocateUniqueName) {
  const faceVar = allocateUniqueName(names, 'selFace');
  const frVar = allocateUniqueName(names, 'fr');
  const nLit = formatVec3(face.normal);
  const cLit = formatVec3(face.center);
  const lines = [
    `const ${faceVar} = (() => {`,
    `  const _cands = facesByNormal(${body}, ${nLit}, 5);`,
    `  if (!_cands.length) throw new Error('No face near selected normal ${nLit}');`,
    `  const _c = ${cLit};`,
    `  let _best = _cands[0], _bd = Infinity;`,
    `  for (const _f of _cands) {`,
    `    const _d = (_f.center[0]-_c[0])**2 + (_f.center[1]-_c[1])**2 + (_f.center[2]-_c[2])**2;`,
    `    if (_d < _bd) { _bd = _d; _best = _f; }`,
    `  }`,
    `  return _best;`,
    `})();`,
    `const ${frVar} = workplaneFromFace(${body}, ${faceVar});`,
  ];
  return { lines, faceVar, frVar };
}

/**
 * Emit span expression: through → holeSpan; else numeric depth.
 */
export function emitSpanExpr(body, frVar, params, names, allocateUniqueName, numFn) {
  const through = params.through !== false && params.through !== 'false' && params.through !== 0;
  if (through) {
    const span = allocateUniqueName(names, 'span');
    return {
      lines: [`const ${span} = holeSpan(${body}, ${frVar});`],
      spanExpr: span,
    };
  }
  const depth = numFn(params.depth, 12);
  return { lines: [], spanExpr: String(depth) };
}

/**
 * Emit edge selection for fillet/chamfer on a face.
 * Filters convexEdges whose n0/n1 aligns with face normal.
 * Fallback option: all convexEdges(body).
 *
 * @returns {{ lines: string[], edgesExpr: string }}
 */
export function emitFaceEdgeLines(body, face, params, names, allocateUniqueName) {
  const scope = params.edgeScope === 'allConvex' ? 'allConvex' : 'face';
  if (scope === 'allConvex') {
    return { lines: [], edgesExpr: `convexEdges(${body})` };
  }
  const edgesVar = allocateUniqueName(names, 'faceEdges');
  const nLit = formatVec3(face.normal);
  const lines = [
    `const ${edgesVar} = convexEdges(${body}).filter((e) => {`,
    `  const _n = ${nLit};`,
    `  const _dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];`,
    `  const _ok = (n) => n && _dot(n, _n) > 0.95;`,
    `  return _ok(e.n0) || _ok(e.n1);`,
    `});`,
    `if (!${edgesVar}.length) throw new Error('No convex edges adjacent to selected face — try Edges: allConvex');`,
  ];
  return { lines, edgesExpr: edgesVar };
}

/**
 * Build a modal item view-model for face placement (or refuse).
 * @returns {{ mode: 'params'|'refuse'|'default', item?: object, face?: FaceClassification, message?: string }}
 */
export function resolveFaceModal(paletteItem, selectedFace) {
  if (!paletteItem) return { mode: 'default' };
  if (!isFaceFeature(paletteItem.id) || !selectedFace) {
    return { mode: 'default' };
  }
  const face = classifySelectedFace(selectedFace);
  if (!face) return { mode: 'default' };
  if (face.type === 'irregular') {
    return { mode: 'refuse', face, message: face.refuseMessage };
  }
  const params = faceAwareParams(paletteItem.id, face.type);
  if (!params) return { mode: 'default' };
  const seeds = seedFaceParams(paletteItem.id, face);
  const mergedParams = params.map((p) => (
    seeds[p.name] !== undefined ? { ...p, default: seeds[p.name] } : p
  ));
  return {
    mode: 'params',
    face,
    item: {
      ...paletteItem,
      params: mergedParams,
      title: `${paletteItem.title} — on ${face.type} face`,
      _facePlacement: true,
    },
  };
}
