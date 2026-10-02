#!/usr/bin/env node
/**
 * Desktop feature strip between editor and viewer panes.
 *
 * CAD desktop mounts a vertical FeatureStrip in the seam (editor | strip |
 * SplitDivider | viewport), starting below the measured editor ribbon.
 * Chips jump Monaco caret; feature sheets stay mobile-only. Mobile CAD/Script
 * strips must remain unchanged.
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

console.log('desktop: feature strip between panes');

{
  const app = read('../../src/App.jsx');
  const strip = read('../../src/components/FeatureStrip.jsx');

  check(
    'desktop shell mounts FeatureStrip with side=between',
    /data-desktop-feature-strip/.test(app) &&
      /data-feature-strip-placement="desktop-seam"/.test(app) &&
      /side="between"/.test(app) &&
      /orientation="vertical"/.test(app),
  );
  check(
    'desktop strip sits between editor column and SplitDivider',
    (() => {
      const iStrip = app.indexOf('data-desktop-feature-strip');
      const iDiv = app.indexOf('<SplitDivider orientation="vertical"');
      const iVp = app.indexOf('isMobile={false}', iDiv);
      return iStrip > 0 && iDiv > iStrip && iVp > iDiv;
    })(),
  );
  // Desktop now jumps the caret AND opens the sheet: both panes are visible,
  // so editing a feature and seeing its code is not the either/or it is on a
  // phone. The sheet renders inside the VIEWER, not over the script.
  check(
    'desktop jump reveals the code and opens the feature sheet',
    /handleDesktopFeatureStripJump/.test(app) &&
      /onJump=\{handleDesktopFeatureStripJump\}/.test(app) &&
      (() => {
        const m = app.match(
          /const handleDesktopFeatureStripJump = \(feature\) => \{[\s\S]*?\n {2}\};/,
        );
        if (!m) return false;
        return /revealRange/.test(m[0]) && /setFeatureSheet/.test(m[0]);
      })(),
  );
  check(
    'the desktop sheet is placed inside the viewer pane',
    /placement="viewport"/.test(app) &&
      app.indexOf('placement="viewport"') > app.indexOf('<SplitDivider orientation="vertical"'),
  );
  check(
    'the viewer pane is a positioning context for it',
    /<div className="relative flex-1 min-w-0">/.test(app),
  );
  check(
    'desktop Edit script reveals in place (no mobile stage switch)',
    (() => {
      const m = app.match(
        /const handleDesktopFeatureSheetEditScript = \(feature\) => \{[\s\S]*?\n {2}\};/,
      );
      return !!m && /revealRange/.test(m[0]) && !/setMobileStage/.test(m[0]);
    })(),
  );
  check(
    'the seam strip itself did not move',
    /data-feature-strip-placement="desktop-seam"/.test(app),
  );
  check(
    'desktop strip gated off in game mode',
    /appMode !== 'game' && \(\s*[\s\S]*?data-desktop-feature-strip/.test(app),
  );
  check(
    'FeatureStrip supports side=between / desktop-seam chrome',
    /stripSide === 'between'/.test(strip) || /side === 'between'/.test(strip) ||
      /between = stripSide === 'between'/.test(strip),
  );
  check(
    'FeatureStrip emits data-feature-strip-side between + desktop-seam',
    /data-feature-strip-placement=\{between \? 'desktop-seam'/.test(strip) &&
      /data-feature-strip-side=\{stripSide\}/.test(strip),
  );
  check(
    'mobile CAD + Script strips unchanged',
    /data-cad-feature-strip/.test(app) &&
      /data-script-feature-strip/.test(app) &&
      /data-feature-strip-placement="under-ribbon-horizontal"/.test(app) &&
      /handleFeatureStripJump/.test(app) &&
      /openFeatureSheetFor/.test(app),
  );
  check(
    'total FeatureStrip mounts = 3 (2 mobile + 1 desktop)',
    (() => {
      const n = (app.match(/<FeatureStrip\b/g) || []).length;
      return n === 3;
    })(),
  );
  check(
    'desktop strip starts below measured editor ribbon',
    /data-desktop-feature-strip/.test(app) &&
      /data-feature-strip-below-ribbon/.test(app) &&
      /data-feature-strip-ribbon-spacer/.test(app) &&
      /data-feature-strip-ribbon-spacer-h="measured"/.test(app) &&
      /style=\{\{ height: ribbonPx \}\}/.test(app),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll desktop feature-strip-between-panes checks passed.');
