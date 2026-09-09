# Manifold Sandbox Helper Functions

The Manifold Sandbox provides several helper functions in addition to the core Manifold API. These functions are available in all user scripts and simplify common CAD operations.

## Core Manifold API

All standard Manifold functions are available:
- `Manifold.cube(size, center)` - Create a cube/box
- `Manifold.cylinder(height, radiusLow, radiusHigh, circularSegments)` - Create a cylinder
- `Manifold.sphere(radius, circularSegments)` - Create a sphere
- `Manifold.union(manifolds)` - Boolean union
- `Manifold.difference(manifolds)` - Boolean difference
- `Manifold.intersection(manifolds)` - Boolean intersection
- Plus many more - see Manifold.js documentation

## Extended Helper Functions

### shell(manifold, thickness, axis)

Creates a hollow shell tool for subtraction. The shell is scaled uniformly and aligned to one side.

```javascript
// Create a hollow box with 2mm walls, open on Z-min side
const box = Manifold.cube([50, 50, 50], true);
const innerTool = shell(box, 2, 'z');
const hollowBox = box.subtract(innerTool);
return hollowBox;
```

**Parameters:**
- `manifold` - The input manifold
- `thickness` - Wall thickness in mm
- `axis` - Alignment axis: 'x', 'y', or 'z' (default: 'z')

**Returns:** The inner tool manifold for subtraction

---

### addDraft(manifold, draftDeg, axis)

Adds a draft angle (linear taper) to a manifold. Essential for injection molding 
and casting where parts need to release from molds.
```javascript
// Add 2° draft to a shelled box
const box = Manifold.cube([50, 50, 30], true);
const hollowed = box.subtract(shell(box, 2, 'z'));
const drafted = addDraft(hollowed, 2, 'z');
return drafted;
```

**Parameters:**
- `manifold` - The manifold to add draft to
- `draftDeg` - Draft angle in degrees (typically 1-3° for injection molding)
- `axis` - The pull direction axis: 'x', 'y', or 'z' (default: 'z')

**Returns:** The drafted manifold, tapered toward the max end of the axis

**Notes:**
- The manifold tapers inward as you move from min to max along the axis
- Draft is applied symmetrically to perpendicular dimensions
- Typical draft angles: 1-2° for smooth surfaces, 3-5° for textured surfaces

---

### sweep(profile, path, options)

Sweeps a 2D cross-section along a parametric 3D path using Frenet-Serret frames.
```javascript
// Sweep a circle along a helix
const profile = CrossSection.circle(2, 32);
const helix = {
  position: (t) => [20 * Math.cos(t), 20 * Math.sin(t), 5 * t],
  tMin: 0,
  tMax: 4 * Math.PI
};
return sweep(profile, helix);
```

**Parameters:**
- `profile` - CrossSection to sweep (should be centered at origin)
- `path` - Parametric path object:
  - `position(t)` - Function returning [x, y, z] at parameter t (required)
  - `derivative(t)` - Function returning first derivative (optional, computed numerically if omitted)
  - `secondDerivative(t)` - Function returning second derivative (optional)
  - `tMin` - Start parameter (default: 0)
  - `tMax` - End parameter (default: 1)
- `options` - Optional settings:
  - `arcSamples` - Samples for arc-length table (default: 1000)
  - `extrudeSegments` - Segments along extrusion (default: 64)
  - `epsilon` - Delta for numerical derivatives (default: 1e-5)

**Example - Trefoil Knot:**
```javascript
const scale = 5;
const profile = CrossSection.circle(1, 32);
const trefoil = {
  position: (t) => [
    scale * (Math.sin(t) + 2 * Math.sin(2 * t)),
    scale * (Math.cos(t) - 2 * Math.cos(2 * t)),
    scale * (-Math.sin(3 * t))
  ],
  derivative: (t) => [
    scale * (Math.cos(t) + 4 * Math.cos(2 * t)),
    scale * (-Math.sin(t) + 4 * Math.sin(2 * t)),
    scale * (-3 * Math.cos(3 * t))
  ],
  tMin: 0,
  tMax: 2 * Math.PI
};
return sweep(profile, trefoil, { arcSamples: 2000, extrudeSegments: 128 });
```

---

### sweepPoints(profile, points, options)

