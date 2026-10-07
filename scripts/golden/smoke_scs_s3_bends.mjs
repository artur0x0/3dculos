#!/usr/bin/env node
/**
 * SCS S3 — edge-tap bends. Tap an edge → Bend popup (angle + length sliders,
 * length scaled to the base flange, Flip) with live preview; radius, k,
 * bend deduction, min flange, max angle from the SKU; corner reliefs automatic.
 */
import { readFileSync } from 'node:fs';
import { Raycaster, Vector3 } from 'three';
import { joinScsCatalog, findScsSku } from '../../src/utils/scs/scsCatalog.js';
import {
  acceptBaseFlange,
  acceptDraft,
  bendDeductionAt,
  bendDefaults,
  bendLimits,
  cancelDraft,
  deleteDraftFeature,
  draftPreviewSpec,
  enterSheetMetalMode,
  pickSheetPlane,
  sheetTap,
  updateDraft,
} from '../../src/utils/sheetMetal/sheetMetalMode.js';
import { createSheetSpec, solveSheet, sheetFreeEdges, cornerReliefSize, bendAllowance } from '../../src/utils/sheetMetal/sheetModel.js';
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
const flatOnly = findScsSku(records, 'ALU6061-100');

const edit = (rec = alu, plane = 'XY') => acceptBaseFlange(pickSheetPlane(enterSheetMetalMode(rec, 'p1'), plane)).mode;

console.log('SCS S3 — limits from the SKU');
{
  const spec = createSheetSpec(alu, 'XY');
  const lim = bendLimits(spec);
  check('max angle 130°, min flange 0.326" (8.28 mm)', lim.angleMax === 130 && near(lim.lengthMin, 8.28, 0.01), JSON.stringify(lim));
  check('length range scales with the base flange', lim.lengthMax === 100
    && bendLimits({ ...spec, width: 300 }).lengthMax === 300);
  check('radius / k from SKU', near(spec.r, 0.032 * 25.4) && spec.k === 0.37);
  check('bend deduction @90° matches SCS (0.142")', near(bendDeductionAt(spec, 90) / 25.4, 0.142, 0.002),
    String(bendDeductionAt(spec, 90) / 25.4));
  const dflt = bendDefaults(spec, 'base', 'u+');
  check('defaults: 90°, ¼ of the side it leaves, up', dflt.angle === 90 && dflt.length === 25 && dflt.flip === false);
  check('v edges use the other side', bendDefaults(spec, 'base', 'v+').length === 15);
}

console.log('SCS S3 — tap → popup → Accept');
let mode = edit();
{
  mode = sheetTap(mode, { kind: 'edge', panel: 'base', edge: 'u+' });
  check('edge tap opens a bend draft', mode.draft?.kind === 'bend' && mode.draft.isNew && mode.hotEdge.edge === 'u+');
  check('taps are ignored while the popup is open', sheetTap(mode, { kind: 'edge', panel: 'base', edge: 'v+' }) === mode);
  mode = updateDraft(mode, { angle: 175 });
  check('angle clamps to SKU max', mode.draft.angle === 130);
  mode = updateDraft(mode, { angle: 90, length: 2 });
  check('length clamps to min flange', near(mode.draft.length, 8.28, 0.01));
  mode = updateDraft(mode, { length: 20, flip: true });
  check('flip toggles', mode.draft.flip === true);
  const preview = draftPreviewSpec(mode);
  check('live preview spec carries the draft; committed spec untouched',
    preview.bends.length === 1 && mode.spec.bends.length === 0);
  const back = cancelDraft(mode);
  check('Back drops the draft only', !back.draft && back.spec.bends.length === 0 && back.stage === 'edit');
  mode = updateDraft(mode, { flip: false });
  const res = acceptDraft(mode);
  check('Accept commits the bend', res.spec.bends.length === 1 && res.spec.bends[0].angle === 90
    && res.spec.bends[0].length === 20 && !res.mode.draft);
  mode = res.mode;
  const noBend = sheetTap({ ...edit(flatOnly), tool: 'bend' }, { kind: 'edge', panel: 'base', edge: 'u+' });
  check('SKU without bending service → toast, no draft', !noBend.draft && /no bending/i.test(noBend.toast || ''));
}

console.log('SCS S3 — editing, chaining, delete');
{
  let m = sheetTap(mode, { kind: 'bend', id: 'b1' });
  check('tap a bend → edit it', m.draft?.id === 'b1' && !m.draft.isNew);
  m = acceptDraft(updateDraft(m, { angle: 45 })).mode;
  check('edit keeps one bend', m.spec.bends.length === 1 && m.spec.bends[0].angle === 45);
  m = acceptDraft(sheetTap(m, { kind: 'edge', panel: 'b1', edge: 'u+' })).mode;
  check('tip of a flange is bendable (chain)', m.spec.bends.length === 2 && m.spec.bends[1].panel === 'b1');
  const del = deleteDraftFeature(sheetTap(m, { kind: 'bend', id: 'b1' }));
  check('delete a bend drops its child flange too', del.spec.bends.length === 0);
}

