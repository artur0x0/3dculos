/**
 * Starting isotropic (or explicitly anisotropic) material library for FEA.
 *
 * Stored units match feaClient.solve(): E_MPa and yield_MPa are megapascals,
 * nu is dimensionless, density_kg_m3 is kilograms per cubic metre
 * (g/cm³ × 1000). A null field was not on the cited source. Do not fill it
 * in. Entries with no single sourced Poisson ratio carry `nu_assumed`,
 * `nuSource: 'assumed'`, and a one-line `nuRationale`. That number is not a
 * datasheet value. `effectiveMaterial` is what feaClient should pass:
 * it uses the assumed ratio so solve() has a ν, and a null yield stays
 * null so the safety factor is null instead of a crash. Printed polymers
 * are anisotropic: the stored E and yield are one orientation, named on
 * the entry, and a different orientation is a different material.
 *
 * Values were read from the cited URLs on 2026-10-09. asm.matweb.com and
 * www.matweb.com answered direct fetches with a gateway timeout or a
 * Cloudflare challenge. Where the number below comes from an ASM/MatWeb
 * sheet, the citation is a fetched PDF copy of that sheet, or the indexed
 * MatWeb text when no copy could be fetched. ksi columns on those sheets
 * are rounded twins of the metric column; the library stores the metric
 * column, not a ksi conversion.
 */

export const MATERIALS_RETRIEVED = '2026-10-09';

