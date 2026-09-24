#!/usr/bin/env node
/**
 * Regular CAD palette promotion + Plane/Contour overlay toggles.
 * - Profile, Workplane, Extrude, Revolve, Sweep, Loft stay one entry each.
 * - Game rail keeps them under Advanced. CAD rail shows them in Model, first,
 *   and does not also render Advanced.
 * - Fillet and Hole stay in Features.
 * - Plane and Contour display toggles default on, session-only, and gate
 *   overlay paint plus viewport picking. Face/Edge pick chrome stays.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  HELPER_PALETTE_GROUPS,
  itemsByGroup,
  paletteRailSections,
} from '../../src/utils/helperPaletteSnippets.js';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const PROMOTED = 'crossSection,workplane,makeExtrude,makeRevolve,makeSweep,makeLoft';

console.log('cad palette + plane/contour toggles');

{
  check(
    'data groups unchanged',
    HELPER_PALETTE_GROUPS.join('|') === 'Primitives|Advanced|Features|Transforms',
  );
  const grouped = itemsByGroup();
  check(
    'Advanced set unchanged',
    grouped.Advanced.map((i) => i.id).join(',') === PROMOTED,
  );
  check('Fillet stays in Features', grouped.Features.some((i) => i.id === 'filletEdges'));
  check('Hole stays in Features', grouped.Features.some((i) => i.id === 'hole'));

  const game = paletteRailSections('game', grouped);
  check(
    'game rail still Prim then Advanced',
    game.map((s) => s.key).join('|') === 'Primitives|Advanced|Features|Transforms',
  );
  check(
    'game Advanced is the promoted set',
    game.find((s) => s.key === 'Advanced').items.map((i) => i.id).join(',') === PROMOTED,
  );

  const cad = paletteRailSections('cad', grouped);
  check(
    'CAD rail is Model then Prim Feat Xform',
    cad.map((s) => s.key).join('|') === 'Model|Primitives|Features|Transforms',
    cad.map((s) => s.key).join('|'),
  );
  check(
    'CAD Model is the promoted set',
    cad.find((s) => s.key === 'Model').items.map((i) => i.id).join(',') === PROMOTED,
  );
  check('CAD does not render an Advanced section', !cad.some((s) => s.key === 'Advanced'));
  const cadIds = cad.flatMap((s) => s.items.map((i) => i.id));
  check('CAD has no duplicate tool ids', new Set(cadIds).size === cadIds.length);
  check(
    'CAD still has Fillet and Hole',
    cadIds.includes('filletEdges') && cadIds.includes('hole'),
  );
  check(
    'CAD Fillet is still under Features',
    cad.find((s) => s.key === 'Features').items.some((i) => i.id === 'filletEdges'),
  );
  check(
    'CAD Hole is still under Features',
    cad.find((s) => s.key === 'Features').items.some((i) => i.id === 'hole'),
  );
}

{
  const rail = readFileSync(join(here, '../../src/components/HelperInsertPalette.jsx'), 'utf8');
  const view = readFileSync(join(here, '../../src/components/Viewport.jsx'), 'utf8');
  const panel = readFileSync(join(here, '../../src/components/CrossSectionPanel.jsx'), 'utf8');

  check(
    'CAD layout is passed outside game',
    /layout=\{mode === 'game' \? 'game' : 'cad'\}/.test(view),
  );
  check('helper palette is not game-only', !/mode === 'game' && onInsertHelper/.test(view));
  check('contour rail is not game-only', !/mode === 'game' && contourMode/.test(view));
  check('palette uses paletteRailSections', /paletteRailSections\(/.test(rail));
  check('palette marks the section', /data-palette-section=\{section\.section\}/.test(rail));
  check('CAD model caption', /section\.key === 'Model' \? 'Model'/.test(rail));

  check(
    'Plane toggle in the right rail',
    /aria-label="Plane display"/.test(panel) && /data-overlay-toggle="plane"/.test(panel),
  );
  check(
    'Contour toggle in the right rail',
    /aria-label="Contour display"/.test(panel) && /data-overlay-toggle="contour"/.test(panel),
  );
  check(
    'toggles sit with Face/Edge',
    /aria-label="Pick mode"/.test(panel) && /aria-label="Plane and contour display"/.test(panel),
  );
  check(
    'toggles report pressed when on',
    /aria-pressed=\{!!showPlanes\}/.test(panel) && /aria-pressed=\{!!showContours\}/.test(panel),
  );
  check(
    'toggle defaults on',
    /showPlanes = true/.test(panel) && /showContours = true/.test(panel),
  );
  check(
    'highlighted class when on',
    /showPlanes[\s\S]{0,80}text-green-600 bg-green-100/.test(panel)
      && /showContours[\s\S]{0,80}text-green-600 bg-green-100/.test(panel),
  );
  check('mobile hit target on the new toggles', /min-h-11 min-w-11/.test(panel));
  check(
    'session state defaults on',
    /const \[showPlanes, setShowPlanes\] = useState\(true\)/.test(view)
      && /const \[showContours, setShowContours\] = useState\(true\)/.test(view),
  );
  check(
    'overlay visibility is not written to storage',
    !/showPlanes|showContours/.test(readFileSync(join(here, '../../src/utils/editorStorage.js'), 'utf8')),
  );

  check(
    'planes hidden skip construction-plane paint',
    /if \(!showPlanes\) \{\s*clearConstructionPlanes\(\)/.test(view),
  );
  check(
    'contours hidden skip saved-contour paint',
    /if \(!showContours\) \{\s*clearSavedContourGhosts\(\)/.test(view),
  );
  check('workplane overlay gated on Plane', /if \(showPlanes\) paintWorkplaneOverlay/.test(view));
  check(
    'saved contour pick gated',
    /showContoursRef\.current && contourModeRef\.current\?\.tool !== 'polyline'/.test(view),
  );
  check(
    'construction plane pick gated',
    /showPlanesRef\.current && constructionPlaneRef\.current/.test(view),
  );
  check(
    'Face/Edge pick handlers unchanged',
    /onPickModeChange\('face'\)/.test(panel) && /onPickModeChange\('edge'\)/.test(panel),
  );
  check(
    'standalone edge chip still hidden in contour and fillet',
    /pickMode === 'edge' && !contourMode && !filletMode/.test(view),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll CAD palette / overlay checks passed.');
