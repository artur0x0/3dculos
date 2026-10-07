#!/usr/bin/env node
/**
 * SCS S2 — base-flange wizard. Start → planes highlight → tap plane → x/y
 * popup (Accept / Back / ✕) → Accept writes one sheet-metal block whose
 * solid is the base flange at SKU thickness on that plane.
 */
import { readFileSync } from 'node:fs';
import { joinScsCatalog, findScsSku } from '../../src/utils/scs/scsCatalog.js';
import {
  enterSheetMetalMode,
  pickSheetPlane,
  setBaseDims,
  backToPlanePick,
  acceptBaseFlange,
  baseDraftSpec,
  BASE_MAX,
} from '../../src/utils/sheetMetal/sheetMetalMode.js';
import { createSheetSpec, SHEET_PLANES } from '../../src/utils/sheetMetal/sheetModel.js';
import {
  composeSheetMetalCommit,
  readSheetMetalSpec,
  sheetMetalBlock,
  SHEET_METAL_BEGIN,
} from '../../src/utils/sheetMetal/sheetMetalScript.js';
import { parseFeatureMarkers } from '../../src/utils/featureMarkers.js';
import { newPartStarterScript } from '../../src/utils/helperPaletteSnippets.js';
import { buildSheetOverlay, sheetPickFromHits } from '../../src/utils/sheetMetal/sheetOverlay.js';
import { Raycaster, Vector3 } from 'three';
import { loadSandbox } from './scs_sandbox.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(read(`scripts/golden/fixtures/scs/${name}.json`));
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const { records } = joinScsCatalog(fixture('catalog'), fixture('specs'));
const alu = findScsSku(records, 'ALU-090');

console.log('SCS S2 — wizard transitions');
let mode = enterSheetMetalMode(alu, 'p1');
check('Start → plane stage', mode.stage === 'plane' && mode.spec === null);
check('unknown plane ignored', pickSheetPlane(mode, 'QQ') === mode);
mode = pickSheetPlane(mode, 'XZ');
check('tap plane → base popup with defaults', mode.stage === 'base' && mode.base.plane === 'XZ'
  && mode.base.width === 100 && mode.base.height === 60);
mode = setBaseDims(mode, { width: 120, height: '' });
check('x edits; blank y keeps value', mode.base.width === 120 && mode.base.height === 60);
check('dims clamp', setBaseDims(mode, { width: 99999 }).base.width === BASE_MAX && setBaseDims(mode, { height: -4 }).base.height === 1);
const back = backToPlanePick(mode);
check('Back → plane pick in one tap, dims kept', back.stage === 'plane' && back.base.width === 120);
const again = pickSheetPlane(back, 'XY');
check('re-pick keeps dims on the new plane', again.base.plane === 'XY' && again.base.width === 120);
const draft = baseDraftSpec(mode);
check('preview spec at SKU thickness', near(draft.t, 2.286) && near(draft.r, 0.8128) && draft.k === 0.37 && draft.plane === 'XZ');
check('limits embedded for offline DFM', near(draft.limits.minFlange, 0.326 * 25.4) && draft.limits.maxAngle === 130 && draft.limits.bendable);
const { mode: edit, spec } = acceptBaseFlange(mode);
check('Accept → edit stage + spec', edit.stage === 'edit' && spec.width === 120 && spec.height === 60 && edit.tool === 'bend');
const reenter = enterSheetMetalMode(findScsSku(records, 'ALU-063'), 'p1', spec);
check('re-entry with a spec skips to edit, re-thickness to new SKU', reenter.stage === 'edit'
  && near(reenter.spec.t, 0.063 * 25.4) && reenter.spec.width === 120 && reenter.spec.sku === 'ALU-063');

