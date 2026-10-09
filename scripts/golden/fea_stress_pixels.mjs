#!/usr/bin/env node
/**
 * Stress skin and legend. After Run the part is viridis (or magenta past
 * yield), the legend is on screen, an edit marks Re-run and drops the
 * colours, and closing Analyze puts the paint skin back.
 *
 * 390×844 touch (iPhone UA, DPR 2) and 1280×800 desktop. FEA_VIEW=desktop
 * or FEA_VIEW=390 runs one of them.
 *
 * Screenshots go to GOLDEN_SHOT_DIR or os.tmpdir() only.
 */
/* global document, indexedDB, localStorage, window */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { stressColor } from '../../src/fea/colormap.js';

const PORT = Number(process.env.SMOKE_PORT || 4333);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SHOT_DIR = process.env.GOLDEN_SHOT_DIR || tmpdir();
const SURF = '2026-10-09-04-24-00-0001-ab12';
const CUBE = `// @surf-id ${SURF}\nconst part = Manifold.cube([20, 20, 20], true);\nreturn part;\n`;
const WIDE = `// @surf-id ${SURF}\nconst part = Manifold.cube([40, 20, 20], true);\nreturn part;\n`;
const PART_ID = 'fea-block';
const USER_ID = 'user-fea';
// 1000 N on the 400 mm² face. Front corners sit near 35 MPa; p95 is the far
// corners, just above PLA yield, so the front face stays on the viridis ramp.
const FRONT = stressColor(35, { p95: 61, yield_MPa: 52.5 }).map((c) => Math.round(c * 255));

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

console.log('FEA stress skin');

const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.log('FEA stress skin: no system Chrome — set CHROME_PATH. Skipping.');
  process.exit(0);
}

if (String(SHOT_DIR).startsWith('/opt/cursor/artifacts')) {
  console.log(`  ❌ screenshots must not use /opt/cursor/artifacts (${SHOT_DIR})`);
  process.exit(1);
}

mkdirSync(SHOT_DIR, { recursive: true });

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
  await page.evaluate(async ({ script, partId, userId, surf }) => {
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
          parts: [{ id: partId, name: 'Block', visible: true, order: 0, surfId: surf }],
          colors: { [surf]: { part: '#ef4444' } },
        }, 'current');
        tx.objectStore('parts').put({ id: partId, script, savedAt: Date.now() }, partId);
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
  }, { script: CUBE, partId: PART_ID, userId: USER_ID, surf: SURF });
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
  const marker = `${JSON.stringify({ kind: 'surfcad-vault', version: 1 }, null, 2)}\n`;
  await page.route('https://api.github.com/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (status, body) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (path === '/user') return send(200, { login: 'fea-user' });
    if (path === '/repos/fea-user/surfcad-vault') {
      return send(200, {
        name: 'surfcad-vault',
        private: true,
        size: 1,
        default_branch: 'main',
        owner: { login: 'fea-user' },
      });
    }
    if (path === '/repos/fea-user/surfcad-vault/branches/main') {
      return send(200, { name: 'main', commit: { sha: 'a'.repeat(40) } });
    }
    if (path.startsWith('/repos/fea-user/surfcad-vault/contents/surfcad.json')) {
      return send(200, { type: 'file', encoding: 'utf-8', content: marker, sha: 'b'.repeat(40) });
    }
    return send(404, { message: 'not found' });
  });
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

