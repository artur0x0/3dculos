/**
 * Part-row Order route for sheet metal. Pure (no React) so node tests can
 * import it. `scs` shows the SendCutSend handoff. Anything else is the
 * normal SurfCAD quote. A cart line is never created or removed here.
 */
import { parseFeatureMarkers } from '../featureMarkers.js';
import { checkSheetDfm } from './sheetDfm.js';
import { sheetScriptHasExtras } from './sheetExport.js';
import {
  SHEET_METAL_BEGIN,
  SHEET_METAL_END,
  readSheetMetalSpec,
} from './sheetMetalScript.js';

const SHEET_ONLY = /let\s+part\s*=\s*sheetMetalSolid\s*\(/;
const SHEET_UNION = /part\.add\s*\(\s*sheetMetalSolid\s*\(/;

/** Every sheet block is `let part = sheetMetalSolid`, never `part.add(sheetMetalSolid`. */
function sheetBlocksAreOnlyAssignment(script) {
  const s = String(script ?? '');
  let from = 0;
  let found = false;
  while (from < s.length) {
    const start = s.indexOf(SHEET_METAL_BEGIN, from);
    if (start < 0) break;
    const end = s.indexOf(SHEET_METAL_END, start + SHEET_METAL_BEGIN.length);
    if (end < 0) return false;
    const body = s.slice(start, end);
    if (SHEET_UNION.test(body) || !SHEET_ONLY.test(body)) return false;
    found = true;
    from = end + SHEET_METAL_END.length;
  }
  return found;
}

/**
 * `scs` when the script is only sheet metal and the SCS hard checks pass.
 * A soft warning (`tab-small`, hole-near-bend) still returns `scs`.
 * @returns {'scs' | 'quote'}
 */
export function sheetCheckoutRoute(script) {
  const text = String(script ?? '');
  const hits = parseFeatureMarkers(text);
  if (hits.length === 0 || hits.some((hit) => hit.kind !== 'sheetMetal')) return 'quote';
  if (sheetScriptHasExtras(text)) return 'quote';
  if (!sheetBlocksAreOnlyAssignment(text)) return 'quote';
  const spec = readSheetMetalSpec(text);
  if (!spec || !checkSheetDfm(spec).ok) return 'quote';
  return 'scs';
}
