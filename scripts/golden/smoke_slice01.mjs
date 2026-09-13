#!/usr/bin/env node
/**
 * In-repo Slice 01 smoke using the *bundled* built/manifold.wasm (same as the
 * browser worker). Not a substitute for cadgen-workspace harness suites.
 */
import Module from '../../built/manifold.js';
import {
  fastenerClearanceDia,
  fastenerTapDrillDia,
  listFastenerSizes,
  resolveFastenerSize,
} from '../../src/workers/fastenerSizes.js';

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function throws(name, fn, re) {
  try {
    fn();
    failed++;
    console.log(`  ❌ ${name} — expected throw`);
  } catch (e) {
    const ok = !re || re.test(String(e.message || e));
    if (ok) console.log(`  ✅ ${name}`);
    else {
      failed++;
      console.log(`  ❌ ${name} — wrong error: ${e.message}`);
    }
  }
}

console.log('slice01 smoke — fastener tables');
check('M3 normal clearance', fastenerClearanceDia('M3') === 3.4);
check('M3 close clearance', fastenerClearanceDia('M3', 'close') === 3.2);
check('M3 tap', fastenerTapDrillDia('M3') === 2.5);
check('numeric 4 → M4', resolveFastenerSize(4).key === 'M4');
check('M2.5 key', resolveFastenerSize('M2.5').key === 'M2_5');
check('#8-32 tap present', fastenerTapDrillDia('#8-32') > 3);
throws('unknown size', () => fastenerClearanceDia('M99'), /unknown/);
throws('bad fit', () => fastenerClearanceDia('M3', 'banana'), /fit/);

const sizes = listFastenerSizes();
check('metric list has M6', sizes.metric.includes('M6'));
check('unc list has 1/4-20', sizes.unc.includes('1/4-20'));

console.log('slice01 smoke — geometry (built/manifold.wasm)');
const plate = Manifold.cube([40, 40, 8], true);
const d = fastenerClearanceDia('M3', 'normal');
const cutter = Manifold.cylinder(20, d / 2, d / 2, 48, true);
const holed = Manifold.difference(plate, cutter);
const st = holed.status();
const okStatus = st === 'NoError' || (st && st.value === 0);
check('clearance cut valid', okStatus, `status=${typeof st === 'object' ? JSON.stringify(st) : st}`);
check('clearance cut volume dropped', holed.volume() < plate.volume() - 1);

const tapD = fastenerTapDrillDia('M3');
check('tap < clearance', tapD < d);
throws('zero major rejected', () => fastenerClearanceDia(0), /size|unknown|> 0/i);

console.log(failed ? `\n❌ FAIL (${failed})` : '\n✅ PASS');
process.exit(failed ? 1 : 0);
