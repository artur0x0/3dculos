#!/usr/bin/env node
/**
 * Assembly-open spinner.
 *
 * A delayed vault open shows a centered spinner ("Opening Gearbox…",
 * "part 3 of 7") and clears it when the load finishes. A failed open and the
 * safety timeout clear the spinner and surface the failure toast with Retry.
 * A fast open never flashes. prefers-reduced-motion stops the ring.
 */
import { readFileSync } from 'node:fs';
import { createMockGithubAdapter } from '../../src/utils/git/mockGithubAdapter.js';
import { findOrCreateVault } from '../../src/utils/git/vault.js';
import { assemblyFilePath, assemblyPartPath } from '../../src/utils/git/vaultLayout.js';
import { stringifySurfJson } from '../../src/utils/git/surfJson.js';
import { fileWrite } from '../../src/utils/git/githubAdapterInterface.js';
import {
  ASSEMBLY_OPEN_SHOW_MS,
  ASSEMBLY_OPEN_SAFETY_MS,
  assemblyOpenLabel,
  createAssemblyOpenController,
  runTrackedAssemblyOpen,
} from '../../src/utils/assemblyOpenOverlay.js';

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

function fakeClock() {
  let now = 0;
  let seq = 1;
  const items = [];
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = seq;
      seq += 1;
      items.push({ id, fn, at: now + ms, dead: false });
      return id;
    },
    clearTimer(id) {
      const item = items.find((row) => row.id === id);
      if (item) item.dead = true;
    },
    advance(ms) {
      now += ms;
      let guard = 0;
      while (guard < 50) {
        guard += 1;
        const due = items
          .filter((row) => !row.dead && row.at <= now)
          .sort((a, b) => a.at - b.at || a.id - b.id);
        if (!due.length) return;
        const next = due[0];
        next.dead = true;
        next.fn();
      }
    },
  };
}

