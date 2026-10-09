import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { shouldRebuildOnEditorClose } from '../src/utils/scriptEditorClose.js';

const LIVE = 'let part = Manifold.cube([10, 10, 10], true);\nreturn part;\n';

test('close rebuilds only when the buffer is not already building or built', () => {
  assert.equal(shouldRebuildOnEditorClose({ live: LIVE, lastBuilt: 'old' }), true);
  assert.equal(shouldRebuildOnEditorClose({ live: LIVE, lastBuilt: LIVE }), false);
  assert.equal(shouldRebuildOnEditorClose({
    live: LIVE,
    lastBuilt: 'old',
    pendingAutoRun: LIVE,
  }), false);
  assert.equal(shouldRebuildOnEditorClose({
    live: LIVE,
    lastBuilt: null,
    assemblyOpenLocked: true,
  }), false);
  assert.equal(shouldRebuildOnEditorClose({ live: LIVE, game: true }), false);
  assert.equal(shouldRebuildOnEditorClose({ live: null, lastBuilt: null }), false);
});

test('App keeps the open lock, the editor auto-run, and the 600ms autosave', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const boot = readFileSync(new URL('../src/utils/assemblyBoot.js', import.meta.url), 'utf8');
  assert.match(app, /assemblyOpenLockRef\.current/);
  assert.match(app, /if \(assemblyOpenLockRef\.current\) return;/);
  assert.match(app, /editorLiveRef\.current/);
  assert.match(app, /\}, 600\);/);
  assert.doesNotMatch(app, /setEditorInitialScript\(DEFAULT_SCRIPT\)/);
  assert.match(boot, /export function bootWriteAllowed/);
  assert.match(app, /shouldRebuildOnEditorClose/);
});