Sweeps a profile along a path defined by an array of points using Catmull-Rom spline interpolation.
```javascript
// Sweep along a curved path
const profile = CrossSection.circle(2, 16);
const points = [
  [0, 0, 0],
  [20, 10, 0],
  [40, 0, 20],
  [60, -10, 20],
  [80, 0, 0]
];
return sweepPoints(profile, points);
```

**Parameters:**
- `profile` - CrossSection to sweep
- `points` - Array of [x, y, z] coordinates defining the path (minimum 2 points)
- `options` - Optional settings:
  - `closed` - If true, creates a closed loop (default: false)
  - Plus all options from `sweep()`

**Example - Closed Loop:**
```javascript
const profile = CrossSection.square([3, 3], true);
const ring = [
  [30, 0, 0],
  [0, 30, 10],
  [-30, 0, 0],
  [0, -30, 10]
];
return sweepPoints(profile, ring, { closed: true });
```

---

### Vector Helpers

These utility functions are available for advanced path calculations:

| Function | Description |
|----------|-------------|
| `vecAdd(a, b)` | Add two 3D vectors |
| `vecSub(a, b)` | Subtract b from a |
| `vecMul(s, v)` | Multiply vector by scalar |
| `vecDot(a, b)` | Dot product |
| `vecCross(a, b)` | Cross product |
| `vecNorm(v)` | Vector magnitude/length |
| `vecNormalize(v)` | Normalize to unit vector |
```javascript
// Example: compute a point offset along a normal
const normal = vecNormalize(vecCross(tangent, up));
const offsetPoint = vecAdd(point, vecMul(5, normal));
```

---

### tube(outerRadius, innerRadius, height, segments)

Creates a tube/pipe shape (hollow cylinder).

```javascript
// Create a tube with 10mm outer radius, 8mm inner radius, 30mm tall
const pipe = tube(10, 8, 30, 32);
return pipe;
```

**Parameters:**
- `outerRadius` - Outer radius
- `innerRadius` - Inner radius (hole)
- `height` - Height of the tube
- `segments` - Number of circular segments (default: 32)

---

### hexPrism(radius, height)

Creates a hexagonal prism (6-sided cylinder).

```javascript
// Create a hex nut shape
const hex = hexPrism(10, 5);
return hex;
```

**Parameters:**
- `radius` - Circumradius (center to vertex)
- `height` - Height

---

### mirror(manifold, plane, keepOriginal)

Mirrors a manifold across a plane.

```javascript
// Create a symmetric part
const half = Manifold.cube([20, 10, 10]);
const full = mirror(half, 'yz', true);
return full;
```

**Parameters:**
- `manifold` - The manifold to mirror
- `plane` - Mirror plane: 'xy', 'xz', or 'yz'
- `keepOriginal` - If true, unions with original (default: true)

---

### array3D(manifold, counts, spacing)

Creates a 3D rectangular array of copies.

```javascript
// Create a 3x3x2 grid of cubes
const cube = Manifold.cube([5, 5, 5], true);
const grid = array3D(cube, [3, 3, 2], [10, 10, 10]);
return grid;
```

**Parameters:**
- `manifold` - The manifold to array
- `counts` - [nx, ny, nz] number of copies in each direction
- `spacing` - [dx, dy, dz] spacing between copies

---

### polarArray(manifold, count, radius, axis)

Creates a circular/polar array of copies around an axis.

```javascript
// Create 6 cylinders in a circle
const cylinder = Manifold.cylinder(20, 5, 5, 32);
const circle = polarArray(cylinder, 6, 30, 'z');
return circle;
```

**Parameters:**
- `manifold` - The manifold to array
- `count` - Number of copies
- `radius` - Radius from center (optional offset)
- `axis` - Rotation axis: 'x', 'y', or 'z' (default: 'z')

---

### center(manifold, axes)

Centers a manifold at the origin.

```javascript
// Center on all axes
const box = Manifold.cube([20, 30, 10]);
const centered = center(box, [true, true, true]);
return centered;

// Center only on X and Y
const partCentered = center(box, [true, true, false]);
```

**Parameters:**
- `manifold` - The manifold to center
- `axes` - [centerX, centerY, centerZ] which axes to center (default: all true)

---

### align(manifold, options)

Aligns a manifold to a specific position.

```javascript
// Align min-Z to the origin
const box = Manifold.cube([20, 20, 20], true);
const aligned = align(box, { min: [undefined, undefined, 0] });
return aligned;

// Center on X, align max-Y to 50
const positioned = align(box, { 
  center: [0, undefined, undefined],
  max: [undefined, 50, undefined]
});
```

