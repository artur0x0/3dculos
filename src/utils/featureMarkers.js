/**
 * Slice Mobile B — parse marked Contour / Extrude / Fillet / … blocks so the
 * Script-stage feature strip can jump the caret between modeling steps.
 *
 * Markers are the same begin/end comments composers already write
 * (helperPaletteSnippets.js). Geometry highlight is out of scope for B.
 */

import {
  CONTOUR_PROFILE_BEGIN,
  CONTOUR_PROFILE_END,
  CONTOUR_EXTRUDE_BEGIN,
  CONTOUR_EXTRUDE_END,
  CONTOUR_REVOLVE_BEGIN,
  CONTOUR_REVOLVE_END,
  CONTOUR_LOFT_BEGIN,
  CONTOUR_LOFT_END,
  CONTOUR_SWEEP_BEGIN,
  CONTOUR_SWEEP_END,
  FILLET_MODE_BEGIN,
  FILLET_MODE_END,
  CHAMFER_MODE_BEGIN,
  CHAMFER_MODE_END,
} from './helperPaletteSnippets.js';

/** Ordered kinds the strip cares about (label is the chip text). */
export const FEATURE_MARKER_KINDS = Object.freeze([
  { begin: CONTOUR_PROFILE_BEGIN, end: CONTOUR_PROFILE_END, kind: 'profile', label: 'Profile' },
  { begin: CONTOUR_EXTRUDE_BEGIN, end: CONTOUR_EXTRUDE_END, kind: 'extrude', label: 'Extrude' },
  { begin: CONTOUR_REVOLVE_BEGIN, end: CONTOUR_REVOLVE_END, kind: 'revolve', label: 'Revolve' },
  { begin: CONTOUR_LOFT_BEGIN, end: CONTOUR_LOFT_END, kind: 'loft', label: 'Loft' },
  { begin: CONTOUR_SWEEP_BEGIN, end: CONTOUR_SWEEP_END, kind: 'sweep', label: 'Sweep' },
  { begin: FILLET_MODE_BEGIN, end: FILLET_MODE_END, kind: 'fillet', label: 'Fillet' },
  { begin: CHAMFER_MODE_BEGIN, end: CHAMFER_MODE_END, kind: 'chamfer', label: 'Chamfer' },
]);

/**
 * Scan `script` for every complete begin…end marker pair.
 * Returns blocks sorted by start offset:
 *   { id, kind, label, chipLabel, startOffset, endOffset, index, typeIndex }
 */
export function parseFeatureMarkers(script) {
  if (typeof script !== 'string' || script.length === 0) return [];

  const hits = [];
  for (const def of FEATURE_MARKER_KINDS) {
    let from = 0;
    while (from < script.length) {
      const i = script.indexOf(def.begin, from);
      if (i < 0) break;
      const j = script.indexOf(def.end, i + def.begin.length);
      if (j < 0) break;
      hits.push({
        kind: def.kind,
        label: def.label,
        startOffset: i,
        endOffset: j + def.end.length,
      });
      from = j + def.end.length;
    }
  }

  hits.sort((a, b) => a.startOffset - b.startOffset);

  const kindTotals = Object.create(null);
  for (const h of hits) kindTotals[h.kind] = (kindTotals[h.kind] || 0) + 1;

  const kindSeen = Object.create(null);
  return hits.map((h, index) => {
    kindSeen[h.kind] = (kindSeen[h.kind] || 0) + 1;
    const typeIndex = kindSeen[h.kind];
    const chipLabel = kindTotals[h.kind] > 1
      ? `${h.label} ${typeIndex}`
      : h.label;
    return {
      id: `${h.kind}-${index}`,
      kind: h.kind,
      label: h.label,
      chipLabel,
      startOffset: h.startOffset,
      endOffset: h.endOffset,
      index,
      /** 1-based index within this kind (badge on strip / sheet icons). */
      typeIndex,
    };
  });
}
