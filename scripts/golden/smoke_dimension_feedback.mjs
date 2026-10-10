#!/usr/bin/env node
/**
 * Dimension and Constrain feedback at 390px and 1280px.
 *
 * Extension lines start on both picked dots. Arrow tips meet the extension
 * lines. Add keeps the card open and a second dimension can be placed.
 * Reopening a tag shows red Delete and Confirm. The dimension card slides
 * the part up. The sketch-plane square is absent. A Constrain tap on a
 * line and on a point both register.
 *
 * Screenshots go to GOLDEN_SHOT_DIR or os.tmpdir(), never the artifacts dir.
 */
/* global document, window */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT || 5245);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SHOT_DIR = process.env.GOLDEN_SHOT_DIR || tmpdir();
const SCRIPT = 'return Manifold.cube([40, 30, 20], true);\n';
const CORNERS = [
  [-20, -15, -10], [20, -15, -10], [-20, 15, -10], [20, 15, -10],
  [-20, -15, 10], [20, -15, 10], [-20, 15, 10], [20, 15, 10],
];

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

console.log('dimension feedback');
mkdirSync(SHOT_DIR, { recursive: true });
check('shot dir is not the artifacts folder', !String(SHOT_DIR).startsWith('/opt/cursor/artifacts'), SHOT_DIR);

const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.log('dimension feedback: no system Chrome — set CHROME_PATH');
  process.exit(1);
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

async function boot(page) {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: false }),
  }));
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.viewport-shell > canvas');
    return !!(canvas && canvas.clientWidth > 0 && window.__VIEWPORT__?.ready?.() && window.__MANIFOLD_CONTEXT__?.isReady);
  }, null, { timeout: 90000 });
  const ran = await page.evaluate(async (src) => window.__VIEWPORT__.executeScript(src), SCRIPT);
  if (ran?.error) throw new Error(ran.error);
  await page.waitForFunction(() => (window.__VIEWPORT__.stageVerifyFraming?.().tris || 0) > 10, null, { timeout: 30000 });
  await page.evaluate(() => window.__VIEWPORT__.stageFit({ az: 28, el: 18, margin: 1.02 }));
  await page.waitForTimeout(200);
}

async function lowestNdc(page) {
  return page.evaluate((pts) => {
    const canvas = document.querySelector('.viewport-shell > canvas');
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return null;
    let low = Infinity;
    for (const w of pts) {
      const p = window.__VIEWPORT__.stageProject(w);
      if (!p) return null;
      const v = 1 - ((p.y - rect.top) / rect.height) * 2;
      if (v < low) low = v;
    }
    return Number.isFinite(low) ? low : null;
  }, CORNERS);
}

async function chooseTriangle(page) {
  const sets = [
    [[-8, -6, 10], [8, -6, 10], [0, 8, 10]],
    [[-8, 6, 10], [8, 6, 10], [0, -8, 10]],
    [[-10, 8, 10], [10, 8, 10], [0, -4, 10]],
  ];
  const view = await page.evaluate((candidates) => {
    const canvas = document.querySelector('canvas').getBoundingClientRect();
    return {
      top: canvas.top,
      height: canvas.height,
      scored: candidates.map((pts) => ({
        pts,
        projected: pts.map((p) => window.__VIEWPORT__.stageProject(p)),
      })),
    };
  }, sets);
  const usable = view.scored.filter((row) => row.projected.every(Boolean));
  const upper = usable.filter((row) => {
    const midY = row.projected.reduce((sum, p) => sum + p.y, 0) / row.projected.length;
    return midY < view.top + view.height * 0.42;
  });
  const pool = upper.length ? upper : usable;
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const span = (row) => {
      const xs = row.projected.map((p) => p.x);
      const ys = row.projected.map((p) => p.y);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    };
    return span(b) - span(a);
  });
  return pool[0].pts;
}

