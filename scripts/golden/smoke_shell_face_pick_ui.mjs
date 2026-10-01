#!/usr/bin/env node
/**
 * Shell face-pick UI — Contour/Loft-style chip; opening = face (not axis).
 *
 * - shellMode enter / validate / compose → hollow() + SHELL markers
 * - Face pick emits { center, normal }; Closed emits 'none'
 * - HelperInsertPalette routes Shell into onEnterShellMode (not axis modal)
 * - ShellModeChip + Viewport / App wiring
 * - docs/POPUP_STYLE + UI_MAP mention ShellModeChip
 * - Strip chip kind `shell` still registered
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  composeHelperInsert,
  SHELL_BEGIN,
  SHELL_END,
} from '../../src/utils/helperPaletteSnippets.js';
import { parseFeatureMarkers, FEATURE_MARKER_KINDS } from '../../src/utils/featureMarkers.js';
import { classifySelectedFace } from '../../src/utils/faceFeaturePlacement.js';
import {
  enterShellState,
  validateShellAccept,
  composeShellCommit,
  hasShellBlock,
  isShellEntry,
  stripShellBlock,
} from '../../src/utils/shellMode.js';

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

console.log('shell face-pick UI');

{
  check('shell is a shell entry', isShellEntry('shell'));
  const markers = FEATURE_MARKER_KINDS.some((k) => k.kind === 'shell' && k.label === 'Shell');
  check('FEATURE_MARKER_KINDS has shell', markers);
  const strip = read('../../src/components/FeatureStrip.jsx');
  check('FeatureStrip icon PackageOpen', /shell:\s*PackageOpen/.test(strip));
}

{
  const pick = classifySelectedFace({
    center: [0, 0, 10],
    normal: [0, 0, 1],
    area: 400,
    triangleCount: 2,
    selectionMode: 'coplanar',
  });
  let state = enterShellState(pick);
  check('enter seeds face', state.lastFace?.normal?.[2] === 1);
  check('enter wall default 2.5', state.params.wall === 2.5);

  const empty = validateShellAccept(null, { wall: 2, openingMode: 'face' });
  check('face mode without pick refuses', !empty.ok);

  const closed = validateShellAccept(null, { wall: 2, openingMode: 'none' });
  check('Closed validates without face', closed.ok && closed.openScope === 'none');

  const faceGate = validateShellAccept(pick, { wall: 2.5, openingMode: 'face' });
  check('face pick validates', faceGate.ok && faceGate.openScope === 'selected');

  const faceCommit = composeShellCommit('', {
    face: pick,
    params: { wall: 2.5, openingMode: 'face' },
  });
  check('compose face ok', faceCommit.ok && faceCommit.run);
  check('compose has SHELL markers', faceCommit.buffer.includes(SHELL_BEGIN) && faceCommit.buffer.includes(SHELL_END));
  check(
    'compose emits face literal opening',
    /hollow\(\s*\w+,\s*2\.5,\s*\{\s*center:\s*\[0,\s*0,\s*10\],\s*normal:\s*\[0,\s*0,\s*1\]\s*\}\s*\)/.test(faceCommit.buffer),
    faceCommit.buffer,
  );
  const feats = parseFeatureMarkers(faceCommit.buffer);
  check(
    'parseFeatureMarkers → shell chip',
    feats.some((f) => f.kind === 'shell' && f.chipLabel === 'Shell'),
    `kinds=${feats.map((f) => f.kind).join(',')}`,
  );

  const closedCommit = composeShellCommit('', {
    params: { wall: 3, openingMode: 'none' },
  });
  check("Closed emits 'none'", /hollow\(\s*\w+,\s*3,\s*'none'\s*\)/.test(closedCommit.buffer), closedCommit.buffer);

  const appended = composeShellCommit(faceCommit.buffer, {
    face: pick,
    params: { wall: 1.5, openingMode: 'face' },
    commitMode: 'append',
  });
  check('append keeps prior shell block', hasShellBlock(appended.buffer)
    && (appended.buffer.match(/hollow\s*\(/g) || []).length === 2);

  const replaced = composeShellCommit(faceCommit.buffer, {
    params: { wall: 4, openingMode: 'none' },
    commitMode: 'replace',
  });
  check('replace strips prior shell', (replaced.buffer.match(/hollow\s*\(/g) || []).length === 1
    && /hollow\(\s*\w+,\s*4,\s*'none'\s*\)/.test(replaced.buffer));
  check('stripShellBlock clears', !hasShellBlock(stripShellBlock(faceCommit.buffer)));
}

{
  // Axis form still composes (worker API / goldens) — UI just does not offer it.
  const axis = composeHelperInsert('', 'shell', null, { wall: 2, openScope: 'z' });
  check("axis compose still works for API", /hollow\(\s*\w+,\s*2,\s*'z'\s*\)/.test(axis));
}

{
  const palette = read('../../src/components/HelperInsertPalette.jsx');
  check(
    'palette routes shell into shell mode',
    /item\.id === 'shell'/.test(palette)
      && /onEnterShellMode\(\{\s*entry:\s*'shell'\s*\}\)/.test(palette),
  );
  const chip = read('../../src/components/ShellModeChip.jsx');
  check('ShellModeChip exists', /data-shell-mode/.test(chip) && /shell-wall/.test(chip));
  check('chip uses Contour-style cyan glass', /bg-cyan-950\/80/.test(chip) && /surface-glass-chip/.test(chip));
  check('chip has Face / Closed segmented', /Opening/.test(chip) && /Closed/.test(chip));
  check('chip Confirm + grey X', /Confirm/.test(chip) && /<X /.test(chip));
  check('chip mobile max-h', /max-h-\[calc\(100dvh-12rem\)\]/.test(chip));

  const view = read('../../src/components/Viewport.jsx');
  check('Viewport imports ShellModeChip', /import ShellModeChip/.test(view));
  check('Viewport enterShellMode', /enterShellMode/.test(view) && /onEnterShellMode=\{enterShellMode\}/.test(view));
  check('Viewport onCommitShell', /onCommitShell/.test(view) && /acceptShell/.test(view));
  check('palette hidden in shell mode', /!shellMode/.test(view));

  const app = read('../../src/App.jsx');
  check('App handleCommitShell', /composeShellCommit/.test(app) && /onCommitShell=\{handleCommitShell\}/.test(app));

  const docs = read('../../docs/POPUP_STYLE.md');
  check('POPUP_STYLE documents ShellModeChip', /ShellModeChip/.test(docs));
  const uiMap = read('../../docs/UI_MAP.md');
  check('UI_MAP mentions ShellModeChip', /ShellModeChip/.test(uiMap));
}

if (failed) {
  console.log(`\n${failed} shell face-pick check(s) failed`);
  process.exit(1);
}
console.log('\nAll shell face-pick UI checks passed.');
