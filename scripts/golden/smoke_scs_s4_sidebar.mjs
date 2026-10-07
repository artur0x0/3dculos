#!/usr/bin/env node
/**
 * SCS S4 — sheet-metal sidebar. The left rail swaps to SendCutSend features
 * only (Tab first), gated by the SKU's services. Tab / Hole / Countersink /
 * Tapped open the same translucent popups (Tab Centered on by default).
 */
import { readFileSync } from 'node:fs';
import { Raycaster, Vector3 } from 'three';
import { joinScsCatalog, findScsSku } from '../../src/utils/scs/scsCatalog.js';
import {
  acceptBaseFlange,
  acceptDraft,
  enterSheetMetalMode,
  pickSheetPlane,
  setSheetTool,
  sheetTap,
  sheetToolsFor,
  SHEET_TOOLS,
  updateDraft,
  draftPreviewSpec,
} from '../../src/utils/sheetMetal/sheetMetalMode.js';
import { sheetFreeEdges } from '../../src/utils/sheetMetal/sheetModel.js';
import { sheetMetalBlock } from '../../src/utils/sheetMetal/sheetMetalScript.js';
import { buildSheetOverlay, sheetPickFromHits } from '../../src/utils/sheetMetal/sheetOverlay.js';
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
const al6061 = findScsSku(records, 'ALU6061-100');
const uhmw = findScsSku(records, 'UHMWBLACK-500');
const edit = (rec = alu) => acceptBaseFlange(pickSheetPlane(enterSheetMetalMode(rec, 'p1'), 'XY')).mode;
const ids = (spec) => sheetToolsFor(spec).map((t) => t.id).join(',');

console.log('SCS S4 — tools gated by SKU services');
{
  check('Tab is first in the catalog of tools', SHEET_TOOLS[0].id === 'tab');
  const a = edit(alu);
  check('5052 (bending, tapping, no countersinking) → Tab, Bend, Hole, Tap', ids(a.spec) === 'tab,bend,hole,tapped', ids(a.spec));
  const csk = { ...a.spec, limits: { ...a.spec.limits, services: [...a.spec.limits.services, 'countersinking'] } };
  check('countersinking service adds Csk (Tab still first)', ids(csk) === 'tab,bend,hole,countersink,tapped', ids(csk));
  const b = edit(al6061);
  check('6061 without bending → no Bend; Tab first', ids(b.spec) === 'tab,hole,tapped' && b.tool === 'tab', ids(b.spec));
  const u = edit(uhmw);
  check('UHMW with no services → Tab + Hole only', ids(u.spec) === 'tab,hole', ids(u.spec));
  check('selecting an ungated tool is refused', setSheetTool(u, 'tapped') === u && setSheetTool(u, 'hole').tool === 'hole');
  check('switching tool drops any draft', !setSheetTool({ ...a, draft: { kind: 'bend' } }, 'tab').draft);
}

console.log('SCS S4 — Tab');
let mode = setSheetTool(edit(alu), 'tab');
{
  mode = sheetTap(mode, { kind: 'edge', panel: 'base', edge: 'u+' });
  const d = mode.draft;
  check('edge tap → Tab popup, Centered on by default', d?.kind === 'tab' && d.centered === true && d.width === 24 && d.depth === 10, JSON.stringify(d));
  mode = updateDraft(mode, { centered: false, offset: 999 });
  check('Centered off → offset clamps to the edge', mode.draft.centered === false && near(mode.draft.offset, 60 - 24));
  mode = updateDraft(mode, { width: 500 });
  check('width clamps to the edge length', mode.draft.width === 60 && mode.draft.offset === 0);
  mode = updateDraft(mode, { width: 20, centered: true });
  const res = acceptDraft(mode);
  check('Accept writes the tab (no helper fields)', res.spec.tabs.length === 1 && !('span' in res.spec.tabs[0]));
  mode = res.mode;
  const free = sheetFreeEdges(mode.spec);
  check('a tabbed edge is not offered for a second tab or a bend',
    !free.some((e) => e.panel === 'base' && e.edge === 'u+'));
  const reopen = sheetTap(mode, { kind: 'tab', id: 't1' });
  check('tap a tab → edit with its edge span', reopen.draft?.id === 't1' && reopen.draft.span === 60);
}

console.log('SCS S4 — holes');
{
  let m = setSheetTool(mode, 'hole');
  m = sheetTap(m, { kind: 'panel', panel: 'base', point: [-20, 10, 2.286] });
  check('face tap → Hole popup at the tap (u, v)', m.draft?.kind === 'hole' && m.draft.u === -20 && m.draft.v === 10 && m.draft.type === 'hole');
  check('default Ø ≥ 2× SKU min hole and ≥ 5 mm', m.draft.d >= 5);
  m = acceptDraft(m).mode;
  let t = sheetTap(setSheetTool(m, 'tapped'), { kind: 'panel', panel: 'base', point: [20, 10, 0] });
  check('tapped hole: M4 → tap drill 3.3', t.draft.type === 'tapped' && t.draft.thread === 'M4' && t.draft.d === 3.3);
  t = updateDraft(t, { thread: '#10-32' });
  check('thread select sets drill Ø', t.draft.thread === '#10-32' && near(t.draft.d, 4.0894));
  m = acceptDraft(t).mode;
  check('Csk refused on a SKU without countersinking', setSheetTool(m, 'countersink') === m);
  const withCsk = { ...m, spec: { ...m.spec, limits: { ...m.spec.limits, services: [...m.spec.limits.services, 'countersinking'] } } };
  let c = sheetTap(setSheetTool(withCsk, 'countersink'), { kind: 'panel', panel: 'base', point: [0, -15, 0] });
  check('countersink: Ø + csk Ø (82°)', c.draft.type === 'countersink' && c.draft.cskDia === c.draft.d * 2 && c.draft.cskAngle === 82);
  m = acceptDraft(c).mode;
  mode = m;
  check('three holes in the spec', mode.spec.holes.length === 3);
}

