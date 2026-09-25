#!/usr/bin/env node
/**
 * CAD phone chrome uses the puzzle shell:
 * viewport on top, Monaco in the bottom budget, keyboard pin for both modes,
 * CAD actions in the mid-strip (not a viewport overlay), right rail vertical.
 * Game strip stays inline in CodeEditor. Desktop CAD keeps the overlay bar.
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

console.log('cad mobile chrome harmonized to puzzle');

{
  const app = read('../../src/App.jsx');
  check('phone editor is not a top 33vh pane', !/h-\[33vh\]/.test(app));
  check(
    'keyboard pin is not game-only',
    !/appMode === 'game' && keyboardOpen/.test(app),
  );
  check(
    'shell drops h-dvh only while the keyboard is open',
    /keyboardOpen \? '' : 'h-dvh'/.test(app),
  );
  check(
    'bottom budget matches the puzzle fractions',
    /vv\.height \* 0\.36/.test(app) && /vv\.height \* 0\.32/.test(app),
  );
  check(
    'game still mounts a blank editor',
    /initialScript=\{appMode === 'game' \? '' : editorInitialScript\}/.test(app),
  );
  check('AI prompt stays on mobile CAD', /appMode !== 'game' && \(\s*<PromptInput/.test(app));
}

{
  const view = read('../../src/components/Viewport.jsx');
  const editor = read('../../src/components/CodeEditor.jsx');
  const toolbar = read('../../src/components/Toolbar.jsx');
  const panel = read('../../src/components/CrossSectionPanel.jsx');

  check('phone right rail is vertical for both modes', /verticalRail=\{isMobile\}/.test(view));
  check('desktop CAD keeps the overlay toolbar', /variant="overlay"/.test(view));
  // Gate is the call-site, not the createPortal import. The Toolbar prop list
  // between variant="strip" and the host argument is longer than 400 chars.
  check(
    'mobile CAD portals the strip into the editor host',
    /mode !== 'game' && isMobile && cadToolbarHost && createPortal\(/.test(view) &&
    /variant="strip"[\s\S]{0,1200}?cadToolbarHost,?\s*\)/.test(view),
  );
  check('shared title chip', /function ViewportTitleChip/.test(view));
  check(
    'game title still falls back to Puzzle',
    /<ViewportTitleChip>\{gamePuzzleTitle \|\| 'Puzzle'\}<\/ViewportTitleChip>/.test(view),
  );
  check(
    'game strip still inline in the editor',
    /mode="game"/.test(editor) && /variant="strip"/.test(editor),
  );
  check('editor hosts the CAD strip only on mobile', /showCadStrip = !isGame && !!isMobile/.test(editor));
  check('CAD strip uses the dark mid-strip shell', /data-toolbar-variant="strip"/.test(toolbar));
  check('CAD strip does not collapse', /!isGame && !isStrip && isCollapsed/.test(toolbar));
  check(
    'vertical rail still has Face and Edge',
    /onPickModeChange\('face'\)/.test(panel) && /onPickModeChange\('edge'\)/.test(panel),
  );
  check(
    'view snaps open inward on the vertical rail',
    /popupAlign=\{verticalRail \? 'end' : 'start'\}/.test(panel),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll CAD mobile chrome checks passed.');
