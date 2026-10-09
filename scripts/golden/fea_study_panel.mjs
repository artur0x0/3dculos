#!/usr/bin/env node
/**
 * Analyze: open the study, pick a material, fix a face, add a force, run
 * the stub, and reload. The study comment is still in the part script.
 *
 * 390×844 touch (iPhone UA, DPR 2) and 1280×800 desktop. FEA_VIEW=desktop
 * or FEA_VIEW=390 runs one of them. FEA_PREVIEW=1 serves the existing
 * dist with vite preview; otherwise this starts the dev server.
 *
 * Screenshots go to GOLDEN_SHOT_DIR or os.tmpdir() only.
 */
/* global document, indexedDB, localStorage, window */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT || 4327);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SHOT_DIR = process.env.GOLDEN_SHOT_DIR || tmpdir();
const PREVIEW = process.env.FEA_PREVIEW === '1';
const CUBE = 'const part = Manifold.cube([20, 20, 20], true);\nreturn part;\n';
const PART_ID = 'fea-block';
const USER_ID = 'user-fea';

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

console.log('FEA study panel');

const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.log('FEA study panel: no system Chrome — set CHROME_PATH. Skipping.');
  process.exit(0);
}

if (String(SHOT_DIR).startsWith('/opt/cursor/artifacts')) {
  console.log(`  ❌ screenshots must not use /opt/cursor/artifacts (${SHOT_DIR})`);
  process.exit(1);
}

mkdirSync(SHOT_DIR, { recursive: true });

const serverArgs = PREVIEW
  ? ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
  : ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'];
const server = spawn('npx', serverArgs, {
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
  await page.evaluate(async ({ script, partId, userId }) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('surfcad-assembly');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
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
        tx.objectStore('assembly').put({
          version: 1,
          source: 'git',
          name: 'Study',
          activeId: partId,
          parts: [{ id: partId, name: 'Block', visible: true, order: 0 }],
        }, 'current');
        tx.objectStore('parts').put({ id: partId, script, savedAt: Date.now() }, partId);
        // A signed-in /me with no GitHub token is reauth and read-only, so
        // the study save is skipped. A still-valid access token (no refresh)
        // is connected. The part id is not a vault path, and source git
        // reopens this cache without a repo lookup.
        localStorage.setItem('surfcad.github.tokenBundle', JSON.stringify({
          accessToken: 'ghu_fea',
          refreshToken: '',
          expiresAt: Date.now() + 86_400_000,
          refreshExpiresAt: 0,
        }));
        localStorage.setItem('surfcad.lastAssembly', JSON.stringify({
          [userId]: {
            name: 'Study',
            activeId: partId,
            source: 'git',
            savedAt: Date.now(),
          },
        }));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { script: CUBE, partId: PART_ID, userId: USER_ID });
}

async function boot(page) {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: false }),
  }));
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true,
      user: { id: USER_ID, email: 'fea@surfcad.test', vaultName: null },
    }),
  }));
  await page.route('https://api.github.com/**', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'Bad credentials' }),
  }));
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err).slice(0, 400)));
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('canvas', { timeout: 40000 });
  return errors;
}

async function solidReady(page) {
  await page.waitForFunction(() => {
    const spinner = document.querySelector('[data-assembly-open-spinner]');
    const solids = document.querySelector('[data-assembly-solids]')?.getAttribute('data-assembly-solids');
    const ctx = window.__MANIFOLD_CONTEXT__;
    const pending = ctx?.worker?.pendingRequests?.size || 0;
    // Production preview does not publish the dev worker hook. The solid
    // count and the open spinner are the signals that exist in both builds.
    const booted = !ctx || ctx.isReady === true;
    return !spinner && solids === '1' && pending === 0 && booted;
  }, null, { timeout: 40000 });
  await page.waitForTimeout(400);
}

