#!/usr/bin/env node
/**
 * Feature card: shared shell, contour pilot, fillet / chamfer / edge card,
 * shell / draft / move face / delete face, keyboard, camera pose.
 *
 * Screenshots go to GOLDEN_SHOT_DIR or os.tmpdir(), never the artifacts dir.
 */
/* The evaluate callbacks run in the browser, where document exists. */
/* global document, window, getComputedStyle, requestAnimationFrame */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { chromium } from 'playwright-core';
import { PerspectiveCamera, Vector3 } from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { applyTrackballFeel } from '../../src/utils/trackballFeel.js';
import { panViewByNdcY } from '../../src/utils/viewCamera.js';
import {
  FEATURE_SHEET_SLIDE_MAX,
  boxCornerPoints,
  captureViewPose,
  createSheetCameraSession,
  featureSheetCardTopNdc,
  featureSheetClearanceNdc,
  featureSheetSlideNdc,
  posesMatch,
  selectionNdcYs,
} from '../../src/utils/featureSheetCamera.js';

process.env.BROWSERSLIST_IGNORE_OLD_DATA = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const shotDir = process.env.GOLDEN_SHOT_DIR || tmpdir();
const PHONE = { width: 390, height: 664 };

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('feature sheet card — source');
{
  const shell = read('src/components/FeatureSheet.jsx');
  const chip = read('src/components/ContourModeChip.jsx');
  const css = read('src/index.css');
  const layout = read('src/utils/featureSheetLayout.js');
  const camera = read('src/utils/featureSheetCamera.js');
  const hook = read('src/hooks/useModalViewport.js');
  const view = read('src/components/Viewport.jsx');
  const app = read('src/App.jsx');
  const arch = read('docs/architecture.md');
  const map = read('docs/UI_MAP.md');

  check('shell props are title, subtitle, onCancel, onConfirm, confirmDisabled, children',
    /title/.test(shell) && /subtitle/.test(shell) && /onCancel/.test(shell)
    && /onConfirm/.test(shell) && /confirmDisabled/.test(shell) && /children/.test(shell));
  check('card is a floating pane child, grey glass, cyan confirm',
    /data-feature-card/.test(shell)
    && /absolute/.test(shell)
    && !/fixed inset-0/.test(shell)
    && /bg-cyan-600/.test(shell)
    && /feature-sheet-card/.test(css)
    && /rgb\(17 24 39 \/ 0\.72\)/.test(css)
    && /border-gray-500\/50/.test(shell)
    && /22\.5rem/.test(css));
  check('width reuses the rail gap with a 10px side gap and a 22rem cap',
    /sheetChipBetweenRails/.test(read('src/utils/featureSheetLayout.js'))
    && /FEATURE_SHEET_SIDE_GAP_PX = 10/.test(layout)
    && /FEATURE_SHEET_MAX_REM = 22/.test(layout)
    && /min\(22rem,calc\(100%-9\.5rem\)\)/.test(shell));
  check('phone bottom clears the home pill, desktop does not invent one',
    /30px \+ max\(8px, env\(safe-area-inset-bottom, 0px\)\) \+ 10px/.test(layout)
    && /FEATURE_SHEET_BOTTOM_DESKTOP/.test(layout));
  check('body scrolls and keeps an iOS-visible track or hint',
    /data-feature-sheet-body/.test(shell)
    && /overflow-y-auto/.test(shell)
    && /data-feature-sheet-scrollbar/.test(shell)
    && /data-feature-sheet-scroll-hint/.test(shell)
    && /data-feature-sheet-footer/.test(shell));
  check('focused fields inside the card scroll, and inputs stay at 16px',
    /data-feature-card/.test(hook)
    && /\[data-feature-card\] input/.test(css)
    && /font-size: 16px/.test(css));
  check('contour pilot uses the shell; the rail X is the same cancel; game mounts no card',
    /<FeatureSheet\b/.test(chip)
    && /onCancel=\{exitContourMode\}/.test(view)
    && /contourMode && mode !== 'game'/.test(view));
  const fillet = read('src/components/FilletModeChip.jsx');
  check('fillet and chamfer use the shell; Confirm saves; X cancels; game mounts no card',
    /<FeatureSheet\b/.test(fillet)
    && /onConfirm=\{onAccept\}/.test(fillet)
    && /onCancel=\{onDismiss\}/.test(fillet)
    && /data-edge-blend/.test(fillet)
    && /Tangent \{tangentOn/.test(fillet)
    && !/>\s*Accept\s*</.test(fillet)
    && /filletMode && mode !== 'game'/.test(view));
  const edgeAt = view.indexOf("'data-edge-selector': 'standalone'");
  const edgeSlice = view.slice(Math.max(0, edgeAt - 500), edgeAt + 700);
  check('standalone edge card is the shell, X clears and leaves edge pick, no Confirm',
    edgeAt > 0
    && /<FeatureSheet\b/.test(edgeSlice)
    && !/onConfirm=/.test(edgeSlice)
    && /setPickMode\('face'\)/.test(edgeSlice)
    && /mode !== 'game' && pickMode === 'edge' && !contourMode && !filletMode/.test(view));
  check('fillet, contour, and the edge card share one camera and do not stack',
    /featureCardKind/.test(view)
    && /filletSheetOpen/.test(view)
    && /edgeSheetOpen/.test(view)
    && /if \(!next \|\| next === featureCardKind\)/.test(view));
  check('shell, draft, move face, and delete face use the shell; game mounts no card',
    ['Shell', 'Draft', 'MoveFace', 'DeleteFace'].every((name) => {
      const src = read(`src/components/${name}ModeChip.jsx`);
      return /<FeatureSheet\b/.test(src)
        && /onCancel=\{onDismiss\}/.test(src)
        && /onConfirm=\{onConfirm\}/.test(src);
    })
    && /shellMode && mode !== 'game'/.test(view)
    && /draftMode && mode !== 'game'/.test(view)
    && /moveFaceMode && mode !== 'game'/.test(view)
    && /deleteFaceMode && mode !== 'game'/.test(view)
    && /shellSheetOpen/.test(view)
    && /draftSheetOpen/.test(view)
    && /moveFaceSheetOpen/.test(view)
    && /deleteFaceSheetOpen/.test(view)
    && /!shellMode && !draftMode && !moveFaceMode && !deleteFaceMode/.test(view));
  check('camera snapshots the pose, slides up, and restores it',
    /export function captureViewPose/.test(camera)
    && /FEATURE_SHEET_SLIDE_MAX = 0\.6/.test(camera)
    && /remountTrackball/.test(camera)
    && /featureSheetCameraOwned/.test(app)
    && /prefers-reduced-motion/.test(view));
  check('docs name the shell',
    /## Feature card/.test(arch) && /FeatureSheet/.test(arch)
    && /data-feature-card/.test(map));
}

console.log('feature sheet card — camera');
{
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      pageXOffset: 0,
      pageYOffset: 0,
      addEventListener() {},
      removeEventListener() {},
    };
  }
  const fakeDom = () => ({
    style: {},
    ownerDocument: {
      documentElement: { clientWidth: 800, clientHeight: 600, clientLeft: 0, clientTop: 0 },
    },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    },
  });
  const camera = new PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(80, -80, 60);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 10);
  camera.updateMatrixWorld();
  let controls = new TrackballControls(camera, fakeDom());
  applyTrackballFeel(controls);
  controls.target.set(0, 0, 10);
  controls.update();
  const box = { min: [-8, -8, 0], max: [8, 8, 16] };
  const fraction = 0.42;
  const cardTop = featureSheetCardTopNdc(fraction);
  const points = boxCornerPoints(box);
  panViewByNdcY({ camera, controls, ndcY: 0.35 });
  const buried = Math.min(...selectionNdcYs(camera, points));
  check('part can sit under the card before the slide', buried < cardTop, `ndc ${buried} top ${cardTop}`);
  const delta = featureSheetClearanceNdc({ camera, controls, points, cardFraction: fraction });
  check('slide moves content up and stays within 0.6 NDC',
    delta < 0 && delta >= -FEATURE_SHEET_SLIDE_MAX, `delta ${delta}`);
  panViewByNdcY({ camera, controls, ndcY: delta });
  const cleared = Math.min(...selectionNdcYs(camera, points));
  check('projected part box sits above the card',
    cleared + 0.02 >= cardTop,
    `cleared ${cleared} cardTop ${cardTop} delta ${delta}`);

  const session = createSheetCameraSession({
    getCamera: () => camera,
    getControls: () => controls,
    setControls: (next) => { controls = next; },
    reducedMotion: () => true,
  });
  const openPose = captureViewPose(camera, controls);
  session.slideBy(featureSheetSlideNdc(-0.7, 0.4));
  camera.position.applyAxisAngle(new Vector3(0, 0, 1), 0.55);
  camera.up.applyAxisAngle(new Vector3(0, 0, 1), 0.35);
  camera.lookAt(controls.target);
  controls.update();
  check('orbit during the sheet leaves the snapshot pose',
    posesMatch(captureViewPose(camera, controls), openPose, 1e-3) === false);
  session.restore();
  controls.update();
  check('close restores the pre-open pose within epsilon, orbit discarded',
    posesMatch(captureViewPose(camera, controls), openPose, 1e-3),
    JSON.stringify({ open: openPose.position, now: captureViewPose(camera, controls).position }));
}

