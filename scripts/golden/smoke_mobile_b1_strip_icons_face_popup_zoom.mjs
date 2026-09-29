#!/usr/bin/env node
/**
 * Slice Mobile B.1 — vertical feature strip icons + face popup center +
 * default-view zoom-out.
 *
 * Builds on Mobile B (#73). Strip is vertical with toolbar-matching icons;
 * face info popup removed by C.1;
 * view snaps use
 * VIEW_SNAP_MARGIN (1.35) so top/right/front/iso frame with more margin.
 * Non-goals: feature sheets (C), PWA (D), AI-on-pill, geometry highlight.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

console.log('mobile B.1: vertical strip icons + face popup under title + view zoom');

{
  const strip = read('../../src/components/FeatureStrip.jsx');
  const app = read('../../src/App.jsx');
  const viewport = read('../../src/components/Viewport.jsx');
  const camera = read('../../src/utils/viewCamera.js');
  const palette = read('../../src/components/HelperInsertPalette.jsx');

  check(
    'FeatureStrip is vertical (orientation attr + flex-col, not horizontal chip row)',
    /data-feature-strip-orientation="vertical"/.test(strip) &&
      /flex flex-col/.test(strip) &&
      !/overflow-x-auto/.test(strip),
  );
  check(
    'FeatureStrip chips use toolbar-matching icons (same set as HelperInsertPalette)',
    /ArrowUpFromLine/.test(strip) &&
      /Rotate3d/.test(strip) &&
      /Pyramid/.test(strip) &&
      /Route/.test(strip) &&
      /NotebookPen/.test(strip) &&
      /SquareRoundCorner/.test(strip) &&
      /TriangleRight/.test(strip) &&
      /FEATURE_ICONS/.test(strip) &&
      /makeExtrude:\s*ArrowUpFromLine/.test(palette) &&
      /filletEdges:\s*SquareRoundCorner/.test(palette),
  );
  check(
    'icon chips keep data-feature-chip + aria-label + onJump',
    /data-feature-chip=\{f\.kind\}/.test(strip) &&
      /aria-label=\{f\.chipLabel\}/.test(strip) &&
      /onClick=\{\(\) => onJump\?\.\(f\)\}/.test(strip),
  );
  check(
    'empty-state still present',
    /data-feature-strip-empty/.test(strip),
  );
  check(
    'safe-area / home-indicator clearance via bottom padding',
    /safe-area-inset-bottom/.test(strip) &&
      /pb-\[max\(3\.5rem/.test(strip),
  );
  check(
    'App mounts strip as left rail beside Monaco (flex-row), Script-stage jump intact',
    /flex flex-row/.test(app) &&
      /isScriptStage && \(/.test(app) &&
      /handleFeatureStripJump/.test(app) &&
      /<FeatureStrip[\s\S]*?script=\{currentScript\}/.test(app) &&
      // Slice C may also mount a CAD-stage strip for feature sheets (≤2 total).
      (() => {
        const n = (app.match(/<FeatureStrip\b/g) || []).length;
        return n >= 1 && n <= 2;
      })(),
  );
  // Slice Mobile C.1 removed the face-selected info popup (no empty reserved band).
  check(
    'face info popup removed (C.1)',
    !/data-face-info-popup/.test(viewport) &&
      !/Selected Face/.test(viewport),
  );
  check(
    'VIEW_SNAP_MARGIN exported and > Zoom-to-Fit default 1.15',
    /export const VIEW_SNAP_MARGIN = 1\.35/.test(camera) &&
      /margin = 1\.15/.test(camera),
  );
  check(
    'handleViewSnap + stageSnap default to VIEW_SNAP_MARGIN',
    /margin = VIEW_SNAP_MARGIN/.test(viewport) &&
      (viewport.match(/margin = VIEW_SNAP_MARGIN/g) || []).length >= 2,
  );
  check(
    'game puzzle framing still explicit 1.55 (not VIEW_SNAP_MARGIN)',
    /margin:\s*1\.55/.test(viewport) &&
      (viewport.match(/margin:\s*1\.55/g) || []).length >= 2,
  );
  check(
    'Zoom-to-Fit still uses fitView default (no VIEW_SNAP_MARGIN forced)',
    /fitView\(\{\s*camera: cameraRef\.current,\s*controls: controlsRef\.current,\s*geometry: resultRef\.current\.geometry\s*\}\)/.test(
      viewport.replace(/\s+/g, ' '),
    ),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll mobile B.1 strip / popup / zoom checks passed.');
