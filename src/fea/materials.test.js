import assert from 'node:assert/strict';
import test from 'node:test';
import { MATERIALS, effectiveMaterial, getMaterial, solverMaterial, solverMaterialForStudy } from './materials.js';

const IDS = [
  'al-6061-t6',
  'al-5052-h32',
  'al-7075-t6',
  'steel-a36',
  'ss-304-annealed',
  'ti-6al-4v-annealed',
  'pla-ultimaker',
  'abs-m30',
  'petg-prusament',
  'pa12-hp-mjf',
];

test('every library entry has SI units, a citation, and sane bounds', () => {
  assert.deepEqual(MATERIALS.map((entry) => entry.id), IDS);
  const seen = new Set();
  for (const entry of MATERIALS) {
    assert.equal(seen.has(entry.id), false);
    seen.add(entry.id);
    assert.equal(getMaterial(entry.id), entry);
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0);
    assert.ok(Array.isArray(entry.sources) && entry.sources.length > 0);
    for (const source of entry.sources) {
      assert.match(source.url, /^https:\/\//);
      assert.ok(source.title.length > 0);
      assert.ok(source.note.length > 0);
      assert.ok(source.fields.length > 0);
    }
    const cited = new Set(entry.sources.flatMap((source) => source.fields));
    for (const field of ['E_MPa', 'nu', 'yield_MPa', 'density_kg_m3']) {
      if (entry[field] == null) assert.ok(entry.unverified.includes(field), `${entry.id} ${field}`);
      else assert.ok(cited.has(field), `${entry.id} ${field} has no source`);
    }
    if (entry.E_MPa != null) {
      assert.equal(typeof entry.E_MPa, 'number');
      // Megapascals, not gigapascals: metals are tens of thousands, not ~70.
      assert.ok(entry.E_MPa >= 1000 && entry.E_MPa <= 250000, entry.id);
    }
    if (entry.nu != null) {
      assert.ok(entry.nu > 0 && entry.nu < 0.5, entry.id);
      assert.equal(entry.nu_assumed, undefined, entry.id);
    } else {
      assert.equal(entry.nuSource, 'assumed', entry.id);
      assert.ok(entry.nu_assumed > 0 && entry.nu_assumed < 0.5, entry.id);
      assert.equal(typeof entry.nuRationale, 'string');
      assert.ok(entry.nuRationale.length > 0, entry.id);
    }
    if (entry.yield_MPa != null) assert.ok(entry.yield_MPa > 0 && entry.yield_MPa < 2000, entry.id);
    // kg/m³, not g/cm³: metals sit in the thousands.
    assert.ok(entry.density_kg_m3 >= 800 && entry.density_kg_m3 <= 20000, entry.id);
    if (entry.anisotropic) {
      assert.equal(typeof entry.orientation, 'string');
      assert.match(entry.sources.map((source) => source.note).join(' '), /anisotropic|orientation/i);
    }
  }
});

test('metal numbers are the metric datasheet column', () => {
  assert.deepEqual(solverMaterial('al-6061-t6').material, { E_MPa: 68900, nu: 0.33, yield_MPa: 276 });
  assert.equal(getMaterial('al-6061-t6').density_kg_m3, 2700);
  assert.match(getMaterial('al-6061-t6').sources[0].note, /Estimated from trends/);
  assert.equal(getMaterial('al-5052-h32').E_MPa, 70300);
  assert.equal(getMaterial('al-5052-h32').yield_MPa, 193);
  assert.equal(getMaterial('al-7075-t6').E_MPa, 71700);
  assert.equal(getMaterial('al-7075-t6').yield_MPa, 503);
  assert.equal(getMaterial('steel-a36').yield_MPa, 250);
  assert.equal(getMaterial('steel-a36').E_MPa, 200000);
  assert.equal(getMaterial('steel-a36').nu, 0.26);
  assert.match(getMaterial('steel-a36').sources.map((source) => source.note).join(' '), /Cloudflare/);
  assert.equal(getMaterial('ss-304-annealed').yield_MPa, 205);
  assert.equal(getMaterial('ss-304-annealed').E_MPa, 193000);
  assert.equal(getMaterial('ss-304-annealed').nu, null);
  assert.equal(getMaterial('ti-6al-4v-annealed').E_MPa, 113800);
  assert.equal(getMaterial('ti-6al-4v-annealed').nu, 0.342);
  assert.equal(getMaterial('ti-6al-4v-annealed').yield_MPa, 880);
});