const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
check('system Chrome available for the feature card render', !!exe, 'set CHROME_PATH');

if (exe && failed === 0) {
  const cssSrc = read('src/index.css');
  const processed = await postcss([
    tailwindcss({ config: join(ROOT, 'tailwind.config.js') }),
    autoprefixer(),
  ]).process(cssSrc, { from: join(ROOT, 'src/index.css') });

  const bundled = await build({
    stdin: {
      contents: `import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight, BoxGeometry, DirectionalLight, Mesh, MeshLambertMaterial,
  PerspectiveCamera, Scene, WebGLRenderer,
} from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { applyTrackballFeel } from './src/utils/trackballFeel.js';
import ContourModeChip from './src/components/ContourModeChip.jsx';
import FilletModeChip from './src/components/FilletModeChip.jsx';
import ShellModeChip from './src/components/ShellModeChip.jsx';
import DraftModeChip from './src/components/DraftModeChip.jsx';
import MoveFaceModeChip from './src/components/MoveFaceModeChip.jsx';
import DeleteFaceModeChip from './src/components/DeleteFaceModeChip.jsx';
import {
  applyViewPose, boxCornerPoints, captureViewPose, createSheetCameraSession,
  featureSheetClearanceNdc, selectionNdcYs,
} from './src/utils/featureSheetCamera.js';
import { panViewByNdcY } from './src/utils/viewCamera.js';

const PART = { min: [-10, -10, 0], max: [10, 10, 20] };

function Stage() {
  const paneRef = useRef(null);
  const [entry, setEntry] = useState('crossSection');
  const [compact, setCompact] = useState(true);
  const [panel, setPanel] = useState('contour');
  const api = useRef(null);

  useEffect(() => {
    const pane = paneRef.current;
    const canvas = pane.querySelector('canvas');
    const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    const scene = new Scene();
    const camera = new PerspectiveCamera(45, 1, 0.1, 2000);
    camera.position.set(70, -90, 55);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 10);
    let controls = new TrackballControls(camera, canvas);
    applyTrackballFeel(controls);
    controls.target.set(0, 0, 10);
    controls.update();
    const mesh = new Mesh(
      new BoxGeometry(20, 20, 20),
      new MeshLambertMaterial({ color: 0x7ec8e3 }),
    );
    mesh.position.set(0, 0, 10);
    scene.add(mesh);
    scene.add(new AmbientLight(0xffffff, 0.7));
    const key = new DirectionalLight(0xffffff, 0.9);
    key.position.set(30, -40, 80);
    scene.add(key);
    const session = createSheetCameraSession({
      getCamera: () => camera,
      getControls: () => controls,
      setControls: (next) => { controls = next; },
      reducedMotion: () => true,
    });
    const initial = captureViewPose(camera, controls);
    const fit = () => {
      const r = pane.getBoundingClientRect();
      renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    fit();
    const render = () => renderer.render(scene, camera);
    const pan = (ndcY) => panViewByNdcY({ camera, controls, ndcY });
    const cardFraction = () => {
      const pane = paneRef.current;
      const card = pane?.querySelector('[data-feature-card]');
      const paneBox = pane?.getBoundingClientRect();
      const cardBox = card?.getBoundingClientRect();
      const ph = paneBox?.height || 1;
      if (!cardBox || !paneBox) return 0;
      return Math.min(0.95, Math.max(0, (paneBox.bottom - cardBox.top) / ph));
    };
    const lowY = () => Math.min(...selectionNdcYs(camera, boxCornerPoints(PART)));
    api.current = {
      fit, render, camera, session,
      controls: () => controls,
      pose: () => captureViewPose(camera, controls),
      partYs: () => selectionNdcYs(camera, boxCornerPoints(PART)),
      reset() {
        applyViewPose(camera, controls, initial);
        controls.update();
        applyViewPose(camera, controls, initial);
      },
      /** Park the part just under the card, then optionally slide it clear. */
      park({ slide }) {
        this.reset();
        fit();
        const topOf = () => -1 + 2 * cardFraction();
        let steps = 0;
        while (lowY() >= topOf() - 0.03 && steps < 8) {
          pan(0.08);
          steps += 1;
        }
        const points = boxCornerPoints(PART);
        let delta = 0;
        if (slide) {
          delta = featureSheetClearanceNdc({
            camera,
            controls,
            points,
            cardFraction: cardFraction(),
          });
          if (Math.abs(delta) > 1e-6) pan(delta);
        }
        const fraction = cardFraction();
        const low = lowY();
        render();
        return { fraction, low, delta, cardTop: -1 + 2 * fraction };
      },
    };
    window.__sheet = api.current;
    const ro = new ResizeObserver(fit);
    ro.observe(pane);
    return () => {
      ro.disconnect();
      renderer.dispose();
    };
  }, []);

  return (
    <div ref={paneRef} className="viewport-shell relative h-full w-full overflow-hidden bg-[#1e1e1e]" data-stage-pane="cad" data-harness-pane="">
      <canvas className="absolute inset-0 block h-full w-full" />
      <div data-rail-pair="left" className="absolute bottom-2.5 left-2 z-10 w-14 rounded-lg bg-white/70" style={{ height: 220 }} />
      <div data-rail-pair="right" className="absolute bottom-2.5 right-2.5 z-10 w-14 rounded-lg bg-white/70" style={{ height: 300 }} />
      {compact ? (
        <div data-home-indicator="" className="pointer-events-none absolute inset-x-0 bottom-0 z-10" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom, 0px))' }}>
          <div data-home-indicator-pill="" className="mx-auto rounded-full border border-white/20 bg-gray-900/70" style={{ width: 112, height: 30 }} />
        </div>
      ) : null}
      {panel === 'fillet' ? (
        <FilletModeChip
          kind="fillet"
          edgeCount={3}
          partCount={1}
          tangentOn
          params={{ radius: 2, _sweepMax: 20 }}
          pathOk
          componentCount={1}
          compact={compact}
          onToggleTangent={() => {}}
          onClear={() => {}}
          onAccept={() => {}}
          onBack={() => {}}
          onDismiss={() => {}}
          onParamChange={() => {}}
        />
      ) : panel === 'shell' ? (
        <ShellModeChip
          face={{ type: 'planar', center: [0, 0, 10], normal: [0, 0, 1] }}
          params={{ wall: 2.5, openingMode: 'face' }}
          compact={compact}
          onParamChange={() => {}}
          onUndoFace={() => {}}
          onClearFace={() => {}}
          onConfirm={() => {}}
          onDismiss={() => {}}
        />
      ) : panel === 'draft' ? (
        <DraftModeChip
          neutral={{ center: [0, 0, 10], normal: [0, 0, 1] }}
          drafts={[{ center: [10, 0, 0], normal: [1, 0, 0] }]}
          angle={2}
          flip={false}
          compact={compact}
          onAngle={() => {}}
          onFlip={() => {}}
          onUndo={() => {}}
          onClear={() => {}}
          onConfirm={() => {}}
          onDismiss={() => {}}
        />
      ) : panel === 'moveFace' ? (
        <MoveFaceModeChip
          faces={[{ center: [0, 0, 10], normal: [0, 0, 1] }]}
          distance={2}
          flip={false}
          compact={compact}
          onDistance={() => {}}
          onFlip={() => {}}
          onUndo={() => {}}
          onClear={() => {}}
          onConfirm={() => {}}
          onDismiss={() => {}}
        />
      ) : panel === 'deleteFace' ? (
        <DeleteFaceModeChip
          faces={[{ center: [0, 0, 10], normal: [0, 0, 1] }]}
          compact={compact}
          onUndo={() => {}}
          onClear={() => {}}
          onConfirm={() => {}}
          onDismiss={() => {}}
        />
      ) : (
        <ContourModeChip
          tool="circle"
          entry={entry}
          params={{ radius: 5, segments: 64 }}
          extrude={{ distance: 10, direction: 'normal', sense: 'positive' }}
          combine="add"
          merge
          planeLabel="default +Z top"
          compact={compact}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      )}
      <div data-harness="" style={{ position: 'absolute', left: 0, top: 0, opacity: 0 }}>
        <button type="button" data-harness-entry="crossSection" onClick={() => { setPanel('contour'); setEntry('crossSection'); }}>circle</button>
        <button type="button" data-harness-entry="makeExtrude" onClick={() => { setPanel('contour'); setEntry('makeExtrude'); }}>extrude</button>
        <button type="button" data-harness-panel="fillet" onClick={() => setPanel('fillet')}>fillet</button>
        <button type="button" data-harness-panel="shell" onClick={() => setPanel('shell')}>shell</button>
        <button type="button" data-harness-panel="draft" onClick={() => setPanel('draft')}>draft</button>
        <button type="button" data-harness-panel="moveFace" onClick={() => setPanel('moveFace')}>moveFace</button>
        <button type="button" data-harness-panel="deleteFace" onClick={() => setPanel('deleteFace')}>deleteFace</button>
        <button type="button" data-harness-compact="1" onClick={() => setCompact(true)}>phone</button>
        <button type="button" data-harness-compact="0" onClick={() => setCompact(false)}>desktop</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Stage />);
`,
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  });

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${processed.css}
html, body, #root { margin: 0; height: 100%; background: #111; }
</style></head>
<body>
<div id="root"></div>
<script>
(function () {
  const listeners = { resize: new Set(), scroll: new Set() };
  let height = window.innerHeight;
  let offsetTop = 0;
  const vv = {
    get height() { return height; },
    get offsetTop() { return offsetTop; },
    get width() { return window.innerWidth; },
    get scale() { return 1; },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = new Set())).add(fn); },
    removeEventListener(type, fn) { listeners[type] && listeners[type].delete(fn); },
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, get() { return vv; } });
  window.__setVisualViewport = (h, top) => {
    height = h;
    offsetTop = top || 0;
    (listeners.resize || []).forEach((fn) => fn());
  };
})();
</script>
<script>${bundled.outputFiles[0].text}</script>
</body></html>`;

  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const pageErrors = [];
  try {
    mkdirSync(shotDir, { recursive: true });
    const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForSelector('[data-feature-card]', { timeout: 15000 });
    await page.waitForFunction(() => window.__sheet && window.__sheet.camera);

    const readCard = () => page.evaluate(() => {
      const card = document.querySelector('[data-feature-card]');
      const pane = document.querySelector('[data-harness-pane]');
      const left = document.querySelector('[data-rail-pair="left"]').getBoundingClientRect();
      const right = document.querySelector('[data-rail-pair="right"]').getBoundingClientRect();
      const box = card.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      const pill = document.querySelector('[data-home-indicator-pill]');
      const pillBox = pill ? pill.getBoundingClientRect() : null;
      const body = card.querySelector('[data-feature-sheet-body]');
      const footer = card.querySelector('[data-feature-sheet-footer]');
      const cs = getComputedStyle(card);
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      return {
        left: box.left - paneBox.left,
        width: box.width,
        top: box.top - paneBox.top,
        bottomGap: paneBox.bottom - box.bottom,
        height: box.height,
        paneH: paneBox.height,
        paneW: paneBox.width,
        gapLeft: box.left - left.right,
        gapRight: right.left - box.right,
        pillGap: pillBox ? pillBox.top - box.bottom : null,
        maxHeight: cs.maxHeight,
        radius: cs.borderRadius,
        compact: card.getAttribute('data-feature-card-compact'),
        cap: 22 * root,
        bodyOverflow: getComputedStyle(body).overflowY,
        footerH: footer.getBoundingClientRect().height,
      };
    });

    const show = async (entry, compact) => {
      await page.evaluate(({ entry: next, compact: phone }) => {
        document.querySelector(`[data-harness-compact="${phone ? '1' : '0'}"]`).click();
        document.querySelector(`[data-harness-entry="${next}"]`).click();
      }, { entry, compact });
      await page.waitForFunction(({ entry: next, compact: phone }) => {
        const card = document.querySelector('[data-feature-card]');
        const title = document.querySelector('[data-feature-card-title]');
        return card
          && card.getAttribute('data-feature-card-compact') === (phone ? '1' : '0')
          && title
          && (next === 'makeExtrude' ? title.textContent.includes('Extrude') || document.querySelector('[data-popup-number="extrude-distance"]') : title.textContent.includes('circle'));
      }, { entry, compact }, { timeout: 5000 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };

    const parkAndShoot = async (name, { slide }) => {
      const result = await page.evaluate(({ slide: doSlide }) => window.__sheet.park({ slide: doSlide }), { slide });
      await page.screenshot({ path: join(shotDir, name) });
      return result;
    };

    await show('crossSection', true);
    let card = await readCard();
    check('phone card is at most 22rem and 10px clear of each rail',
      card.width <= card.cap + 1.5
      && card.gapLeft >= 8
      && card.gapRight >= 8
      && card.width > 120,
      JSON.stringify(card));
    check('phone card sits 10px above the home pill',
      card.compact === '1'
      && card.bottomGap >= 46
      && card.bottomGap <= 52
      && card.pillGap != null
      && card.pillGap >= 8
      && card.pillGap <= 14,
      JSON.stringify({ bottomGap: card.bottomGap, pillGap: card.pillGap }));
    check('phone card height is capped and the body scrolls',
      card.height <= 362
      && card.height > 160
      && (card.bodyOverflow === 'auto' || card.bodyOverflow === 'scroll'),
      JSON.stringify({ height: card.height, overflow: card.bodyOverflow, max: card.maxHeight }));
    const phoneBefore = await parkAndShoot('feature-sheet-circle-390-before.png', { slide: false });
    check('phone before-slide parks the part under the card',
      phoneBefore.low < phoneBefore.cardTop,
      JSON.stringify(phoneBefore));
    const phoneAfter = await parkAndShoot('feature-sheet-circle-390-after.png', { slide: true });
    check('phone: projected part box sits above the card while it is open',
      Number.isFinite(phoneAfter.low) && phoneAfter.low + 0.02 >= phoneAfter.cardTop,
      JSON.stringify(phoneAfter));

    await show('makeExtrude', true);
    await parkAndShoot('feature-sheet-extrude-390-before.png', { slide: false });
    await parkAndShoot('feature-sheet-extrude-390-after.png', { slide: true });
    const extrudeCard = await readCard();
    check('extrude card stays inside the same phone cap',
      extrudeCard.height <= 362 && extrudeCard.width <= extrudeCard.cap + 1.5,
      JSON.stringify({ h: extrudeCard.height, w: extrudeCard.width }));

    await page.evaluate(() => {
      const pane = document.querySelector('[data-harness-pane]');
      pane.style.height = '340px';
      window.__setVisualViewport(340, 0);
    });
    await page.waitForFunction(() => {
      const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--modal-vvh'));
      return v > 0 && v <= 340;
    });
    await page.locator('[data-popup-number="extrude-distance"], [data-popup-number="radius"]').first().focus();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      const card = document.querySelector('[data-feature-card]');
      const body = card.querySelector('[data-feature-sheet-body]');
      const footer = card.querySelector('[data-feature-sheet-footer]');
      const pane = document.querySelector('[data-harness-pane]');
      const field = el.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      const vv = window.visualViewport.height;
      return {
        tag: el.tagName,
        font: parseFloat(getComputedStyle(el).fontSize),
        top: field.top,
        bottom: field.bottom,
        bodyTop: bodyBox.top,
        bodyBottom: bodyBox.bottom,
        footerTop: footerBox.top,
        paneBottom: paneBox.bottom,
        vv,
        cardH: card.getBoundingClientRect().height,
      };
    });
    check('a focused number stays inside the shrunk visual viewport, above the footer',
      focused.font >= 16
      && focused.top >= focused.bodyTop - 2
      && focused.bottom <= focused.bodyBottom + 2
      && focused.bottom <= focused.footerTop + 2
      && focused.bottom <= focused.vv + 2
      && focused.bottom <= focused.paneBottom + 2
      && focused.cardH < 360,
      JSON.stringify(focused));
    await page.evaluate(() => {
      document.querySelector('[data-harness-pane]').style.height = '';
      window.__setVisualViewport(window.innerHeight, 0);
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await show('crossSection', false);
    await page.evaluate(() => window.__sheet.fit());
    card = await readCard();
    check('desktop card stays a card: 22rem cap, 10px off the bottom, clear of the rails',
      card.compact === '0'
      && card.width <= card.cap + 1.5
      && card.width >= card.cap - 4
      && card.bottomGap >= 8
      && card.bottomGap <= 16
      && card.gapLeft >= 8
      && card.gapRight >= 8
      && card.pillGap == null,
      JSON.stringify(card));
    const deskBefore = await parkAndShoot('feature-sheet-circle-desktop-before.png', { slide: false });
    check('desktop before-slide parks the part under the card',
      deskBefore.low < deskBefore.cardTop,
      JSON.stringify(deskBefore));
    const deskAfter = await parkAndShoot('feature-sheet-circle-desktop-after.png', { slide: true });
    check('desktop: projected part box sits above the card while it is open',
      Number.isFinite(deskAfter.low) && deskAfter.low + 0.02 >= deskAfter.cardTop,
      JSON.stringify(deskAfter));

    await show('makeExtrude', false);
    await parkAndShoot('feature-sheet-extrude-desktop-before.png', { slide: false });
    await parkAndShoot('feature-sheet-extrude-desktop-after.png', { slide: true });

    const showFillet = async (phone) => {
      await page.setViewportSize(phone ? PHONE : { width: 1280, height: 800 });
      await page.evaluate((next) => {
        document.querySelector(`[data-harness-compact="${next ? '1' : '0'}"]`).click();
        document.querySelector('[data-harness-panel="fillet"]').click();
      }, phone);
      await page.waitForFunction((next) => {
        const card = document.querySelector('[data-feature-card]');
        const title = document.querySelector('[data-feature-card-title]');
        const confirm = document.querySelector('[data-feature-card-confirm]');
        return card
          && card.getAttribute('data-edge-blend') === 'fillet'
          && card.getAttribute('data-feature-card-compact') === (next ? '1' : '0')
          && title
          && title.textContent.includes('Fillet')
          && confirm
          && confirm.textContent.includes('Confirm')
          && !confirm.textContent.includes('Accept');
      }, phone, { timeout: 5000 });
      await page.evaluate(() => window.__sheet.fit());
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };

    await showFillet(true);
    const filletPhone = await readCard();
    check('fillet card on a phone uses the same rail gap and pill clearance',
      filletPhone.compact === '1'
      && filletPhone.width <= filletPhone.cap + 1.5
      && filletPhone.gapLeft >= 8
      && filletPhone.gapRight >= 8
      && filletPhone.pillGap != null
      && filletPhone.pillGap >= 8
      && filletPhone.pillGap <= 14
      && filletPhone.height < 360,
      JSON.stringify(filletPhone));
    const filletPick = await page.evaluate(() => {
      const pane = document.querySelector('[data-harness-pane]');
      const box = pane.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + 36);
      return {
        tag: el && el.tagName,
        onCard: !!(el && el.closest('[data-feature-card]')),
      };
    });
    check('a point above the fillet card is the canvas, so edge picks still land',
      filletPick.tag === 'CANVAS' && filletPick.onCard === false,
      JSON.stringify(filletPick));
    await parkAndShoot('feature-sheet-fillet-390-before.png', { slide: false });
    const filletAfter = await parkAndShoot('feature-sheet-fillet-390-after.png', { slide: true });
    check('phone fillet: projected part box sits above the card',
      Number.isFinite(filletAfter.low) && filletAfter.low + 0.02 >= filletAfter.cardTop,
      JSON.stringify(filletAfter));

    await showFillet(false);
    const filletDesk = await readCard();
    check('fillet card on desktop stays a card clear of the rails',
      filletDesk.compact === '0'
      && filletDesk.width <= filletDesk.cap + 1.5
      && filletDesk.bottomGap >= 8
      && filletDesk.bottomGap <= 16
      && filletDesk.gapLeft >= 8
      && filletDesk.gapRight >= 8
      && filletDesk.pillGap == null,
      JSON.stringify(filletDesk));
    await parkAndShoot('feature-sheet-fillet-desktop-before.png', { slide: false });
    const filletDeskAfter = await parkAndShoot('feature-sheet-fillet-desktop-after.png', { slide: true });
    check('desktop fillet: projected part box sits above the card',
      Number.isFinite(filletDeskAfter.low) && filletDeskAfter.low + 0.02 >= filletDeskAfter.cardTop,
      JSON.stringify(filletDeskAfter));

    const orbit = await page.evaluate(() => {
      const sheet = window.__sheet;
      const before = sheet.pose();
      sheet.session.slideBy(-0.25);
      const cam = sheet.camera;
      const ctl = sheet.controls();
      const rot = (v, ang) => {
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const x = v.x * c - v.y * s;
        const y = v.x * s + v.y * c;
        v.x = x;
        v.y = y;
      };
      rot(cam.position, 0.5);
      rot(cam.up, 0.3);
      cam.lookAt(ctl.target);
      ctl.update();
      const mid = sheet.pose();
      const drifted = Math.hypot(
        mid.position[0] - before.position[0],
        mid.position[1] - before.position[1],
        mid.position[2] - before.position[2],
      ) > 1;
      sheet.session.restore();
      sheet.controls().update();
      const after = sheet.pose();
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      return {
        drifted,
        position: dist(after.position, before.position),
        target: dist(after.target, before.target),
        up: dist(after.up, before.up),
        fov: Math.abs(after.fov - before.fov),
      };
    });
    check('browser: close restores the pre-open pose after an orbit',
      orbit.drifted
      && orbit.position < 1e-2
      && orbit.target < 1e-2
      && orbit.up < 1e-2
      && orbit.fov < 1e-3,
      JSON.stringify(orbit));

    const showFace = async (name, titleText, marker) => {
      await page.setViewportSize(PHONE);
      await page.evaluate((panelName) => {
        document.querySelector('[data-harness-compact="1"]').click();
        document.querySelector(`[data-harness-panel="${panelName}"]`).click();
      }, name);
      await page.waitForFunction(({ titleText: want, marker: attr }) => {
        const cards = document.querySelectorAll('[data-feature-card]');
        const card = cards[0];
        const title = document.querySelector('[data-feature-card-title]');
        const confirm = document.querySelector('[data-feature-card-confirm]');
        const cancel = document.querySelector('[data-feature-card-cancel]');
        return cards.length === 1
          && card
          && card.getAttribute(attr) != null
          && card.getAttribute('data-feature-card-compact') === '1'
          && title
          && title.textContent.includes(want)
          && confirm
          && confirm.textContent.includes('Confirm')
          && cancel;
      }, { titleText, marker }, { timeout: 5000 });
      await page.evaluate(() => window.__sheet.fit());
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };

    await showFace('shell', 'Shell', 'data-shell-mode');
    const shellPick = await page.evaluate(() => {
      const pane = document.querySelector('[data-harness-pane]');
      const box = pane.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + 36);
      return {
        tag: el && el.tagName,
        onCard: !!(el && el.closest('[data-feature-card]')),
      };
    });
    check('a point above the shell card is the canvas, so face picks still land',
      shellPick.tag === 'CANVAS' && shellPick.onCard === false,
      JSON.stringify(shellPick));
    const shellPhone = await readCard();
    check('shell card on a phone uses the same rail gap and pill clearance',
      shellPhone.compact === '1'
      && shellPhone.width <= shellPhone.cap + 1.5
      && shellPhone.gapLeft >= 8
      && shellPhone.gapRight >= 8
      && shellPhone.pillGap != null
      && shellPhone.pillGap >= 8
      && shellPhone.pillGap <= 14
      && shellPhone.height < 360,
      JSON.stringify(shellPhone));
    await parkAndShoot('feature-sheet-shell-390-before.png', { slide: false });
    const shellAfter = await parkAndShoot('feature-sheet-shell-390-after.png', { slide: true });
    check('phone shell: projected part box sits above the card',
      Number.isFinite(shellAfter.low) && shellAfter.low + 0.02 >= shellAfter.cardTop,
      JSON.stringify(shellAfter));

    await showFace('draft', 'Draft', 'data-draft-mode');
    await parkAndShoot('feature-sheet-draft-390-before.png', { slide: false });
    await parkAndShoot('feature-sheet-draft-390-after.png', { slide: true });
    await showFace('moveFace', 'Move Face', 'data-move-face-mode');
    await parkAndShoot('feature-sheet-move-face-390-before.png', { slide: false });
    await parkAndShoot('feature-sheet-move-face-390-after.png', { slide: true });
    await showFace('deleteFace', 'Delete Face', 'data-delete-face-mode');
    const deletePick = await page.evaluate(() => {
      const pane = document.querySelector('[data-harness-pane]');
      const box = pane.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + 36);
      return {
        tag: el && el.tagName,
        onCard: !!(el && el.closest('[data-feature-card]')),
        cards: document.querySelectorAll('[data-feature-card]').length,
      };
    });
    check('a point above the delete-face card is the canvas',
      deletePick.tag === 'CANVAS' && deletePick.onCard === false && deletePick.cards === 1,
      JSON.stringify(deletePick));
    await parkAndShoot('feature-sheet-delete-face-390-before.png', { slide: false });
    await parkAndShoot('feature-sheet-delete-face-390-after.png', { slide: true });

    check('the page did not throw', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
  }
}

console.log(failed ? `\n❌ FAIL (${failed} failed)` : `\n✅ PASS`);
process.exit(failed ? 1 : 0);
