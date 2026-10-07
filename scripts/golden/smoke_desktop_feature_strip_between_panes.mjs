#!/usr/bin/env node
/**
 * Desktop feature strip on the CAD viewer (horizontal under title).
 *
 * Replaces the old vertical seam strip between editor and viewer.
 * Chips jump Monaco caret + open the feature sheet in the viewer.
 * Mobile CAD/Script strips must remain unchanged.
 * Script toolbar mounts the same ProfileChip as CAD/Parts.
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

console.log('desktop: feature strip on CAD viewer');

{
  const app = read('../../src/App.jsx');
  const strip = read('../../src/components/FeatureStrip.jsx');
  const editor = read('../../src/components/CodeEditor.jsx');
  const viewport = read('../../src/components/Viewport.jsx');
  const feed = read('../../src/components/PartFeed.jsx');

  check(
    'desktop shell mounts horizontal FeatureStrip on CAD viewer',
    /data-desktop-feature-strip/.test(app) &&
      /data-feature-strip-placement="viewer-under-title-horizontal"/.test(app) &&
      /data-cad-feature-strip="desktop"/.test(app) &&
      /orientation="horizontal"/.test(app) &&
      !/data-feature-strip-placement="desktop-seam"/.test(app) &&
      !/side="between"/.test(app),
  );
  check(
    'desktop strip overlays the viewer pane (after SplitDivider)',
    (() => {
      const iDiv = app.indexOf('<SplitDivider orientation="vertical"');
      const iStrip = app.indexOf('data-desktop-feature-strip');
      const iVp = app.indexOf('isMobile={false}', iDiv);
      return iDiv > 0 && iStrip > iDiv && iVp > iStrip;
    })(),
  );
  check(
    'no vertical seam strip between editor and viewer',
    !/data-feature-strip-placement="desktop-seam"/.test(app) &&
      !/data-feature-strip-ribbon-spacer/.test(app) ||
      // mobile script still has ribbon spacer attrs
      (() => {
        // desktop-specific: no spacer tied to data-desktop-feature-strip
        const i = app.indexOf('data-desktop-feature-strip');
        const chunk = app.slice(i, i + 800);
        return !/data-feature-strip-ribbon-spacer/.test(chunk);
      })(),
  );
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
    'desktop strip gated off in game mode',
    /appMode !== 'game' && \(\s*[\s\S]*?data-desktop-feature-strip/.test(app),
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
    'total FeatureStrip mounts = 3 (2 mobile + 1 desktop viewer)',
    (() => {
      const n = (app.match(/<FeatureStrip\b/g) || []).length;
      return n === 3;
    })(),
  );
  check(
    'Script toolbar mounts same ProfileChip (CAD/Parts/Script unify)',
    /data-script-profile-chip/.test(editor) &&
      /ProfileChip variant="inline"/.test(editor) &&
      /onAccount/.test(editor) &&
      /data-parts-profile-chip/.test(feed) &&
      /ProfileChip variant="viewport"/.test(viewport),
  );
  check(
    'FeatureStrip still supports horizontal CAD chrome',
    /orientation === 'horizontal'/.test(strip) || /horizontal = orientation === 'horizontal'/.test(strip),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll desktop CAD-viewer feature-strip checks passed.');
