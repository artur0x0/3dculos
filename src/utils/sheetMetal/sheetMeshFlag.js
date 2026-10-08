/**
 * Sheet-metal script markers and the mesh flag the viewer reads.
 * No three.js — the sandbox worker imports this.
 */
export const SHEET_METAL_BEGIN = '// --- sheet-metal begin ---';
export const SHEET_METAL_END = '// --- sheet-metal end ---';

export function hasSheetMetalBlock(script) {
  const s = String(script || '');
  const i = s.indexOf(SHEET_METAL_BEGIN);
  return i >= 0 && s.indexOf(SHEET_METAL_END, i) > i;
}

/** Tag a serialized mesh so the viewer and the part thumbnail share one material. */
export function markSheetMesh(mesh, script) {
  if (!mesh || typeof mesh !== 'object') return mesh;
  if (hasSheetMetalBlock(script)) mesh.sheetMetal = true;
  return mesh;
}

export function isSheetMesh(mesh) {
  return mesh?.sheetMetal === true;
}
