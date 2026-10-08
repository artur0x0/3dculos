#!/usr/bin/env node
/**
 * Sheet Metal is a Shape tool on the left rail, on the desktop shell and at
 * 390px (the mobile feature bar). One button: FoldVertical, after the other
 * Shape tools. The right-rail inspection group does not carry a second copy.
 *
 * Screenshots go to GOLDEN_SHOT_DIR or os.tmpdir(), never the artifacts dir.
 */
/* The evaluate callback runs in the browser, where document exists. */
/* global document, window */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { chromium } from 'playwright-core';

process.env.BROWSERSLIST_IGNORE_OLD_DATA = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const shotDir = process.env.GOLDEN_SHOT_DIR || tmpdir();

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('sheet metal: Shape group on desktop and the 390px feature bar');

{
  const palette = read('src/components/HelperInsertPalette.jsx');
  const panel = read('src/components/CrossSectionPanel.jsx');
  const view = read('src/components/Viewport.jsx');
  const snippets = read('src/utils/helperPaletteSnippets.js');
  const shapeAt = palette.indexOf("section.section === 'shape' && onOpenSheetMetal");
  const shapeBlock = shapeAt < 0 ? '' : palette.slice(shapeAt, shapeAt + 700);
  check('rail order stays Block, Build, Shape, Polish, Move',
    /CAD_RAIL_ORDER = \['Primitives', 'Build', 'Shape', 'Features', 'Transforms'\]/.test(snippets)
    && /Primitives: 'Block'/.test(palette)
    && /Build: 'Build'/.test(palette)
    && /Shape: 'Shape'/.test(palette)
    && /Features: 'Polish'/.test(palette)
    && /Transforms: 'Move'/.test(palette));
  check('Sheet Metal is the Shape button, orange FoldVertical',
    shapeAt > 0
    && /data-sheet-metal-button="1"/.test(shapeBlock)
    && /FoldVertical size=\{iconSize\}/.test(shapeBlock)
    && /text-orange-700 hover:bg-orange-100 active:bg-orange-200/.test(shapeBlock)
    && /aria-label="Sheet Metal: pick SendCutSend material and gauge"/.test(shapeBlock)
    && /onClick=\{\(\) => onOpenSheetMetal\(\)\}/.test(shapeBlock));
  check('Viewport opens the picker from the left rail, hidden in game',
    /onOpenSheetMetal=\{mode !== 'game' && onBindSheetMetal/.test(view)
    && /setSheetMetalPicker\(/.test(view)
    && !/onOpenSheetMetal=/.test(panel));
  check('the right rail has no Sheet Metal copy',
    !/data-sheet-metal-button/.test(panel)
    && !/data-sheet-metal-group="inspection"/.test(panel)
    && !/FoldVertical/.test(panel));
}

const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
check('system Chrome available for the rail render', !!exe, 'set CHROME_PATH');

if (exe && failed === 0) {
  const cssSrc = read('src/index.css');
  const processed = await postcss([
    tailwindcss({ config: join(ROOT, 'tailwind.config.js') }),
    autoprefixer(),
  ]).process(cssSrc, { from: join(ROOT, 'src/index.css') });

  const bundled = await build({
    stdin: {
      contents: `import { createRoot } from 'react-dom/client';
import HelperInsertPalette from './src/components/HelperInsertPalette.jsx';
import CrossSectionPanel from './src/components/CrossSectionPanel.jsx';

function Stage() {
  const compact = window.innerWidth <= 768;
  return (
    <div data-sheet-shape-stage="" data-compact={compact ? '1' : '0'} style={{ position: 'relative', width: '100vw', height: '100vh', background: '#1e1e1e' }}>
      <HelperInsertPalette
        layout="cad"
        compact={compact}
        onInsert={() => {}}
        onOpenSheetMetal={() => { window.__sheetOpened = (window.__sheetOpened || 0) + 1; }}
      />
      <CrossSectionPanel
        verticalRail
        showPaint
        paintActive={false}
        onPaintToggle={() => {}}
        enabled={false}
        onToggle={() => {}}
        onPlaneChange={() => {}}
        onZoomToFit={() => {}}
        onSnapView={() => {}}
      />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Stage />);
window.__sheetOpened = 0;
`,
      resolveDir: ROOT,
      loader: 'jsx',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  });

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${processed.css}</style></head>
<body style="margin:0;background:#1e1e1e">
<div id="root"></div>
<script>${bundled.outputFiles[0].text}</script>
</body></html>`;

  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const views = [
    ['390px mobile feature bar', '390', 390, 844],
    ['desktop feature strip', 'desktop', 1280, 800],
  ];
  try {
    mkdirSync(shotDir, { recursive: true });
    for (const [label, slug, width, height] of views) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForSelector('[data-palette-section="shape"]', { timeout: 8000 });
      const placed = await page.evaluate(() => {
        const sections = [...document.querySelectorAll('[data-palette-section]')];
        const shape = document.querySelector('[data-palette-section="shape"]');
        const buttons = [...document.querySelectorAll('[data-sheet-metal-button]')];
        const right = document.querySelector('[data-rail-pair="right"]');
        const shapeButtons = shape ? [...shape.querySelectorAll('button')] : [];
        const last = shapeButtons[shapeButtons.length - 1] || null;
        return {
          order: sections.map((el) => el.getAttribute('data-palette-section')),
          labels: sections.map((el) => (el.innerText || '').split('\n')[0].trim()),
          count: buttons.length,
          inShape: !!(shape && last && last === buttons[0] && shape.contains(buttons[0])),
          inRight: buttons.some((btn) => right && right.contains(btn)),
          orange: !!(last && last.className.includes('text-orange-700')),
          label: last ? last.getAttribute('aria-label') : '',
          compact: document.querySelector('[data-sheet-shape-stage]')?.getAttribute('data-compact'),
        };
      });
      check(`${label}: sections are Block, Build, Shape, Polish, Move`,
        placed.order.join(',') === 'primitives,build,shape,features,transforms'
        && placed.labels.join(',') === 'BLOCK,BUILD,SHAPE,POLISH,MOVE',
        JSON.stringify(placed));
      check(`${label}: Sheet Metal is the last Shape button and not on the right rail`,
        placed.count === 1 && placed.inShape && !placed.inRight && placed.orange
        && placed.label === 'Sheet Metal: pick SendCutSend material and gauge'
        && placed.compact === (width <= 768 ? '1' : '0'),
        JSON.stringify(placed));
      await page.click('[data-sheet-metal-button]');
      const opened = await page.evaluate(() => window.__sheetOpened);
      check(`${label}: the button opens sheet metal`, opened === 1, String(opened));
      const file = join(shotDir, `sheet-metal-shape-dark-${slug}.png`);
      await page.locator('[data-palette-section="shape"]').screenshot({ path: file });
      console.log(`  shot ${file}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll sheet-metal Shape checks passed');