console.log('SCS S3 — automatic corner reliefs + flat');
{
  const spec = { ...createSheetSpec(alu, 'XY'), bends: [
    { id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20 },
    { id: 'b2', panel: 'base', edge: 'v+', angle: 90, length: 20 },
  ] };
  const solved = solveSheet(spec);
  const g = cornerReliefSize(spec);
  check('one corner notch where two bends meet', solved.notches.length === 1
    && near(solved.notches[0].u1 - solved.notches[0].u0, g) && near(solved.notches[0].v1 - solved.notches[0].v0, g));
  const b1 = solved.bends.find((b) => b.id === 'b1');
  check('flanges trimmed back from the relief', near(b1.q1, 30 - g) && near(b1.q0, -30));
  const flat = solveSheet(spec, { flat: true });
  const f1 = flat.panels.find((p) => p.id === 'b1');
  check('flat: flange starts one bend allowance past the edge', near(f1.o[0], 50 + bendAllowance(spec, 90)) && near(f1.N[2], 1));
  check('free edges: 2 base + 2 flange tips (+ flange sides for tabs)',
    sheetFreeEdges(spec, solved).filter((e) => e.bendable).length === 4);
}

console.log('SCS S3 — solids (real sandbox)');
{
  const { exec } = await loadSandbox();
  const base = createSheetSpec(alu, 'XY');
  const t = base.t;
  const r = base.r;
  const zone = (th, len) => th * t * (r + t / 2) * len;
  const up = await exec(`${sheetMetalBlock({ ...base, bends: [{ id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20 }] })}\nreturn part;`);
  check('90° up: flange top at t + r + L, outside at w/2 + r + t',
    near(up.boundingBox.max[2], t + r + 20, 1e-3) && near(up.boundingBox.max[0], 50 + r + t, 1e-3)
    && near(up.volume, 100 * 60 * t + 20 * 60 * t + zone(Math.PI / 2, 60), 3), JSON.stringify(up.boundingBox));
  const down = await exec(`${sheetMetalBlock({ ...base, bends: [{ id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20, flip: true }] })}\nreturn part;`);
  check('Flip bends below the base', near(down.boundingBox.min[2], -(r + 20), 1e-3) && near(down.boundingBox.max[2], t, 1e-3),
    JSON.stringify(down.boundingBox));
  const box = await exec(`${sheetMetalBlock({ ...base, bends: ['u+', 'u-', 'v+', 'v-'].map((e, i) => ({ id: `b${i + 1}`, panel: 'base', edge: e, angle: 90, length: 20 })) })}\nreturn part;`);
  check('four-sided tray builds (reliefs keep flanges apart)', box.volume > 100 * 60 * t && near(box.boundingBox.max[2], t + r + 20, 1e-3));
}

console.log('SCS S3 — overlay edge pick + chrome');
{
  const m = edit();
  const g = buildSheetOverlay(m);
  const handles = g.children.filter((c) => c.userData.sm?.kind === 'edge');
  check('four base edge handles in bend tool', handles.length === 4);
  g.updateMatrixWorld(true);
  const hit = sheetPickFromHits(new Raycaster(new Vector3(50, 0, 100), new Vector3(0, 0, -1)).intersectObject(g, true));
  check('tap above the +X edge picks that edge', hit?.kind === 'edge' && hit.edge === 'u+' && hit.panel === 'base', JSON.stringify(hit));
  const drafting = buildSheetOverlay({ ...sheetTap(m, hit), previewSpec: draftPreviewSpec(sheetTap(m, hit)) });
  check('while drafting: preview has the bend, no handles',
    drafting.children.some((c) => c.userData.sm?.kind === 'bend') && !drafting.children.some((c) => c.userData.sm?.kind === 'edge'));
  const flow = read('src/components/sheetMetal/SheetMetalFlow.jsx');
  check('Bend popup: angle + length sliders, Flip, R/K/BD line, Back/Accept/Delete, ✕',
    /sm-bend-angle/.test(flow) && /sm-bend-length/.test(flow) && /data-sm-flip/.test(flow)
    && /BD \{formatSheetLength\(bd, unit\)\}/.test(flow) && /cancelDraft/.test(flow) && /deleteDraftFeature/.test(flow) && /onClose=\{onExit\}/.test(flow));
  const view = read('src/components/Viewport.jsx');
  check('Viewport routes taps through sheetTap and previews the draft', /sheetTap\(prev, pick\)/.test(view) && /draftPreviewSpec\(sheetMetalMode\)/.test(view));
  check('architecture.md documents bends', /Bends \(S3\)/.test(read('docs/architecture.md')));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll SCS S3 checks passed');
process.exit(0);
