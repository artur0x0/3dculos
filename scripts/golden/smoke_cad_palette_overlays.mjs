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
  composeHelperInsert,
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
    'CAD rail is Block, Model, Polish, Move',
    cad.map((s) => s.key).join('|') === 'Primitives|Model|Features|Transforms',
    cad.map((s) => s.key).join('|'),
  );
  check(
    'CAD Model is the promoted set',
    cad.find((s) => s.key === 'Model').items.map((i) => i.id).join(',') === PROMOTED,
  );
  check('CAD does not render an Advanced section', !cad.some((s) => s.key === 'Advanced'));
  // The dedicated Path button is gone; Sweep covers it. The item survives for
  // programmatic composition, so assert the *rail* drops it while the data
  // model keeps it.
  for (const [name, sections] of [['CAD', cad], ['game', game]]) {
    check(
      `${name} rail has no Path button`,
      !sections.flatMap((s) => s.items).some((i) => i.id === 'sweepPath'),
    );
  }
  check('sweepPath is still a palette item', grouped.Features.some((i) => i.id === 'sweepPath'));

  // ── One Array button, two patterns ──
  {
    const railIds = cad.flatMap((s) => s.items.map((i) => i.id));
    check('no separate Polar button', !railIds.includes('polarArray') && railIds.includes('array3D'));
    check(
      'polarArray survives as a hidden item',
      grouped.Transforms.find((i) => i.id === 'polarArray')?.railHidden === true,
    );
    const array = grouped.Transforms.find((i) => i.id === 'array3D');
    const typeParam = array.params.find((p) => p.name === 'arrayType');
    check('Array has a Grid/Polar type param', !!typeParam
      && typeParam.options.map((o) => o.value).join(',') === 'grid,polar');
    check(
      'grid params are hidden under Type=Polar and vice versa',
      array.params.find((p) => p.name === 'nx').showWhen.values.join() === 'grid'
        && array.params.find((p) => p.name === 'boltCircleRadius').showWhen.values.join() === 'polar',
    );
    const gridBuf = composeHelperInsert('', 'array3D', null, { arrayType: 'grid', nx: 3 });
    check('Type=Grid emits array3D', /array3D\(/.test(gridBuf) && !/polarArray\(/.test(gridBuf));
    const polarBuf = composeHelperInsert('', 'array3D', null, { arrayType: 'polar', count: 6 });
    check('Type=Polar emits polarArray', /polarArray\([^)]*6/.test(polarBuf) && !/array3D\(/.test(polarBuf));
    check('both Array types stay parseable', [gridBuf, polarBuf].every((b) => {
      try { new Function(b); return true; } catch { return false; }
    }));
  }

  // ── Draft is Polish now, and the rail reads Block → Model → Polish → Move ──
  {
    const polish = cad.find((s) => s.key === 'Features').items.map((i) => i.id);
    check('Draft sits in Polish', polish.includes('addDraft'));
    const move = cad.find((s) => s.key === 'Transforms').items.map((i) => i.id);
    check('Move no longer carries Draft', !move.includes('addDraft'));
  }
  check(
    'sweepPath is hidden by the railHidden flag, not by deletion',
    grouped.Features.find((i) => i.id === 'sweepPath').railHidden === true,
  );
  for (const id of ['clearanceHole', 'tapDrillHole', 'cboreHole', 'cskHole']) {
    check(`${id} stays in the data model`, grouped.Features.some((i) => i.id === id));
    check(`${id} is railHidden`, grouped.Features.find((i) => i.id === id).railHidden === true);
    for (const [name, sections] of [['CAD', cad], ['game', game]]) {
      check(
        `${name} rail has no ${id} button`,
        !sections.flatMap((s) => s.items).some((i) => i.id === id),
      );
    }
  }
  const hole = grouped.Features.find((i) => i.id === 'hole');
  check('Hole type is clearance or tap drill',
    (hole.params.find((p) => p.name === 'holeType').options || []).map((o) => (o && o.value) || o).join(',')
      === 'clearance,tapDrill');
  check('Hole has near and far end options',
    hole.params.some((p) => p.name === 'nearEnd') && hole.params.some((p) => p.name === 'farEnd'));
  check(
    'Create contour is the crossSection label',
    grouped.Advanced.find((i) => i.id === 'crossSection').label === 'Create contour',
  );
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
    'Patch overlay toggle in the right rail',
    /aria-label="Patch colour overlay"/.test(panel) && /data-overlay-toggle="patches"/.test(panel),
  );
  check(
    'toggles sit with Face/Edge',
    /aria-label="Pick mode"/.test(panel) && /aria-label="Plane, contour, and patch display"/.test(panel),
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
  check(
    'Plane/Contour use Face/Edge button chrome (no extra hit box)',
    /onShowPlanesChange[\s\S]{0,220}className=\{`p-2 rounded \$\{/.test(panel)
      && /onShowContoursChange[\s\S]{0,220}className=\{`p-2 rounded \$\{/.test(panel)
      && !/min-h-11 min-w-11/.test(panel),
  );
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
  check('workplane overlay gated on Plane',
    /if \(showPlanes \|\| isWorkplaneEntry\(contourMode\.entry\)\) paintWorkplaneOverlay/.test(view));
  check(
    'saved contour pick gated',
    /showContoursRef\.current && !moveModeRef\.current && contourModeRef\.current\?\.tool !== 'polyline'/.test(view)
      && /!cutModeRef\.current && showContoursRef\.current/.test(view),
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
    'selector groups have a modest gap',
    /flex gap-1[\s\S]{0,240}data-selector-group="pick-mode"/.test(panel)
      && /flex gap-1[\s\S]{0,240}data-selector-group="plane-contour"/.test(panel),
  );
  check(
    'standalone edge chip still hidden in contour and fillet',
    /pickMode === 'edge' && !contourMode && !filletMode/.test(view),
  );
}

// ── Shapes APPEND onto the part, they never replace it ──
// This was a real bug: every primitive emitted `part = <newShape>` when a part
// already existed, so a second shape silently stranded the first as dead code
// while Extrude / Revolve / Loft / Sweep were correctly doing `part.add(...)`.
{
  const SHAPES = ['cube', 'roundedBox', 'cylinder', 'sphere', 'tube', 'hexPrism'];
  for (const id of SHAPES) {
    const first = composeHelperInsert('', id, null, {});
    check(`${id} on an empty script declares the part`, /let part = /.test(first));
    const second = composeHelperInsert(first, id === 'cube' ? 'cylinder' : 'cube', null, {});
    check(`${id} + another shape unions instead of overwriting`,
      /part = part\.add\(/.test(second));
    // The first solid must still be reachable, not stranded above a reassign.
    const reassigned = second.match(/^part = (?!part\.add)/gm) || [];
    check(`${id} leaves no orphaned solid`, reassigned.length === 0, second);
    check(`${id} chain stays parseable`, (() => {
      try { new Function(second); return true; } catch { return false; }
    })());
  }
  // Three shapes deep, every one of them still in the tree.
  let buf = composeHelperInsert('', 'cube', null, {});
  buf = composeHelperInsert(buf, 'cylinder', null, {});
  buf = composeHelperInsert(buf, 'sphere', null, {});
  check('three shapes compose into two unions',
    (buf.match(/part = part\.add\(/g) || []).length === 2);
  check('the one-shot solid entries append too', ['makeExtrude', 'makeRevolve', 'makeLoft']
    .every((id) => /part = part\.add\(/.test(composeHelperInsert(
      composeHelperInsert('', 'cube', null, {}), id, null, {},
    ))));
}

// ── Hole absorbs Hole grid ──
{
  const feats = itemsByGroup().Features;
  const hole = feats.find((i) => i.id === 'hole');
  check('Hole has the n×m pattern option',
    hole.params.some((p) => p.name === 'usePattern')
      && ['n', 'm', 'spacingU', 'spacingV'].every((n) => hole.params.some((p) => p.name === n)));
  const railIds = paletteRailSections('cad').flatMap((s) => s.items.map((i) => i.id));
  check('no separate Hole grid button', !railIds.includes('holePattern'));
  check('holePattern survives as a hidden item',
    feats.find((i) => i.id === 'holePattern')?.railHidden === true);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll CAD palette / overlay checks passed.');