**Parameters:**
- `manifold` - The manifold to align
- `options.min` - [x, y, z] align min bounds (use undefined to skip)
- `options.max` - [x, y, z] align max bounds
- `options.center` - [x, y, z] align center

---

### getDimensions(manifold)

Gets the dimensions and bounding box of a manifold.

```javascript
const box = Manifold.cube([20, 30, 10]);
const dims = getDimensions(box);
console.log(dims.size);   // [20, 30, 10]
console.log(dims.center); // [10, 15, 5]
console.log(dims.min);    // [0, 0, 0]
console.log(dims.max);    // [20, 30, 10]
```

**Returns:**
```javascript
{
  size: [x, y, z],    // Dimensions
  min: [x, y, z],     // Minimum corner
  max: [x, y, z],     // Maximum corner
  center: [x, y, z]   // Center point
}
```

---

### getScaleRatio(manifold, axis, thickness)

Helper function used by `shell()`. Computes the uniform scale ratio needed to create a shell of the given thickness.

**Parameters:**
- `manifold` - The input manifold
- `axis` - Axis index (0=x, 1=y, 2=z)
- `thickness` - Desired wall thickness

**Returns:** Scale ratio (0-1)

---

## Selection & Feature Helpers (C4)

These helpers add a geometric **selector layer** (Manifold has no native
face/edge API) plus parametric **features** (holes, counterbores,
countersinks, chamfers). They read a manifold's mesh via `getMesh()` and
operate in local 2D face frames, so a script can reason about "the top
face", "vertical edges", or "a hole pattern on this wall" the way a CAD
user does.

All of them take and return standard `Manifold` objects and validate the
result (`status() === 'NoError'`), throwing on failure.

### Face & edge selection

`c4MeshData` is the internal indexer (grouping triangles into BRep faces
via `faceID`, welding edges). The public selectors:

### facesByNormal(m, dir, tolDeg = 1)

**Parameters:**
- `m` - The input manifold
- `dir` - Target normal as `[x,y,z]` (e.g. `[0,0,1]` for `>Z`, `[0,0,-1]` for `<Z`)
- `tolDeg` - Angular tolerance in degrees (default 1)

**Returns:** Array of face objects `{ id, tris, normal, center, verts }`.

```javascript
const topFaces = facesByNormal(part, [0, 0, 1]);      // all upward faces
const wall     = facesByNormal(part, [1, 0, 0])[0];   // a +X face
```

### planarFaceAt(m, axis, value, tol = 1e-3)

The single planar face lying in the plane `axis == value` (axis `'x'|'y'|'z'`).
Returns `null` if none, throws if more than one.

```javascript
const top = planarFaceAt(part, 'z', 30);   // the face at z=30
```

### edgesByOrientation(m, axis, dir = null, tolDeg = 5)

Edges parallel to `axis` (`'x'|'y'|'z'`). `dir` of `1` / `-1` / `null`
selects one direction or both.

```javascript
const vEdges = edgesByOrientation(part, 'z');      // all vertical edges
```

### workplaneFromFace(m, face)

Builds a deterministic, axis-aligned local frame on a face (or a face index
into `m`). Returns `{ center, normal, x, y }` where `normal` is the outward
face normal and `(x, y)` are the in-plane axes. Axes are aligned to world
axes so `(u, v)` map to predictable world directions:

- `+Z` face → `u→+X, v→+Y`   - `-Z` face → `u→+X, v→-Y`
- `+X` face → `u→+Y, v→+Z`   - `-X` face → `u→+Y, v→-Z`
- `+Y` face → `u→+X, v→-Z`   - `-Y` face → `u→+X, v→+Z`

```javascript
const fr = workplaneFromFace(part, facesByNormal(part, [0,0,1])[0]);
// fr.center, fr.normal, fr.x, fr.y
```

### placeOnFace(part, frame, builder)

Runs `builder` in the face's local frame. The builder receives
`{ Manifold, frame, put }` where `put(m, [u,v,w])` transforms a built
Manifold so its origin lands at `center + u·x + v·y + w·normal` (w is along
the outward normal; negative w goes into the solid). Lets scripts write
axis-aligned geometry for arbitrary face normals. Returns the builder's
Manifold.

