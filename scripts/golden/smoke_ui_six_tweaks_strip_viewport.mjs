#!/usr/bin/env node
/**
 * UI six-tweaks: feature-strip scrollbar + auto-scroll, clear chip highlight,
 * Script jump-only, viewport #1e1e1e backdrop, mobile popup max-height.
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

console.log('ui six-tweaks: strip / highlight / viewport / popup height');

{
  const app = read('../../src/App.jsx');
  const strip = read('../../src/components/FeatureStrip.jsx');
  const sheet = read('../../src/components/FeatureSheet.jsx');
  const contour = read('../../src/components/ContourModeChip.jsx');
  const fillet = read('../../src/components/FilletModeChip.jsx');
  const helper = read('../../src/components/HelperParamModal.jsx');
  const viewport = read('../../src/components/Viewport.jsx');
  const css = read('../../src/index.css');

  // 1 — visible rail-scroll (no no-scrollbar on FeatureStrip)
  check(
    '1: FeatureStrip uses rail-scroll (no no-scrollbar)',
    /rail-scroll/.test(strip) &&
      !/no-scrollbar/.test(strip) &&
      /overflow-x-auto rail-scroll/.test(strip),
  );
  check(
    '1: rail-scroll styles horizontal thumb height',
    /\.rail-scroll::-webkit-scrollbar[\s\S]*?height:\s*8px/.test(css),
  );

  // 2 — auto-scroll to last feature
  check(
    '2: FeatureStrip auto-scrolls to last chip on list change',
    /scrollRef/.test(strip) &&
      /lastFeatureId/.test(strip) &&
      /scrollIntoView/.test(strip) &&
      /features\.length/.test(strip),
  );

  // 3 — clear highlight on cancel/accept
  check(
    '3: closeFeatureSheet clears featureStripActiveId',
    (() => {
      const m = app.match(/const closeFeatureSheet = \(\) => \{[\s\S]*?\n {2}\};/);
      return m && /setFeatureSheet\(null\)/.test(m[0]) && /setFeatureStripActiveId\(null\)/.test(m[0]);
    })(),
  );
  check(
    '3: handleFeatureSheetAccept clears featureStripActiveId',
    (() => {
      const m = app.match(/const handleFeatureSheetAccept = \(feature, params\) => \{[\s\S]*?\n {2}\};/);
      return m && /setFeatureStripActiveId\(null\)/.test(m[0]);
    })(),
  );

  // 4 — Script jump-only (no FeatureSheet)
  check(
    '4: handleFeatureStripJump is caret-only (no setFeatureSheet)',
    (() => {
      const m = app.match(/const handleFeatureStripJump = \(feature\) => \{[\s\S]*?\n {2}\};/);
      if (!m) return false;
      return /revealRange/.test(m[0]) && !/setFeatureSheet/.test(m[0]);
    })(),
  );
  check(
    '4: CAD strip still opens FeatureSheet via openFeatureSheetFor',
    /onJump=\{\(f\) => openFeatureSheetFor\(f\)\}/.test(app),
  );

  // 5 — viewport backdrop #1e1e1e
  check(
    '5: viewport-shell CSS backdrop is #1e1e1e',
    /viewport-shell[^"]*bg-\[#1e1e1e\]/.test(viewport) ||
      /className="viewport-shell relative w-full h-full bg-\[#1e1e1e\]/.test(viewport),
  );
  check(
    '5: Three.js scene.background + setClearColor use 0x1e1e1e',
    /scene\.background = new Color\(0x1e1e1e\)/.test(viewport) &&
      /setClearColor\(0x1e1e1e/.test(viewport),
  );

  // 6 — mobile popup max-height + internal scroll
  check(
    '6: ContourModeChip mobile max-h + scroll body',
    /max-h-\[calc\(100dvh-12rem\)\]/.test(contour) &&
      /data-contour-chip-scroll/.test(contour) &&
      /overflow-y-auto rail-scroll/.test(contour),
  );
  check(
    '6: FeatureSheet SheetShell max-h + rail-scroll body',
    /max-h-\[calc\(100dvh-10rem\)\]/.test(sheet) &&
      /data-feature-sheet-scroll/.test(sheet),
  );
  check(
    '6: HelperParamModal / FilletModeChip respect dvh cap',
    /max-h-\[min\(70%,calc\(100dvh-11rem\)\)\]/.test(helper) &&
      /max-h-\[calc\(100dvh-12rem\)\]/.test(fillet),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll ui six-tweaks checks passed.');
