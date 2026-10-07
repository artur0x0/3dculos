#!/usr/bin/env node
/**
 * Safari minimize/restore lifecycle: no reload-on-visibility; soft worker
 * recover via ping/ensureAlive; architecture documents the hard limit.
 */
import { readFileSync } from 'node:fs';

let failed = 0;
let passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../../src/utils/ManifoldWorker.js', import.meta.url), 'utf8');
const sandbox = readFileSync(new URL('../../src/workers/sandboxWorker.js', import.meta.url), 'utf8');
const arch = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');

console.log('safari page lifecycle');

ok('App listens for pageshow', /addEventListener\('pageshow'/.test(app));
ok('App soft-recovers via ensureAlive', /ensureAlive\(/.test(app));
// Reload button on init-error UI is fine; lifecycle handlers must not call it.
ok('lifecycle handlers never call location.reload',
  !/onPageHide[\s\S]{0,200}location\.reload/.test(app)
  && !/softRecover[\s\S]{0,600}location\.reload/.test(app)
  && !/onPageShow[\s\S]{0,200}location\.reload/.test(app));
ok('no unload / beforeunload handlers in App', !/addEventListener\('unload'/.test(app)
  && !/addEventListener\('beforeunload'/.test(app));
ok('ManifoldWorker has ping + ensureAlive', /async ping\(/.test(worker)
  && /async ensureAlive\(/.test(worker));
// App imports the ManifoldContext singleton — soft-recover must hit context, not only the class.
ok('ManifoldContext exposes ensureAlive (App call site)',
  /class ManifoldContext[\s\S]*?async ensureAlive\(/.test(worker)
  && /typeof manifoldContext\.ensureAlive !== 'function'/.test(app));
ok('sandbox worker handles ping', /case 'ping':/.test(sandbox));
ok('architecture documents Safari discard limit', /Safari page lifecycle/.test(arch)
  && /discard/.test(arch)
  && /bfcache/.test(arch));

if (failed) {
  console.log(`\n❌ FAIL (${failed} failed, ${passed} passed)`);
  process.exit(1);
}
console.log(`\n✅ PASS (${passed})`);
