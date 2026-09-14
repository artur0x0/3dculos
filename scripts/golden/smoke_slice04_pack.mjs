#!/usr/bin/env node
/**
 * Slice 04 smoke: puzzle pack shape + formatGameTime still works.
 */
import { formatGameTime, listPuzzles, getPuzzle, DEMO_PUZZLE } from '../../src/utils/gamePuzzle.js';

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

console.log(failed ? `\n❌ FAIL (${failed})` : '\n✅ PASS');
process.exit(failed ? 1 : 0);
