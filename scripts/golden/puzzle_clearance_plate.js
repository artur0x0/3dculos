// Golden puzzle script — 60×40×6 plate with M3 clearance, M5 tap-drill,
// M4 counterbore, and outer-top chamfer. Paste into SurfCAD editor.
let part = Manifold.cube([60, 40, 6], true);
part = align(part, { min: [undefined, undefined, 0] });

const top = facesByNormal(part, [0, 0, 1])[0];
const fr = workplaneFromFace(part, top);
const span = holeSpan(part, fr);

part = clearanceHole(part, fr, -15, 0, 'M3', span, 'normal');
part = tapDrillHole(part, fr, 15, 0, 'M5', span);
part = cboreHole(part, fr, 0, 10, fastenerClearanceDia('M4'), 8, 3.5, span);

const topRim = convexEdges(part).filter((e) =>
  Math.abs(e.va[2] - 6) < 0.05 && Math.abs(e.vb[2] - 6) < 0.05
);
part = chamferEdges(part, topRim, 1);

return part;
