#!/usr/bin/env node
/**
 * Empty run clears everything.
 *
 * A blank / comment-only / construction-plane-only script must leave an EMPTY
 * viewport — and, just as important, must leave nothing behind that can hand the
 * previous solid back: the worker's cached manifold, the context's lastResult,
 * the pick topology, the solid-derived overlays.
 *
 * Half of this is real behaviour (the worker's `clearResult` is driven here
 * against the bundled wasm build); the other half is wiring in React code that
 * only runs in a browser, so it is asserted at the source level.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldClearViewportScript } from '../../src/utils/helperPaletteSnippets.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '../../', rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── The worker half: drive sandboxWorker's message handler for real ───────────
{
  // Minimal worker-global stand-in; the module installs self.onmessage on load.
  const inbox = [];
  const selfStub = { postMessage: (m) => inbox.push(m), onmessage: null };
  globalThis.self = selfStub;

  await import('../../src/workers/sandboxWorker.js');

  let seq = 0;
  const send = async (type, payload = {}) => {
    const id = `t${++seq}`;
    inbox.length = 0;
    await selfStub.onmessage({ data: { type, payload, id } });
    const msg = inbox.find((m) => m.id === id);
    if (!msg) throw new Error(`no reply to ${type}`);
    if (msg.type === 'error') return { error: msg.payload.message };
    return msg.payload;
  };

  await send('init');
  const cube = 'return Manifold.cube([10, 10, 10], true);';

  const run = await send('execute', { script: cube });
  check('execute caches a solid', !run.error && run.volume > 0, run.error);
  const info = await send('getModelInfo');
  check('model info reads the cached solid', !info.error && info.volume > 0, info.error);

  const cleared = await send('clearResult');
  check('clearResult acks', cleared.ok === true, cleared.error);

  const infoAfter = await send('getModelInfo');
  check(
    'model info has nothing to serve after the clear',
    /No cached manifold/.test(infoAfter.error || ''),
    `got ${JSON.stringify(infoAfter)}`,
  );
  const trimAfter = await send('trimByPlane', { normal: [0, 0, 1], originOffset: 0 });
  check(
    'cross-section has nothing to trim after the clear',
    /No cached manifold/.test(trimAfter.error || ''),
    `got ${JSON.stringify(trimAfter)}`,
  );
  const lastMesh = await send('stageGetLastMesh');
  check(
    'stage tooling sees no last mesh after the clear',
    /nothing executed yet/.test(lastMesh.error || ''),
    `got ${JSON.stringify(lastMesh)}`,
  );

  // A later real run must still work — the clear frees, it does not poison.
  const rerun = await send('execute', { script: cube });
  check('a run after the clear rebuilds normally', !rerun.error && rerun.volume > 0, rerun.error);
}

// ── The app half: the clearing run is wired all the way down ─────────────────
{
  const view = read('src/components/Viewport.jsx');
  const clearBlock = view.slice(
    view.indexOf('if (shouldClearViewportScript(script)) {'),
    view.indexOf('return { ok: true, cleared: true };'),
  );
  check('clear path exists in executeScript', clearBlock.length > 0);
  check('clear path blanks the rendered geometry', /new BufferGeometry\(\)/.test(clearBlock));
  check('clear path drops the cached mesh', /cachedMeshDataRef\.current = null/.test(clearBlock));
  check('clear path drops the pick topology',
    /faceIDsRef\.current = null/.test(clearBlock)
    && /boundaryTopoRef\.current = null/.test(clearBlock)
    && /featureEdgesRef\.current = \[\]/.test(clearBlock));
  check('clear path removes solid-derived overlays',
    /clearCuttingPlane\(\)/.test(clearBlock)
    && /clearXsPreview\(\)/.test(clearBlock)
    && /clearPathPreview\(\)/.test(clearBlock)
    && /clearFilletBlendPreview\(\)/.test(clearBlock)
    && /clearIdLabels\(\)/.test(clearBlock));
  check('clear path forgets the worker-side result',
    /manifoldContext\.clearResult\(\)/.test(clearBlock));
  check('clear path bumps the mesh epoch', /setMeshEpoch\(/.test(clearBlock));

  const ctx = read('src/utils/ManifoldWorker.js');
  check('context clearResult nulls lastResult',
    /async clearResult\(\)\s*\{[\s\S]*?this\.lastResult = null/.test(ctx));
  check('context clearResult reaches the worker',
    /type: 'clearResult'/.test(ctx));

  const app = read('src/App.jsx');
  check('a cleared run does not grade as a game attempt', /run\.cleared/.test(app));
}

// ── Which scripts clear ───────────────────────────────────────────────────────
{
  check('empty string clears', shouldClearViewportScript(''));
  check('whitespace clears', shouldClearViewportScript('   \n\t '));
  check('comment-only clears', shouldClearViewportScript('// nothing\n/* here */'));
  check('a real solid does not clear',
    shouldClearViewportScript('return Manifold.cube([1,1,1], true);') === false);
}

if (failed) {
  console.log(`\n${failed} empty-run check(s) failed`);
  process.exit(1);
}
console.log('\nAll empty-run clear checks passed.');