```javascript
const fr = workplaneFromFace(part, facesByNormal(part, [0,0,1])[0]);
const rib = placeOnFace(part, fr, ({ put, Manifold }) =>
  put(Manifold.cube([40, 4, 6], true), [0, 0, -3]));
return Manifold.union(part, rib);
```

### Features

### hole(part, frame, u, v, dia, span)

Cut a round through-hole on `frame` at local `(u, v)` (mm), diameter `dia`,
cut length `span` along the outward normal. Use `holeSpan()` for full
thickness.

```javascript
const fr = workplaneFromFace(part, facesByNormal(part, [0,0,1])[0]);
part = hole(part, fr, 10, 5, 6, holeSpan(part, fr));
```

### holeSpan(part, frame)

Full extent of the part along the frame normal (both directions) + 2 mm
overshoot — a safe full-through cut length from that face.

### cboreHole(part, frame, u, v, diaThru, diaCbore, cboreDepth, span)

Through hole `diaThru` plus a larger counterbore `diaCbore` to `cboreDepth`
from the face. (CadQuery `cboreHole`.)

### cskHole(part, frame, u, v, diaThru, diaCsk, cskDepth, span)

Through hole `diaThru` plus a cone countersink spanning `diaThru`→`diaCsk`
over `cskDepth`. (CadQuery `cskHole`.)

### chamferEdges(part, edges, c)

Equal-leg 45° chamfer on a **set** of straight convex edges. `c` is the
**leg length along each adjacent face** (CAD "C2" = 2 mm on both legs) —
the perpendicular face offset is derived from the face-to-face angle
(`offset = c·tan(θ/2)`; at a 90° corner they coincide, at a 120° hex-nut
corner C2 → 1.155 mm offset). `edges` come from `convexEdges()` /
`c4MeshData()` / other C4 selectors (they carry `faces: [i0, i1]`, from
which `chamferEdges` **auto-derives the adjacent face normals**) or a plain
`[{va, vb, n0, n1}]` array where `n0`/`n1` (outward normals of the two
adjacent faces) must be provided explicitly.

Cutters are applied **sequentially** (one boolean per edge) and every
intermediate result is checked, so a single degenerate edge (e.g. at a
triple-junction rib-base edge where the two "adjacent faces" are
coplanar) throws a named, actionable error instead of trapping the wasm
kernel. Cost: n differences instead of 1 — fine for the edge counts these
parts use (≤ ~30).

```javascript
part = chamferEdges(part, convexEdges(part), 2);
```

**Throws (named errors):** edge without va/vb; missing adjacent face
normals (pass `convexEdges()` output on THIS part, or explicit n0/n1);
coplanar adjacent faces (tessellation seam / wrong face pair); degenerate
cutter or failed boolean at a specific edge index.

### convexEdges(m, minAngleDeg = 2)

Genuine straight convex edges: dihedral angle > `minAngleDeg` (filters
curved-face tessellation seams) and a ball-probe confirms the corner is
convex (not concave). Returns edge objects `{ va, vb, a, b, tris, tangent,
faces: [i0, i1], n0, n1 }` — `n0`/`n1` are the adjacent face normals and
`faces` the face indices, so the result is ready for `chamferEdges`
(normals auto-derived) and `filletEdges` as-is.

```javascript
const vConvex = convexEdges(part).filter(e => Math.abs(e.tangent[2]) > 0.99);
part = chamferEdges(part, vConvex, 0.5);   // chamfer only the vertical corners
```

### holePattern(part, frame, { n, m, spacingU, spacingV, dia, span, u0=0, v0=0 })

Linear grid of `n`×`m` through-holes (CadQuery `rarray`), centered on the
face center plus an optional `(u0, v0)` offset.

```javascript
const fr = workplaneFromFace(part, facesByNormal(part, [0,0,1])[0]);
part = holePattern(part, fr, { n: 3, m: 2, spacingU: 12, spacingV: 10, dia: 4 });
```

---

## Fillet Helper (C6)

### filletEdges(part, edges, radius, opts)

Circular fillet of radius `r` on a **set** of straight convex edges
(Manifold has no native fillet; this is a geometric construction).
`edges` must come from `convexEdges()` (it needs the per-edge vertex
indices to recover the in-face directions — and the in-face geometry, not
just the normals, is what makes non-90° corners work). `radius` is a
number (same `r` for all edges) or a `number[]` parallel to `edges`
(per-edge radii). `opts` (optional): `{ sphericalCorners: true }`
(see below).