const MATERIALS_LIST = [
  {
    id: 'al-6061-t6',
    name: 'Aluminum 6061-T6',
    E_MPa: 68900,
    nu: 0.33,
    nuBasis: 'datasheet-estimated',
    yield_MPa: 276,
    density_kg_m3: 2700,
    anisotropic: false,
    unverified: [],
    sources: [
      {
        fields: ['E_MPa', 'nu', 'yield_MPa', 'density_kg_m3'],
        title: 'ASM Material Data Sheet, Aluminum 6061-T6; 6061-T651 (fetched PDF copy)',
        url: 'https://www.aerospacemetals.com/wp-content/uploads/2023/06/Aluminum-6061-T6-6061-T651.pdf',
        canonicalUrl: 'https://asm.matweb.com/search/SpecificMaterial.asp?bassnum=MA6061T6',
        note: 'Metric column: density 2.7 g/cm³ (AA; Typical), tensile yield 276 MPa (AA; Typical), modulus 68.9 GPa (AA; Typical; average of tension and compression), Poisson\'s ratio 0.33 ("Estimated from trends in similar Al alloys"). The AA note says the values are not for design. The English modulus is the rounded 10000 ksi, which is not stored.',
      },
    ],
  },
  {
    id: 'al-5052-h32',
    name: 'Aluminum 5052-H32',
    E_MPa: 70300,
    nu: 0.33,
    nuBasis: 'datasheet',
    yield_MPa: 193,
    density_kg_m3: 2680,
    anisotropic: false,
    unverified: [],
    sources: [
      {
        fields: ['E_MPa', 'nu', 'yield_MPa', 'density_kg_m3'],
        title: 'ASM Material Data Sheet, Aluminum 5052-H32 (fetched PDF copy)',
        url: 'https://www.aerospacemetals.com/wp-content/uploads/2023/06/Aluminum-5052-H32.pdf',
        canonicalUrl: 'https://asm.matweb.com/search/SpecificMaterial.asp?bassnum=MA5052H32',
        note: 'Metric column: density 2.68 g/cm³ (AA; Typical), tensile yield 193 MPa (AA; Typical), modulus 70.3 GPa (AA; Typical; average of tension and compression), Poisson\'s ratio 0.33. AA typical values are not for design.',
      },
    ],
  },
  {
    id: 'al-7075-t6',
    name: 'Aluminum 7075-T6',
    E_MPa: 71700,
    nu: 0.33,
    nuBasis: 'datasheet',
    yield_MPa: 503,
    density_kg_m3: 2810,
    anisotropic: false,
    unverified: [],
    sources: [
      {
        fields: ['E_MPa', 'nu', 'yield_MPa', 'density_kg_m3'],
        title: 'ASM Material Data Sheet, Aluminum 7075-T6; 7075-T651 (fetched PDF copy)',
        url: 'https://quickparts.com/wp-content/uploads/2024/05/Aluminum-7075.pdf',
        canonicalUrl: 'https://asm.matweb.com/search/SpecificMaterial.asp?bassnum=MA7075T6',
        note: 'The PDF is a print of the ASM page. Metric column: density 2.81 g/cm³ (AA; Typical), tensile yield 503 MPa (AA; Typical), modulus 71.7 GPa (AA; Typical; average of tension and compression), Poisson\'s ratio 0.33. AA typical values are not for design.',
      },
    ],
  },
  {
    id: 'steel-a36',
    name: 'ASTM A36 steel',
    E_MPa: 200000,
    nu: 0.26,
    nuBasis: 'datasheet',
    yield_MPa: 250,
    density_kg_m3: 7800,
    anisotropic: false,
    unverified: [],
    sources: [
      {
        fields: ['yield_MPa'],
        title: 'ASTM A36/A36M-05, Table 3',
        url: 'https://www.shipbuilding-plate.com/uploads/30316/files/ASTM-A36.pdf',
        note: 'Minimum yield point 36 ksi [250 MPa] for plates, shapes, and bars. Plates over 8 in [200 mm] thick are 32 ksi [220 MPa]; the library stores the 250 MPa minimum, not the thick-plate minimum. ASTM A36 does not specify modulus, Poisson\'s ratio, or density. The bracketed 250 MPa is the specification\'s SI value, not a fresh ksi conversion (36 ksi is about 248 MPa).',
      },
      {
        fields: ['E_MPa', 'nu', 'density_kg_m3'],
        title: 'MatWeb, ASTM A36 Steel, plate',
        url: 'https://www.matweb.com/search/datasheet_print.aspx?matguid=afc003f4fb40465fa3df05129f0e88e6',
        note: 'Indexed datasheet text retrieved 2026-10-09: modulus 200 GPa, Poisson\'s ratio 0.26, density 7.80 g/cm³ ("Typical of ASTM Steel"), yield 250 MPa. Direct fetch of matweb.com was blocked by Cloudflare, so these three numbers were not re-read from the live HTML.',
      },
    ],
  },
  {
    id: 'ss-304-annealed',
    name: 'AISI 304 stainless steel, annealed',
    E_MPa: 193000,
    nu: null,
    nuBasis: 'unverified',
    nu_assumed: 0.29,
    nuSource: 'assumed',
    nuRationale: 'Midpoint of the eFunda annealed range 0.27–0.30; that page does not give a single Poisson ratio.',
    yield_MPa: 205,
    density_kg_m3: 8000,
    anisotropic: false,
    unverified: ['nu'],
    sources: [
      {
        fields: ['E_MPa', 'yield_MPa', 'density_kg_m3'],
        title: 'eFunda, AISI Type 304',
        url: 'https://www.efunda.com/materials/alloys/stainless_steels/show_stainless.cfm?ID=AISI_Type_304&show_prop=all',
        note: 'Fetched 2026-10-09. At 25°C, annealed plate/sheet/strip: density 8 × 1000 kg/m³, elastic modulus 193 GPa, yield 205 MPa, tensile strength 515 MPa. Poisson\'s ratio is published only as the range 0.27–0.30, so nu is left unset. ASM MatWeb bassnum MQ304A is often quoted as yield 215 MPa at 0.2% offset and ν 0.29 with modulus 193–200 GPa; that page returned HTTP 504 here and those single values are not stored.',
      },
    ],
  },
  {
    id: 'ti-6al-4v-annealed',
    name: 'Ti-6Al-4V (Grade 5), annealed',
    E_MPa: 113800,
    nu: 0.342,
    nuBasis: 'datasheet',
    yield_MPa: 880,
    density_kg_m3: 4430,
    anisotropic: false,
    unverified: [],
    sources: [
      {
        fields: ['E_MPa', 'nu', 'yield_MPa', 'density_kg_m3'],
        title: 'Titanium Ti-6Al-4V (Grade 5), Annealed datasheet',
        url: 'https://www.professionalplastics.com/professionalplastics/content/downloads/TitaniumTi-6Al-4VGrade5Data.pdf',
        note: 'Fetched 2026-10-09. Annealed Grade 5: density 4.43 g/cm³, tensile yield 880 MPa, ultimate 950 MPa, modulus 113.8 GPa, Poisson\'s ratio 0.342. The English modulus column is the rounded 16500 ksi and is not stored. This is the annealed condition, not solution-treated and aged.',
      },
    ],
  },
  {
    id: 'pla-ultimaker',
    name: 'UltiMaker PLA (FFF, XY)',
    E_MPa: 3250,
    nu: null,
    nuBasis: 'unverified',
    nu_assumed: 0.36,
    nuSource: 'assumed',
    nuRationale: 'Assumed. The UltiMaker TDS has no Poisson ratio; 0.36 is a PLA value used in published FEA (https://link.springer.com/article/10.1007/s00170-025-15314-3), not a measurement of this filament.',
    yield_MPa: 52.5,
    density_kg_m3: 1240,
    anisotropic: true,
    orientation: 'XY flat, mostly infill, 100% infill, 0.15 mm layers, UltiMaker S5',
    unverified: ['nu'],
    sources: [
      {
        fields: ['E_MPa', 'yield_MPa', 'density_kg_m3'],
        title: 'UltiMaker PLA Technical data sheet v5.00 (April 2022)',
        url: 'https://um-support-files.ultimaker.com/materials/2.85mm/tds/PLA/Ultimaker-PLA-TDS-v5.00.pdf',
        note: '3D-printed specimens, ASTM D3039. XY tensile modulus 3250 ± 119 MPa and XY tensile stress at yield 52.5 ± 0.9 MPa; the library stores the typical value, not the scatter. YZ is 3292 MPa and 59.0 MPa. Z modulus is 3071 MPa and Z has no yield. Specific gravity 1.24 g/cm³ (ASTM D1505). Poisson\'s ratio is not in the TDS. FFF properties are anisotropic and orientation-dependent; these numbers are indicative for this print orientation only.',
      },
    ],
  },
  {
    id: 'abs-m30',
    name: 'Stratasys ABS-M30 (FDM, XZ)',
    E_MPa: 2400,
    nu: null,
    nuBasis: 'unverified',
    nu_assumed: 0.35,
    nuSource: 'assumed',
    nuRationale: 'Assumed. The Stratasys ABS-M30 sheet has no Poisson ratio; 0.35 is a common generic-ABS textbook value and was not confirmed on a live datasheet for this FDM grade.',
    yield_MPa: 30.8,
    density_kg_m3: 1050,
    anisotropic: true,
    orientation: 'XZ, F900 T16 tip, 0.254 mm layers',
    unverified: ['nu'],
    sources: [
      {
        fields: ['E_MPa', 'yield_MPa', 'density_kg_m3'],
        title: 'Stratasys ABS-M30 datasheet MDS_FDM_ABS-M30_0921a',
        url: 'https://www.stratasys.com/siteassets/materials/materials-catalog/fdm-materials/abs-m30/mds_fdm_abs-m30_0921a.pdf',
        note: 'Table 5, F900 T16, ASTM D638: XZ yield strength 30.8 MPa, XZ elastic modulus 2.40 GPa. ZX is 27.5 MPa and 2.30 GPa. Specific gravity 1.05 (the sheet lists ASTM D257 at 23°C). Poisson\'s ratio is not on the datasheet. FDM properties are anisotropic and orientation-dependent. A generic "ABS" modulus is not used; this is the named Stratasys grade.',
      },
    ],
  },
  {
    id: 'petg-prusament',
    name: 'Prusament PETG (FFF, horizontal)',
    E_MPa: 1500,
    nu: null,
    nuBasis: 'unverified',
    nu_assumed: 0.38,
    nuSource: 'assumed',
    nuRationale: 'Assumed. The Prusament TDS has no Poisson ratio; 0.38 is a commonly used PETG value and was not confirmed on a manufacturer sheet for this filament.',
    yield_MPa: 47,
    density_kg_m3: 1270,
    anisotropic: true,
    orientation: 'horizontal, 100% rectilinear infill, 0.20 mm layers, Original Prusa i3 MK3',
    unverified: ['nu'],
    sources: [
      {
        fields: ['E_MPa', 'yield_MPa', 'density_kg_m3'],
        title: 'Prusament PETG technical datasheet (Prusa Polymers, 16 Feb 2022)',
        url: 'https://prusament.com/wp-content/uploads/2022/10/PETG_Prusament_TDS_2021_10_EN.pdf',
        note: 'Printed specimens, ISO 527-1: horizontal tensile yield 47 ± 2 MPa, horizontal tensile modulus 1.5 ± 0.1 GPa. Vertical XZ is 50 MPa and 1.6 GPa. Density 1.27 g/cm³ (ISO 1183). The filament (not printed) yield of 46 MPa is not stored. Poisson\'s ratio is not on the datasheet. FFF properties are anisotropic and orientation-dependent.',
      },
    ],
  },
  {
    id: 'pa12-hp-mjf',
    name: 'HP 3D High Reusability PA 12 (MJF, XY)',
    E_MPa: 1700,
    nu: null,
    nuBasis: 'unverified',
    nu_assumed: 0.39,
    nuSource: 'assumed',
    nuRationale: 'Assumed. The public HP PA 12 sheet has no Poisson ratio; 0.39 is a generic nylon-12 listing (https://engdatabase.com/compare/pa12-vs-pc-abs-blend), not this MJF grade.',
    yield_MPa: null,
    density_kg_m3: 1010,
    anisotropic: true,
    orientation: 'XY, balanced print mode, ASTM D638 type V',
    unverified: ['nu', 'yield_MPa'],
    sources: [
      {
        fields: ['E_MPa', 'density_kg_m3'],
        title: 'HP 3D High Reusability PA 12 datasheet 4AA6-4895EEP (November 2017)',
        url: 'https://www.tth.com/hubfs/Website/PDFs/HP%20Material%20Data%20Sheets/HP%20PA%2012%20Material%20Data%20Sheet.pdf',
        note: 'Public sheet: density of parts 1.01 g/cm³ (ASTM D792), XY tensile modulus 1700 MPa, Z tensile modulus 1800 MPa, XY tensile strength at max load 48 MPa (ASTM D638). That strength is not a yield stress, so yield_MPa is unset. Poisson\'s ratio is not on this public sheet. MJF properties are anisotropic and orientation-dependent.',
      },
    ],
  },
];

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export const MATERIALS = freezeDeep(MATERIALS_LIST.map((entry) => ({ ...entry, sources: entry.sources.map((s) => ({ ...s })) })));