function installProbe(page) {
  return page.evaluate(() => {
    window.__feaProbe = {
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

async function snapFront(page) {
  const viaHook = await page.evaluate(() => {
    if (typeof window.__VIEWPORT__?.stageSnap === 'function') return !!window.__VIEWPORT__.stageSnap('front');
    return false;
  });
  if (viaHook) {
    await page.waitForTimeout(200);
    return;
  }
  await page.locator('[aria-label="View snaps"]').click();
  await page.locator('[aria-label="Snap to Front"]').click();
  await page.waitForTimeout(300);
}

function facePoints(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const { canvas, renderer } = window.__feaProbe.bits();
    if (!canvas || !renderer) {
      resolve([]);
      return;
    }
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
      const pts = [];
      for (let y = 4; y < h - 4; y += 3) {
        for (let x = 4; x < w - 4; x += 3) {
          const i = (y * w + x) * 4;
          const r = buf[i];
          const g = buf[i + 1];
          const b = buf[i + 2];
          const score = Math.abs(r - 128) + Math.abs(g - 128) + Math.abs(b - 255);
          if (b < 200 || r < 90 || g < 90 || score > 40) continue;
          const cssX = rect.left + (x + 0.5) / dpr;
          const cssY = rect.top + (h - y - 0.5) / dpr;
          if (document.elementFromPoint(cssX, cssY) !== canvas) continue;
          pts.push({ x: cssX, y: cssY });
        }
      }
      if (!pts.length) {
        resolve([]);
        return;
      }
      const picks = [];
      const step = Math.max(1, Math.floor(pts.length / 8));
      for (let i = step >> 1; i < pts.length && picks.length < 8; i += step) picks.push(pts[i]);
      resolve(picks);
      return out;
    };
  }));
}

