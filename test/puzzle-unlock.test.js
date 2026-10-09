import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { authStateFromPhase } from '../src/utils/authPhase.js';
import {
  PUZZLE_UNLOCK_DRAG_PX,
  PUZZLE_UNLOCK_TAPS,
  PUZZLE_UNLOCK_WINDOW_MS,
  isStationaryTap,
  notePuzzleTap,
} from '../src/utils/puzzleUnlock.js';

function taps(signedIn, times) {
  let state = [];
  let unlocked = false;
  for (const now of times) {
    const next = notePuzzleTap(state, { now, signedIn });
    state = next.taps;
    unlocked = next.unlocked;
  }
  return { state, unlocked };
}

test('signed-out five taps do nothing', () => {
  assert.equal(authStateFromPhase('signed-out').signedIn, false);
  assert.equal(authStateFromPhase('pending').signedIn, false);
  const signedOut = authStateFromPhase('signed-out').signedIn;
  const result = taps(signedOut, [0, 100, 200, 300, 400]);
  assert.equal(result.unlocked, false);
  assert.deepEqual(result.state, []);
  const pending = taps(authStateFromPhase('pending').signedIn, [0, 100, 200, 300, 400]);
  assert.equal(pending.unlocked, false);
  assert.deepEqual(pending.state, []);
});

test('signed-in five taps inside the window unlock, including grey reauth', () => {
  assert.equal(authStateFromPhase('connected').signedIn, true);
  assert.equal(authStateFromPhase('reauth').signedIn, true);
  const times = [0, 400, 800, 1200, 1600];
  assert.equal(taps(authStateFromPhase('connected').signedIn, times).unlocked, true);
  const reauth = taps(authStateFromPhase('reauth').signedIn, times);
  assert.equal(reauth.unlocked, true);
  assert.deepEqual(reauth.state, []);
  const edge = taps(true, [0, 750, 1500, 2250, PUZZLE_UNLOCK_WINDOW_MS]);
  assert.equal(edge.unlocked, true);
});

test('four taps do nothing', () => {
  const result = taps(true, [0, 200, 400, 600]);
  assert.equal(result.unlocked, false);
  assert.equal(result.state.length, 4);
  assert.equal(PUZZLE_UNLOCK_TAPS, 5);
});

test('a fifth tap outside the three second window does not unlock', () => {
  const early = taps(true, [0, 100, 200, 300]);
  assert.equal(early.unlocked, false);
  const late = notePuzzleTap(early.state, {
    now: PUZZLE_UNLOCK_WINDOW_MS + 1,
    signedIn: true,
  });
  assert.equal(late.unlocked, false);
  assert.equal(late.taps.includes(0), false);
  assert.equal(late.taps.length, 4);
});

test('a drag is not a tap', () => {
  assert.equal(isStationaryTap(0, 0), true);
  assert.equal(isStationaryTap(PUZZLE_UNLOCK_DRAG_PX, 0), true);
  assert.equal(isStationaryTap(PUZZLE_UNLOCK_DRAG_PX + 1, 0), false);
  assert.equal(isStationaryTap(0, 20), false);
});

test('the corner reads useAuthState().signedIn and starts the old game path', () => {
  const unlock = readFileSync(new URL('../src/components/PuzzleUnlock.jsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/components/Viewport.jsx', import.meta.url), 'utf8');
  const toolbar = readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(unlock, /const \{ signedIn \} = useAuthState\(\)/);
  assert.doesNotMatch(unlock, /githubConnected/);
  assert.match(unlock, /data-puzzle-unlock-placement="under-io-tray"/);
  assert.match(unlock, /width: 44, height: 44/);
  assert.match(unlock, /stopPropagation\(\)/);
  assert.match(unlock, /setPointerCapture/);
  assert.match(unlock, /isStationaryTap/);
  assert.match(unlock, /data-puzzle-unlock-toast/);
  assert.doesNotMatch(unlock, /localStorage|sessionStorage/);
  assert.match(view, /<PuzzleUnlock enabled=\{mode !== 'game'\} onUnlock=\{onStartGame\} \/>/);
  assert.doesNotMatch(toolbar, /Play match-the-part puzzle/);
  assert.doesNotMatch(toolbar, /onStartGame/);
  assert.match(app, /const handleStartGame = \(\) => \{/);
  assert.match(app, /onStartGame=\{handleStartGame\}/);
});
