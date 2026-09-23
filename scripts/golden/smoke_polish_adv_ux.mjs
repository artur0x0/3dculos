#!/usr/bin/env node
/**
 * Polish — Advanced UX + loft fidelity.
 * - circle↔rect loft corners are sharp (no circle-segment bite)
 * - default plane is world +Z / XY; a picked face still wins
 * - Confirm exits contour mode (source)
 * - Sweep path selector lives inside the popup; standalone edge chip stays gated
 * - Workplane is a literal plane, not a host cube
 * - blank / construction-plane-only scripts clear the viewport
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Module from '../../built/manifold.js';
import {
  buildMakeLoftSolid,
  offsetPlaneFrame,
} from '../../src/utils/makeLoft.js';
import {
  activeContourFace,
  applyContourPlaneEdit,
  axisPresetFrame,
  composeContourLoft,
  enterContourState,
  orientPlaneFrame,
  planeFromContourFace,
} from '../../src/utils/contourMode.js';
import {
  composeHelperInsert,
  isConstructionPlaneOnlyScript,
  shouldClearViewportScript,
} from '../../src/utils/helperPaletteSnippets.js';
import { listConstructionPlanes } from '../../src/utils/savedContours.js';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('polish: advanced UX + loft corners');

const plane = {
  center: [0, 0, 0],
  normal: [0, 0, 1],
  x: [1, 0, 0],
  y: [0, 1, 0],
};

function circlePts(r, n = 32) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}

function rectPts(w, h) {
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
}

function pointSegDist(c, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  let t = l2 < 1e-12 ? 0 : ((c[0] - a[0]) * vx + (c[1] - a[1]) * vy) / l2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return Math.hypot(c[0] - (a[0] + t * vx), c[1] - (a[1] + t * vy));
}

function cornerGap(cs, corners) {
  const polys = typeof cs?.toPolygons === 'function' ? cs.toPolygons() : [];
  let worst = 0;
  for (const c of corners) {
    let best = Infinity;
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        best = Math.min(best, pointSegDist(c, poly[i], poly[(i + 1) % poly.length]));
      }
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

function xyExtent(cs) {
  const b = cs.bounds();
  return { x: b.max[0] - b.min[0], y: b.max[1] - b.min[1] };
}

const wasm = await Module();
wasm.setup();
const { Manifold, CrossSection } = wasm;

// ── AC1: circle ↔ rectangle corners + axis alignment ───────────
{
  const solid = buildMakeLoftSolid(Manifold, CrossSection, [
    { plane, contours: [circlePts(8, 32)] },
    { plane: offsetPlaneFrame(plane, 20), contours: [rectPts(20, 12)] },
  ]);
  const sl = solid.slice(19.8);
  const gap = cornerGap(sl, [[10, 6], [10, -6], [-10, 6], [-10, -6]]);
  const ext = xyExtent(sl);
  check(
    'circle→rect corner gap < 0.15 mm near the station',
    gap < 0.15,
    `gap=${gap.toFixed(4)}`,
  );
  check(
    'circle→rect end is axis-aligned 20×12 (not spun off the views)',
    Math.abs(ext.x - 20) < 0.25 && Math.abs(ext.y - 12) < 0.25,
    `ext=${ext.x.toFixed(3)}×${ext.y.toFixed(3)}`,
  );

  const cup = buildMakeLoftSolid(Manifold, CrossSection, [
    { plane, contours: [circlePts(46, 64)] },
    { plane: offsetPlaneFrame(plane, 125), contours: [rectPts(57, 57)] },
  ]);
  const top = cup.slice(124.2);
  const cupGap = cornerGap(top, [[28.5, 28.5], [28.5, -28.5], [-28.5, 28.5], [-28.5, -28.5]]);
  const cupExt = xyExtent(top);
  check(
    'Solo Cup circle→square corners stay sharp',
    cupGap < 0.4,
    `gap=${cupGap.toFixed(4)}`,
  );
  check(
    'Solo Cup square end is axis-aligned',
    Math.abs(cupExt.x - 57) < 0.6 && Math.abs(cupExt.y - 57) < 0.6,
    `ext=${cupExt.x.toFixed(2)}×${cupExt.y.toFixed(2)}`,
  );
}

// ── AC1: default frame is world +Z / XY; picked face still wins ─
{
  const profiles = [
    { tool: 'circle', params: { radius: 8, segments: 32 }, offset: 0 },
    { tool: 'rectangle', params: { width: 20, height: 12, centered: true }, offset: 20 },
  ];
  const def = composeContourLoft('', { face: null, profiles });
  check('default loft compose ok', def.ok === true, def.message || '');
  check(
    'default loft frame is world +Z / XY',
    /normal:\s*\[0,\s*0,\s*1\]/.test(def.buffer)
      && /x:\s*\[1,\s*0,\s*0\]/.test(def.buffer)
      && /y:\s*\[0,\s*1,\s*0\]/.test(def.buffer),
    def.buffer?.slice(0, 240) || '',
  );
  const entered = enterContourState('makeLoft', null);
  const face = activeContourFace(entered, null);
  const fr = planeFromContourFace(face);
  check(
    'active default face is +Z with X/Y axes',
    fr.normal[2] === 1 && fr.x[0] === 1 && fr.y[1] === 1 && fr.normal[0] === 0 && fr.normal[1] === 0,
  );

  const tilted = {
    type: 'planar',
    center: [0, 0, 4],
    normal: [0, 0, 1],
    area: 100,
    triangleCount: 2,
    selectionMode: 'coplanar',
    planeFrame: {
      center: [1, 2, 4],
      normal: [0, 0, 1],
      x: [1, 0, 0],
      y: [0, 1, 0],
    },
  };
  const picked = composeContourLoft('', { face: tilted, profiles });
  check(
    'picked face center is kept',
    picked.ok && /center:\s*\[1,\s*2,\s*4\]/.test(picked.buffer),
    picked.message || picked.buffer?.slice(0, 180) || '',
  );
}

// ── AC5: plane editor presets + angle sliders ──────────────────
{
  const st0 = enterContourState('makeExtrude', null);
  const zed = applyContourPlaneEdit(st0, { preset: 'z', base: axisPresetFrame('z', [0, 0, 0]) });
  check('Z preset normal is +Z', zed.planeFace.normal[2] === 1 && zed.planeFace.normal[0] === 0);
  check('Z preset x is +X', zed.planeFace.planeFrame.x[0] === 1 && zed.planeFace.planeFrame.y[1] === 1);
  const xed = applyContourPlaneEdit(st0, { preset: 'x' });
  check('X preset normal is +X', xed.planeFace.normal[0] === 1 && Math.abs(xed.planeFace.normal[2]) < 1e-9);
  const yed = applyContourPlaneEdit(st0, { preset: 'y' });
  check('Y preset normal is +Y', yed.planeFace.normal[1] === 1);
  const tilted = applyContourPlaneEdit(zed, {
    base: zed.planeBase,
    angles: { x: 0, y: 90, z: 0 },
  });
  check(
    'angle slider reorients the plane (Y 90° takes +Z toward +X)',
    Math.abs(tilted.planeFace.normal[0] - 1) < 1e-6
      && Math.abs(tilted.planeFace.normal[2]) < 1e-6,
    `n=${tilted.planeFace.normal.map((v) => v.toFixed(3)).join(',')}`,
  );
  const ident = orientPlaneFrame(plane, { x: 0, y: 0, z: 0 });
  check('zero angles leave the frame unchanged', ident.x[0] === 1 && ident.y[1] === 1 && ident.normal[2] === 1);
  const wp = applyContourPlaneEdit(st0, {
    preset: 'workplane',
    base: { center: [3, 0, 5], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
    angles: { x: 0, y: 0, z: 0 },
  });
  check(
    'picked workplane becomes the contour plane',
    wp.planePreset === 'workplane' && wp.planeFace.center[0] === 3 && wp.planeFace.center[2] === 5,
  );
}

// ── AC2 / AC3: Confirm exits; Sweep selector is inside the popup ─
{
  const view = readFileSync(join(here, '../../src/components/Viewport.jsx'), 'utf8');
  const confirmStart = view.indexOf('const confirmContourProfile = useCallback');
  const confirmEnd = view.indexOf('const exitFilletMode', confirmStart);
  const confirmBody = view.slice(confirmStart, confirmEnd);
  check('Confirm handler calls exitContourMode', /exitContourMode\(\)/.test(confirmBody));
  check(
    'standalone edge chip is hidden during contour mode',
    /pickMode === 'edge' && !contourMode && !filletMode/.test(view)
      && /data-edge-selector="standalone"/.test(view),
  );
  const chip = readFileSync(join(here, '../../src/components/ContourModeChip.jsx'), 'utf8');
  check('Sweep path selector is embedded in the popup', /data-sweep-path-selector="embedded"/.test(chip));
  check('plane editor exposes X/Y/Z and angle sliders', /data-plane-editor="1"/.test(chip) && /Plane angle/.test(chip));
  const palette = readFileSync(join(here, '../../src/components/HelperInsertPalette.jsx'), 'utf8');
  check(
    'Workplane tap inserts a plane without a param popup',
    /item\.id === 'workplane'/.test(palette) && /onInsert\?\.\('workplane'/.test(palette),
  );
  check(
    'blank script short-circuits before the worker',
    /shouldClearViewportScript\(script\)/.test(view) && /cleared:\s*true/.test(view),
  );
  const app = readFileSync(join(here, '../../src/App.jsx'), 'utf8');
  check('blank clear skips game compare', /run\.cleared/.test(app));
}

// ── AC4 / AC7: workplane is a plane; blank clears ──────────────
{
  const emptyWp = composeHelperInsert('', 'workplane');
  check('empty Workplane has no cube', emptyWp && !/Manifold\.cube\s*\(/.test(emptyWp));
  check('empty Workplane is a literal +Z frame',
    /normal:\s*\[0,\s*0,\s*1\]/.test(emptyWp) && /x:\s*\[1,\s*0,\s*0\]/.test(emptyWp));
  check('empty Workplane is plane-only', isConstructionPlaneOnlyScript(emptyWp));
  check('plane-only script clears the viewport', shouldClearViewportScript(emptyWp));
  const planes = listConstructionPlanes(emptyWp);
  check('plane-only script lists one selectable plane', planes.length === 1 && planes[0].plane.normal[2] === 1);

  const starter = 'let part = Manifold.cube([40, 30, 20], true);\nreturn part;\n';
  const onPart = composeHelperInsert(starter, 'workplane');
  check(
    'Workplane on an existing part adds no second cube',
    (onPart.match(/Manifold\.cube\s*\(/g) || []).length === 1,
  );
  check('Workplane on an existing part does not clear', shouldClearViewportScript(onPart) === false);

  check('empty string clears', shouldClearViewportScript(''));
  check('whitespace clears', shouldClearViewportScript('  \n\t'));
  check('comment-only clears', shouldClearViewportScript('// note\n/* x */'));
  check(
    'a real solid does not clear',
    shouldClearViewportScript('let part = Manifold.cube([1,1,1], true);\nreturn part;\n') === false,
  );
  check('null does not clear', shouldClearViewportScript(null) === false);
}

if (failed) {
  console.log(`\n${failed} polish check(s) failed`);
  process.exit(1);
}
console.log('\nAll polish advanced-UX checks passed.');
