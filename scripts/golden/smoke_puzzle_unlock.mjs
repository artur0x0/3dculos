#!/usr/bin/env node
/**
 * The match-the-part entry is not a button. A signed-in corner sequence
 * (useAuthState().signedIn, grey reauth included) starts the same
 * handleStartGame path. Signed-out taps and four taps do not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authStateFromPhase } from '../../src/utils/authPhase.js';
import { notePuzzleTap } from '../../src/utils/puzzleUnlock.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function run(signedIn, times) {
  let state = [];
  let unlocked = false;
  for (const now of times) {
    const next = notePuzzleTap(state, { now, signedIn });
    state = next.taps;
    unlocked = next.unlocked;
  }
  return unlocked;
}

console.log('puzzle easter egg');

{
  const unlock = read('../../src/components/PuzzleUnlock.jsx');
  const view = read('../../src/components/Viewport.jsx');
  const toolbar = read('../../src/components/Toolbar.jsx');
  const app = read('../../src/App.jsx');

  check('signed-out five taps do nothing',
    authStateFromPhase('signed-out').signedIn === false
    && run(false, [0, 100, 200, 300, 400]) === false);
  check('signed-in five taps enter, four taps do not, reauth counts',
    authStateFromPhase('connected').signedIn === true
    && authStateFromPhase('reauth').signedIn === true
    && run(authStateFromPhase('reauth').signedIn, [0, 200, 400, 600]) === false
    && run(authStateFromPhase('reauth').signedIn, [0, 200, 400, 600, 800]) === true);
  check('corner uses useAuthState().signedIn and the old start path',
    /const \{ signedIn \} = useAuthState\(\)/.test(unlock)
    && /<PuzzleUnlock enabled=\{mode !== 'game'\} onUnlock=\{onStartGame\} \/>/.test(view)
    && /onStartGame=\{handleStartGame\}/.test(app)
    && /const handleStartGame = \(\) => \{/.test(app));
  check('hit area is 44px at the top-left and does not drag',
    /data-puzzle-unlock-placement="under-io-tray"/.test(unlock)
    && /width: 44, height: 44/.test(unlock)
    && /z-20/.test(unlock)
    && !/data-cad-io-tray/.test(view)
    && /stopPropagation\(\)/.test(unlock)
    && /isStationaryTap/.test(unlock));
  check('editor ribbon has no puzzle button; upload lives on the parts ribbon',
    !/Play match-the-part puzzle/.test(toolbar)
    && !/onStartGame/.test(toolbar)
    && !/data-script-upload/.test(toolbar)
    && !/data-script-download/.test(toolbar)
    && /data-part-upload/.test(read('../../src/components/PartFeed.jsx'))
    && /data-script-upload/.test(read('../../src/components/PartFeed.jsx'))
    && !/Get Quote/.test(toolbar));
  check('unlock toast is present and the sequence is not stored',
    /data-puzzle-unlock-toast/.test(unlock)
    && /Puzzle unlocked/.test(unlock)
    && !/localStorage|sessionStorage/.test(unlock));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nPuzzle unlock checks passed.');
