/**
 * Sheet-metal script block. The part script stays the source of truth:
 * one marked block holds the sheet spec (JSON) and builds the solid.
 */
import { newPartStarterScript } from '../helperPaletteSnippets.js';
import { DEFAULT_SCRIPT } from '../defaultScript.js';

export const SHEET_METAL_BEGIN = '// --- sheet-metal begin ---';
export const SHEET_METAL_END = '// --- sheet-metal end ---';

export function hasSheetMetalBlock(script) {
  const s = String(script || '');
  const i = s.indexOf(SHEET_METAL_BEGIN);
  return i >= 0 && s.indexOf(SHEET_METAL_END, i) > i;
}

/**
 * Can sheet-metal mode write into this part without clobbering work?
 * Empty, the new-part starter cube, the demo script, or an existing
 * sheet-metal block → yes. Anything else → Start makes a new part.
 */
export function sheetMetalReady(script) {
  const s = String(script ?? '').trim();
  if (!s) return true;
  if (hasSheetMetalBlock(s)) return true;
  return s === newPartStarterScript().trim() || s === DEFAULT_SCRIPT.trim();
}
