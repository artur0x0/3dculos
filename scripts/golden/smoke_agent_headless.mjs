/**
 * Headless Node entry: the same helper scope as the worker, three scripts
 * (filleted box, separate bodies, sheet metal), and non-empty STL / 3MF / STEP.
 */
import { exportResult, runScript, sheetSpecToStep } from '../../src/lib/surfcad/index.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sheetSpec = {
  v: 1,
  sku: 'ALU-090',
  material: 'Aluminum 5052',
  t: 1.63,
  r: 1.5,
  k: 0.44,
  limits: { bendable: true },
  plane: 'XY',
  width: 80,
  height: 50,
  bends: [{ id: 'b1', panel: 'base', edge: 'u+', angle: 90, length: 20 }],
  tabs: [],
  holes: [],
};

const filletScript = `
const part = Manifold.cube([24, 18, 12], true);
const vertical = convexEdges(part).filter((e) => Math.abs(e.tangent[2]) > 0.99);
if (vertical.length !== 4) throw new Error('expected 4 vertical edges, got ' + vertical.length);
return filletEdges(part, vertical, 1.5);
`;

const assemblyScript = `
const base = Manifold.cube([30, 20, 8], true);
const pin = Manifold.cylinder(14, 3, -1, 24, false).translate([0, 0, 4]);
return base.add(pin, { merge: false });
`;

const sheetScript = `
const sheetSpec = ${JSON.stringify(sheetSpec)};
return sheetMetalSolid(sheetSpec);
`;

function finiteBox(box) {
  if (!box?.min || !box?.max) return false;
  return [...box.min, ...box.max].every((n) => Number.isFinite(n));
}

async function expectSolid(label, source, { bodyCount, volumeMin, volumeMax }) {
  const result = await runScript(source);
  check(`${label} status`, result.status === 'NoError', result.status);
  check(`${label} volume`, result.volume > volumeMin && result.volume < volumeMax,
    `vol=${result.volume}`);
  check(`${label} bbox`, finiteBox(result.boundingBox)
    && result.boundingBox.max[0] > result.boundingBox.min[0]
    && result.boundingBox.max[2] > result.boundingBox.min[2]);
  check(`${label} bodies`, result.bodyCount === bodyCount, `bodies=${result.bodyCount}`);
  const stl = await exportResult(result, 'stl');
  const mf = await exportResult(result, '3mf');
  const step = await exportResult(result, 'step', { name: label });
  check(`${label} stl`, stl.byteLength > 84, `bytes=${stl?.byteLength}`);
  check(`${label} 3mf`, mf.byteLength > 64 && mf[0] === 0x50 && mf[1] === 0x4b, `bytes=${mf?.byteLength}`);
  const stepText = new TextDecoder().decode(step);
  check(`${label} step`, step.byteLength > 64 && stepText.includes('ISO-10303-21') && stepText.includes('MANIFOLD_SOLID_BREP'),
    `bytes=${step?.byteLength}`);
  try { result.manifold?.delete?.(); } catch { /* already freed */ }
  return result;
}

console.log('headless SurfCAD entry');

await expectSolid('filleted box', filletScript, { bodyCount: 1, volumeMin: 4500, volumeMax: 24 * 18 * 12 });
await expectSolid('two-body assembly', assemblyScript, { bodyCount: 2, volumeMin: 4800, volumeMax: 4800 + Math.PI * 9 * 14 + 50 });

const sheet = await expectSolid('sheet metal', sheetScript, { bodyCount: 1, volumeMin: 1000, volumeMax: 80000 });
const exact = sheetSpecToStep(sheetSpec, { name: 'bracket', mesh: sheet.mesh, script: sheetScript });
const exactText = exact.text || '';
check('sheet step is true-curve', exact.stepSource === 'spec' && exactText.includes('CYLINDRICAL_SURFACE') && !exact.blocked,
  `source=${exact.stepSource} blocked=${exact.blocked} brep=${exact.brepError || ''}`);
check('sheet step bytes', exact.bytes.byteLength > 64);

if (failed) {
  console.log(`\nheadless entry: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nheadless entry: checks passed');
