/**
 * Slice Mobile B — parse marked Contour / Extrude / Fillet / … blocks so the
 * Script-stage feature strip can jump the caret between modeling steps.
 *
 * Markers are the same begin/end comments composers already write
 * (helperPaletteSnippets.js). Geometry highlight is out of scope for B.
 *
 * Slice A — also parse primitives / polish / move insertables so every
 * left-rail feature that creates a block shows a strip chip (same pattern
 * as fillets).
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
  CUBE_BEGIN,
  CUBE_END,
  ROUNDED_BOX_BEGIN,
  ROUNDED_BOX_END,
  CYLINDER_BEGIN,
  CYLINDER_END,
  SPHERE_BEGIN,
  SPHERE_END,
  TUBE_BEGIN,
  TUBE_END,
  HEX_PRISM_BEGIN,
  HEX_PRISM_END,
  HOLE_BEGIN,
  HOLE_END,
  HOLE_PATTERN_BEGIN,
  HOLE_PATTERN_END,
  CLEARANCE_HOLE_BEGIN,
  CLEARANCE_HOLE_END,
  TAP_DRILL_HOLE_BEGIN,
  TAP_DRILL_HOLE_END,
  CBORE_HOLE_BEGIN,
  CBORE_HOLE_END,
  CSK_HOLE_BEGIN,
  CSK_HOLE_END,
  SHELL_BEGIN,
  SHELL_END,
  DRAFT_BEGIN,
  DRAFT_END,
  CENTER_BEGIN,
  CENTER_END,
  ALIGN_BEGIN,
  ALIGN_END,
  MIRROR_BEGIN,
  MIRROR_END,
  ARRAY_BEGIN,
  ARRAY_END,
  POLAR_ARRAY_BEGIN,
  POLAR_ARRAY_END,
  WORKPLANE_BEGIN,
  WORKPLANE_END,
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
  { begin: CUBE_BEGIN, end: CUBE_END, kind: 'cube', label: 'Cube' },
  { begin: ROUNDED_BOX_BEGIN, end: ROUNDED_BOX_END, kind: 'roundedBox', label: 'Round box' },
  { begin: CYLINDER_BEGIN, end: CYLINDER_END, kind: 'cylinder', label: 'Cylinder' },
  { begin: SPHERE_BEGIN, end: SPHERE_END, kind: 'sphere', label: 'Sphere' },
  { begin: TUBE_BEGIN, end: TUBE_END, kind: 'tube', label: 'Tube' },
  { begin: HEX_PRISM_BEGIN, end: HEX_PRISM_END, kind: 'hexPrism', label: 'Hex' },
  { begin: HOLE_BEGIN, end: HOLE_END, kind: 'hole', label: 'Hole' },
  { begin: HOLE_PATTERN_BEGIN, end: HOLE_PATTERN_END, kind: 'holePattern', label: 'Hole grid' },
  { begin: CLEARANCE_HOLE_BEGIN, end: CLEARANCE_HOLE_END, kind: 'clearanceHole', label: 'Clearance' },
  { begin: TAP_DRILL_HOLE_BEGIN, end: TAP_DRILL_HOLE_END, kind: 'tapDrillHole', label: 'Tap drill' },
  { begin: CBORE_HOLE_BEGIN, end: CBORE_HOLE_END, kind: 'cboreHole', label: 'Cbore' },
  { begin: CSK_HOLE_BEGIN, end: CSK_HOLE_END, kind: 'cskHole', label: 'Csk' },
  { begin: SHELL_BEGIN, end: SHELL_END, kind: 'shell', label: 'Shell' },
  { begin: DRAFT_BEGIN, end: DRAFT_END, kind: 'draft', label: 'Draft' },
  { begin: CENTER_BEGIN, end: CENTER_END, kind: 'center', label: 'Center' },
  { begin: ALIGN_BEGIN, end: ALIGN_END, kind: 'align', label: 'Align' },
  { begin: MIRROR_BEGIN, end: MIRROR_END, kind: 'mirror', label: 'Mirror' },
  { begin: ARRAY_BEGIN, end: ARRAY_END, kind: 'array', label: 'Array' },
  { begin: POLAR_ARRAY_BEGIN, end: POLAR_ARRAY_END, kind: 'polarArray', label: 'Polar' },
  { begin: WORKPLANE_BEGIN, end: WORKPLANE_END, kind: 'workplane', label: 'Workplane' },
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