async function sampleCenter(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const { canvas, renderer } = window.__feaProbe.bits();
    if (!canvas || !renderer) {
      resolve(null);
      return;
    }
    const orig = renderer.render.bind(renderer);
    renderer.render = function hooked(scene, camera) {
      const out = orig(scene, camera);
      renderer.render = orig;
      const gl = renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const x0 = Math.floor(w * 0.38);
      const x1 = Math.floor(w * 0.62);
      const y0 = Math.floor(h * 0.38);
      const y1 = Math.floor(h * 0.62);
      let model = 0;
      let red = 0;
      let stress = 0;
      const paint = [239, 68, 68];
      const teal = window.__feaExpected;
      const slack = 180;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * w + x) * 4;
          const rgb = [buf[i], buf[i + 1], buf[i + 2]];
          if (rgb[0] < 45 && rgb[1] < 45 && rgb[2] < 45) continue;
          model += 1;
          const redD = Math.abs(rgb[0] - paint[0]) + Math.abs(rgb[1] - paint[1]) + Math.abs(rgb[2] - paint[2]);
          const stressD = Math.abs(rgb[0] - teal[0]) + Math.abs(rgb[1] - teal[1]) + Math.abs(rgb[2] - teal[2]);
          if (redD <= slack) red += 1;
          if (stressD <= slack) stress += 1;
        }
      }
      resolve({ model, red, stress });
      return out;
    };
  }));
}

async function readColors(page) {
  await page.evaluate((expected) => { window.__feaExpected = expected; }, FRONT);
  const colors = await sampleCenter(page);
  return colors;
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
      for (let y = 4; y < h - 4; y += 4) {
        for (let x = 4; x < w - 4; x += 4) {
          const i = (y * w + x) * 4;
          const r = buf[i];
          const g = buf[i + 1];
          const b = buf[i + 2];
          if (r < 140 || g > 140 || b > 140) continue;
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
      const step = Math.max(1, Math.floor(pts.length / 6));
      for (let i = step >> 1; i < pts.length && picks.length < 6; i += step) picks.push(pts[i]);
      resolve(picks);
      return out;
    };
  }));
}

