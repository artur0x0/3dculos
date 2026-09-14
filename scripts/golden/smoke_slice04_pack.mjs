#!/usr/bin/env node
/**
 * Slice 04 smoke: puzzle pack shape + every targetScript builds a solid
 * through the *bundled* wasm + sandboxWorker helpers (same as the browser).
 */
import { register } from 'node:module';
import { formatGameTime, listPuzzles, getPuzzle, DEMO_PUZZLE, GAME_PUZZLES } from '../../src/utils/gamePuzzle.js';

// Vite resolves extensionless `built/manifold`; Node needs the .js suffix.
register('./manifold-resolve-hook.mjs', import.meta.url);

let failed = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('slice04 smoke — puzzle pack');
const pack = listPuzzles();
check('at least 5 puzzles', pack.length >= 5, `count=${pack.length}`);
check('DEMO_PUZZLE is first', DEMO_PUZZLE?.id === pack[0]?.id);

const ids = new Set();
for (const p of pack) {
  check(`id unique: ${p.id}`, !ids.has(p.id));
  ids.add(p.id);
  check(`${p.id} has title`, typeof p.title === 'string' && p.title.length > 0);
  check(`${p.id} has targetScript`, typeof p.targetScript === 'string' && p.targetScript.includes('return'));
  check(`${p.id} blank starter`, (p.starterScript ?? '') === '');
  check(`getPuzzle(${p.id})`, getPuzzle(p.id)?.id === p.id);
}

check('formatGameTime still ok', formatGameTime(10000) === '0:10.0');

// --- geometry: drive sandboxWorker with a Node-side self mock --------------
console.log('slice04 smoke — targetScript geometry (bundled wasm + helpers)');

const pending = new Map();
let msgId = 0;
const workerSelf = {
  onmessage: null,
  postMessage(msg) {
    if (msg.type === 'loaded') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.type === 'error') {
      waiter.reject(new Error(msg.payload?.message || 'worker error'));
    } else {
      waiter.resolve(msg);
    }
  },
};
globalThis.self = workerSelf;

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    Promise.resolve().then(() => {
      if (!workerSelf.onmessage) {
        reject(new Error('sandboxWorker handler missing'));
        return;
      }
      workerSelf.onmessage({ data: { type, payload, id } });
    });
  });
}

await import('../../src/workers/sandboxWorker.js');
await send('init');

for (const p of GAME_PUZZLES) {
  try {
    const res = await send('execute', {
      script: p.targetScript,
      importedModels: {},
      memoryLimitMB: 512,
    });
    const vol = res.payload?.volume;
    const tris = res.payload?.tris;
    const mesh = res.payload?.mesh;
    const numTri = tris ?? (mesh?.triVerts?.length ? mesh.triVerts.length / 3 : 0);
    check(
      `${p.id} builds solid`,
      Number.isFinite(vol) && vol > 0 && numTri > 0,
      `vol=${vol} numTri=${numTri}`
    );
  } catch (e) {
    failed++;
    console.log(`  ❌ ${p.id} builds solid — ${e.message}`);
  }
}

console.log(failed ? `\n❌ FAIL (${failed})` : '\n✅ PASS');
process.exit(failed ? 1 : 0);