console.log('SCS S4 — solids (real sandbox)');
{
  const { exec } = await loadSandbox();
  const base = { ...mode.spec, tabs: [], holes: [] };
  const t = base.t;
  const v0 = (await exec(`${sheetMetalBlock(base)}\nreturn part;`)).volume;
  const withTab = await exec(`${sheetMetalBlock({ ...base, tabs: mode.spec.tabs })}\nreturn part;`);
  check('tab adds width × depth × t and reaches +depth', near(withTab.volume - v0, 20 * 10 * t, 0.05)
    && near(withTab.boundingBox.max[0], 60, 1e-3), `${withTab.volume - v0}`);
  const plain = mode.spec.holes[0];
  const withHole = await exec(`${sheetMetalBlock({ ...base, holes: [plain] })}\nreturn part;`);
  const area = Math.PI * (plain.d / 2) ** 2;
  check('hole removes ≈ π r² t', near(v0 - withHole.volume, area * t, area * t * 0.02), `${v0 - withHole.volume} vs ${area * t}`);
  const csk = mode.spec.holes[2];
  const withCsk = await exec(`${sheetMetalBlock({ ...base, holes: [csk] })}\nreturn part;`);
  const thru = Math.PI * (csk.d / 2) ** 2 * t;
  check('countersink removes more than its through hole', v0 - withCsk.volume > thru * 1.05, `${v0 - withCsk.volume} vs ${thru}`);
  const all = await exec(`${sheetMetalBlock(mode.spec)}\nreturn part;`);
  check('tab + 3 holes build together', all.volume > 0 && all.volume < withTab.volume);
}

console.log('SCS S4 — overlay + chrome');
{
  const tabMode = setSheetTool(edit(alu), 'tab');
  const g = buildSheetOverlay(tabMode);
  check('Tab tool shows edge handles', g.children.filter((c) => c.userData.sm?.kind === 'edge').length === 4);
  const holeMode = setSheetTool(edit(alu), 'hole');
  const g2 = buildSheetOverlay(holeMode);
  g2.updateMatrixWorld(true);
  check('Hole tool shows no edge handles', !g2.children.some((c) => c.userData.sm?.kind === 'edge'));
  const pick = sheetPickFromHits(new Raycaster(new Vector3(-20, 10, 50), new Vector3(0, 0, -1)).intersectObject(g2, true));
  check('face tap picks the base panel with a point', pick?.kind === 'panel' && pick.panel === 'base' && near(pick.point[2], 2.286, 1e-3), JSON.stringify(pick));
  const d = sheetTap(tabMode, { kind: 'edge', panel: 'base', edge: 'v+' });
  const g3 = buildSheetOverlay({ ...d, previewSpec: draftPreviewSpec(d) });
  check('tab draft previews live', g3.children.some((c) => c.userData.sm?.kind === 'tab'));

  const rail = read('src/components/sheetMetal/SheetMetalRail.jsx');
  const flow = read('src/components/sheetMetal/SheetMetalFlow.jsx');
  const view = read('src/components/Viewport.jsx');
  const controls = read('src/components/sheetMetal/SmControls.jsx');
  check('rail renders gated tools with 44px targets', /data-sheet-tool/.test(rail) && /min-h-\[44px\]/.test(rail));
  check('Viewport feeds sheetToolsFor + setSheetTool', /tools=\{sheetMetalMode\.stage === 'edit' \? sheetToolsFor/.test(view) && /setSheetTool\(prev, id\)/.test(view));
  check('Tab popup: width, depth, Centered toggle, offset when off', /sm-tab-width/.test(flow) && /sm-tab-depth/.test(flow)
    && /sm-tab-centered/.test(flow) && /d\.centered === false && \(/.test(flow));
  check('Hole popup: thread select / Ø / csk Ø / U / V', /sm-hole-thread/.test(flow) && /sm-hole-d"/.test(flow)
    && /sm-hole-csk/.test(flow) && /sm-hole-u/.test(flow) && /sm-hole-v/.test(flow));
  check('toggle + sliders are mobile-sized', /role="switch"/.test(controls) && /SM_TAP/.test(controls));
  check('architecture.md documents the sidebar', /Sidebar \(S4\)/.test(read('docs/architecture.md')));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll SCS S4 checks passed');
process.exit(0);