async function tap(page, touch, point) {
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function tapUntil(page, touch, points, attr, expected) {
  for (const point of points) {
    await tap(page, touch, point);
    await page.waitForTimeout(500);
    const count = await page.locator(`[${attr}]`).getAttribute(attr).catch(() => null);
    if (count === expected) return true;
  }
  return false;
}

async function legendBox(page) {
  return page.locator('[data-fea-legend]').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  });
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
  await snapFront(page);

  const painted = await readColors(page);
  check(
    `${vp.name} paint skin is red`,
    !!painted && painted.model > 20 && painted.red > painted.model * 0.45,
    JSON.stringify(painted),
  );

  await page.locator('[data-analyze-chip]').click();
  const shell = vp.touch ? '[data-fea-sheet="1"]' : '[data-fea-mode="1"]';
  await page.locator(shell).waitFor({ timeout: 8000 });
  await page.locator('[data-fea-material]').selectOption('pla-ultimaker');
  await solidReady(page);
  const face = await facePoints(page);
  check(`${vp.name} front face is tappable`, face.length > 0, `points=${face.length}`);
  await page.locator('[data-fea-target="fixture"]').click();
  check(`${vp.name} fixture`, await tapUntil(page, vp.touch, face, 'data-fea-fixture-count', '1'));
  await page.locator('[data-fea-target="force"]').click();
  await page.locator('[data-popup-number="fea-force"]').fill('1000');
  check(`${vp.name} force`, await tapUntil(page, vp.touch, face, 'data-fea-load-count', '1'));

  await page.locator('[data-fea-run]').click();
  await page.locator('[data-fea-legend]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  const legend = await page.evaluate(() => ({
    stub: document.querySelector('[data-fea-legend] [data-fea-stub="1"]') ? 'yes' : 'no',
    stress: document.querySelector('[data-fea-stress]')?.textContent || '',
    fos: document.querySelector('[data-fea-fos]')?.getAttribute('data-fea-fos') || '',
    warning: document.querySelector('[data-fea-warning]')?.textContent || '',
    ticks: document.querySelector('[data-fea-legend-ticks]')?.textContent || '',
    bar: document.querySelector('[data-fea-legend-bar]')?.style?.backgroundImage || document.querySelector('[data-fea-legend-bar]')?.style?.background || '',
    stale: document.querySelector('[data-fea-stale]')?.getAttribute('data-fea-stale') || '',
  }));
  check(`${vp.name} stub badge`, legend.stub === 'yes', JSON.stringify(legend));
  check(`${vp.name} legend ticks`, (legend.ticks.match(/\d/g) || []).length >= 5, legend.ticks);
  check(`${vp.name} legend gradient`, /linear-gradient/.test(legend.bar), legend.bar.slice(0, 80));
  check(`${vp.name} min p95 max`, /min .+ MPa/.test(legend.stress) && /p95 /.test(legend.stress) && /max /.test(legend.stress), legend.stress);
  check(`${vp.name} safety factor`, legend.fos !== '' && legend.fos !== 'n/a', legend.fos);
  check(`${vp.name} stub warning`, /STUB, not a real result/.test(legend.warning), legend.warning);
  check(`${vp.name} result is current`, legend.stale === '0', legend.stale);

  const box = await legendBox(page);
  check(
    `${vp.name} legend fits`,
    box.width > 40 && box.height > 20 && box.x >= -1 && box.y >= -1 && box.right <= vp.width + 1 && box.bottom <= vp.height + 1,
    JSON.stringify(box),
  );

  const stressed = await readColors(page);
  check(
    `${vp.name} stress colours replace paint`,
    !!stressed && stressed.stress > stressed.model * 0.45 && stressed.red < stressed.model * 0.2,
    JSON.stringify({ stressed, expected: FRONT }),
  );

  const shot = join(SHOT_DIR, vp.touch ? 'fea-stress-390.png' : 'fea-stress-desktop.png');
  check(`${vp.name} shot dir`, !shot.startsWith('/opt/cursor/artifacts'), shot);
  await page.screenshot({ path: shot });
  check(`${vp.name} shot saved`, existsSync(shot), shot);
  console.log(`  shot ${shot}`);

  await page.locator('[data-paint-chip]').click();
  await page.locator('[data-paint-mode="1"]').waitFor({ timeout: 8000 });
  check(`${vp.name} paint closes analyze`, await page.locator(shell).count() === 0);
  await page.waitForTimeout(300);
  const paintedAgain = await readColors(page);
  check(
    `${vp.name} opening paint restores the skin`,
    !!paintedAgain && paintedAgain.red > paintedAgain.model * 0.45 && paintedAgain.stress < paintedAgain.model * 0.2,
    JSON.stringify(paintedAgain),
  );
  await page.locator('[data-paint-dismiss]').click();
  await page.locator('[data-paint-mode="1"]').waitFor({ state: 'detached', timeout: 8000 });

  await page.locator('[data-analyze-chip]').click();
  await page.locator(shell).waitFor({ timeout: 8000 });
  await page.locator('[data-fea-run]').click();
  await page.locator('[data-fea-stale="0"]').waitFor({ timeout: 30000 });
  const edited = await page.evaluate(async (script) => {
    if (typeof window.__VIEWPORT__?.executeScript !== 'function') return { skipped: true };
    return window.__VIEWPORT__.executeScript(script);
  }, WIDE);
  if (!edited?.skipped && !edited?.error && edited?.onScreen) {
    await page.locator('[data-fea-rerun]').waitFor({ timeout: 15000 });
    check(`${vp.name} geometry edit is stale`, true);
  } else {
    await page.locator('[data-fea-material]').selectOption('al-6061-t6');
    await page.locator('[data-fea-rerun]').waitFor({ timeout: 8000 });
    check(`${vp.name} material edit is stale`, true, JSON.stringify(edited));
  }
  await page.waitForTimeout(300);
  const staleColors = await readColors(page);
  check(
    `${vp.name} stale colours are not shown`,
    !!staleColors && staleColors.stress < staleColors.model * 0.2 && staleColors.red > staleColors.model * 0.35,
    JSON.stringify(staleColors),
  );
  check(`${vp.name} analyze still open`, await page.locator(shell).count() === 1);

  await page.locator('[data-fea-dismiss]').click();
  await page.locator(shell).waitFor({ state: 'detached', timeout: 8000 });
  await page.waitForTimeout(300);
  const closed = await readColors(page);
  check(
    `${vp.name} close keeps the paint skin`,
    !!closed && closed.red > closed.model * 0.35,
    JSON.stringify(closed),
  );
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
console.log('\nFEA stress skin: ok');