function controller(clock, hooks, { showDelayMs = ASSEMBLY_OPEN_SHOW_MS, safetyMs = 1000 } = {}) {
  return createAssemblyOpenController({
    showDelayMs,
    safetyMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...hooks,
  });
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

console.log('labels');
{
  const gear = assemblyOpenLabel('Gearbox', { index: 3, total: 7 });
  ok('opening line names the assembly', gear.label === 'Opening Gearbox…');
  ok('part counter', gear.detail === 'part 3 of 7');
  ok('no counter before the first part', assemblyOpenLabel('Gearbox', { index: 0, total: 7 }).detail === '');
  ok('blank name falls back', assemblyOpenLabel('  ', {}).label === 'Opening assembly…');
  ok('show delay is 150ms', ASSEMBLY_OPEN_SHOW_MS === 150);
  ok('safety timeout is finite', ASSEMBLY_OPEN_SAFETY_MS >= 30000);
}

console.log('\nfast open does not flash');
{
  const clock = fakeClock();
  const seen = [];
  const ctrl = controller(clock, { onChange: (ui) => seen.push(ui) });
  await runTrackedAssemblyOpen(ctrl, {
    name: 'Gearbox',
    load: async () => ({ ok: true }),
  });
  clock.advance(1000);
  ok('spinner never became visible', seen.every((ui) => !ui || ui.visible !== true));
}

console.log('\ndelayed open shows, then clears');
{
  const clock = fakeClock();
  let ui = null;
  const frames = [];
  const ctrl = controller(clock, {
    onChange: (next) => {
      ui = next;
      if (next) frames.push(next);
    },
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = runTrackedAssemblyOpen(ctrl, {
    name: 'Gearbox',
    total: 7,
    load: async ({ progress }) => {
      progress({ index: 3, total: 7, name: 'Gearbox' });
      await gate;
      return { ok: true };
    },
  });
  await Promise.resolve();
  clock.advance(100);
  ok('still hidden at 100ms', ui == null);
  clock.advance(50);
  ok('visible after 150ms', ui?.visible === true && ui.name === 'Gearbox');
  ok('label is Opening Gearbox…', assemblyOpenLabel(ui.name, ui).label === 'Opening Gearbox…');
  ok('progress is part 3 of 7', assemblyOpenLabel(ui.name, ui).detail === 'part 3 of 7');
  release();
  await pending;
  ok('clears when the load finishes', ui == null);
  ok('it had been shown', frames.length > 0);
}

console.log('\nfailure clears the spinner and toasts Retry');
{
  const clock = fakeClock();
  let ui = null;
  let failure = null;
  const ctrl = controller(clock, {
    onChange: (next) => { ui = next; },
    onFailure: (fail) => { failure = fail; },
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = runTrackedAssemblyOpen(ctrl, {
    name: 'Gearbox',
    retry: () => 'retry-gearbox',
    load: async () => {
      await gate;
      throw new Error('Could not open Gearbox');
    },
  });
  clock.advance(150);
  ok('spinner is up while the open is still running', ui?.visible === true);
  release();
  let threw = false;
  try { await pending; } catch (err) { threw = /Could not open Gearbox/.test(err.message); }
  ok('load rejected', threw);
  ok('spinner cleared on failure', ui == null);
  ok('toast message', failure?.message === 'Could not open Gearbox');
  ok('toast keeps Retry', typeof failure?.retry === 'function' && failure.retry() === 'retry-gearbox');
}

console.log('\nsafety timeout');
{
  const clock = fakeClock();
  let ui = null;
  let failure = null;
  const ctrl = controller(clock, {
    showDelayMs: 20,
    safetyMs: 100,
    onChange: (next) => { ui = next; },
    onFailure: (fail) => { failure = fail; },
  });
  void runTrackedAssemblyOpen(ctrl, {
    name: 'Gearbox',
    retry: () => 'again',
    load: () => new Promise(() => {}),
  });
  clock.advance(20);
  ok('spinner shows before the timeout', ui?.visible === true);
  clock.advance(100);
  ok('timeout clears the spinner', ui == null);
  ok('timeout uses the failure toast', failure?.reason === 'timeout'
    && failure.message === 'Could not open Gearbox'
    && failure.retry() === 'again');
}

console.log('\ncancel and a newer open do not stick');
{
  const clock = fakeClock();
  let ui = null;
  let failures = 0;
  const ctrl = controller(clock, {
    onChange: (next) => { ui = next; },
    onFailure: () => { failures += 1; },
  });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = runTrackedAssemblyOpen(ctrl, {
    name: 'Old',
    load: () => firstGate,
  });
  clock.advance(150);
  ok('first open is showing', ui?.name === 'Old');
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const second = runTrackedAssemblyOpen(ctrl, {
    name: 'New',
    load: () => secondGate,
  });
  ok('replaced open hides immediately', ui == null);
  releaseFirst();
  await first;
  clock.advance(150);
  ok('the new open shows on its own', ui?.name === 'New');
  releaseSecond();
  await second;
  ok('the new open clears when it finishes', ui == null);
  ok('the replaced open does not toast', failures === 0);
}

console.log('\ndelayed vault open');
{
  const gh = createMockGithubAdapter({ login: 'artur' });
  const vault = await findOrCreateVault(gh);
  const parts = [];
  for (let i = 1; i <= 7; i += 1) {
    parts.push({
      id: assemblyPartPath('Gearbox', `Part ${i}`),
      name: `Part ${i}`,
      visible: true,
      order: i - 1,
    });
  }
  const files = [
    fileWrite(assemblyFilePath('Gearbox'), stringifySurfJson({
      source: 'git', name: 'Gearbox', activeId: parts[0].id, parts,
    })),
    ...parts.map((part) => fileWrite(part.id, 'return Manifold.cube([4, 4, 4], true);\n')),
  ];
  const commit = await gh.commitFiles(vault.repo, {
    branch: 'main', message: 'seed', baseSha: vault.headSha, files,
  });
  const orig = gh.readFile.bind(gh);
  gh.readFile = async (...args) => {
    await sleep(40);
    return orig(...args);
  };
  let ui = null;
  const frames = [];
  const ctrl = createAssemblyOpenController({
    onChange: (next) => {
      ui = next;
      if (next) frames.push({ ...next });
    },
  });
  const opened = await runTrackedAssemblyOpen(ctrl, {
    name: 'Gearbox',
    retry: () => {},
    load: async ({ progress }) => openVaultAssemblyDelayed(gh, vault.repo, progress, commit.sha),
  });
  const hit = frames.find((frame) => frame.name === 'Gearbox' && frame.index === 3 && frame.total === 7);
  ok('delayed open shows the spinner', frames.some((frame) => frame.visible));
  ok('centered label would read Opening Gearbox… / part 3 of 7', !!hit
    && assemblyOpenLabel(hit.name, hit).label === 'Opening Gearbox…'
    && assemblyOpenLabel(hit.name, hit).detail === 'part 3 of 7');
  ok('spinner is gone after the assembly loads', ui == null);
  ok('opened the seven parts', opened?.doc?.parts?.length === 7 && opened.doc.name === 'Gearbox');
}

async function openVaultAssemblyDelayed(adapter, repo, progress, headSha) {
  const { openVaultAssembly } = await import('../../src/utils/git/gitWorkspace.js');
  return openVaultAssembly(adapter, repo, 'Gearbox', {
    branch: 'main',
    headSha,
    onProgress: (update) => progress({ ...update, name: update.name || 'Gearbox' }),
  });
}

console.log('\nforced failure after the spinner is up');
{
  globalThis.__ASSEMBLY_OPEN_DELAY_MS__ = 180;
  globalThis.__ASSEMBLY_OPEN_FAIL__ = 'Could not open Gearbox';
  let ui = null;
  let saw = null;
  let failure = null;
  const ctrl = createAssemblyOpenController({
    onChange: (next) => {
      ui = next;
      if (next) saw = next;
    },
    onFailure: (fail) => { failure = fail; },
  });
  let threw = false;
  try {
    await runTrackedAssemblyOpen(ctrl, {
      name: 'Gearbox',
      retry: () => 'retry',
      load: async () => ({ ok: true }),
    });
  } catch (err) {
    threw = err?.message === 'Could not open Gearbox';
  } finally {
    delete globalThis.__ASSEMBLY_OPEN_DELAY_MS__;
    delete globalThis.__ASSEMBLY_OPEN_FAIL__;
  }
  ok('delayed failure throws', threw);
  ok('spinner had appeared', saw?.visible === true && saw.name === 'Gearbox');
  ok('spinner cleared', ui == null);
  ok('failure toast offers Retry', failure?.message === 'Could not open Gearbox' && failure.retry() === 'retry');
}

console.log('\nmarkup is centered and does not block toasts');
{
  const spinner = readFileSync(new URL('../../src/components/AssemblyOpenSpinner.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  ok('overlay fills and centers', /absolute inset-0/.test(spinner)
    && /flex items-center justify-center/.test(spinner)
    && /data-assembly-open-spinner/.test(spinner));
  ok('clicks pass through under the toasts', /pointer-events-none/.test(spinner)
    && /z-\[45\]/.test(spinner)
    && /z-50/.test(spinner)
    && /pointer-events-auto/.test(spinner));
  ok('reuses the border spinner', /animate-spin/.test(spinner)
    && /border-b-2 border-white/.test(spinner)
    && /motion-reduce:animate-none/.test(spinner));
  ok('label and part counter hooks', /data-assembly-open-label/.test(spinner)
    && /data-assembly-open-progress/.test(spinner));
  ok('toast has Retry', /data-assembly-open-toast/.test(spinner)
    && /data-assembly-open-retry/.test(spinner)
    && />\s*Retry\s*</.test(spinner));
  ok('reduced motion stops the ring', /prefers-reduced-motion:\s*reduce/.test(css)
    && /\[data-assembly-open-ring\]/.test(css)
    && /animation:\s*none/.test(css));
  ok('open dialog, folder load, branch switch, and last-assembly hydrate',
    /handleOpenVaultAssembly[\s\S]*?runTrackedAssemblyOpen/.test(app)
    && /handleLoadAssembly[\s\S]*?runTrackedAssemblyOpen/.test(app)
    && /handleSwitchBranch[\s\S]*?runTrackedAssemblyOpen/.test(app)
    && /runTrackedAssemblyOpen\(assemblyOpenCtrlRef\.current/.test(app)
    && /Skipping stale IDB hydrate/.test(app)
    && /vault baseline already set/.test(app));
  ok('switch still adopts the opened vault', /handleSwitchBranch[\s\S]*?adoptVaultOpening\(/.test(app));
}

console.log(failed ? `\n❌ FAIL (${failed} failed, ${passed} passed)` : `\n✅ PASS (${passed} passed)`);
process.exit(failed ? 1 : 0);
