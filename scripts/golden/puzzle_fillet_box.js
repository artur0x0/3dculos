// Golden puzzle script — 40×30×20 box, all convex edges filleted r=3,
// spherical corners. Paste into SurfCAD editor.
let part = Manifold.cube([40, 30, 20], true);
part = filletEdges(part, convexEdges(part), 3, { sphericalCorners: true });
return part;
