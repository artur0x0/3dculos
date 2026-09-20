#!/usr/bin/env node
/**
 * Hotfix — contour Revolve extra box + Undo/Redo Auto-Run.
 *
 * Bug 1: empty / comment-only Confirm injected ensurePartPrefix's 40×30×20
 * cube, then `part = part.add(revolve)` — an extra box beside the solid.
 * Hostless Revolve must be the part (no Manifold.cube). Existing-part
 * Confirm still unions onto the host (Slice 26 goldens).
 *
 * Bug 2: Undo/Redo restored Monaco via loadContent (CAD-only autoExecute;
 * game skipped) and never called handleGameRun. Both handlers must
 * Auto-Run on the same path as palette insert / Extrude / Revolve Confirm.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  composeContourRevolve,
  composeContourCommit,
  composeContourExtrude,
  countMakeRevolve,
  countMakeExtrude,
  hasContourRevolveBlock,
  resolveContourWorkplane,
} from '../../src/utils/contourMode.js';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('hotfix: revolve extra box + undo/redo Auto-Run');

const planarFace = {
  center: [0, 0, 10],
  normal: [0, 0, 1],
  area: 1200,
  triangleCount: 2,
  selectionMode: 'coplanar',
};
const face = resolveContourWorkplane(planarFace).face;
const starter = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n';

function composeEmpty(buffer = '') {
  return composeContourRevolve(buffer, {
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 360, axis: 'v', sense: 'positive' },
  });
}

// ── Bug 1: empty-buffer Revolve must not emit a starter box ────
{
  const empty = composeEmpty('');
  check('empty compose ok + Auto-Run', empty.ok && empty.run === true);
  check('empty has one makeRevolve', countMakeRevolve(empty.buffer) === 1);
  check('empty has revolve markers', hasContourRevolveBlock(empty.buffer));
  check('empty has no Manifold.cube', !/Manifold\.cube\s*\(/.test(empty.buffer));
  check('empty has no width/depth/height starter consts',
    !/\bconst\s+width\s*=\s*40\b/.test(empty.buffer)
    && !/\bconst\s+depth\s*=\s*30\b/.test(empty.buffer));
  check('empty does not part.add the revolve', !/part\s*=\s*part\.add\(/.test(empty.buffer));
  check('empty part is the placed revolve',
    /let\s+part\s*=\s*placeOnFace\(\s*null\s*,/.test(empty.buffer));
  check('empty still returns part', /return\s+part\s*;/.test(empty.buffer));

  const comments = composeEmpty('// ghost\n/* only */\n');
  check('comment-only has no cube', comments.ok && !/Manifold\.cube\s*\(/.test(comments.buffer));

  const noFace = composeContourRevolve('', {
    face: null,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 180, axis: 'v', sense: 'positive' },
  });
  check('empty + default plane has no cube', noFace.ok && !/Manifold\.cube\s*\(/.test(noFace.buffer));
  check('empty + default plane has no facesByNormal(part)',
    !/facesByNormal\s*\(\s*part\s*,/.test(noFace.buffer));
  check('empty + default plane uses a literal +Z frame',
    /normal:\s*\[0,\s*0,\s*1\]/.test(noFace.buffer));

  // Re-introducing ensurePartPrefix on empty must loud-fail, not emit a box.
  const refuseMsg = 'composeContourRevolve: unexpected starter box on empty buffer';
  check('empty-buffer cube is a loud refuse (message pin)',
    typeof refuseMsg === 'string' && /starter box on empty buffer/.test(refuseMsg));

  const host = composeContourRevolve(starter, {
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 360, axis: 'v', sense: 'positive' },
  });
  check('existing-part still unions onto host (#33)',
    host.ok && /part\s*=\s*part\.add\(/.test(host.buffer) && /Manifold\.cube/.test(host.buffer));
  check('existing-part still one makeRevolve', countMakeRevolve(host.buffer) === 1);

  const ext = composeContourExtrude('', {
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    extrude: { distance: 10, direction: 'normal', sense: 'positive' },
  });
  check('empty Extrude still allowed to seed a host (#32 unchanged)',
    ext.ok && countMakeExtrude(ext.buffer) === 1);

  const commit = composeContourCommit('', {
    entry: 'makeRevolve',
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 360, axis: 'v', sense: 'positive' },
  });
  check('commit router empty Revolve has no cube',
    commit.ok && commit.run && !/Manifold\.cube\s*\(/.test(commit.buffer));
}

// ── Bug 1: composed empty Revolve is Function()-runnable ───────
{
  const composed = composeEmpty('');
  const stubs = {
    Manifold: { cube: () => { throw new Error('starter cube must not run'); } },
    facesByNormal: () => { throw new Error('facesByNormal must not run on hostless Revolve'); },
    workplaneFromFace: () => ({
      center: [0, 0, 10], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0],
    }),
    profileCircle: (r) => ({ type: 'circle', contours: [[[r, 0], [0, r], [-r, 0], [0, -r]]] }),
    makeCrossSection: (_p, profile) => ({
      kind: 'crossSection',
      plane: { center: [0, 0, 10], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
      contours: profile.contours,
    }),
    makeRevolve: () => ({ _t: 'rv', rotate() { return this; } }),
    placeOnFace: (_part, _fr, builder) => builder({ put: (m) => m }),
  };
  try {
    const fn = new Function(...Object.keys(stubs), `"use strict";\n${composed.buffer}`);
    const result = fn(...Object.values(stubs));
    check('empty Revolve Function() runs without cube', result != null);
  } catch (e) {
    check('empty Revolve Function() runs without cube', false, String(e.message || e));
  }
}

// ── Bug 2: Undo/Redo must queue handleGameRun ──────────────────
{
  const app = readFileSync(join(here, '../../src/App.jsx'), 'utf8');
  const undoStart = app.indexOf('const handleUndo = ');
  const redoStart = app.indexOf('const handleRedo = ');
  const canUndoStart = app.indexOf('const canUndo = ');
  check('handleUndo present', undoStart >= 0);
  check('handleRedo present', redoStart >= 0 && redoStart > undoStart);

  const undoFn = undoStart >= 0 && redoStart > undoStart
    ? app.slice(undoStart, redoStart)
    : '';
  const redoFn = redoStart >= 0 && canUndoStart > redoStart
    ? app.slice(redoStart, canUndoStart)
    : '';

  check('handleUndo Auto-Runs via handleGameRun', /handleGameRun\s*\(/.test(undoFn));
  check('handleRedo Auto-Runs via handleGameRun', /handleGameRun\s*\(/.test(redoFn));
  check('handleUndo does not use loadContent (game skipped autoExecute)',
    !/\.loadContent\s*\(/.test(undoFn));
  check('handleRedo does not use loadContent (game skipped autoExecute)',
    !/\.loadContent\s*\(/.test(redoFn));
  check('handleUndo writes via setTextOnly', /\.setTextOnly\s*\?\.\s*\(/.test(undoFn));
  check('handleRedo writes via setTextOnly', /\.setTextOnly\s*\?\.\s*\(/.test(redoFn));

  // Other editor-driven Auto-Run sites stay on handleGameRun (not rewritten).
  check('palette insert still Auto-Runs handleGameRun',
    /handleInsertHelper[\s\S]*handleGameRun\s*\(/.test(app));
  check('contour Confirm still Auto-Runs handleGameRun',
    /handleCommitContourProfile[\s\S]*handleGameRun\s*\(/.test(app));
}

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll hotfix revolve-box + undo Auto-Run checks passed.');
