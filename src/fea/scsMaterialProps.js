/**
 * Parse one SendCutSend `material_properties` string into SI.
 *
 * The catalog stores modulus and strength as text: "10000 ksi", "39 ksi",
 * "58-65 ksi", "~26 ksi", and the occasional typo ("kssi"). Poisson's ratio
 * is a bare number. Density is usually "lb/ft^3". This does not guess a
 * missing unit. A value that parses but is physically implausible for the
 * named material is returned with an `outlier:` warning; acrylic at
 * 3500 ksi and an inflated copper yield are the cases the catalog has been
 * wrong about.
 */

/** 1 ksi = 6.894757293168361 MPa (1 lbf = 4.4482216152605 N, 1 in = 0.0254 m). */
export const MPA_PER_KSI = 6.894757293168361;
export const MPA_PER_PSI = MPA_PER_KSI / 1000;
/** 1 lb/ft³ = 0.45359237 kg / (0.3048 m)³. */
export const KG_M3_PER_LB_FT3 = 16.018463373960138;

const UNIT_TYPOS = {
  kssi: 'ksi',
  kis: 'ksi',
  ksis: 'ksi',
  psii: 'psi',
};

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)';
const RANGE_RE = new RegExp(`^(${NUMBER})\\s*(?:-|–|—|to)\\s*(${NUMBER})\\s*(.*)$`, 'i');
const SINGLE_RE = new RegExp(`^(${NUMBER})\\s*(.*)$`, 'i');

function fail(warnings, extra = {}) {
  return {
    ok: false,
    value: null,
    min: null,
    max: null,
    approximate: false,
    outlier: false,
    inputUnit: null,
    outputUnit: null,
    warnings,
    ...extra,
  };
}

function normalizeUnit(token, warnings) {
  if (!token) return null;
  const cleaned = token.trim().toLowerCase().replace(/[.,]$/, '').replace('³', '3').replace('²', '2');
  if (UNIT_TYPOS[cleaned]) {
    warnings.push(`unit typo "${token.trim()}" read as ${UNIT_TYPOS[cleaned]}`);
    return UNIT_TYPOS[cleaned];
  }
  if (cleaned === 'ksi' || cleaned === 'kip/in2' || cleaned === 'kip/in^2') return 'ksi';
  if (cleaned === 'psi' || cleaned === 'lb/in2' || cleaned === 'lb/in^2' || cleaned === 'lbf/in2' || cleaned === 'lbf/in^2') {
    return 'psi';
  }
  if (cleaned === 'mpa' || cleaned === 'n/mm2' || cleaned === 'n/mm^2') return 'MPa';
  if (cleaned === 'gpa') return 'GPa';
  if (cleaned === 'pa') return 'Pa';
  if (cleaned === 'lb/ft3' || cleaned === 'lb/ft^3' || cleaned === 'lbs/ft3' || cleaned === 'lbs/ft^3' || cleaned === 'pcf') {
    return 'lb/ft3';
  }
  if (cleaned === 'g/cm3' || cleaned === 'g/cm^3' || cleaned === 'g/cc') return 'g/cm3';
  if (cleaned === 'kg/m3' || cleaned === 'kg/m^3') return 'kg/m3';
  return undefined;
}

function toOutput(value, unit, role) {
  if (role === 'poisson') {
    if (unit) return { error: `Poisson's ratio must be dimensionless, not ${unit}` };
    return { value, outputUnit: '1' };
  }
  if (role === 'density') {
    if (unit === 'lb/ft3') return { value: value * KG_M3_PER_LB_FT3, outputUnit: 'kg/m3' };
    if (unit === 'g/cm3') return { value: value * 1000, outputUnit: 'kg/m3' };
    if (unit === 'kg/m3') return { value, outputUnit: 'kg/m3' };
    if (!unit) return { error: 'density is missing a unit' };
    return { error: `unit ${unit} is not a density` };
  }
  const outputUnit = 'MPa';
  if (unit === 'ksi') return { value: value * MPA_PER_KSI, outputUnit };
  if (unit === 'psi') return { value: value * MPA_PER_PSI, outputUnit };
  if (unit === 'MPa') return { value, outputUnit };
  if (unit === 'GPa') return { value: value * 1000, outputUnit };
  if (unit === 'Pa') return { value: value / 1e6, outputUnit };
  if (!unit) return { error: `${role === 'yield' ? 'yield strength' : 'elastic modulus'} is missing a unit` };
  return { error: `unit ${unit} is not a stress` };
}

