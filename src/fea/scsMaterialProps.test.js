import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MPA_PER_KSI, parseScsMaterialProperties, parseScsQuantity } from './scsMaterialProps.js';

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`);
}

test('ksi, psi, ranges, approximations, and unit typos convert to MPa', () => {
  const ksi = parseScsQuantity('10000 ksi', { role: 'elastic_modulus' });
  assert.equal(ksi.ok, true);
  close(ksi.value, 10000 * MPA_PER_KSI);
  assert.equal(ksi.outputUnit, 'MPa');
  assert.equal(ksi.inputUnit, 'ksi');

  const psi = parseScsQuantity('40000 psi', { role: 'yield' });
  close(psi.value, 40000 * MPA_PER_KSI / 1000);

  const range = parseScsQuantity('58-65 ksi', { role: 'yield' });
  assert.equal(range.ok, true);
  close(range.min, 58 * MPA_PER_KSI);
  close(range.max, 65 * MPA_PER_KSI);
  close(range.value, (58 + 65) / 2 * MPA_PER_KSI);

  const dash = parseScsQuantity('58–65 ksi', { role: 'yield' });
  close(dash.value, range.value);

  const approx = parseScsQuantity('~26 ksi', { role: 'yield' });
  assert.equal(approx.approximate, true);
  close(approx.value, 26 * MPA_PER_KSI);

  const about = parseScsQuantity('about 26 ksi', { role: 'yield' });
  assert.equal(about.approximate, true);

  const typo = parseScsQuantity('39 kssi', { role: 'yield' });
  assert.equal(typo.ok, true);
  close(typo.value, 39 * MPA_PER_KSI);
  assert.ok(typo.warnings.some((warning) => /unit typo/.test(warning)));

  const poisson = parseScsQuantity('0.33', { role: 'poisson' });
  assert.equal(poisson.ok, true);
  assert.equal(poisson.value, 0.33);
  assert.equal(poisson.outputUnit, '1');

  const density = parseScsQuantity('169.344 lb/ft^3', { role: 'density' });
  assert.equal(density.ok, true);
  assert.equal(density.outputUnit, 'kg/m3');
  assert.ok(density.value > 2700 && density.value < 2720);

  assert.equal(parseScsQuantity('N/A', { role: 'yield' }).ok, false);
  assert.equal(parseScsQuantity('20%', { role: 'yield' }).ok, false);
  assert.equal(parseScsQuantity('39', { role: 'yield' }).ok, false);
  assert.match(parseScsQuantity('39', { role: 'yield' }).warnings[0], /missing a unit/);
});

test('acrylic 3500 ksi and an inflated copper yield are flagged, not dropped', () => {
  const acrylic = parseScsQuantity('3500 ksi', { role: 'elastic_modulus', name: 'Acrylic' });
  assert.equal(acrylic.ok, true);
  assert.equal(acrylic.outlier, true);
  close(acrylic.value, 3500 * MPA_PER_KSI);
  assert.ok(acrylic.warnings.some((warning) => warning.startsWith('outlier:') && /acrylic/i.test(warning)));

  const steel = parseScsQuantity('3500 ksi', { role: 'elastic_modulus', name: 'Mild steel' });
  assert.equal(steel.outlier, false);

  const copperYield = parseScsQuantity('80 ksi', { role: 'yield', name: 'Copper 110' });
  assert.equal(copperYield.outlier, true);
  assert.ok(copperYield.warnings.some((warning) => /copper yield/.test(warning)));

  const copperModulus = parseScsQuantity('17000 ksi', { role: 'elastic_modulus', name: 'Copper 110' });
  assert.equal(copperModulus.outlier, false);
  close(copperModulus.value, 17000 * MPA_PER_KSI);

  const tinyPsi = parseScsQuantity('3500 psi', { role: 'elastic_modulus', name: 'ABS' });
  assert.equal(tinyPsi.outlier, true);
  assert.ok(tinyPsi.warnings.some((warning) => /usually ksi/.test(warning)));
});

test('the SendCutSend fixture properties parse without throwing', () => {
  const specs = JSON.parse(readFileSync(new URL('../../scripts/golden/fixtures/scs/specs.json', import.meta.url), 'utf8'));
  assert.ok(specs.materials.length > 0);
  for (const material of specs.materials) {
    const parsed = parseScsMaterialProperties(material.material_properties, {
      name: material.general_specs?.learn_more_url || material.sku,
    });
    if (!material.material_properties) {
      assert.equal(parsed.elasticModulus.ok, false, material.sku);
      continue;
    }
    assert.equal(parsed.elasticModulus.ok, true, material.sku);
    assert.equal(parsed.yieldStrength.ok, true, material.sku);
    assert.equal(parsed.poissonsRatio.ok, true, material.sku);
    assert.equal(parsed.density.ok, true, material.sku);
    assert.equal(parsed.elasticModulus.outputUnit, 'MPa');
    assert.equal(parsed.density.outputUnit, 'kg/m3');
  }
  const aluminum = specs.materials.find((material) => material.sku === 'ALU6061-100');
  const parsed = parseScsMaterialProperties(aluminum.material_properties, { name: '6061-T6' });
  close(parsed.elasticModulus.value, 10000 * MPA_PER_KSI);
  close(parsed.yieldStrength.value, 39 * MPA_PER_KSI);
  assert.equal(parsed.poissonsRatio.value, 0.33);

  const galvanized = specs.materials.find((material) => material.sku === 'G90-030');
  const galv = parseScsQuantity(galvanized.material_properties.tensile_strength_ultimate, { role: 'yield' });
  assert.equal(galv.min != null && galv.max != null, true);
  close(galv.min, 58 * MPA_PER_KSI);
  close(galv.max, 65 * MPA_PER_KSI);
});
