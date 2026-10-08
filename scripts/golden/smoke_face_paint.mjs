/* global window */
/**
 * Paint mode. A click picks the same face the viewport already picks.
 * Confirm writes faceColorKey into the assembly and the skin draws it.
 * Cancel writes nothing. Undo drops a pick only. Game mode hides the chip.
 *
 * Screenshots: GOLDEN_SHOT_DIR or os.tmpdir()/surfcad-golden-shots.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { chromium } from 'playwright-core';
import { createServer as createVite } from 'vite';
import { buildSolidGeometry } from '../../src/utils/partSolidCache.js';
import { serializeAssembly } from '../../src/utils/assembly.js';
import { faceFingerprints } from '../../src/utils/faceColorMatch.js';
import { syncFaceColorSkin } from '../../src/utils/faceColorSkin.js';
import { warmFaceGraph } from '../../src/utils/selectFace.js';
import {
  PAINT_SWATCHES,
  clearPaintColors,
  commitPaintColors,
  paintChipVisible,
  paintPickFromClick,
  paintPicksAfterMeshChange,
  paintPicksAfterPartChange,
  parsePaintHex,
  removeUnmatchedColors,
  resolvedPaintColor,
  togglePaintPick,
  undoPaintPick,
} from '../../src/utils/facePaint.js';

register('./manifold-resolve-hook.mjs', import.meta.url);

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const w = pending.get(msg.id);
    if (!w) return;
    pending.delete(msg.id);
    if (msg.type === 'error') w.reject(new Error(msg.payload?.message || 'err'));
    else w.resolve(msg);
  },
};
globalThis.self = workerSelf;
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => workerSelf.onmessage({ data: { type, payload, id } }));
  });
}

let failed = 0;
let passed = 0;
function ifConditionsContaining(src, token) {
  const found = [];
  const re = /\bif\s*\(/g;
  let match;
  while ((match = re.exec(src))) {
    let depth = 1;
    let j = match.index + match[0].length;
    const start = j;
    for (; j < src.length && depth > 0; j++) {
      const ch = src[j];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth === 0) {
      const cond = src.slice(start, j - 1);
      if (cond.includes(token)) found.push(cond);
    } else {
      break;
    }
  }
  return found;
}

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const SID = '2026-10-08-14-00-00-0001-ab12';
const SID_B = '2026-10-08-14-00-00-0002-cd34';
const SWATCH = PAINT_SWATCHES[4];
const CUBE = 'return Manifold.cube([20, 16, 12], true);';

await import('../../src/workers/sandboxWorker.js');
await send('init');
async function exec(script) {
  return (await send('execute', { script, importedModels: {}, memoryLimitMB: 512 })).payload;
}

function built(meshData) {
  const solid = buildSolidGeometry(meshData);
  const faces = faceFingerprints(
    warmFaceGraph(solid.geometry, solid.faceIDs),
    solid.geometry.userData?.triSource || null,
    {
      positions: solid.geometry.attributes.position.array,
      indices: solid.geometry.index.array,
    },
  );
  return { ...solid, faces };
}

function byNormal(faces, axis, sign) {
  return faces
    .filter((face) => face.n[axis] * sign > 0.9)
    .sort((a, b) => b.area - a.area)[0];
}

function skinTris(skin) {
  const pos = skin?.geometry?.attributes?.position?.array;
  const col = skin?.geometry?.attributes?.color?.array;
  if (!pos || !col) return [];
  const out = [];
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i + 3] - pos[i];
    const ay = pos[i + 4] - pos[i + 1];
    const az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i];
    const by = pos[i + 7] - pos[i + 1];
    const bz = pos[i + 8] - pos[i + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    out.push({
      n: [nx / len, ny / len, nz / len],
      rgb: [col[i], col[i + 1], col[i + 2]],
    });
  }
  return out;
}

function near(rgb, hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const want = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  return rgb.every((c, i) => Math.abs(c - want[i]) < 0.02);
}

function saveDoc(colors) {
  return serializeAssembly({
    source: 'local',
    name: 'Paint',
    activeId: 'a',
    parts: [
      { id: 'a', name: 'A', surfId: SID, visible: true },
      { id: 'b', name: 'B', surfId: SID_B, visible: true },
    ],
    colors,
  });
}

console.log('face paint — two faces, a swatch, confirm');
const mesh = (await exec(CUBE)).mesh;
const cube = built(mesh);
const top = byNormal(cube.faces, 2, 1);
const side = byNormal(cube.faces, 0, 1);
check('cube has a top and a side', !!top && !!side && top !== side);
const topPick = paintPickFromClick({
  geometry: cube.geometry,
  faceIDs: cube.faceIDs,
  seedFaceIndex: top.tris[0],
});
const sidePick = paintPickFromClick({
  geometry: cube.geometry,
  faceIDs: cube.faceIDs,
  seedFaceIndex: side.tris[0],
});
check('a click picks the whole face, not one triangle',
  topPick.indices.length > 1 && topPick.indices.length === top.tris.length,
  `picked ${topPick?.indices?.length} of ${top?.tris?.length}`);
let picks = togglePaintPick([], topPick);
picks = togglePaintPick(picks, sidePick);
picks = togglePaintPick(picks, topPick);
check('tapping a picked face again unpicks it', picks.length === 1 && picks[0].key.area === side.area);
picks = togglePaintPick(picks, topPick);
check('the two faces are picked', picks.length === 2);
const swatchColors = commitPaintColors(null, SID, {
  color: SWATCH,
  keys: picks.map((pick) => pick.key),
  faces: cube.faces,
});
const saved = saveDoc(swatchColors);
check('the save holds two keys', saved.colors?.[SID]?.faces?.length === 2, JSON.stringify(saved.colors?.[SID]?.faces?.map((f) => f.color)));
check('both keys are the swatch', saved.colors[SID].faces.every((face) => face.color === SWATCH));

{
  const { Mesh, MeshNormalMaterial } = await import('three');
  const host = new Mesh(cube.geometry, new MeshNormalMaterial({ flatShading: true }));
  host.userData.surfId = SID;
  const skin = syncFaceColorSkin(host, {
    geometry: cube.geometry,
    faceIDs: cube.faceIDs,
    surfId: SID,
    colors: saved.colors,
    rainbow: false,
  });
  const tris = skinTris(skin);
  const topPainted = tris.filter((tri) => tri.n[2] > 0.9 && near(tri.rgb, SWATCH)).length;
  const sidePainted = tris.filter((tri) => tri.n[0] > 0.9 && near(tri.rgb, SWATCH)).length;
  const other = tris.filter((tri) => tri.n[2] < -0.9 && near(tri.rgb, SWATCH)).length;
  check('the two keys render on the picked faces', topPainted > 0 && sidePainted > 0 && other === 0,
    `top ${topPainted} side ${sidePainted} back ${other}`);
}

console.log('face paint — custom hex');
check('eight swatches', PAINT_SWATCHES.length === 8 && PAINT_SWATCHES.every((hex) => parsePaintHex(hex) === hex));
check('a custom hex is lowercase #rrggbb', parsePaintHex('#AABBCC') === '#aabbcc' && parsePaintHex('#abc') == null && parsePaintHex('112233') == null);
check('a bad custom hex blocks the swatch', resolvedPaintColor(SWATCH, '#zz') == null && resolvedPaintColor(SWATCH, '') === SWATCH);
const custom = '#112233';
const customColors = commitPaintColors(saved.colors, SID, {
  color: parsePaintHex('#112233'),
  keys: [topPick.key],
  faces: cube.faces,
});
check('custom hex replaces the matching key',
  customColors[SID].faces.length === 2
  && customColors[SID].faces.filter((face) => face.color === custom).length === 1
  && customColors[SID].faces.filter((face) => face.color === SWATCH).length === 1);
check('an invalid hex writes nothing', commitPaintColors(customColors, SID, { color: 'red', keys: [topPick.key], faces: cube.faces }) === customColors);

console.log('face paint — part color and clear');
const parted = commitPaintColors(customColors, SID, { color: '#00aa00', part: true });
check('part color is stored and the face keys stay',
  parted[SID].part === '#00aa00' && parted[SID].faces.length === 2);
const clearedFace = clearPaintColors(parted, SID, { keys: [sidePick.key], faces: cube.faces });
check('clear removes the picked face color',
  clearedFace[SID].faces.length === 1
  && clearedFace[SID].faces[0].color === custom
  && clearedFace[SID].part === '#00aa00');
const clearedPart = clearPaintColors(clearedFace, SID, { part: true });
check('clear removes the part color', clearedPart[SID].part == null && clearedPart[SID].faces.length === 1);

console.log('face paint — undo leaves committed colors alone');
const committed = clearedPart;
const undone = undoPaintPick(picks);
check('undo removes the last pick', undone.length === picks.length - 1);
check('undo does not change the saved colors', committed === clearedPart && JSON.stringify(committed) === JSON.stringify(clearedPart));

console.log('face paint — cancel writes nothing');
{
  const view = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const exitAt = view.indexOf('const exitPaintMode = useCallback');
  const exitBlock = view.slice(exitAt, view.indexOf('const clearPaintPicks', exitAt));
  check('leaving paint does not write', exitAt > 0 && !/onCommitPaint/.test(exitBlock));
  check('cancel and the grey X dismiss', /data-paint-cancel/.test(readFileSync(new URL('../../src/components/PaintModeChip.jsx', import.meta.url), 'utf8'))
    && /onDismiss\?\.\(\)/.test(readFileSync(new URL('../../src/components/PaintModeChip.jsx', import.meta.url), 'utf8')));
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const handlerAt = app.indexOf('const handleCommitPaint');
  const handler = app.slice(handlerAt, app.indexOf('const handleCommitShell', handlerAt));
  check('confirm saves through the assembly path', /rememberAssembly\(/.test(handler) && /enqueueAssemblySave\(/.test(handler));
}

console.log('face paint — game mode and part switch');
{
  const view = readFileSync(new URL('../../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const chip = readFileSync(new URL('../../src/components/PaintModeChip.jsx', import.meta.url), 'utf8');
  check('the chip is hidden in game mode', paintChipVisible('cad') === true && paintChipVisible('game') === false
    && /mode !== 'game'[\s\S]{0,160}<PaintModeToggle/.test(view)
    && /data-paint-chip/.test(chip));
  check('paint uses the normal face pick and the normal highlight',
    /paintPickFromClick\(/.test(view) && /'paint-pick'/.test(view));
  const skipsPaint = (token) => {
    const conds = ifConditionsContaining(view, token);
    return conds.length > 0 && conds.every((cond) => cond.includes('!paintModeRef.current'));
  };
  check('a paint tap is not swallowed by a contour or a construction plane',
    skipsPaint('showContoursRef') && skipsPaint('planeHits'));
  const switched = paintPicksAfterPartChange('part-a', 'part-b', picks);
  check('a part switch clears picks', switched.length === 0);
  check('the same part keeps picks', paintPicksAfterPartChange('part-a', 'part-a', picks).length === picks.length);
  check('a new mesh clears picks', paintPicksAfterMeshChange(false, picks).length === 0 && paintPicksAfterMeshChange(true, picks).length === picks.length);
  const other = commitPaintColors(clearedPart, SID_B, { color: SWATCH, keys: [topPick.key], faces: cube.faces });
  check('a key is not written onto the other part',
    other[SID].faces.length === 1 && other[SID_B].faces.length === 1 && other[SID].faces[0].color === custom);
}

console.log('face paint — repick after a rebuild replaces the key');
{
  const mesh2 = (await exec(CUBE)).mesh;
  const cube2 = built(mesh2);
  const top2 = byNormal(cube2.faces, 2, 1);
  const again = paintPickFromClick({
    geometry: cube2.geometry,
    faceIDs: cube2.faceIDs,
    seedFaceIndex: top2.tris[0],
  });
  const orphan = {
    color: '#abcdef',
    key: { at: [1000, 0, 0], n: [0, 0, 1], area: 10 },
  };
  const withOrphan = {
    ...clearedPart,
    [SID]: { faces: [...clearedPart[SID].faces, orphan] },
  };
  const replaced = commitPaintColors(withOrphan, SID, {
    color: '#445566',
    keys: [again.key],
    faces: cube2.faces,
  });
  const faces = replaced[SID].faces;
  check('a repick replaces the key instead of duplicating it',
    faces.filter((face) => face.color === '#445566').length === 1
    && faces.filter((face) => face.color === custom).length === 0
    && faces.length === 2,
    faces.map((face) => face.color).join(','));
  check('an unmatched key is not pruned by confirm', faces.some((face) => face.color === '#abcdef'));
  const pruned = removeUnmatchedColors(replaced, SID, cube2.faces);
  check('remove unmatched drops only the unmatched key',
    pruned[SID].faces.length === 1 && pruned[SID].faces[0].color === '#445566');
  const doc = saveDoc(replaced);
  check('the replaced key still round-trips', doc.colors[SID].faces.length === 2);
}

console.log('face paint — docs');
{
  const arch = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');
  const map = readFileSync(new URL('../../docs/UI_MAP.md', import.meta.url), 'utf8');
  check('architecture.md names the paint chip and the save', /Face color paint/.test(arch) && /rememberAssembly/.test(arch) && /game mode/i.test(arch));
  check('UI_MAP.md names the chip and the popup', /data-paint-chip/.test(map) && /data-paint-mode/.test(map));
}

console.log('face paint — chip and popup, 390 and desktop, dark and light');
const shotDir = process.env.GOLDEN_SHOT_DIR || join(tmpdir(), 'surfcad-golden-shots');
mkdirSync(shotDir, { recursive: true });
const htmlFor = (theme, compact) => `<!doctype html><meta charset="utf-8">
<div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>
<script type="module">
import '/src/index.css';
import { renderPaintChrome } from '/scripts/golden/face_paint_shot.js';
renderPaintChrome(document.getElementById('root'), { theme: ${JSON.stringify(theme)}, compact: ${compact ? 'true' : 'false'} });
window.__READY__ = true;
</script>`;

const vite = await createVite({
  root: new URL('../..', import.meta.url).pathname,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
const server = createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/' || url.startsWith('/?')) {
    const theme = url.includes('theme=light') ? 'light' : 'dark';
    const compact = url.includes('compact=1');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(htmlFor(theme, compact));
    return;
  }
  vite.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end('no');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const shots = [
    ['face-paint-chip-popup-dark-390.png', 'theme=dark&compact=1', 390, 700],
    ['face-paint-chip-popup-light-390.png', 'theme=light&compact=1', 390, 700],
    ['face-paint-chip-popup-dark-desktop.png', 'theme=dark&compact=0', 1100, 720],
    ['face-paint-chip-popup-light-desktop.png', 'theme=light&compact=0', 1100, 720],
  ];
  for (const [name, query, width, height] of shots) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__READY__, null, { timeout: 30000 });
    await page.locator('[data-paint-chip]').waitFor();
    await page.locator('[data-paint-mode="1"]').waitFor();
    const swatches = await page.locator('[data-paint-swatch]').count();
    check(`${name} shows the chip, popup, and 8 swatches`, errors.length === 0 && swatches === 8, errors.join('; ') || `swatches ${swatches}`);
    const file = join(shotDir, name);
    await page.screenshot({ path: file });
    console.log(`  shot ${file}`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
  await vite.close();
}

if (failed) {
  console.log(`\nface paint: ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\nface paint: ${passed} passed`);
