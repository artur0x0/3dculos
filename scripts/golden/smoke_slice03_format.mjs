#!/usr/bin/env node
/**
 * Slice 03 smoke: formatGameTime only (no jest/vitest in package.json;
 * full worker _gameMatchCompare needs CADGEN_HARNESS — skip here).
 */
import { formatGameTime } from '../../src/utils/gamePuzzle.js';

let failed = 0;
function check(name, got, want) {
  if (got === want) console.log(`  ✅ ${name} → ${JSON.stringify(got)}`);
  else {
    failed++;
    console.log(`  ❌ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

console.log('slice03 smoke — formatGameTime');
check('0 ms', formatGameTime(0), '0:00.0');
check('61234 ms → 1:01.2', formatGameTime(61234), '1:01.2');
check('negative', formatGameTime(-5), '0:00.0');
check('NaN', formatGameTime(NaN), '0:00.0');
check('~9950 ms → 0:09.9', formatGameTime(9950), '0:09.9');
check('10000 ms → 0:10.0', formatGameTime(10000), '0:10.0');
check('undefined', formatGameTime(undefined), '0:00.0');

console.log(failed ? `\n❌ FAIL (${failed})` : '\n✅ PASS');
process.exit(failed ? 1 : 0);