```javascript
// round all 12 box corners at r=3
part = filletEdges(part, convexEdges(part), 3);

// fillet only the 4 vertical corners, mixed radii per edge
const vert = convexEdges(part).filter(e => Math.abs(e.tangent[2]) > 0.99);
part = filletEdges(part, vert, [3, 3, 5, 5]);

// fully-rounded box corners: r=5 fillets + spherical corner patches
part = filletEdges(part, convexEdges(part), 5, { sphericalCorners: true });
```

**How it works (per edge).** In the cross-section perpendicular to the
edge, the two faces meet at interior angle θ. The fillet arc of radius `r`
is tangent to both faces at distance `t = r/tan(θ/2)` from the corner,
centered on the interior angle bisector at `r/sin(θ/2)`. The removed
cross-section is the sliver `r·t − ½·r²·(π−θ)` (= `r²(1−π/4)` at 90°).
The cutter is exactly `parallelepiped(t·f0, t·f1, edge) − cylinder(r)` —
both are exact primitives, so the result is geometrically exact for any
θ. The in-face boundary directions `f0`/`f1` come from the adjacent
triangles' third vertices (robust to Manifold's `faceID` grouping, which
can merge faces from different planes into one). All cutters for the set
are unioned and subtracted once, so shared-corner interactions resolve
through the boolean — matching analytic inclusion-exclusion for adjacent
edges (two cutters at a corner, three at a box corner).

**Closed circular rims (v2, 2026-09-08).** A curved surface (a cylinder
wall, a hole wall) meeting a planar face tessellates as a LOOP of many
short straight mesh edges — e.g. a Ø12 hole rim at 48 segments has
~0.78mm segments. In v1 this loop was filleted PER SEGMENT, and any
segment failing the size guard below was silently skipped — for a real
fillet radius (r=1 on that Ø12 rim, t=1 > 0.45·0.78mm) EVERY segment
failed, so the whole rim's fillet silently vanished with no error. v2
detects a maximal chain of input edges that (a) share consecutive mesh
vertices, (b) turn ≤30° at each shared vertex (a genuine polygon corner
turns 60-180°; a tessellated circle turns 360/segs°, well under 30° for
any segs≥12), and (c) keep the same interior angle θ (within 3°) and the
same radius. If that chain closes into a loop AND fits an exact circle
(3-point circumcircle, verified against every other vertex in the run),
the WHOLE rim is filleted as one exact revolved cutter — the same 2D
corner-sliver cross-section swept a full 360° around the rim's own axis
— instead of per-segment boxes, so the old per-segment size guard does
not apply to it at all. `convexEdges(part)` (unfiltered, or filtered only
by position/orientation — do NOT filter out short segments) is the
correct input; a "filter out the tiny seam edges" workaround is no longer
necessary or correct for a genuine curved rim. If a chain doesn't close,
or doesn't fit a clean circle (mixed/non-circular topology), filletEdges
falls back to the v1 per-edge construction for every edge in that chain,
including the size guard below — so isolated straight edges and
non-circular chains behave exactly as before.

**Constraints (v1 per-edge path — still the fallback for singleton edges
and non-circular chains).**
- **Planar faces only** — each adjacent face must be planar at the edge
  (checked: all same-face neighbor triangles coplanar within 1e-3). A
  fillet touching a curved face **throws** for a SINGLETON edge. (A
  successfully-fit closed circular run skips this check entirely — the
  circle fit plus per-vertex on-circle verification is a strictly more
  specific validity proof for "this chain is one smooth curved feature"
  than the singleton check, which was never designed to look past one
  edge.)
- **Convex edges only** — concave corners (rounding = adding material)
  throw. `convexEdges()` already filters these out; passing them directly
  also throws via the ball probe. (Applies to every edge, run or not.)
- **Size guard** — for a SINGLETON edge (or an edge in a chain that didn't
  qualify as a closed circular run), `r` must satisfy `t < 0.45·L` where
  `L` is the edge length; edges that FAIL this guard are **skipped** (part
  unchanged for that edge), not an error. Closed-circular-run members are
  exempt — their per-segment `L` is a tessellation artifact, not a signal
  that the feature is too small.