function addOutliers(role, name, value, inputUnit, warnings) {
  const label = String(name || '');
  if (role === 'elastic_modulus') {
    if (value > 1_000_000) warnings.push('outlier: elastic modulus is above 1000 GPa');
    if (inputUnit === 'psi' && value < 1000) {
      warnings.push('outlier: elastic modulus was in psi and converted to under 1000 MPa; SCS modulus strings are usually ksi');
    }
    if (/acrylic|pmma|plexiglass/i.test(label) && value > 10000) {
      warnings.push('outlier: acrylic elastic modulus is far above cast PMMA (about 3 GPa)');
    }
    if (/copper/i.test(label) && (value < 50000 || value > 200000)) {
      warnings.push('outlier: copper elastic modulus is outside the usual 110-130 GPa band');
    }
  }
  if (role === 'yield' && /copper/i.test(label) && value > 400) {
    warnings.push('outlier: copper yield is above 400 MPa');
  }
}

/**
 * Parse one property string.
 * `role` is `elastic_modulus`, `yield`, `poisson`, or `density`.
 * `name` is the material name, used only to flag known-bad catalog values.
 */
export function parseScsQuantity(raw, { role = 'elastic_modulus', name = '' } = {}) {
  const warnings = [];
  if (raw == null) return fail(['missing value']);
  let text = String(raw).trim();
  if (!text || /^n\/?a$/i.test(text) || text === '-' || text === '—') return fail(['missing value']);

  let approximate = false;
  const approx = text.match(/^(?:~|≈|approx(?:imately)?\.?|about)\s*/i);
  if (approx) {
    approximate = true;
    text = text.slice(approx[0].length).trim();
  }

  let low;
  let high;
  let unitText = '';
  const range = text.match(RANGE_RE);
  if (range) {
    low = Number(range[1]);
    high = Number(range[2]);
    unitText = range[3];
  } else {
    const single = text.match(SINGLE_RE);
    if (!single) return fail(['not a number'], { approximate });
    low = Number(single[1]);
    high = low;
    unitText = single[2];
  }
  if (high < low) {
    const swap = low;
    low = high;
    high = swap;
  }

  const unitParts = unitText.trim().split(/\s+/).filter(Boolean);
  const token = unitParts[0] || '';
  const junk = unitParts.slice(1).join(' ');
  if (junk) warnings.push(`trailing text "${junk}"`);
  const unit = normalizeUnit(token, warnings);
  if (unit === undefined) return fail([`unknown unit "${token}"`, ...warnings], { approximate });

  const convertedLow = toOutput(low, unit, role);
  if (convertedLow.error) return fail([convertedLow.error, ...warnings], { approximate, inputUnit: unit });
  const convertedHigh = toOutput(high, unit, role);
  const min = convertedLow.value;
  const max = convertedHigh.value;
  const value = range ? (min + max) / 2 : min;
  addOutliers(role, name, value, unit, warnings);
  const outlier = warnings.some((warning) => warning.startsWith('outlier:'));
  return {
    ok: true,
    value,
    min: range ? min : null,
    max: range ? max : null,
    approximate,
    outlier,
    inputUnit: unit,
    outputUnit: convertedLow.outputUnit,
    warnings,
  };
}

/**
 * Pull modulus, yield, Poisson's ratio, and density out of one
 * `material_properties` object. Other keys (composition, hardness, ...)
 * are ignored. Nothing is invented when a key is absent.
 */
export function parseScsMaterialProperties(props, { name = '' } = {}) {
  const bag = props && typeof props === 'object' ? props : {};
  const elasticModulus = parseScsQuantity(bag.elastic_modulus, { role: 'elastic_modulus', name });
  const yieldStrength = parseScsQuantity(bag.tensile_strength_yield, { role: 'yield', name });
  const poissonsRatio = parseScsQuantity(bag.poissons_ratio, { role: 'poisson', name });
  const density = parseScsQuantity(bag.density, { role: 'density', name });
  const warnings = [
    ...elasticModulus.warnings.map((warning) => `elastic_modulus: ${warning}`),
    ...yieldStrength.warnings.map((warning) => `tensile_strength_yield: ${warning}`),
    ...poissonsRatio.warnings.map((warning) => `poissons_ratio: ${warning}`),
    ...density.warnings.map((warning) => `density: ${warning}`),
  ];
  return { name, elasticModulus, yieldStrength, poissonsRatio, density, warnings };
}
