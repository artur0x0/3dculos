#!/usr/bin/env node
/**
 * Mobile CAD feature bar: full-width row, Undo fixed at the start, Redo fixed
 * at the end, feature chips centered in the padded middle while they fit, and
 * the tail of the list once they overflow.
 *
 * Desktop seam and the Script vertical rail stay as they are. This checks
 * structure, not pixels.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { featureBarWindowMode } from '../../src/utils/featureBarLayout.js';

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

console.log('mobile feature bar: undo | centered features | redo');

{
  const app = read('../../src/App.jsx');
  const strip = read('../../src/components/FeatureStrip.jsx');
  const mounts = [...app.matchAll(/<FeatureStrip\b[\s\S]*?\/>/g)].map((m) => m[0]);
  const cad = mounts.find((m) => /orientation="horizontal"/.test(m));
  const script = mounts.find((m) => /handleFeatureStripJump/.test(m));
  const desktop = mounts.find((m) => /side="between"/.test(m));

  check('three FeatureStrip mounts (CAD bar, Script rail, desktop seam)', mounts.length === 3 && cad && script && desktop);

  const cadAt = app.indexOf('data-cad-feature-strip');
  const cadRow = cadAt < 0 ? '' : app.slice(Math.max(0, cadAt - 250), cadAt + 280);
  check(
    'CAD bar row is the full width of the row',
    /data-feature-bar-row="full"/.test(cadRow) &&
      /inset-x-0/.test(cadRow) &&
      !/justify-center/.test(cadRow),
  );
  check(
    'CAD bar wires the existing undo/redo handlers',
    /onUndo=\{handleUndo\}/.test(cad) &&
      /onRedo=\{handleRedo\}/.test(cad) &&
      /canUndo=\{canUndo\(\)\}/.test(cad) &&
      /canRedo=\{canRedo\(\)\}/.test(cad),
  );
  check(
    'Script rail and desktop seam do not take the bar handlers',
    !/onUndo/.test(script) && !/onRedo/.test(script) &&
      !/onUndo/.test(desktop) && !/onRedo/.test(desktop) &&
      /orientation="vertical"/.test(script) &&
      /orientation="vertical"/.test(desktop),
  );

  const undoAt = strip.indexOf('data-feature-bar-section="undo"');
  const featuresAt = strip.indexOf('data-feature-bar-section="features"');
  const redoAt = strip.indexOf('data-feature-bar-section="redo"');
  check(
    'horizontal bar is Undo, then features, then Redo',
    undoAt > 0 && featuresAt > undoAt && redoAt > featuresAt &&
      /data-feature-bar-layout="undo-features-redo"/.test(strip) &&
      /data-feature-bar-undo/.test(strip) &&
      /data-feature-bar-redo/.test(strip) &&
      /className="flex w-full min-w-0 flex-row items-center/.test(strip),
  );
  check(
    'undo and redo sections stay fixed; middle can shrink',
    /shrink-0 pl-\[max\(0\.5rem,env\(safe-area-inset-left\)\)\][\s\S]{0,80}data-feature-bar-section="undo"/.test(strip) &&
      /shrink-0 pr-\[max\(0\.5rem,env\(safe-area-inset-right\)\)\][\s\S]{0,80}data-feature-bar-section="redo"/.test(strip) &&
      /min-w-0 flex-1/.test(strip),
  );
  check(
    'middle section is padded on both sides and centered while the chips fit',
    /min-w-0 flex-1 px-3[\s\S]{0,80}data-feature-bar-section="features"/.test(strip) &&
      /overflow-x-auto rail-scroll/.test(strip) &&
      /featureWindow === 'tail' \? 'justify-start' : 'justify-center'/.test(strip) &&
      /data-feature-bar-section="features"/.test(strip) &&
      /data-feature-bar-justify=\{featureWindow === 'tail' \? 'tail' : 'center'\}/.test(strip),
  );
  check(
    'overflow window is the tail (latest features), not the head',
    /featureBarWindowMode/.test(strip) &&
      /featureWindow === 'tail' \? 'justify-start' : 'justify-center'/.test(strip) &&
      /scroller\.scrollLeft = max/.test(strip) &&
      /data-feature-bar-window=\{featureWindow\}/.test(strip),
  );
  check(
    'chips are unchanged (same marker buttons) and vertical rails still scroll to the last chip',
    /data-feature-chip=\{f\.kind\}/.test(strip) &&
      /onClick=\{\(\) => onJump\?\.\(f\)\}/.test(strip) &&
      /scrollIntoView/.test(strip) &&
      /overflow-x-auto rail-scroll/.test(strip) &&
      /data-feature-strip-orientation="vertical"/.test(strip) &&
      /data-feature-strip-side=\{stripSide\}/.test(strip),
  );
}

{
  check('fit when the chips are narrower than the middle', featureBarWindowMode(120, 200) === 'fit');
  check('fit on an exact fit (1px slop)', featureBarWindowMode(200, 200) === 'fit');
  check('tail when the chips overflow the middle', featureBarWindowMode(480, 200) === 'tail');
  check('fit when the middle has not been measured yet', featureBarWindowMode(80, 0) === 'fit');
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll mobile feature-bar layout checks passed.');