async function addPoint(page, world, n) {
  const at = await page.evaluate((p) => window.__VIEWPORT__.stageProject(p), world);
  if (!at) throw new Error(`point off screen ${world.join(',')}`);
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction((count) => window.__VIEWPORT__.stageContourSketch().points >= count, n, { timeout: 4000 });
}

async function anchorProbe(page) {
  let last = null;
  const started = Date.now();
  while (Date.now() - started < 4000) {
    last = await page.evaluate(() => {
      const sketch = window.__VIEWPORT__.stageContourSketch();
      const picked = (sketch.picked || []).filter((p) => p.kind === 'point');
      const dots = (sketch.dots || []).filter((d) => picked.some((p) => p.id === d.id));
      const exts = [...document.querySelectorAll('[data-contour-dim-ext]')].map((el) => ({
        x1: Number(el.getAttribute('x1')),
        y1: Number(el.getAttribute('y1')),
        x2: Number(el.getAttribute('x2')),
        y2: Number(el.getAttribute('y2')),
      }));
      const gaps = dots.map((dot) => {
        let best = Infinity;
        for (const ext of exts) {
          best = Math.min(best, Math.hypot(dot.x - ext.x1, dot.y - ext.y1));
        }
        return best;
      });
      const tips = [...document.querySelectorAll('[data-contour-dim-arrow]')].map((el) => {
        const pair = (el.getAttribute('points') || '').trim().split(/\s+/)[0] || '0,0';
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
      });
      const tipGaps = tips.map((tip) => {
        let best = Infinity;
        for (const ext of exts) {
          const dx = ext.x2 - ext.x1;
          const dy = ext.y2 - ext.y1;
          const L2 = dx * dx + dy * dy;
          let t = L2 > 1e-6 ? ((tip.x - ext.x1) * dx + (tip.y - ext.y1) * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          best = Math.min(best, Math.hypot(tip.x - (ext.x1 + t * dx), tip.y - (ext.y1 + t * dy)));
        }
        return best;
      });
      return {
        gaps,
        tipGaps,
        picked: sketch.picked,
        highlights: sketch.pickHighlights,
        planeSquare: sketch.planeSquare,
        dimensions: sketch.dimensions,
        dots: dots.length,
        exts: exts.length,
      };
    });
    const tipsOk = last && last.tipGaps.length >= 2 && last.tipGaps.every((n) => n < 2);
    const anchored = last && last.gaps.length === 2 && last.gaps.every((n) => n < 3);
    if (anchored && tipsOk) return last;
    await page.waitForTimeout(40);
  }
  return last;
}

async function clickDot(page, index) {
  const at = await page.evaluate((i) => {
    const dots = window.__VIEWPORT__.stageContourSketch().dots || [];
    return dots[i] || null;
  }, index);
  if (!at) throw new Error(`no dot ${index}`);
  await page.mouse.click(at.x, at.y);
}

async function runViewport(page, width) {
  console.log(`\nviewport ${width}`);
  await boot(page);
  await page.locator('button[aria-label^="Insert Create contour"]').click();
  await page.locator('[data-contour-chip]').waitFor({ timeout: 8000 });
  const planeSquare = await page.evaluate(() => window.__VIEWPORT__.stageContourSketch().planeSquare);
  check(`${width} no sketch-plane square on the plane card`, planeSquare === false, String(planeSquare));
  await page.locator('[data-contour-tool="polyline"]').click();
  await page.locator('[data-feature-card-confirm]').click();
  await page.waitForFunction(() => (
    document.querySelector('.viewport-shell')?.getAttribute('data-contour-face-aim') === 'done'
    && !document.querySelector('[data-contour-chip]')
  ), null, { timeout: 8000 });
  const afterAim = await page.evaluate(() => window.__VIEWPORT__.stageContourSketch().planeSquare);
  check(`${width} no sketch-plane square after Start drawing`, afterAim === false, String(afterAim));

  const pts = await chooseTriangle(page);
  check(`${width} triangle is on the upper canvas`, Array.isArray(pts) && pts.length === 3, JSON.stringify(pts));
  if (!pts) return;
  await addPoint(page, pts[0], 1);
  await addPoint(page, pts[1], 2);
  await addPoint(page, pts[2], 3);

  const before = await lowestNdc(page);
  const beforeCam = await page.evaluate(() => window.__VIEWPORT__.stageCamera());
  await page.locator('[data-contour-tool="dimension"]').click();
  await page.locator('[data-contour-card="dimension"]').waitFor({ timeout: 4000 });
  await page.waitForTimeout(500);
  const after = await lowestNdc(page);
  const afterCam = await page.evaluate(() => window.__VIEWPORT__.stageCamera());
  const lifted = after != null && before != null ? after - before : null;
  const moved = beforeCam && afterCam
    ? Math.hypot(
      afterCam.position[0] - beforeCam.position[0],
      afterCam.position[1] - beforeCam.position[1],
      afterCam.position[2] - beforeCam.position[2],
    )
    : null;
  console.log(`  ${width} slide before ${before?.toFixed?.(3)} after ${after?.toFixed?.(3)} lifted ${lifted?.toFixed?.(3)} moved ${moved?.toFixed?.(3)}`);
  check(`${width} dimension card slides the part up`, lifted != null && lifted >= 0.04 && moved > 0.5, `lifted ${lifted} moved ${moved}`);

  await clickDot(page, 0);
  await clickDot(page, 1);
  const anchored = await anchorProbe(page);
  const highlightIds = anchored?.highlights?.points || [];
  const pickedIds = (anchored?.picked || []).filter((p) => p.kind === 'point').map((p) => p.id);
  check(`${width} both picks stay highlighted`, pickedIds.length === 2 && pickedIds.every((id) => highlightIds.includes(id)), JSON.stringify(anchored));
  check(`${width} extension lines sit on both dots`, anchored?.gaps?.length === 2 && anchored.gaps.every((n) => n < 3), JSON.stringify(anchored?.gaps));
  check(`${width} arrow tips land on the extension lines`, anchored?.tipGaps?.length >= 2 && anchored.tipGaps.every((n) => n < 2), JSON.stringify(anchored?.tipGaps));
  await page.screenshot({ path: join(SHOT_DIR, `dimension-feedback-${width}.png`) });

  const add = page.locator('[data-feature-card-confirm]');
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-feature-card-confirm]');
    return btn && !btn.disabled && /Add/.test(btn.textContent || '');
  }, null, { timeout: 4000 });
  await add.click();
  await page.waitForFunction(() => {
    const sketch = window.__VIEWPORT__.stageContourSketch();
    const card = document.querySelector('[data-contour-card="dimension"]');
    return sketch.dimensions === 1 && sketch.picked.length === 0 && card?.getAttribute('data-contour-dimension-mode') === 'add';
  }, null, { timeout: 4000 });
  const afterAdd = await page.evaluate(() => window.__VIEWPORT__.stageContourSketch());
  check(`${width} Add keeps the card open`, afterAdd.dimensions === 1 && afterAdd.picked.length === 0 && afterAdd.gesture === 'dimension', JSON.stringify({
    dimensions: afterAdd.dimensions,
    picked: afterAdd.picked,
    gesture: afterAdd.gesture,
  }));
  check(`${width} highlights clear when the dimension is accepted`, (afterAdd.pickHighlights?.points || []).length === 0, JSON.stringify(afterAdd.pickHighlights));

  await clickDot(page, 1);
  await clickDot(page, 2);
  await page.waitForFunction(() => window.__VIEWPORT__.stageContourSketch().picked.length === 2, null, { timeout: 4000 });
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-feature-card-confirm]');
    return btn && !btn.disabled && /Add/.test(btn.textContent || '');
  }, null, { timeout: 4000 });
  await add.click();
  await page.waitForFunction(() => {
    const sketch = window.__VIEWPORT__.stageContourSketch();
    return sketch.dimensions === 2 && !!document.querySelector('[data-contour-card="dimension"]');
  }, null, { timeout: 4000 });
  check(`${width} a second Add stays on the card`, (await page.evaluate(() => window.__VIEWPORT__.stageContourSketch().dimensions)) === 2);

  await page.locator('[data-contour-tag]').first().click();
  await page.waitForFunction(() => (
    document.querySelector('[data-contour-card="dimension"]')?.getAttribute('data-contour-dimension-mode') === 'edit'
  ), null, { timeout: 4000 });
  const edit = await page.evaluate(() => {
    const del = document.querySelector('[data-contour-dimension-delete]');
    const confirm = document.querySelector('[data-feature-card-confirm]');
    return {
      mode: document.querySelector('[data-contour-card="dimension"]')?.getAttribute('data-contour-dimension-mode') || '',
      delete: !!del,
      label: (confirm?.textContent || '').trim(),
      red: !!del && String(del.className).includes('text-red-200') && String(del.className).includes('bg-red-950'),
    };
  });
  check(`${width} reopen is Delete and Confirm`, edit.mode === 'edit' && edit.delete && edit.label === 'Confirm' && edit.red && !/Add/.test(edit.label), JSON.stringify(edit));

  await page.locator('[data-feature-card-cancel]').click();
  await page.waitForFunction(() => !document.querySelector('[data-contour-card="dimension"]'), null, { timeout: 4000 });

  await page.locator('[data-contour-tool="constraints"]').click();
  await page.locator('[data-contour-card="constraint"]').waitFor({ timeout: 4000 });
  const edge = await page.evaluate(() => {
    const dots = window.__VIEWPORT__.stageContourSketch().dots || [];
    if (dots.length < 2) return null;
    return { x: (dots[0].x + dots[1].x) / 2, y: (dots[0].y + dots[1].y) / 2 };
  });
  if (edge) await page.mouse.click(edge.x, edge.y);
  await page.waitForFunction(() => (
    window.__VIEWPORT__.stageContourSketch().picked.some((p) => p.kind === 'line')
  ), null, { timeout: 4000 });
  await clickDot(page, 2);
  await page.waitForFunction(() => {
    const picked = window.__VIEWPORT__.stageContourSketch().picked || [];
    return picked.some((p) => p.kind === 'line') && picked.some((p) => p.kind === 'point');
  }, null, { timeout: 4000 });
  const constrain = await page.evaluate(() => {
    const sketch = window.__VIEWPORT__.stageContourSketch();
    return {
      picked: sketch.picked,
      lines: sketch.pickHighlights?.lines || [],
      points: sketch.pickHighlights?.points || [],
      mode: document.querySelector('[data-contour-card="constraint"]')?.getAttribute('data-contour-constraint-mode') || '',
      label: (document.querySelector('[data-feature-card-confirm]')?.textContent || '').trim(),
    };
  });
  const linePick = (constrain.picked || []).find((p) => p.kind === 'line');
  const pointPick = (constrain.picked || []).find((p) => p.kind === 'point');
  check(`${width} Constrain tap picks a line and a point`, !!linePick && !!pointPick, JSON.stringify(constrain));
  check(`${width} Constrain picks stay highlighted`, !!linePick && constrain.lines.includes(linePick.id) && !!pointPick && constrain.points.includes(pointPick.id), JSON.stringify(constrain));
  check(`${width} Constrain create says Add`, constrain.mode === 'add' && constrain.label === 'Add', JSON.stringify(constrain));
}

const up = await waitForServer();
if (!up) {
  console.log('dimension feedback: vite did not start');
  stop();
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: exe, headless: true });
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
    await page.addInitScript(() => { window.__SURFCAD_NO_TUTORIAL = true; });
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err).slice(0, 300)));
    await runViewport(page, width);
    check(`${width} no page error`, errors.length === 0, errors.join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  stop();
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\ndimension feedback ok');
