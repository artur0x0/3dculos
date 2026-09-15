#!/usr/bin/env node
/**
 * Slice 09 — sequential helper-palette compose stays runnable.
 * Proves filletEdges → cube → hole yields one trailing `return part;`,
 * no starter/const redeclarations, and Function() accepts the buffer
 * under stubbed helpers (syntax + binding check).
 */
import {
  composeHelperInsert,
  buildHelperSnippet,
  isBufferEmpty,
  HELPER_PALETTE_ITEMS,
} from '../../src/utils/helperPaletteSnippets.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function countMatches(text, re) {
  const m = String(text).match(re);
  return m ? m.length : 0;
}

function assertSingleTrailingReturn(buf, label) {
  const returns = countMatches(buf, /\breturn\s+part\s*;/g);
  check(`${label}: exactly one return part`, returns === 1, `got ${returns}`);
  check(
    `${label}: return is trailing`,
    /\nreturn\s+part\s*;\s*$/.test(buf),
    'return part; not at end',
  );
}

function assertNoRedeclares(buf, label) {
  const seen = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(buf))) {
    if (seen.has(m[1])) {
      failed++;
      console.log(`  ❌ ${label}: redeclared ${m[1]}`);
      return;
    }
    seen.add(m[1]);
  }
  check(`${label}: no const/let/var redeclarations`, true);
}

function solid(tag = 's') {
  const o = { _t: tag };
  o.subtract = () => solid(`${tag}-sub`);
  return o;
}

/** Stub Manifold + helpers so Function() only checks syntax/bindings. */
function stubRunner(source) {
  const stubs = {
    Manifold: {
      cube: () => solid('cube'),
      cylinder: () => solid('cyl'),
      sphere: () => solid('sph'),
    },
    tube: () => solid('tube'),
    hexPrism: () => solid('hex'),
    roundedBox: () => solid('rb'),
    filletEdges: (p) => p,
    chamferEdges: (p) => p,
    convexEdges: () => [],
    facesByNormal: () => [0],
    workplaneFromFace: () => ({}),
    holeSpan: () => 20,
    hole: (p) => p,
    holePattern: (p) => p,
    clearanceHole: (p) => p,
    tapDrillHole: (p) => p,
    cboreHole: (p) => p,
    cskHole: (p) => p,
    shell: () => solid('shell'),
    addDraft: (p) => p,
    center: (p) => p,
    align: (p) => p,
    mirror: (p) => p,
    array3D: (p) => p,
    polarArray: (p) => p,
    makeExtrude: () => solid('ex'),
    makeRevolve: () => solid('rev'),
  };
  const keys = Object.keys(stubs);
  const fn = new Function(...keys, `"use strict";\n${source}`);
  return fn(...keys.map((k) => stubs[k]));
}

console.log('slice-09 helper compose smoke');

// ── Repro from review: blind += vs compose ─────────────────────
{
  let blind = '';
  for (const id of ['filletEdges', 'cube', 'hole']) {
    blind += buildHelperSnippet(id, { bufferEmpty: isBufferEmpty(blind) });
  }
  check(
    'blind += still broken (baseline)',
    /return\s+part\s*;[\s\S]+Manifold\.cube/.test(blind),
    'expected dead code after return',
  );
}

{
  let buf = '';
  for (const id of ['filletEdges', 'cube', 'hole']) {
    buf = composeHelperInsert(buf, id);
  }
  assertSingleTrailingReturn(buf, 'fillet→cube→hole');
  assertNoRedeclares(buf, 'fillet→cube→hole');
  check(
    'fillet→cube→hole: no dead code after return',
    !/return\s+part\s*;[\s\S]*\S/.test(buf.replace(/\s+$/, '')),
  );
  check(
    'fillet→cube→hole: keeps fillet + cube + hole ops',
    /filletEdges/.test(buf) && /Manifold\.cube/.test(buf) && /\bhole\s*\(/.test(buf),
  );
  try {
    const result = stubRunner(buf);
    check('fillet→cube→hole: Function() runs under stubs', result != null);
  } catch (e) {
    check('fillet→cube→hole: Function() runs under stubs', false, String(e.message || e));
  }
}

// ── Every palette item in sequence stays single-return / no redecl ─
{
  let buf = '';
  for (const item of HELPER_PALETTE_ITEMS) {
    const next = composeHelperInsert(buf, item.id);
    check(`compose ${item.id} returns string`, typeof next === 'string' && next.length > 0);
    buf = next;
  }
  assertSingleTrailingReturn(buf, 'all palette items');
  assertNoRedeclares(buf, 'all palette items');
  try {
    stubRunner(buf);
    check('all palette items: Function() runs under stubs', true);
  } catch (e) {
    check('all palette items: Function() runs under stubs', false, String(e.message || e));
  }
}

check('unknown id → null', composeHelperInsert('', 'not-a-helper') === null);

check('comment-only buffer counts as empty', isBufferEmpty('// note\n/* x */'));
{
  const next = composeHelperInsert('// note\n', 'filletEdges');
  check('comment-first gets starter part', /let\s+part\s*=/.test(next));
  check('comment-first keeps comment', next.includes('// note'));
}

{
  let buf = composeHelperInsert('', 'filletEdges');
  buf = composeHelperInsert(buf, 'cube');
  const stripped = buf.replace(/(?:\r?\n)?return\s+part\s*;\s*$/, '');
  const afterFillet = stripped.indexOf('filletEdges');
  const mid = stripped.indexOf('\n', afterFillet) + 1;
  const withCenter = composeHelperInsert(buf, 'center', mid);
  const body = withCenter.replace(/(?:\r?\n)?return\s+part\s*;\s*$/, '');
  const cAt = body.indexOf('part = center');
  const fAt = body.indexOf('filletEdges');
  // Second cube assign is `part = Manifold.cube` (starter is `let part = ...`)
  const cubeRe = body.indexOf('\npart = Manifold.cube');
  check('mid-caret inserts center', cAt >= 0);
  check('mid-caret center after fillet line', cAt > fAt, `cAt=${cAt} fAt=${fAt}`);
  check(
    'mid-caret center before later cube assign',
    cubeRe < 0 || cAt < cubeRe,
    `cAt=${cAt} cubeRe=${cubeRe}`,
  );
  check('mid-caret still one trailing return', /\nreturn\s+part\s*;\s*$/.test(withCenter));
}


if (failed) {
  console.log(`\nFAILED: ${failed}`);
  process.exit(1);
}
console.log('\nAll slice-09 compose checks passed.');