const BY_ID = new Map(MATERIALS.map((entry) => [entry.id, entry]));

export function listMaterials() {
  return MATERIALS;
}

export function getMaterial(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Constants feaClient.solve() should use. Sourced ν is preferred. When the
 * datasheet has no single ν, `nu` is `nu_assumed` and `assumptions` carries
 * the badge. `yield_MPa` stays null when the datasheet has no yield: the
 * solver then returns a null safety factor and a warning, and does not throw.
 */
export function effectiveMaterial(id) {
  const entry = typeof id === 'string' ? getMaterial(id) : null;
  if (!entry) throw new Error(`unknown material id "${id}"`);
  const assumptions = [];
  let nu = entry.nu;
  if (typeof nu !== 'number') {
    if (entry.nuSource !== 'assumed' || typeof entry.nu_assumed !== 'number') {
      throw new Error(`${entry.id}: nu is unset and no assumed Poisson ratio is recorded`);
    }
    nu = entry.nu_assumed;
    assumptions.push({
      field: 'nu',
      value: entry.nu_assumed,
      source: 'assumed',
      rationale: entry.nuRationale,
    });
  }
  const warnings = [];
  if (entry.yield_MPa == null) {
    warnings.push({
      code: 'missing-yield',
      field: 'yield_MPa',
      msg: `${entry.name}: yield strength is not on the cited datasheet, so the safety factor is null`,
    });
  }
  if (!(typeof entry.density_kg_m3 === 'number' && entry.density_kg_m3 > 0)) {
    throw new Error(`${entry.id}: density_kg_m3 is unset`);
  }
  return {
    E_MPa: entry.E_MPa,
    nu,
    yield_MPa: entry.yield_MPa == null ? null : entry.yield_MPa,
    density_kg_m3: entry.density_kg_m3,
    assumptions,
    warnings,
  };
}

/**
 * The { E_MPa, nu, yield_MPa } object from the cited datasheet only.
 * A null sourced ν or yield is an error here. Call effectiveMaterial when
 * the solver needs a ν and an explicit assumption list.
 */
export function solverMaterial(id) {
  const entry = typeof id === 'string' ? getMaterial(id) : id;
  if (!entry) return { ok: false, errors: [`unknown material id "${id}"`] };
  const errors = [];
  if (!(typeof entry.E_MPa === 'number' && entry.E_MPa > 0)) errors.push(`${entry.id}: E_MPa is missing`);
  if (typeof entry.nu !== 'number') errors.push(`${entry.id}: nu is not in the cited datasheet`);
  if (!(typeof entry.yield_MPa === 'number' && entry.yield_MPa > 0)) {
    errors.push(`${entry.id}: yield_MPa is not in the cited datasheet`);
  }
  if (errors.length) return { ok: false, errors, anisotropic: entry.anisotropic === true };
  return {
    ok: true,
    errors: [],
    anisotropic: entry.anisotropic === true,
    material: { E_MPa: entry.E_MPa, nu: entry.nu, yield_MPa: entry.yield_MPa },
  };
}

/** Resolve a study material, library id or inline custom, to solver props. */
export function solverMaterialForStudy(study) {
  const material = study && study.material;
  if (!material || typeof material !== 'object') {
    return { ok: false, errors: ['study has no material'] };
  }
  if (material.id) return solverMaterial(material.id);
  return {
    ok: true,
    errors: [],
    anisotropic: false,
    material: {
      E_MPa: material.E_MPa,
      nu: material.nu,
      yield_MPa: material.yield_MPa,
    },
  };
}