console.log('SCS S2 — script block');
{
  const starter = newPartStarterScript();
  const res = composeSheetMetalCommit(starter, spec);
  check('starter cube is replaced by the block', res.ok && res.buffer.startsWith(SHEET_METAL_BEGIN) && !/Manifold\.cube/.test(res.buffer));
  check('spec round-trips', JSON.stringify(readSheetMetalSpec(res.buffer)) === JSON.stringify(spec));
  const wider = { ...spec, width: 150 };
  const res2 = composeSheetMetalCommit(`// header\n${res.buffer}// tail\n`, wider);
  check('existing block is replaced in place', res2.ok && res2.buffer.startsWith('// header\n')
    && res2.buffer.includes('// tail') && readSheetMetalSpec(res2.buffer).width === 150
    && res2.buffer.split(SHEET_METAL_BEGIN).length === 2);
  check('busy part refuses', !composeSheetMetalCommit('let part = Manifold.sphere(4);', spec).ok);
  const chips = parseFeatureMarkers(sheetMetalBlock(spec));
  check('feature strip shows a Sheet chip', chips.length === 1 && chips[0].kind === 'sheetMetal' && chips[0].label === 'Sheet');
}

console.log('SCS S2 — solid on each plane (real sandbox)');
{
  const { exec } = await loadSandbox();
  for (const plane of Object.keys(SHEET_PLANES)) {
    const s = createSheetSpec(alu, plane, { width: 100, height: 60 });
    const res = await exec(`${sheetMetalBlock(s)}\nreturn part;`);
    const size = res.boundingBox.max.map((v, i) => v - res.boundingBox.min[i]);
    const sorted = [...size].sort((a, b) => a - b);
    const nIdx = SHEET_PLANES[plane].N.findIndex((c) => c !== 0);
    check(`${plane}: 100 × 60 × t, thickness along the plane normal`,
      near(res.volume, 100 * 60 * 2.286, 0.5) && near(sorted[0], 2.286) && near(sorted[1], 60) && near(sorted[2], 100)
      && near(size[nIdx], 2.286), JSON.stringify(size));
  }
}

console.log('SCS S2 — overlay + taps');
{
  const planeMode = enterSheetMetalMode(alu, 'p1');
  const g = buildSheetOverlay(planeMode);
  const quads = g.children.filter((c) => c.userData.sm?.kind === 'plane');
  check('plane stage shows three plane quads', quads.length === 3);
  g.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(10, 7, 200), new Vector3(0, 0, -1));
  const pick = sheetPickFromHits(ray.intersectObject(g, true));
  check('a tap from above hits the Top (XY) plane', pick?.kind === 'plane' && pick.plane === 'XY', JSON.stringify(pick));
  const baseMode = pickSheetPlane(planeMode, 'XY');
  const g2 = buildSheetOverlay({ ...baseMode, previewSpec: baseDraftSpec(baseMode), draft: { id: 'base' } });
  check('base stage previews the flange (no plane quads)', g2.children.some((c) => c.userData.sm?.kind === 'panel')
    && !g2.children.some((c) => c.userData.sm?.kind === 'plane'));
}

console.log('SCS S2 — chrome + wiring');
{
  const flow = read('src/components/sheetMetal/SheetMetalFlow.jsx');
  const view = read('src/components/Viewport.jsx');
  const app = read('src/App.jsx');
  const worker = read('src/workers/sandboxWorker.js');
  check('base popup: x/y sliders, Back, Accept, ✕ exits', /sm-base-x/.test(flow) && /sm-base-y/.test(flow)
    && /backToPlanePick/.test(flow) && /acceptBaseFlange/.test(flow) && /onClose=\{onExit\}/.test(flow));
  check('plane buttons as big tap fallback', /data-sm-plane/.test(flow));
  check('taps route to the overlay first', /if \(sheetMetalModeRef\.current\) \{[\s\S]{0,600}sheetPickFromHits/.test(view));
  check('part mesh hidden while drafting, restored on exit', /sheetMetalHidden = true/.test(view) && /mesh\.visible = true/.test(view));
  check('App writes one block and runs', /composeSheetMetalCommit\(buf, spec\)/.test(app) && /onCommitSheetMetal=\{handleCommitSheetMetal\}/.test(app));
  check('sandbox exposes sheetMetalSolid', /function sheetMetalSolid\(spec\)/.test(worker) && /\n {2}sheetMetalSolid,\n/.test(worker));
  const arch = read('docs/architecture.md');
  check('architecture.md documents the base flange step', /Base flange \(S2\)/.test(arch));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll SCS S2 checks passed');
process.exit(0);
