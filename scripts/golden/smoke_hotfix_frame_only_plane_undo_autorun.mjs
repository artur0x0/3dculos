#!/usr/bin/env node
/**
 * Hotfix — frame-only plane Confirm + Undo/Redo Auto-Run.
 *
 * Bug 1 (leftover box): Confirm used placeOnFace(part, …) then part.add(…)
 * so the host (ensurePartPrefix 40×30×20 cube / puzzle box) stayed in `part`.
 * Locked rule: Plane = PlaneFrame { center, normal, x, y } — never a
 * Manifold / cube / scaffold. New-body Confirm emits
 * `part = placeInFrame(frame, solid)` (replace, not add).
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
  hasContourExtrudeBlock,
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

console.log('hotfix: frame-only plane + undo/redo Auto-Run');

const planarFace = {
  center: [0, 0, 10],
  normal: [0, 0, 1],
  area: 1200,
  triangleCount: 2,
  selectionMode: 'coplanar',
};
const face = resolveContourWorkplane(planarFace).face;
const starter = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n';

function composeEmptyRevolve(buffer = '') {
  return composeContourRevolve(buffer, {
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 360, axis: 'v', sense: 'positive' },
  });
}

function composeEmptyExtrude(buffer = '') {
  return composeContourExtrude(buffer, {
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    extrude: { distance: 10, direction: 'normal', sense: 'positive' },
  });
}

function noHostBox(buf) {
  return !/Manifold\.cube\s*\(/.test(buf)
    && !/part\s*=\s*part\.add\(/.test(buf)
    && !/placeOnFace\s*\(/.test(buf);
}

// ── Bug 1: empty-buffer Revolve is frame-only, no host box ────
{
  const empty = composeEmptyRevolve('');
  check('empty Revolve ok + Auto-Run', empty.ok && empty.run === true);
  check('empty Revolve has one makeRevolve', countMakeRevolve(empty.buffer) === 1);
  check('empty Revolve has markers', hasContourRevolveBlock(empty.buffer));
  check('empty Revolve has no host box', noHostBox(empty.buffer));
  check('empty Revolve has no width/depth/height starter consts',
    !/\bconst\s+width\s*=\s*40\b/.test(empty.buffer)
    && !/\bconst\s+depth\s*=\s*30\b/.test(empty.buffer));
  check('empty Revolve part is placeInFrame (replace)',
    /let\s+part\s*=\s*placeInFrame\s*\(/.test(empty.buffer));
  check('empty Revolve emits a literal PlaneFrame',
    /center:\s*\[0,\s*0,\s*10\]/.test(empty.buffer)
    && /normal:\s*\[0,\s*0,\s*1\]/.test(empty.buffer));
  check('empty Revolve still returns part', /return\s+part\s*;/.test(empty.buffer));
  check('empty Revolve has no Plane class / new Plane',
    !/\bnew\s+Plane\b/.test(empty.buffer) && !/\bclass\s+Plane\b/.test(empty.buffer));

  const comments = composeEmptyRevolve('// ghost\n/* only */\n');
  check('comment-only Revolve has no cube', comments.ok && noHostBox(comments.buffer));

  const noFace = composeContourRevolve('', {
    face: null,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 180, axis: 'v', sense: 'positive' },
  });
  check('empty + default plane has no cube', noFace.ok && noHostBox(noFace.buffer));
  check('empty + default plane has no facesByNormal(part)',
    !/facesByNormal\s*\(\s*part\s*,/.test(noFace.buffer));
  check('empty + default plane uses a literal +Z frame',
    /normal:\s*\[0,\s*0,\s*1\]/.test(noFace.buffer));

  const host = composeContourRevolve(starter, {
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 360, axis: 'v', sense: 'positive' },
  });
  check('existing-part Revolve replaces (no add)',
    host.ok
    && /part\s*=\s*placeInFrame\s*\(/.test(host.buffer)
    && !/part\s*=\s*part\.add\(/.test(host.buffer)
    && !/placeOnFace\s*\(/.test(host.buffer));
  check('existing-part still one makeRevolve', countMakeRevolve(host.buffer) === 1);

  const commit = composeContourCommit('', {
    entry: 'makeRevolve',
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    revolve: { angle: 360, axis: 'v', sense: 'positive' },
  });
  check('commit router empty Revolve has no host box',
    commit.ok && commit.run && noHostBox(commit.buffer));
}

// ── Bug 1: empty-buffer Extrude is the same replace path ──────
{
  const empty = composeEmptyExtrude('');
  check('empty Extrude ok + Auto-Run', empty.ok && empty.run === true);
  check('empty Extrude has one makeExtrude', countMakeExtrude(empty.buffer) === 1);
  check('empty Extrude has markers', hasContourExtrudeBlock(empty.buffer));
  check('empty Extrude has no host box', noHostBox(empty.buffer));
  check('empty Extrude part is placeInFrame (replace)',
    /let\s+part\s*=\s*placeInFrame\s*\(/.test(empty.buffer));

  const host = composeContourExtrude(starter, {
    face,
    tool: 'circle',
    params: { radius: 5, segments: 32 },
    extrude: { distance: 10, direction: 'normal', sense: 'positive' },
  });
  check('existing-part Extrude replaces (no add)',
    host.ok
    && /part\s*=\s*placeInFrame\s*\(/.test(host.buffer)
    && !/part\s*=\s*part\.add\(/.test(host.buffer));
}

// ── Bug 1: composed empty Revolve is Function()-runnable ───────
{
  const composed = composeEmptyRevolve('');
  const stubs = {
    Manifold: { cube: () => { throw new Error('starter cube must not run'); } },
    facesByNormal: () => { throw new Error('facesByNormal must not run on hostless Revolve'); },
    workplaneFromFace: () => { throw new Error('workplaneFromFace must not query a host'); },
    profileCircle: (r) => ({ type: 'circle', contours: [[[r, 0], [0, r], [-r, 0], [0, -r]]] }),
    makeCrossSection: (_p, profile) => ({
      kind: 'crossSection',
      plane: { center: [0, 0, 10], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
      contours: profile.contours,
    }),
    makeRevolve: () => ({ _t: 'rv', rotate() { return this; } }),
    placeInFrame: (_fr, solid) => solid,
    transformByFrame: (_fr, solid) => solid,
    placeOnFace: () => { throw new Error('placeOnFace must not run on new-body Confirm'); },
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
  check('handleUndo writes via setTextOnly', /\.setTextOnly\s*\?\.?\s*\(/.test(undoFn));
  check('handleRedo writes via setTextOnly', /\.setTextOnly\s*\?\.?\s*\(/.test(redoFn));

  check('palette insert still Auto-Runs handleGameRun',
    /handleInsertHelper[\s\S]*handleGameRun\s*\(/.test(app));
  check('contour Confirm still Auto-Runs handleGameRun',
    /handleCommitContourProfile[\s\S]*handleGameRun\s*\(/.test(app));
}

if (failed) {
  console.error(`\nFAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('\nAll hotfix frame-only plane + undo Auto-Run checks passed.');
