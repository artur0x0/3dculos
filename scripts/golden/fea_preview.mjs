#!/usr/bin/env node
/**
 * Voxel stress preview golden.
 *
 * CI does not start Chrome with WebGPU, so this script exits 0 unless
 * FEA_PREVIEW_GOLDEN=1. The kernels are checked by the JS reference
 * (src/fea/preview/*.test.js) on every unit run. With the flag set, Chrome
 * is launched with --enable-unsafe-webgpu. If that Chrome has no adapter,
 * the script reports the skip and exits 0. Screenshots go to
 * GOLDEN_SHOT_DIR or os.tmpdir(), never /opt/cursor/artifacts.
 */
/* global document, indexedDB, localStorage, navigator, Event, PointerEvent */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { feaStudyBlock } from '../../src/fea/studyScript.js';

if (process.env.FEA_PREVIEW_GOLDEN !== '1') {
  console.log('FEA preview golden: skipped.');
  console.log('  Set FEA_PREVIEW_GOLDEN=1 to drive the sliders in headless Chrome with WebGPU.');
  console.log('  CI does not pass that flag. The JS reference tests cover the hex kernels,');
  console.log('  multigrid residual drop, warm start, and the TET10 p95 comparison.');
  process.exit(0);
}

const PORT = Number(process.env.SMOKE_PORT || 4333);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SHOT_DIR = process.env.GOLDEN_SHOT_DIR || tmpdir();
const STUDY = feaStudyBlock({
  mesh: { target: 4 },
  material: { id: 'pla-ultimaker' },
  fixtures: [{
    kind: 'fixed',
    faces: [{ faceID: 1, at: [0, 5, 5], n: [-1, 0, 0], area: 100 }],
  }],
  loads: [{
    kind: 'force',
    vector: [0, 0, -200],
    faces: [{ faceID: 2, at: [40, 5, 5], n: [1, 0, 0], area: 100 }],
  }],
});
const CUBE = `const part = Manifold.cube([40, 10, 10], false);\nreturn part;\n${STUDY}`;
const PART_ID = 'fea-preview-block';
const USER_ID = 'user-fea-preview';

if (String(SHOT_DIR).startsWith('/opt/cursor/artifacts')) {
  console.log(`screenshots must not use /opt/cursor/artifacts (${SHOT_DIR})`);
  process.exit(1);
}
mkdirSync(SHOT_DIR, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);
const exe = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!exe) {
  console.log('FEA preview golden: no system Chrome. Skipping.');
  process.exit(0);
}

const CHROME_ARGS = [
  '--no-sandbox',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
];

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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

