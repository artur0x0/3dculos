/**
 * Material a part already carries, before the study picker.
 *
 * Sheet metal stores `const sheetSpec = {...}` with a material name and sku.
 * A match becomes a library id. Anything else stays unset and the study
 * material is the default.
 */

const SHEET_SPEC = /const sheetSpec\s*=\s*(\{.*\});/;

function libraryId(spec) {
  const text = `${spec?.material || ''} ${spec?.sku || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (text.includes('7075')) return 'al-7075-t6';
  if (text.includes('5052')) return 'al-5052-h32';
  if (text.includes('6061')) return 'al-6061-t6';
  if (text.includes('titanium') || text.includes('ti-6') || text.includes('6al-4v') || text.includes('6al4v')) {
    return 'ti-6al-4v-annealed';
  }
  if (text.includes('stainless') || text.includes('316') || text.includes('304')) return 'ss-304-annealed';
  if (text.includes('steel')) return 'steel-a36';
  return null;
}

/** Library id from a part script, or null when the script names no material. */
export function assignedMaterialFromScript(script) {
  if (typeof script !== 'string' || !script.includes('sheetSpec')) return null;
  const match = script.match(SHEET_SPEC);
  if (!match) return null;
  let spec = null;
  try {
    spec = JSON.parse(match[1]);
  } catch {
    return null;
  }
  return libraryId(spec);
}

function copyMaterial(material) {
  if (!material || typeof material !== 'object') return { id: 'al-6061-t6' };
  if (material.id) return { id: material.id };
  const out = {};
  if (material.name) out.name = material.name;
  out.E_MPa = material.E_MPa;
  out.nu = material.nu;
  out.yield_MPa = material.yield_MPa;
  return out;
}

/**
 * One `{ id, material }` per selected part. A sheet-metal assignment wins.
 * Every other part takes the study material, so the picker stays the default.
 */
export function partMaterialEntries(rows, studyMaterial, scriptFor) {
  const fallback = copyMaterial(studyMaterial);
  const read = typeof scriptFor === 'function' ? scriptFor : () => '';
  return (rows || []).map((row) => {
    const id = String(row.id);
    const assigned = assignedMaterialFromScript(read(id));
    return {
      id,
      material: assigned ? { id: assigned } : copyMaterial(fallback),
    };
  });
}
