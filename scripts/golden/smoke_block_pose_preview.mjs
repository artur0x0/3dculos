#!/usr/bin/env node
/**
 * Block pop: live pose on all six solids.
 *
 * Identity pose writes the old constructor line (no rotate / translate).
 * A pose is rotate, then translate. The preview mesh matches that script.
 * Subtract preview is the cutter (10³ → 1000), not the cut part, and it
 * does not replace the cached solid.
 *
 * Look: Add and Subtract both paint with the shared preview recipe
 * (utils/previewStyle — unlit translucent cyan skin, no depth write, both
 * sides, plus a brighter cyan crease outline), the same as Loft. Never the
 * opaque CAD flat normal material. Subtract also skips the depth test.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  composeHelperInsert,
  defaultParamsFor,
  HELPER_PALETTE_ITEMS,
} from '../../src/utils/helperPaletteSnippets.js';
import * as blockSolid from '../../src/utils/blockSolid.js';
import {
  BLOCK_PREVIEW_EDGE_ANGLE,
  makeBlockPreviewSkinMaterial,
  makePreviewOutlineMaterial,
  makePreviewSkinMaterial,
  PREVIEW_COLORS,
  PREVIEW_OPACITY,
  PREVIEW_RENDER_ORDER,
} from '../../src/utils/previewStyle.js';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  EdgesGeometry,
  MeshBasicMaterial,
} from 'three';

const { BLOCK_SOLID_IDS } = blockSolid;

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function near(a, b, eps = 1e-2) {
  return Math.abs(a - b) < eps;
}

function bboxNear(a, b, eps = 1e-2) {
  if (!a?.min || !b?.min || !a?.max || !b?.max) return false;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.min[i] - b.min[i]) > eps) return false;
    if (Math.abs(a.max[i] - b.max[i]) > eps) return false;
  }
  return true;
}

console.log('block pose preview');

const POSE = ['x', 'y', 'z', 'rx', 'ry', 'rz'];
const LINES = {
  cube: 'let box1 = Manifold.cube([40, 30, 20], true);',
  roundedBox: 'let rbox1 = roundedBox([50, 30, 20], 4, 16);',
  cylinder: 'let cyl1 = Manifold.cylinder(20, 10, 10, 64);',
  sphere: 'let sphere1 = Manifold.sphere(15, 64);',
  tube: 'let tube1 = tube(15, 10, 40, 64);',
  hexPrism: 'let hex1 = hexPrism(12, 8);',
};

{
  for (const id of BLOCK_SOLID_IDS) {
    const item = HELPER_PALETTE_ITEMS.find((h) => h.id === id);
    const defaults = defaultParamsFor(id);
    check(`${id} defaults to add`, defaults.combine === 'add');
    for (const name of POSE) {
      check(`${id} has ${name}`, item.params.some((p) => p.name === name) && defaults[name] === 0);
    }
    const script = composeHelperInsert('', id, null, {});
    check(`${id} identity line`, script.includes(LINES[id]), script);
    check(`${id} identity has no pose`, !/\.rotate\(/.test(script) && !/\.translate\(/.test(script));
  }

  const posed = composeHelperInsert('', 'cube', null, { x: 10, rz: 90 });
  check('pose is rotate then translate',
    /Manifold\.cube\(\[40, 30, 20\], true\)\.rotate\(\[0, 0, 90\]\)\.translate\(\[10, 0, 0\]\)/.test(posed),
    posed);
  const spinOnly = composeHelperInsert('', 'cylinder', null, { rx: 90 });
  check('rotation without a move omits translate',
    /Manifold\.cylinder\(20, 10, 10, 64\)\.rotate\(\[90, 0, 0\]\);/.test(spinOnly)
    && !/\.translate\(/.test(spinOnly),
    spinOnly);
  const slideOnly = composeHelperInsert('', 'sphere', null, { y: 20 });
  check('a move without rotation omits rotate',
    /Manifold\.sphere\(15, 64\)\.translate\(\[0, 20, 0\]\);/.test(slideOnly)
    && !/\.rotate\(/.test(slideOnly),
    slideOnly);
  const rect = composeHelperInsert('', 'tube', null, {
    section: 'rect', width: 40, depth: 20, wall: 2.5, height: 40, cornerRadius: 4, x: 5,
  });
  check('rect tube keeps its corner opts and then translates',
    /tube\(\[40, 20\], 2\.5, 40, \{ cornerRadius: 4 \}\)\.translate\(\[5, 0, 0\]\)/.test(rect),
    rect);

  const host = composeHelperInsert('', 'cube', null, {});
  const cut = composeHelperInsert(host, 'cube', null, {
    width: 10, depth: 10, height: 10, combine: 'subtract', x: 30, ry: 90,
  });
  check('subtract pose stays on the cutter',
    /let box2 = Manifold\.cube\(\[10, 10, 10\], true\)\.rotate\(\[0, 90, 0\]\)\.translate\(\[30, 0, 0\]\);/.test(cut)
    && /part = part\.subtract\(box2\)/.test(cut)
    && !/part\.subtract\(box2\.rotate/.test(cut),
    cut);

  const modal = readFileSync(new URL('../../src/components/HelperParamModal.jsx', import.meta.url), 'utf8');
  check('cube Depth stays visible (Through only hides hole depth)',
    /hasThrough && p\.name === 'depth' && !showDepth/.test(modal));
  const palette = readFileSync(new URL('../../src/components/HelperInsertPalette.jsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../../src/workers/sandboxWorker.js', import.meta.url), 'utf8');
  check('Cancel clears the block preview', /onBlockPreview\?\.\(null\)/.test(palette));
  check('the sheet feeds block params to the preview',
    /isBlockSolidId\(item\?\.id\)/.test(palette) && /blockParamsPending\(values\)/.test(palette));
  const paint = view.slice(view.indexOf('const paintBlockPreview'), view.indexOf('const setBlockPreview'));
  check('viewport paints the block preview',
    /onBlockPreview=\{setBlockPreview\}/.test(view)
    && /name = 'blockSolidPreviewSkin'/.test(paint)
    && /dataset\.blockPreview = subtract \? 'subtract' : 'add'/.test(paint));
  check('block preview skin is the shared preview recipe for Add and Subtract',
    /new ThreeMesh\(geom, makeBlockPreviewSkinMaterial\(\{ subtract \}\)\)/.test(paint)
    && /skin\.renderOrder = PREVIEW_RENDER_ORDER\.skin/.test(paint),
    paint.slice(0, 400));
  check('block preview has the cyan crease outline (previewStyle)',
    /new EdgesGeometry\(geom, BLOCK_PREVIEW_EDGE_ANGLE\)/.test(paint)
    && /makePreviewOutlineMaterial\(\)/.test(paint)
    && /outline\.renderOrder = PREVIEW_RENDER_ORDER\.outline/.test(paint)
    && /group\.add\(outline\)/.test(paint));
  check('block preview never uses the CAD material or a hand-rolled one',
    !/MeshNormalMaterial|MeshLambertMaterial|MeshStandardMaterial|MeshPhongMaterial|new MeshBasicMaterial|opacity:/.test(paint)
    && !('BLOCK_SUBTRACT_OPACITY' in blockSolid));
  check('neither block preview mesh raycasts',
    /skin\.raycast = \(\) => \{\}/.test(paint) && /outline\.raycast = \(\) => \{\}/.test(paint));
  const previewCase = worker.slice(
    worker.indexOf("case 'previewBlock'"),
    worker.indexOf("case 'previewCut'"),
  );
  check('previewBlock builds the solid and does not replace the cached part',
    /buildBlockManifold\(/.test(previewCase)
    && !/cachedManifold\s*=/.test(previewCase)
    && !/cachedManifold\.clone\(/.test(previewCase),
    previewCase.slice(0, 240));
}

// ── Preview look: the real materials, Add and Subtract ─────────
{
  const loft = makePreviewSkinMaterial();
  for (const subtract of [false, true]) {
    const tag = subtract ? 'subtract' : 'add';
    const m = makeBlockPreviewSkinMaterial({ subtract });
    check(`${tag} skin is unlit translucent cyan (MeshBasicMaterial 0x22d3ee @ ${PREVIEW_OPACITY.skin})`,
      m instanceof MeshBasicMaterial && m.type === 'MeshBasicMaterial'
      && m.color.getHex() === PREVIEW_COLORS.skin && m.color.getHex() === 0x22d3ee
      && m.transparent === true && m.opacity === PREVIEW_OPACITY.skin && m.opacity < 0.5,
      `${m.type} ${m.color.getHexString()} ${m.opacity}`);
    check(`${tag} skin is both sides, no depth write (same as Loft's skin)`,
      m.side === DoubleSide && m.depthWrite === false
      && m.side === loft.side && m.depthWrite === loft.depthWrite && m.blending === loft.blending);
    check(`${tag} skin depth test ${subtract ? 'off (cutter shows through the host)' : 'on (like Loft)'}`,
      m.depthTest === !subtract);
    check(`${tag} skin is not the opaque CAD material`,
      m.type !== 'MeshNormalMaterial' && !m.flatShading && m.opacity !== 1);
    m.dispose();
  }
  const o = makePreviewOutlineMaterial();
  check('outline is the brighter cyan preview line',
    o.color.getHex() === PREVIEW_COLORS.outline && o.depthTest === false && o.transparent);
  check('skin renders under the outline', PREVIEW_RENDER_ORDER.skin < PREVIEW_RENDER_ORDER.outline);
  o.dispose();
  loft.dispose();
}

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') waiter.reject(new Error(msg.payload?.message || 'worker error'));
    else waiter.resolve(msg);
  },
};
globalThis.self = workerSelf;

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => {
      if (!workerSelf.onmessage) {
        reject(new Error('sandboxWorker handler missing'));
        return;
      }
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

register('./manifold-resolve-hook.mjs', import.meta.url);
await import('../../src/workers/sandboxWorker.js');
await send('init');

async function exec(script) {
  const res = await send('execute', { script, importedModels: {}, memoryLimitMB: 512 });
  return res.payload;
}

const cases = [
  { id: 'cube', params: { x: 12, rz: 90 }, label: 'cube' },
  { id: 'roundedBox', params: { x: -8, ry: 90 }, label: 'roundedBox' },
  { id: 'cylinder', params: { z: 15, rx: 90 }, label: 'cylinder' },
  { id: 'sphere', params: { y: 20, rz: 45 }, label: 'sphere' },
  { id: 'tube', params: { x: 5, z: 3, ry: 90 }, label: 'tube' },
  {
    id: 'tube',
    params: { section: 'rect', width: 30, depth: 16, wall: 2, height: 24, cornerRadius: 2, x: 4, rz: 30 },
    label: 'tube rect',
  },
  { id: 'hexPrism', params: { x: -6, rx: 90 }, label: 'hexPrism' },
];

{
  const cold = await send('previewBlock', { id: 'cube', params: {} });
  check('preview runs with no cached part', near(cold.payload.volume, 40 * 30 * 20), `vol=${cold.payload?.volume}`);

  for (const c of cases) {
    const script = composeHelperInsert('', c.id, null, c.params);
    const ran = await exec(script);
    const preview = await send('previewBlock', { id: c.id, params: c.params });
    const cached = await send('stageGetLastMesh');
    check(`${c.label} preview volume matches the script`,
      near(preview.payload.volume, ran.volume),
      `preview=${preview.payload?.volume} script=${ran.volume}`);
    check(`${c.label} preview bbox matches the script`,
      bboxNear(preview.payload.boundingBox, ran.boundingBox),
      `preview=${JSON.stringify(preview.payload?.boundingBox)} script=${JSON.stringify(ran.boundingBox)}`);
    check(`${c.label} preview leaves the cached solid`,
      near(cached.payload.volume, ran.volume),
      `cached=${cached.payload?.volume} script=${ran.volume}`);
  }

  // Outline built the way the viewport builds it, from the real preview mesh.
  const geomOf = (mesh) => {
    const np = mesh.numProp || 3;
    const n = Math.floor(mesh.vertProperties.length / np);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = mesh.vertProperties[i * np + k];
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setIndex(new BufferAttribute(Uint32Array.from(mesh.triVerts), 1));
    return g;
  };
  const edgeCount = async (id, params = {}) => {
    const res = await send('previewBlock', { id, params });
    const mesh = res.payload?.mesh;
    if (!mesh?.vertProperties) return -1;
    return new EdgesGeometry(geomOf(mesh), BLOCK_PREVIEW_EDGE_ANGLE).attributes.position.count / 2;
  };
  const cubeEdges = await edgeCount('cube', { x: 12, rz: 90 });
  check('cube preview outline is its 12 edges', cubeEdges === 12, `edges=${cubeEdges}`);
  const cutEdges = await edgeCount('cube', { width: 10, depth: 10, height: 10, combine: 'subtract' });
  check('subtract cutter preview outline is its 12 edges', cutEdges === 12, `edges=${cutEdges}`);
  const sphereEdges = await edgeCount('sphere', {});
  check('sphere preview outline does not trace every facet', sphereEdges >= 0 && sphereEdges < 64, `edges=${sphereEdges}`);
  const hexEdges = await edgeCount('hexPrism', {});
  check('hex prism preview outline is its 18 edges', hexEdges === 18, `edges=${hexEdges}`);

  const host = composeHelperInsert('', 'cube', null, {});
  await exec(host);
  const cutter = { width: 10, depth: 10, height: 10, combine: 'subtract' };
  const subPreview = await send('previewBlock', { id: 'cube', params: cutter });
  const still = await send('stageGetLastMesh');
  check('subtract preview is the cutter, not the cut part',
    near(subPreview.payload.volume, 1000) && subPreview.payload.combine === 'subtract',
    `vol=${subPreview.payload?.volume}`);
  check('subtract preview does not cut the cached solid',
    near(still.payload.volume, 24000), `vol=${still.payload?.volume}`);
  const added = await send('previewBlock', {
    id: 'cube',
    params: { width: 10, depth: 10, height: 10, combine: 'add', x: 30 },
  });
  check('add preview is the new solid, not the union', near(added.payload.volume, 1000), `vol=${added.payload?.volume}`);
  const cut = composeHelperInsert(host, 'cube', null, cutter);
  const cutRes = await exec(cut);
  check('subtract confirm still cuts 1000 from the cube', near(cutRes.volume, 23000), `vol=${cutRes.volume}`);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