async function waitForServer(timeoutMs = 40000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(APP_URL);
      if (res.ok) return true;
    } catch { /* not up */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function adapterName(browser) {
  const page = await browser.newPage();
  // about:blank is not a secure context, so navigator.gpu is missing there
  // even when this Chrome can create a software adapter on localhost.
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const name = await page.evaluate(async () => {
    if (!navigator.gpu) return '';
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return '';
    const info = adapter.info || {};
    return info.description || info.vendor || info.architecture || 'webgpu';
  });
  await page.close();
  return name;
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
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['assembly', 'parts'], 'readwrite');
        tx.objectStore('assembly').put({
          version: 1,
          source: 'git',
          name: 'Preview',
          activeId: partId,
          parts: [{ id: partId, name: 'Block', visible: true, order: 0 }],
        }, 'current');
        tx.objectStore('parts').put({ id: partId, script, savedAt: Date.now() }, partId);
        localStorage.setItem('surfcad.github.tokenBundle', JSON.stringify({
          accessToken: 'ghu_fea_preview',
          refreshToken: '',
          expiresAt: Date.now() + 86_400_000,
          refreshExpiresAt: 0,
        }));
        localStorage.setItem('surfcad.lastAssembly', JSON.stringify({
          [userId]: { name: 'Preview', activeId: partId, source: 'git', savedAt: Date.now() },
        }));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
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
      user: { id: USER_ID, email: 'fea-preview@surfcad.test', vaultName: null },
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
  page.on('pageerror', (err) => errors.push(String(err).slice(0, 300)));
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('canvas', { timeout: 40000 });
  return errors;
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
  const gpuErrors = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('Invalid CommandBuffer') || text.includes('WGSL') || text.includes('synchronization scope')) {
      gpuErrors.push(text.slice(0, 180));
    }
  });
  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 40000 });
  await page.waitForFunction(() => {
    const solids = document.querySelector('[data-assembly-solids]')?.getAttribute('data-assembly-solids');
    const spinner = document.querySelector('[data-assembly-open-spinner]');
    return solids === '1' && !spinner;
  }, null, { timeout: 40000 });
  await page.locator('[data-analyze-chip]').click();
  const shell = vp.touch ? '[data-fea-sheet="1"]' : '[data-fea-mode="1"]';
  await page.locator(shell).waitFor({ timeout: 8000 });
  const sliders = await page.locator('[data-fea-preview-sliders]').waitFor({ timeout: 8000 }).then(() => 1).catch(() => 0);
  if (sliders !== 1) {
    const debug = await page.evaluate(async () => {
      const scripts = await new Promise((resolve) => {
        const req = indexedDB.open('surfcad-assembly', 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['assembly', 'parts'], 'readonly');
          const out = { doc: null, parts: [] };
          tx.objectStore('assembly').get('current').onsuccess = (ev) => { out.doc = ev.target.result; };
          tx.objectStore('parts').getAll().onsuccess = (ev) => { out.parts = ev.target.result; };
          tx.oncomplete = () => { db.close(); resolve(out); };
        };
        req.onerror = () => resolve({ error: 'idb' });
      });
      return {
        solids: document.querySelector('[data-assembly-solids]')?.getAttribute('data-assembly-solids') || '',
        mode: document.querySelector('[data-fea-mode]')?.getAttribute('data-fea-mode') || '',
        sheet: document.querySelector('[data-fea-sheet]')?.getAttribute('data-fea-sheet') || '',
        analyze: document.querySelector('[data-analyze-chip-state]')?.getAttribute('data-analyze-chip-state') || '',
        doc: scripts.doc,
        parts: (scripts.parts || []).map((part) => ({
          id: part.id,
          script: String(part.script || '').slice(0, 500),
        })),
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
      };
    });
    console.log(`  debug ${vp.name}`, JSON.stringify(debug));
  }
  check(`${vp.name} preview sliders`, sliders === 1, 'hidden — probe failed or the study has no force');
  if (sliders === 1) {
    const slider = page.locator('[data-fea-preview-slider="magnitude"]');
    await slider.evaluate((el) => {
      el.value = String(Math.min(Number(el.max), Number(el.value) + 80));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.locator('[data-fea-preview-badge]').waitFor({ timeout: 90000 });
    const badge = await page.evaluate(() => ({
      source: document.querySelector('[data-fea-source]')?.getAttribute('data-fea-source') || '',
      fosFrom: document.querySelector('[data-fea-fos-from]')?.getAttribute('data-fea-fos-from') || '',
      fos: document.querySelector('[data-fea-fos]')?.getAttribute('data-fea-fos') || '',
      ms: document.querySelector('[data-fea-preview-ms]')?.getAttribute('data-fea-preview-ms') || '',
      bytes: document.querySelector('[data-fea-preview-bytes]')?.getAttribute('data-fea-preview-bytes') || '',
      res: document.querySelector('[data-fea-preview-res]')?.getAttribute('data-fea-preview-res') || '',
      stub: document.querySelector('[data-fea-stub="1"]') ? 'yes' : 'no',
    }));
    console.log(`  preview ${vp.name} ${badge.ms} ms ${badge.bytes} bytes res ${badge.res}`);
    check(`${vp.name} preview source`, badge.source === 'preview', badge.source);
    check(`${vp.name} fos is not a preview factor`, badge.fosFrom === 'none' || badge.fos === 'n/a', JSON.stringify(badge));
    check(`${vp.name} no stub badge`, badge.stub === 'no');
    check(`${vp.name} latency recorded`, Number(badge.ms) >= 0, badge.ms);
    check(`${vp.name} gpu bytes recorded`, Number(badge.bytes) > 0, badge.bytes);
  }
  const shot = join(SHOT_DIR, vp.touch ? 'fea-preview-390.png' : 'fea-preview-1280.png');
  await page.screenshot({ path: shot });
  check(`${vp.name} shot saved`, existsSync(shot), shot);
  console.log(`  shot ${shot}`);
  check(`${vp.name} gpu passes`, gpuErrors.length === 0, gpuErrors.slice(0, 2).join(' | '));
  check(`${vp.name} no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

let browser;
try {
  if (!await waitForServer()) {
    check('server started', false);
    process.exit(1);
  }
  browser = await chromium.launch({ executablePath: exe, args: CHROME_ARGS });
  const adapter = await adapterName(browser);
  if (!adapter) {
    console.log('FEA preview golden: Chrome has no WebGPU adapter. Skipping the slider pass.');
    console.log('  Kernels stay covered by the JS reference tests.');
    process.exit(0);
  }
  console.log(`FEA preview golden: adapter ${adapter}`);
  const view = process.env.FEA_VIEW || '';
  const viewports = [
    { name: '390', width: 390, height: 844, touch: true },
    { name: '1280', width: 1280, height: 800, touch: false },
  ].filter((vp) => !view || vp.name === view);
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
console.log('\nFEA preview golden: ok');
