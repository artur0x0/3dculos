#!/usr/bin/env node
/**
 * Fixture scripts run in the worker as the body of
 *   new Function(...helperNames, '"use strict";\n' + script)
 * A top-level `const cut` in that script is a SyntaxError: `cut` is already
 * a parameter. Nesting the user script in another function would hide the
 * clash and is not the fix. This scan is that check.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const worker = read('src/workers/sandboxWorker.js') + '\n' + read('src/lib/surfcad/runtime.js');
const helperBlock = worker.slice(
  worker.indexOf('const HELPER_FUNCTIONS = {'),
  worker.indexOf('\n};', worker.indexOf('const HELPER_FUNCTIONS = {')),
);
const helpers = new Set(
  [...helperBlock.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*(?:\/\/.*)?$/gm)].map((m) => m[1]),
);
helpers.add('window');
check('helper list includes cut and move', helpers.has('cut') && helpers.has('move') && helpers.size > 20,
  `n=${helpers.size}`);
check('user script is not nested in sandboxWorker',
  /const wrappedScript = `"use strict";\\n\$\{script\}`;/.test(worker)
  && /new Function\(\.\.\.scopeKeys, wrappedScript\)/.test(worker)
  && !/new Function\(\.\.\.scopeKeys, [\s\S]{0,80}function\s*\(/.test(worker));

function topLevelBindings(src) {
  const names = [];
  let i = 0;
  let depth = 0;
  const s = String(src || '');
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (depth === 0) {
      const m = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(s.slice(i));
      if (m) {
        names.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return names;
}

const dir = new URL('./fixtures/', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.txt')).sort();
check('fixture directory is scanned', files.length >= 5, files.join(','));
const clashes = [];
for (const name of files) {
  const text = readFileSync(join(dir.pathname, name), 'utf8');
  for (const binding of topLevelBindings(text)) {
    if (helpers.has(binding)) clashes.push(`${name}: ${binding}`);
  }
}
check('no fixture const shadows an injected helper', clashes.length === 0, clashes.join('; '));

if (failed) {
  console.log(`\n${failed} helper-binding check(s) failed`);
  process.exit(1);
}
console.log('\nAll helper-binding checks passed.');
