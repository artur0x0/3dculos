#!/usr/bin/env node
/**
 * Does the app actually render? The one check every other golden cannot make.
 *
 * Text-matching goldens and `npm run build` both passed on the change that
 * shipped a white page (a hook dependency array reading a `const` from the
 * temporal dead zone — see golden:hook-dep-tdz). Nothing here parsed the source;
 * it needs a real browser executing the real bundle.
 *
 * Runs `vite preview` over a production build and drives it with playwright-core
 * against the SYSTEM Chrome, so CI/dev machines download no browser. Set
 * CHROME_PATH to override the executable.
 *
 * Fails on: a blank root, any uncaught page error, or a console error. The app
 * boots WebGL and a Manifold wasm worker, so genuinely-optional noise is
 * allowlisted below rather than ignored wholesale — keep that list short and
 * specific, or this test stops meaning anything.
 */
/* The `page.evaluate` callbacks below are serialised and run INSIDE the
   browser, where `document` exists — eslint lints this file as Node. */
/* global document */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT || 4317);
const APP_URL = `http://localhost:${PORT}/`;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

/** Noise the app legitimately produces; anything else fails the run. */
const ALLOWED = [
  /favicon/i,
  /Failed to load resource.*404.*favicon/i,
  /WebGL|WEBGL|GPU stall|Automatic fallback to software WebGL/i,
  /\[APP\]|\[App\]/,
];

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.log('app loads: no system Chrome found — set CHROME_PATH. Skipping.');
  process.exit(0);
}

console.log('app loads in a real browser');

if (!existsSync(new URL('../../dist/index.html', import.meta.url))) {
  console.log('  ❌ dist/ missing — run `npm run build` first');
  process.exit(1);
}

// `detached` puts vite in its own process GROUP. Killing the npx wrapper alone
// leaves the real server holding the port, which then fails every later run
// with "Port already in use" — so signal the whole group instead.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
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

async function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(APP_URL);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let browser;
try {
  if (!await waitForServer()) {
    check('preview server started', false, `no response on ${APP_URL}`);
    process.exit(1);
  }

  browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ALLOWED.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });

  await page.goto(APP_URL, { waitUntil: 'load', timeout: 45000 });

  // The blank screen was React bailing out: #root existed but stayed empty.
  await page.waitForFunction(
    () => document.querySelector('#root')?.children.length > 0,
    null,
    { timeout: 20000 },
  ).catch(() => {});

  const rootChildren = await page.evaluate(
    () => document.querySelector('#root')?.children.length ?? 0,
  );
  check('#root has rendered children (not a blank screen)', rootChildren > 0,
    `#root child count = ${rootChildren}`);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no unexpected console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));

  // Real chrome, not just any DOM: the editor pane and the viewport canvas.
  const canvas = await page.locator('canvas').count();
  check('the 3D canvas mounted', canvas > 0);
  const strip = await page.locator('[data-toolbar-variant="strip"]').count();
  check('the CAD toolbar strip mounted', strip > 0);
  const run = await page.locator('[data-cad-run]').count();
  check('the Run button is present', run > 0);
} catch (err) {
  check('the page loaded', false, String(err && err.message ? err.message : err));
} finally {
  if (browser) await browser.close().catch(() => {});
  stop();
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nApp renders.');