test('printed plastics keep the datasheet orientation and do not invent Poisson or yield', () => {
  const pla = getMaterial('pla-ultimaker');
  assert.equal(pla.anisotropic, true);
  assert.equal(pla.E_MPa, 3250);
  assert.equal(pla.yield_MPa, 52.5);
  assert.equal(pla.nu, null);
  assert.equal(pla.density_kg_m3, 1240);
  assert.match(pla.orientation, /XY/);

  const abs = getMaterial('abs-m30');
  assert.equal(abs.E_MPa, 2400);
  assert.equal(abs.yield_MPa, 30.8);
  assert.equal(abs.nu, null);
  assert.equal(abs.density_kg_m3, 1050);

  const petg = getMaterial('petg-prusament');
  assert.equal(petg.E_MPa, 1500);
  assert.equal(petg.yield_MPa, 47);
  assert.equal(petg.nu, null);
  assert.equal(petg.density_kg_m3, 1270);

  const pa12 = getMaterial('pa12-hp-mjf');
  assert.equal(pa12.E_MPa, 1700);
  assert.equal(pa12.yield_MPa, null);
  assert.equal(pa12.nu, null);
  assert.equal(pa12.density_kg_m3, 1010);
  assert.deepEqual(pa12.unverified, ['nu', 'yield_MPa']);

  for (const id of ['pla-ultimaker', 'abs-m30', 'petg-prusament', 'pa12-hp-mjf']) {
    const resolved = solverMaterial(id);
    assert.equal(resolved.ok, false, id);
    assert.equal(resolved.anisotropic, true);
  }
  const study = solverMaterialForStudy({ material: { id: 'pla-ultimaker' } });
  assert.equal(study.ok, false);
  assert.match(study.errors.join(' '), /nu/);
});

test('effectiveMaterial fills an assumed Poisson ratio and leaves a missing yield null', () => {
  const sourced = effectiveMaterial('al-6061-t6');
  assert.deepEqual(sourced, {
    E_MPa: 68900,
    nu: 0.33,
    yield_MPa: 276,
    density_kg_m3: 2700,
    assumptions: [],
    warnings: [],
  });
  assert.equal(getMaterial('al-6061-t6').nuSource, undefined);

  const stainless = effectiveMaterial('ss-304-annealed');
  assert.equal(getMaterial('ss-304-annealed').nu, null);
  assert.equal(stainless.nu, 0.29);
  assert.equal(stainless.yield_MPa, 205);
  assert.deepEqual(stainless.assumptions, [{
    field: 'nu',
    value: 0.29,
    source: 'assumed',
    rationale: getMaterial('ss-304-annealed').nuRationale,
  }]);
  assert.match(stainless.assumptions[0].rationale, /0\.27/);
  assert.deepEqual(stainless.warnings, []);

  assert.equal(effectiveMaterial('pla-ultimaker').nu, 0.36);
  assert.equal(effectiveMaterial('pla-ultimaker').yield_MPa, 52.5);
  assert.equal(effectiveMaterial('abs-m30').nu, 0.35);
  assert.equal(effectiveMaterial('petg-prusament').nu, 0.38);

  const pa12 = effectiveMaterial('pa12-hp-mjf');
  assert.equal(getMaterial('pa12-hp-mjf').nu, null);
  assert.equal(getMaterial('pa12-hp-mjf').yield_MPa, null);
  assert.equal(pa12.nu, 0.39);
  assert.equal(pa12.yield_MPa, null);
  assert.equal(pa12.assumptions.length, 1);
  assert.equal(pa12.assumptions[0].source, 'assumed');
  assert.equal(pa12.warnings.length, 1);
  assert.equal(pa12.warnings[0].code, 'missing-yield');
  assert.match(pa12.warnings[0].msg, /safety factor is null/);

  assert.throws(() => effectiveMaterial('not-a-material'), /unknown material id/);
});
