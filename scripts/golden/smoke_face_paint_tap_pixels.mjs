#!/usr/bin/env node
/**
 * A paint tap changes the pixel under the finger.
 *
 * Opens Paint on a cube, at 390px touch and on desktop. One tap moves the
 * sample at that point toward the swatch. A second tap within 300ms paints
 * the body, so a different face moves toward the swatch too.
 *
 * Screenshots: GOLDEN_SHOT_DIR or os.tmpdir() only.
 */
/* global document, indexedDB, window */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT || 5213);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SHOT_DIR = process.env.GOLDEN_SHOT_DIR || tmpdir();
const SURF = '2026-10-08-22-00-00-0001-ab12';
const PART = 'paint';
const CUBE = 'return Manifold.cube([20, 16, 12], true);\n';
const SWATCH = [0xef, 0x44, 0x44];
const DOC = {
  version: 1,
  source: 'local',
  name: 'Paint',
  activeId: PART,
  parts: [{ id: PART, name: 'Block', visible: true, order: 0, surfId: SURF }],
};

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
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function dist(rgb) {
  if (!rgb) return 999;
  return Math.abs(rgb[0] - SWATCH[0]) + Math.abs(rgb[1] - SWATCH[1]) + Math.abs(rgb[2] - SWATCH[2]);
}

console.log('face paint tap pixels');

const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.log('face paint tap pixels: no system Chrome — set CHROME_PATH');
  process.exit(1);
}

mkdirSync(SHOT_DIR, { recursive: true });
check('shot dir is not the artifacts folder', !String(SHOT_DIR).startsWith('/opt/cursor/artifacts'), SHOT_DIR);

const server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: new URL('../../', import.meta.url).pathname,
  stdio: 'ignore',
  detached: true,
});
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { server.kill('SIGKILL'); } catch { /* already gone */ }
};
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(1); });

async function waitForServer(timeoutMs = 40000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(APP_URL);
      if (res.ok) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function seed(page) {
  await page.evaluate(async ({ doc, script, partId }) => {
    const drop = (name) => new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    await drop('surfcad-assembly');
    await drop('surfcad');
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('surfcad-assembly', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('assembly')) db.createObjectStore('assembly');
        if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts');
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['assembly', 'parts'], 'readwrite');
        tx.objectStore('assembly').put(doc, 'current');
        tx.objectStore('parts').put({ id: partId, script, savedAt: Date.now() }, partId);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('surfcad', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('editorDraft')) db.createObjectStore('editorDraft');
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('editorDraft', 'readwrite');
        tx.objectStore('editorDraft').put({
          script,
          filename: 'Block',
          partId,
          savedAt: Date.now(),
        }, 'current');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { doc: DOC, script: CUBE, partId: PART });
}

function installProbe(page) {
  return page.evaluate(() => {
    window.__paintProbe = {
      bits() {
        const canvas = document.querySelector('.viewport-shell > canvas');
        const root = document.getElementById('root');
        const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
        const start = root[key].current || root[key];
        const seen = new Set();
        let renderer = null;
        function walk(fiber) {
          if (!fiber || seen.has(fiber) || renderer) return;
          seen.add(fiber);
          let hook = fiber.memoizedState;
          for (let guard = 0; hook && guard < 900; guard += 1) {
            const cur = hook.memoizedState && hook.memoizedState.current;
            if (cur && typeof cur.setPixelRatio === 'function' && typeof cur.render === 'function' && cur.domElement === canvas) {
              renderer = cur;
            }
            hook = hook.next;
          }
          walk(fiber.child);
          walk(fiber.sibling);
        }
        walk(start);
        return { canvas, renderer };
      },
    };
  });
}

async function ready(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.viewport-shell > canvas');
    return !!(canvas && canvas.clientWidth > 0 && window.__VIEWPORT__ && window.__MANIFOLD_CONTEXT__?.isReady);
  }, null, { timeout: 90000 });
  await page.waitForFunction(() => (
    (window.__MANIFOLD_CONTEXT__?.worker?.pendingRequests?.size || 0) === 0
    && (window.__VIEWPORT__?._renderCount || 0) >= 1
  ), null, { timeout: 90000 });
  await page.waitForTimeout(300);
}

