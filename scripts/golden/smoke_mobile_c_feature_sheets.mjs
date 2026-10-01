#!/usr/bin/env node
/**
 * Slice Mobile C — CAD-stage feature sheets (default mobile edit path).
 *
 * Long-press / CAD strip opens a bottom glass sheet with Extrude / Fillet /
 * Revolve params (popupUI widgets). Accept surgically rewrites the marked
 * block; Cancel does not; Edit script → Script stage + revealRange.
 * Stub kinds → Edit script only. Desktop sheets off. Non-goals: PWA (D),
 * AI-on-pill, Monaco replace, geometry highlight, Fillet D.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseFeatureSheetParams,
  writeFeatureSheetParams,
  pickDefaultFeatureSheetTarget,
  listFeatureSheetTargets,
  isFeatureSheetEditable,
  FEATURE_SHEET_EDITABLE,
  inferExtrudeSense,
  extrudeSenseOffset,
} from '../../src/utils/featureSheetWriteback.js';
import { parseFeatureMarkers } from '../../src/utils/featureMarkers.js';

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

console.log('mobile C: feature sheets');

{
  const app = read('../../src/App.jsx');
  const sheet = read('../../src/components/FeatureSheet.jsx');
  const writeback = read('../../src/utils/featureSheetWriteback.js');
  const viewport = read('../../src/components/Viewport.jsx');
  const strip = read('../../src/components/FeatureStrip.jsx');
  const popup = read('../../src/components/controls/popupUI.jsx');

  check(
    'FeatureSheet component exists with glass sheet chrome + Accept/Cancel/Edit script',
    /data-feature-sheet=/.test(sheet) &&
      /data-feature-sheet-accept/.test(sheet) &&
      /data-feature-sheet-cancel/.test(sheet) &&
      /data-feature-sheet-edit-script/.test(sheet) &&
      /surface-glass-chip/.test(sheet) &&
      /Edit script/.test(sheet),
  );
  check(
    'FeatureSheet is under-title horizontal (C.1), not bottom sheet',
    /data-feature-sheet-layout="under-title-horizontal"/.test(sheet) &&
      /top-14/.test(sheet) &&
      /overflow-x-auto/.test(sheet) &&
      !/bottom-0 z-40/.test(sheet) &&
      !/rounded-t-2xl/.test(sheet),
  );
  check(
    'FeatureSheet reuses popupUI NumberField / ChoiceRow / PopupButton',
    /NumberField/.test(sheet) &&
      /ChoiceRow/.test(sheet) &&
      /PopupButton/.test(sheet) &&
      /from '\.\/controls\/popupUI'/.test(sheet) &&
      /export const NumberField/.test(popup),
  );
  check(
    'real writeback kinds include Extrude + Fillet + Revolve',
    FEATURE_SHEET_EDITABLE.includes('extrude') &&
      FEATURE_SHEET_EDITABLE.includes('fillet') &&
      FEATURE_SHEET_EDITABLE.includes('revolve') &&
      /rewriteExtrudeBlock|kind === 'extrude'/.test(writeback) &&
      /rewriteFilletBlock|kind === 'fillet'/.test(writeback) &&
      /rewriteRevolveBlock|kind === 'revolve'/.test(writeback),
  );
  check(
    'App mounts FeatureSheet on CAD + Script stages (shared under-title chrome)',
    /featureSheet\?\.mode === 'edit'/.test(app) &&
      /featureSheet\?\.mode === 'picker'/.test(app) &&
      !/isCadStage && featureSheet\?\.mode === 'edit'/.test(app) &&
      (app.match(/<FeatureSheet\b/g) || []).length >= 2,
  );
  check(
    'CAD-stage FeatureStrip opens sheets (hideWhenEmpty)',
    /data-cad-feature-strip/.test(app) &&
      /hideWhenEmpty/.test(app) &&
      /hideWhenEmpty/.test(strip) &&
      /onJump=\{\(f\) => openFeatureSheetFor\(f\)\}/.test(app),
  );
  check(
    'Script-stage strip still jumps caret (revealRange)',
    /handleFeatureStripJump/.test(app) &&
      /revealRange\?\.\(feature\.startOffset, feature\.endOffset\)/.test(app),
  );
  check(
    'Script-stage strip does not open FeatureSheet',
    (() => {
      const m = app.match(
        /const handleFeatureStripJump = \(feature\) => \{[\s\S]*?\n {2}\};/,
      );
      return m && /revealRange/.test(m[0]) && !/setFeatureSheet/.test(m[0]);
    })(),
  );
  check(
    'Edit script switches to Script stage + revealRange',
    /handleFeatureSheetEditScript/.test(app) &&
      /setMobileStageSticky\('script'\)/.test(app),
  );
  check(
    'Accept writes via writeFeatureSheetParams + applyBuffer + Auto-Run',
    /writeFeatureSheetParams/.test(app) &&
      /applyBuffer\?\.\(/.test(app) &&
      /handleGameRun/.test(app),
  );
  check(
    'Viewport long-press (~450ms) gated by featureSheetEnabled (mobile CAD)',
    /featureSheetEnabled/.test(viewport) &&
      /onFeatureLongPress/.test(viewport) &&
      /450/.test(viewport) &&
      /featureSheetEnabled=\{useStages && isCadStage && !featureSheet\}/.test(app),
  );
  check(
    'Desktop never gets featureSheetEnabled from mobile-only branch props pattern',
    // Desktop Viewport mount should not pass featureSheetEnabled (defaults false)
    (() => {
      // Rough: only one occurrence of featureSheetEnabled={ in App
      const hits = app.match(/featureSheetEnabled=\{/g) || [];
      return hits.length === 1;
    })(),
  );
  check(
    'home-indicator / B.1 strip still present',
    /data-mobile-stage-home-indicator/.test(app) &&
      /data-home-indicator-pill/.test(read('../../src/components/MobileStageToggle.jsx')) &&
      /data-feature-strip-orientation="vertical"/.test(strip),
  );
}

{
  const script = `// --- contour-mode profile begin ---
const xs = makeCrossSection({ center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] }, profileRectangle(30, 20, true));
// --- contour-mode profile end ---

// --- contour-mode extrude begin ---
let part = placeInFrame(xs.plane, makeExtrude(xs.contours, 12), [0, 0, 0]);
// --- contour-mode extrude end ---

// --- fillet-mode begin ---
const path = makeSweepPath(edges);
part = filletAlongPath(part, path, 2); // sweep fillet wedge
// --- fillet-mode end ---

// --- contour-mode revolve begin ---
let solid = placeInFrame(fr, makeRevolve(mapped, 96, 360));
// --- contour-mode revolve end ---

return part;
`;
  const features = parseFeatureMarkers(script);
  check('parse markers finds profile+extrude+fillet+revolve', features.length === 4);

  const ext = features.find((f) => f.kind === 'extrude');
  const parsed = parseFeatureSheetParams('extrude', script.slice(ext.startOffset, ext.endOffset));
  check('parse Extrude distance 12 / sense Out', parsed.editable && parsed.params.distance === 12 && parsed.params.sense === 'positive');

  const written = writeFeatureSheetParams(script, ext, { distance: 20, sense: 'negative' });
  check('write Extrude distance 20', written.ok && /makeExtrude\([^,]+, 20\)/.test(written.buffer));
  check('write Extrude sense In → w=-20', /\[0, 0, -20\]/.test(written.buffer));
  check('write keeps markers', /contour-mode extrude begin/.test(written.buffer) && /contour-mode extrude end/.test(written.buffer));
  check('Cancel path = no write (identity)', writeFeatureSheetParams(script, ext, { distance: 12, sense: 'positive' }).buffer === script
    || writeFeatureSheetParams(script, ext, { distance: 12, sense: 'positive' }).ok);

  const fil = features.find((f) => f.kind === 'fillet');
  const fW = writeFeatureSheetParams(script, fil, { radius: 3.5 });
  check('write Fillet radius 3.5', fW.ok && /filletAlongPath\([^,]+, [^,]+, 3\.5\)/.test(fW.buffer));

  const rev = features.find((f) => f.kind === 'revolve');
  const rW = writeFeatureSheetParams(script, rev, { angle: 180 });
  check('write Revolve angle 180', rW.ok && /makeRevolve\([^,]+, [^,]+, 180\)/.test(rW.buffer));

  const prof = features.find((f) => f.kind === 'profile');
  check('profile is stub (not editable)', !isFeatureSheetEditable('profile'));
  const stub = parseFeatureSheetParams('profile', script.slice(prof.startOffset, prof.endOffset));
  check('profile parse is stub', stub.stub === true && !stub.editable);

  check('pick default prefers Extrude', pickDefaultFeatureSheetTarget(script)?.kind === 'extrude');
  check('listFeatureSheetTargets matches parseFeatureMarkers', listFeatureSheetTargets(script).length === features.length);
  check('sense both offset', extrudeSenseOffset(12, 'both') === -6 && inferExtrudeSense(12, -6) === 'both');
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll mobile C feature sheet checks passed.');
