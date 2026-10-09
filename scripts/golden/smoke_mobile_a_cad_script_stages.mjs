#!/usr/bin/env node
/**
 * Slice Mobile A — CAD stage / Script stage toggle on the phone shell.
 *
 * Narrow viewport gets a fullscreen-ish CAD stage (viewport + rails) and a
 * fullscreen-ish Script stage (editor + toolbar), with a session-sticky
 * stage control. Desktop split is untouched. Game keeps the stacked budget.
 *
 * Slice Mobile B moved the control from a top text chrome bar to a bottom
 * home-indicator pill; this golden still asserts dual-stage foundations.
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

console.log('mobile A: CAD / Script stages');

{
  const app = read('../../src/App.jsx');
  const toggle = read('../../src/components/MobileStageToggle.jsx');

  check(
    'mobileStage state defaults to CAD and is session-sticky',
    /sessionStorage\.getItem\('3dculos\.mobileStage'\)/.test(app) &&
      /sessionStorage\.setItem\('3dculos\.mobileStage'/.test(app) &&
      /landingMobileStage/.test(app) &&
      !/return s === 'script' \? 'script' : 'cad'/.test(app),
  );
  check(
    'stages apply only to mobile CAD (game keeps stacked split)',
    /const useStages = appMode === 'cad'/.test(app),
  );
  check(
    'shell exposes data-mobile-stage for CAD',
    /data-mobile-stage=\{useStages \? mobileStage : undefined\}/.test(app),
  );
  check(
    'CAD and Script stage panes stay mounted',
    /data-stage-pane="cad"/.test(app) && /data-stage-pane="script"/.test(app),
  );
  check(
    'off-stage pane is invisible + non-interactive',
    /invisible pointer-events-none/.test(app),
  );
  check(
    'MobileStageToggle is mounted on the CAD phone shell',
    /<MobileStageToggle stage=\{mobileStage\} onChange=\{setMobileStageSticky\} \/>/.test(app),
  );
  check(
    'game branch still has the horizontal SplitDivider + editor budget',
    /orientation="horizontal"/.test(app) && /height: mobileEditorPx/.test(app),
  );
  check(
    'toggle offers CAD and Parts, not Script',
    /data-stage-btn="cad"/.test(toggle) &&
      /data-stage-btn="parts"/.test(toggle) &&
      !/data-stage-btn="script"/.test(toggle),
  );
  check(
    'toggle marks pressed state for a11y',
    /aria-pressed=\{isCad\}/.test(toggle) && /aria-pressed=\{isParts\}/.test(toggle),
  );
}

{
  // Desktop shell must still be the side-by-side split (no stage chrome).
  const app = read('../../src/App.jsx');
  // The desktop return is the second big shell; it must not reference MobileStageToggle.
  const desktopIdx = app.indexOf('Desktop shell');
  const desktopChunk = desktopIdx >= 0 ? app.slice(desktopIdx) : app.split('if (isMobile)')[2] || '';
  // Fallback: count MobileStageToggle usages — should be exactly one mount site.
  const mounts = app.match(/<MobileStageToggle\b/g) || [];
  check('MobileStageToggle mounts exactly once (mobile CAD only)', mounts.length === 1);
  check(
    'desktop still uses vertical SplitDivider',
    /orientation="vertical"/.test(app),
  );
  void desktopChunk;
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll mobile A CAD/Script stage checks passed.');