async function tap(page, touch, point) {
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function canvasPoints(page, points) {
  return page.evaluate((pts) => {
    const canvas = document.querySelector('.viewport-shell > canvas');
    return pts.filter((point) => document.elementFromPoint(point.x, point.y) === canvas);
  }, points);
}

async function tapUntil(page, touch, points, attr, expected) {
  const live = await canvasPoints(page, points);
  if (!live.length) return { ok: false, points: 0, notice: await noticeOf(page) };
  for (const point of live) {
    await tap(page, touch, point);
    await page.waitForTimeout(500);
    const count = await page.locator(`[${attr}]`).getAttribute(attr).catch(() => null);
    if (count === expected) return { ok: true, points: live.length };
  }
  return { ok: false, points: live.length, notice: await noticeOf(page) };
}

function noticeOf(page) {
  return page.locator('[data-fea-notice]').textContent().catch(() => '');
}

async function readStudyScripts(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('surfcad-assembly', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('parts', 'readonly');
      const all = tx.objectStore('parts').getAll();
      all.onsuccess = () => {
        db.close();
        resolve((all.result || []).map((row) => row?.script || ''));
      };
      all.onerror = () => reject(all.error);
    };
  }));
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
  const errors = await boot(page);
  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 40000 });
  await solidReady(page);
  await installProbe(page);

  const rail = await page.evaluate(() => [...document.querySelectorAll('[data-palette-section]')]
    .map((el) => (el.querySelector('.truncate')?.textContent || '').trim())
    .filter(Boolean));
  check(`${vp.name} left rail order`, rail.join(',') === 'Block,Build,Shape,Polish,Move', rail.join(','));

  await snapFront(page);
  await page.locator('[data-analyze-chip]').click();
  const shell = vp.touch ? '[data-fea-sheet="1"]' : '[data-fea-mode="1"]';
  await page.locator(shell).waitFor({ timeout: 8000 });
  check(`${vp.name} analyze open`, true);
  check(
    `${vp.name} paint stays closed`,
    await page.locator('[data-paint-mode]').count() === 0,
  );
  check(
    `${vp.name} inspection group`,
    await page.locator('[data-selector-group="inspection"]').count() === 1,
  );

  await page.locator('[data-fea-material]').selectOption('pla-ultimaker');
  await page.locator('[data-fea-assumed="nu"]').waitFor({ timeout: 8000 });
  await solidReady(page);

  const face = await facePoints(page);
  check(`${vp.name} front face is tappable`, face.length > 0, `points=${face.length}`);
  await page.locator('[data-fea-target="fixture"]').click();
  const fixed = await tapUntil(page, vp.touch, face, 'data-fea-fixture-count', '1');
  check(`${vp.name} fixture on a face`, fixed.ok, JSON.stringify(fixed));

  await page.locator('[data-fea-target="force"]').click();
  const loaded = await tapUntil(page, vp.touch, face, 'data-fea-load-count', '1');
  check(`${vp.name} force on a face`, loaded.ok, JSON.stringify(loaded));

  await page.locator('[data-fea-run]').click();
  await page.locator('[data-fea-summary]').waitFor({ timeout: 30000 });
  const summary = await page.evaluate(() => ({
    stubs: document.querySelectorAll('[data-fea-stub="1"]').length,
    stress: document.querySelector('[data-fea-stress]')?.textContent || '',
    fos: document.querySelector('[data-fea-fos]')?.getAttribute('data-fea-fos') || '',
    warning: document.querySelector('[data-fea-warning]')?.textContent || '',
  }));
  check(`${vp.name} stub badge`, summary.stubs >= 1, JSON.stringify(summary));
  check(`${vp.name} stress summary`, /min .+ MPa/.test(summary.stress) && /p95 /.test(summary.stress) && /max /.test(summary.stress), summary.stress);
  check(`${vp.name} safety factor`, summary.fos !== '' && summary.fos !== 'n/a', summary.fos);
  check(`${vp.name} stub warning`, /STUB, not a real result/.test(summary.warning), summary.warning);

  const shot = join(SHOT_DIR, vp.touch ? 'fea-study-390.png' : 'fea-study-desktop.png');
  check(`${vp.name} shot dir`, !shot.startsWith('/opt/cursor/artifacts'), shot);
  await page.screenshot({ path: shot });
  check(`${vp.name} shot saved`, existsSync(shot), shot);
  console.log(`  shot ${shot}`);

  const notice = (await noticeOf(page) || '').trim();
  check(`${vp.name} study write accepted`, notice === '', notice);
  const drawerOpen = await page.locator('[data-script-editor-open="true"]').count();
  check(`${vp.name} script drawer stays closed`, drawerOpen === 0, `open=${drawerOpen}`);
  await page.waitForTimeout(200);
  const scripts = await readStudyScripts(page);
  const stored = scripts.find((script) => script.includes('// @fea-study ') && script.includes('pla-ultimaker'));
  check(`${vp.name} study stored`, !!stored, scripts.map((script) => script.slice(0, 80)).join(' | '));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 40000 });
  await solidReady(page);
  await page.locator('[data-analyze-chip]').click();
  await page.locator(shell).waitFor({ timeout: 8000 });
  const again = await page.evaluate(() => ({
    material: document.querySelector('[data-fea-material]')?.value || '',
    fixtures: document.querySelector('[data-fea-fixture-count]')?.getAttribute('data-fea-fixture-count') || '',
    loads: document.querySelector('[data-fea-load-count]')?.getAttribute('data-fea-load-count') || '',
    result: document.querySelector('[data-fea-summary]') ? 'present' : 'absent',
  }));
  check(`${vp.name} material persisted`, again.material === 'pla-ultimaker', JSON.stringify(again));
  check(`${vp.name} fixture persisted`, again.fixtures === '1', JSON.stringify(again));
  check(`${vp.name} load persisted`, again.loads === '1', JSON.stringify(again));
  check(`${vp.name} result not in the script`, again.result === 'absent');
  check(`${vp.name} no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

const viewArg = process.env.FEA_VIEW || '';
const viewports = [
  { name: '390', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1280, height: 800, touch: false },
].filter((vp) => !viewArg || vp.name === viewArg);

let browser;
try {
  if (!await waitForServer()) {
    check('server started', false, `no response on ${APP_URL}`);
    process.exit(1);
  }
  check('server started', true);
  browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  for (const vp of viewports) {
    console.log(` ${vp.name}`);
    await runCase(browser, vp);
  }
} finally {
  if (browser) await browser.close();
  stop();
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nFEA study panel: ok');