function facePoint(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const { canvas, renderer } = window.__paintProbe.bits();
    const orig = renderer.render.bind(renderer);
    renderer.render = function hooked(scene, camera) {
      const out = orig(scene, camera);
      renderer.render = orig;
      const gl = renderer.getContext();
      const dpr = renderer.getPixelRatio();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const rect = canvas.getBoundingClientRect();
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let y = 4; y < h - 4; y += 2) {
        for (let x = 4; x < w - 4; x += 2) {
          const i = (y * w + x) * 4;
          const r = buf[i];
          const g = buf[i + 1];
          const b = buf[i + 2];
          const score = Math.abs(r - 128) + Math.abs(g - 128) + Math.abs(b - 255);
          if (b < 200 || r < 90 || g < 90 || score > 40) continue;
          const cssX = rect.left + (x + 0.5) / dpr;
          const cssY = rect.top + (h - y - 0.5) / dpr;
          if (document.elementFromPoint(cssX, cssY) !== canvas) continue;
          n += 1;
          sx += cssX;
          sy += cssY;
          sr += r;
          sg += g;
          sb += b;
        }
      }
      const hit = n
        ? {
          x: sx / n,
          y: sy / n,
          rgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
          n,
        }
        : null;
      resolve(hit);
      return out;
    };
  }));
}

function sample(page, x, y) {
  return page.evaluate(({ x: sx, y: sy }) => new Promise((resolve) => {
    const { canvas, renderer } = window.__paintProbe.bits();
    const orig = renderer.render.bind(renderer);
    renderer.render = function hooked(scene, camera) {
      const out = orig(scene, camera);
      renderer.render = orig;
      const gl = renderer.getContext();
      const dpr = renderer.getPixelRatio();
      const rect = canvas.getBoundingClientRect();
      const px = Math.max(0, Math.floor((sx - rect.left) * dpr));
      const py = Math.max(0, Math.floor((rect.bottom - sy) * dpr));
      const buf = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      resolve([buf[0], buf[1], buf[2]]);
      return out;
    };
  }), { x, y });
}

async function tap(page, touch, x, y) {
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function runCase(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch,
    isMobile: vp.touch,
    deviceScaleFactor: vp.touch ? 2 : 1,
    colorScheme: 'dark',
    userAgent: vp.touch
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err).slice(0, 240)));
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: false }),
  }));
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready(page);
  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await installProbe(page);
  await page.locator('[data-paint-chip]').click();
  await page.locator('[data-paint-mode="1"]').waitFor();
  await page.evaluate(() => window.__VIEWPORT__.stageSnap('front'));
  const front = await facePoint(page);
  await page.evaluate(() => window.__VIEWPORT__.stageSnap('right'));
  const side = await facePoint(page);
  check(`${vp.name} found a front face`, !!front, JSON.stringify(front));
  check(`${vp.name} found a side face`, !!side, JSON.stringify(side));
  if (!front || !side) {
    await context.close();
    return;
  }
  await page.evaluate(() => window.__VIEWPORT__.stageSnap('front'));
  const before = await sample(page, front.x, front.y);
  await tap(page, vp.touch, front.x, front.y);
  await page.waitForTimeout(80);
  const one = await sample(page, front.x, front.y);
  await page.evaluate(() => window.__VIEWPORT__.stageSnap('right'));
  const sideAfterOne = await sample(page, side.x, side.y);
  console.log(`  ${vp.name} tap ${JSON.stringify(before)} -> ${JSON.stringify(one)} side ${JSON.stringify(sideAfterOne)}`);
  check(
    `${vp.name} tap moves toward the swatch`,
    dist(before) > 120 && dist(one) < 48,
    `before ${dist(before)} after ${dist(one)} ${JSON.stringify(one)}`,
  );
  check(
    `${vp.name} one tap leaves the other face`,
    dist(sideAfterOne) > 120,
    JSON.stringify(sideAfterOne),
  );
  await page.evaluate(() => window.__VIEWPORT__.stageSnap('front'));
  await tap(page, vp.touch, front.x, front.y);
  await page.waitForTimeout(40);
  await tap(page, vp.touch, front.x, front.y);
  await page.waitForTimeout(80);
  await page.evaluate(() => window.__VIEWPORT__.stageSnap('right'));
  const sideBody = await sample(page, side.x, side.y);
  console.log(`  ${vp.name} body side ${JSON.stringify(sideBody)}`);
  check(
    `${vp.name} double-tap paints the body`,
    dist(sideBody) < 48,
    `dist ${dist(sideBody)} ${JSON.stringify(sideBody)}`,
  );
  if (vp.touch) {
    const shot = join(SHOT_DIR, 'face-paint-tap-390.png');
    await page.screenshot({ path: shot });
    check('390 shot saved outside artifacts', existsSync(shot) && !shot.startsWith('/opt/cursor/artifacts'), shot);
    console.log(`  shot ${shot}`);
  }
  check(`${vp.name} no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

let browser;
try {
  if (!await waitForServer()) {
    check('dev server started', false, APP_URL);
    process.exit(1);
  }
  check('dev server started', true);
  browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  await runCase(browser, { name: '390', width: 390, height: 844, touch: true });
  await runCase(browser, { name: 'desktop', width: 1280, height: 800, touch: false });
} finally {
  if (browser) await browser.close();
  stop();
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nface paint tap pixels: ok');