- **Arc tessellation** — a SINGLETON edge's fillet arc is an inscribed
  384-gon: the result volume sits at most `L·(π−(n/2)·sin(2π/n))·r²` BELOW
  the circle-exact value per edge. A closed run's revolve resolution is
  tied to the rim's own mesh segment count exactly (verified necessary
  for a numerically clean boolean: Manifold's boolean difference between
  the original n-segment part and a cutter revolved at a DIFFERENT
  segment count — even a clean integer multiple of n — silently removes
  LESS than the cutter's own volume), with a separately-tunable, finer
  resolution for the small fillet arc itself.
- **Known gaps** — an OPEN curved run (a fillet on a less-than-360° arc)
  does not get the closed-run treatment and can still lose short segments
  to the size guard; not exercised by any part in the current corpus
  (every curved surface here comes from a full-revolution primitive). A
  closed-run cutter throws (rather than silently clipping) if `r` is so
  large the fillet would revolve through the rim's own axis.

**Spherical corner caps** (`opts.sphericalCorners: true`). Three fillets
meeting at a box corner converge to a sharp cusp point — the plain
result is a valid but pointy corner. With this option the cusp pocket is
cut away by a ball of radius `r` centered on the trihedral incenter
(equidistant `r` from all three faces and lying ON all three fillet
cylinder axes), leaving a spherical corner patch that is tangent to each
fillet sail along a circle (C1 junction) and to each face at one point —
i.e. the true CAD r/r/r rounded corner. v1 scope: applies only at
vertices where exactly THREE filleted edges meet at ~90° with EQUAL
radii; other corners keep the cusp, and non-triple corners are
unaffected (the option is a no-op on an edge set whose corners have
fewer than three fillets).

**Verified** against analytic volumes: single edge, 4 top edges, all 12
box edges (pair + triple corner overlaps), an obtuse wedge (90°/116°/153°
corners), and mixed per-edge radii — see `cadgen-workspace/reports/c6-report.md`.

---

## Revolve & Extrude Helpers (C8)

### makeRevolve(contours, segments = 96)

Revolve a 2D profile around its **Y** axis → result axis = **Z**.
`contours` = `[[x,y]...]` outer first + optional hole contours after;
winding is **auto-normalized** (outermost CCW, holes CW) — do NOT hand-roll
`new CrossSection(...).revolve()` and fight winding yourself (wrong winding
fails silently in raw CrossSection). Profile: **x = radial distance (≥ 0),
y = height along the axis**. Throws a named error on an invalid profile
instead of returning a silent empty manifold.

```javascript
// revolved flange ⌀90×10 + boss ⌀30 base, 30 tall — one closed silhouette
let part = makeRevolve([ [[0,0],[45,0],[45,10],[15,10],[15,30],[0,30]] ], 96);

// hollow tube OD40 ID28 × 30: outer contour + inner (through) contour
const tube = makeRevolve([ [[0,0],[20,0],[20,30],[0,30]],
                           [[14,0],[14,30],[20,30],[20,0]] ], 64);
```

### makeExtrude(contours, height)

Extrude a 2D profile by `height` along +Z. Same contour rules as
makeRevolve (outer + optional holes, winding auto-fixed).

```javascript
const plate = makeExtrude([ [[-40,-15],[40,-15],[40,15],[-40,15]] ], 3);
```

**Rules for both:**
- `contours` is an **array of contours** `[outer, hole1, ...]`; a single
  solid can be written as `[...pts]` (bare point list) — both accepted.
- Every contour needs **≥ 3 distinct points**, closed polygon (auto-closed
  if first ≠ last). Open polylines / 2-point lists throw.
- For a **hollow** part: outer contour + inner contour (through-hole).
- Invalid profile → **named throw** (never a silent empty).

---

## Example: Complex Part

```javascript
// Create a flanged tube with mounting holes

// Main tube
const mainTube = tube(15, 12, 40, 64);

// Bottom flange
const flange = Manifold.cylinder(5, 25, 25, 64);

// Mounting holes in flange
const bore = Manifold.cylinder(10, 3, 3, 32);
const holes = polarArray(bore, 4, 20, 'z');

// Combine
let part = mainTube.add(flange);
part = part.subtract(holes);

// Center and align bottom to Z=0
part = center(part, [true, true, false]);
part = align(part, { min: [undefined, undefined, 0] });

return part;
```

## Security Notes

Scripts run in an isolated Web Worker sandbox with:
- No network access (fetch, XMLHttpRequest, WebSocket blocked)
- No storage access (indexedDB, localStorage blocked)
- No worker spawning
- Memory limits enforced
- Execution timeout enforced

Imported models are available via `window.__importedManifolds['filename']`.
