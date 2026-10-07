/**
 * S5 export bundle: DFM verdict + flat DXF (from the spec) + STEP (from the
 * last built mesh). Hard DFM fails block every download and the SCS order.
 */
import { checkSheetDfm } from './sheetDfm.js';
import { sheetFlatDxf } from './sheetFlat.js';
import { meshToStep } from './stepExport.js';
import { bendAllowance, normalizeSheetSpec, solveSheet } from './sheetModel.js';

export function sheetFileBase(partName, sku) {
  const clean = (s) => String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return [clean(partName) || 'sheet', clean(sku)].filter(Boolean).join('-');
}

/** Signed mesh volume (mm³). */
export function meshVolume(mesh) {
  const np = mesh?.numProp || 3;
  const p = mesh?.vertProperties;
  const t = mesh?.triVerts;
  if (!p || !t) return 0;
  let v = 0;
  for (let i = 0; i + 2 < t.length; i += 3) {
    const a = t[i] * np;
    const b = t[i + 1] * np;
    const c = t[i + 2] * np;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/**
 * Expected solid volume from the flat pattern: area·t, minus through holes,
 * plus each bend zone's (sector − BA strip) difference θ·L·(t²/2 + r·t) − BA·t·L.
 */
export function sheetExpectedVolume(rawSpec, flat) {
  const spec = normalizeSheetSpec(rawSpec);
  const { t, r } = spec;
  let v = flat.area * t - flat.holes.reduce((s, h) => s + Math.PI * h.r * h.r * t, 0);
  for (const b of solveSheet(spec).bends) {
    const L = b.q1 - b.q0;
    v += (b.theta / 2) * ((r + t) ** 2 - r ** 2) * L - bendAllowance(spec, b.angle) * t * L;
  }
  return v;
}

/**
 * { dfm, flat, files: { dxf, step }, blocked, meshStale }.
 * `mesh` is the part's last built mesh (may be null while a run is pending).
 */
export function buildSheetExport(spec, { mesh = null, partName = '', timestamp } = {}) {
  const dfm = checkSheetDfm(spec);
  const issues = [...dfm.issues];
  const flat = dfm.flat;
  const base = sheetFileBase(partName, spec?.sku);
  let meshStale = false;
  if (flat && mesh?.vertProperties) {
    const want = sheetExpectedVolume(spec, flat);
    const got = meshVolume(mesh);
    // Countersinks / faceting move this a little; 5% means a different part.
    meshStale = !(want > 0) || Math.abs(got - want) / want > 0.05;
    if (meshStale) {
      issues.push({ level: 'warn', rule: 'mesh-stale', message: 'The 3D part does not match the sheet spec (run pending or script edited) — STEP uses the 3D part.', featureId: null });
    }
  }
  const files = {
    dxf: flat ? { name: `${base}-flat.dxf`, mime: 'application/dxf', text: sheetFlatDxf(flat) } : null,
    step: mesh?.vertProperties ? { name: `${base}.step`, mime: 'model/step', ...meshToStep(mesh, { name: base, timestamp }) } : null,
  };
  const fails = issues.filter((x) => x.level === 'fail').length;
  return { dfm: { ...dfm, issues, warns: issues.length - fails }, flat, files, blocked: fails > 0, meshStale };
}
