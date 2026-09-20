# Manifold Sandbox Helper Functions

The Manifold Sandbox provides several helper functions in addition to the core Manifold API. These functions are available in all user scripts and simplify common CAD operations.

## Official puzzle vocabulary (Slice 01)

Match-the-part puzzles are expected to stay inside this allowlist. Prefer these
names over hand-rolled cylinders for fastener features so scripts stay
comparable and train-able.

| Helper | Role |
|---|---|
| `filletEdges(part, edges, r, opts?)` | Circular fillet on convex edges (C6) |
| `chamferEdges(part, edges, c)` | Equal-leg chamfer (C4) |
| `hole` / `holeSpan` / `holePattern` | Generic through-holes |
| `clearanceHole(part, frame, u, v, size, span?, fit?)` | Clearance hole by fastener size |
| `tapDrillHole(part, frame, u, v, size, span?)` | Tap-drill hole by fastener size |
| `cboreHole` / `cskHole` | Counterbore / countersink |
| `convexEdges` / `facesByNormal` / `workplaneFromFace` / `planarFaceAt` / `edgesByOrientation` / `placeInFrame` / `transformByFrame` | Selection / frame |
| `shell`, `addDraft`, `tube`, `hexPrism`, `roundedBox`, `mirror`, `array3D`, `polarArray`, `center`, `align` | Solids / layout |
| `loft`, `makeLoft`, `offsetPlaneFrame`, `sweep`, `sweepPoints`, `makeExtrude`, `makeRevolve` | Profiles / paths |
| `profileCircle` / `profileRectangle` / `profilePolygon` / `makeCrossSection` | Cross-section substrate (Slice 21) |
| `makeSweepPath(edges, opts?)` | Ordered sweep path / wire from edges (Slice 22) |
| `filletAlongPath(part, path, r, opts?)` | Sweep fillet/chamfer wedge along path → subtract (Slice 23) |

**Loud failure rule:** feature helpers throw named `Error`s on bad inputs,
degenerate cutters, non-manifold / empty results, or (for `filletEdges`) when
*every* requested edge is skipped. Silent “success” with an unchanged solid is
not allowed for puzzle vocabulary ops.

**Supported / unsupported (honest):**
- **Supported:** straight convex edges; closed circular rims via `filletEdges`
  closed-run detection; **sweep fillet** via `filletAlongPath` for compound /
  curved-adjacent chains (post-fillet seams, circular rims as Path); metric +
  common UNC clearance/tap sizes below.
- **Unsupported (planar `filletEdges`):** curved-face singleton fillets; open
  (partial-arc) curved runs under C6. **Strategy=sweep** / `filletAlongPath` is
  the default Fillet path. Still unsupported: concave “fillets” (adding material); variable-radius
  / rolling-ball industrial fillets; arbitrary non-table fastener sizes.

Lookup helpers (also injected): `fastenerClearanceDia(size, fit?)`,
`fastenerTapDrillDia(size)`, `fastenerMajorDia(size)`, `listFastenerSizes()`,
`resolveFastenerSize(size)`.


## Face-select feature placement (Slice 11)

In **game mode**, tapping a face in the viewport then a face-aware palette
feature (Hole, Clearance, Cbore, Csk, Hole grid, Fillet, Chamfer) opens a
param sheet seeded from that face. Generated code resolves the face with
`facesByNormal(body, normal, tolDeg?)` + closest-center pick, then
`workplaneFromFace` — never an illegal bare `top` identifier.

**Face classification** (from Viewport `selectedFace`):

| Type | How detected | Param sheet |
|---|---|---|
| Planar | single-click `coplanar` (or small angular walk) | u/v, dia/depth/through, optional n×m pattern |
| Cylindrical | double-click `angular-tolerance` with ≥8 tris | angle°, axial height, dia/depth/through |
| Irregular | triple-click `all-connected` | **refused** with a clear message (v1 — no best-fit) |

Fillet/Chamfer with a face filters `convexEdges(body)` to edges whose `n0`/`n1`
aligns with the face normal (`edgeScope: face`); fallback `allConvex` uses
all convex edges.

Without a selected face, palette v2 behavior is unchanged (default +Z
`topFace` workplane / body selector).

**Sweep path (Slice 22):** palette **Path** builds an ordered wire from
Edge selection (open chain or closed loop). Consume with **Fillet → Strategy=sweep**
(`filletAlongPath`) or `sweepPoints`.

**Sweep fillet (Slice 23+):** same **Fillet** control — **Strategy=sweep** is the
universal default (and **auto** resolves to sweep). **planar** is an explicit
manual override for classic `filletEdges` (planar–planar / closed-run C6).
**sweep** builds `makeSweepPath` + `filletAlongPath` (quarter-circle or chamfer
wedge swept as a **linear polyline** along the edge wire, boolean subtract).
Disconnected / branched selections loud-fail (path stays visible) — never a
wrong solid.

**Fillet mode (Slice 27):** tapping **Fillet** enters edge-pick mode with no
prior selection required (no soft-fail / no pre-select). The chip is Tangent
(default-on) / Clear / **Accept** / Back. Live sweep-blend preview updates as
edges accumulate. **Accept** writes `makeSweepPath` + `filletAlongPath` in a
marked block and Auto-Runs; second Accept replaces that same block. **Back**
exits with no commit. Strategy default stays **sweep**.

**Cross-section (Slice 21):** `makeCrossSection(plane, profile)` is the reusable
plane + 2D profile substrate (planar face via `workplaneFromFace`, or default
+Z). Cylindrical / irregular faces are refused. Does **not** extrude, sweep,
or fillet — substrate only.

**Contour mode (Slice 24/25/26/28):** in game mode, tapping **Extrude**, **Revolve**,
**Loft**, or **Profile** enters a shared contour shell — the part stays on
screen but is ghosted, the left rail swaps to circle / rect / polygon /
polyline + **Back**, and a chip (Edge-pick pattern) holds plane + profile params.
Live preview uses `makeCrossSection`. **Profile** Confirm writes or updates the
in-mode Profile only. **Extrude** / **Revolve** / **Loft** Confirm commit the
profile(s) plus a solid (`makeExtrude` / `makeRevolve` / `makeLoft` via
`placeInFrame` — replace `part`, no host add; live solid preview). Second
Confirm updates the same marked block. **Back** exits with no additional solid
commit. **Fillet** is its own edge-pick mode (Slice 27), not a contour entry.
The one-shot Xform Extrude stub is gone — Extrude always enters contour mode.

**Loft v1 plane model (Slice 28):** one shared workplane (selected planar face
or default +Z). Each profile is `makeCrossSection` on `offsetPlaneFrame(plane,
offset)` — a copy of that plane whose `center` is translated by
`offset * normal`. Planes must stay parallel. Independent (skew / non-parallel)
profile planes are a later slice. Loud-fail on fewer than 2 profiles or
coincident station offsets. Confirm replaces `part` with
`placeInFrame(frame, makeLoft(sections))` (no host box / no `placeOnFace`+add).

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
into `m`). Returns `{ center, normal, x, y }` where `center` is the
area-weighted face centroid (coplanar connected triangles are merged even
when Manifold assigns per-triangle `faceID`s — so `hole(…, 0, 0, …)` hits
the true face center), `normal` is the outward face normal, and `(x, y)`
are the in-plane axes. Axes are aligned to world axes so `(u, v)` map to
predictable world directions:

- `+Z` face → `u→+X, v→+Y`   - `-Z` face → `u→+X, v→-Y`
- `+X` face → `u→+Y, v→+Z`   - `-X` face → `u→+Y, v→-Z`
- `+Y` face → `u→+X, v→-Z`   - `-Y` face → `u→+X, v→+Z`

```javascript
const fr = workplaneFromFace(part, facesByNormal(part, [0,0,1])[0]);
// fr.center, fr.normal, fr.x, fr.y
```

### placeInFrame(frame, solid, uvw = [0, 0, 0]) / transformByFrame(…)

Places a solid on a **PlaneFrame** `{ center, normal, x, y }` (from
`workplaneFromFace` / `makeCrossSection.plane` / default +Z). The solid's
local origin lands at `center + u·x + v·y + w·normal`, axes aligned to
`(x, y, normal)`. **Frame-only** — never a Manifold / cube / scaffold.
Does not take a host part; assign the result (`part = placeInFrame(…)`).
`transformByFrame` is the same helper.

```javascript
const fr = { center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
const xs = makeCrossSection(fr, profileCircle(5, 32));
part = placeInFrame(xs.plane, makeExtrude(xs.contours, 10), [0, 0, 0]);
```

### placeOnFace(part, frame, builder)

Runs `builder` in the face's local frame. The builder receives
`{ Manifold, frame, put }` where `put(m, [u,v,w])` transforms a built
Manifold so its origin lands at `center + u·x + v·y + w·normal` (w is along
the outward normal; negative w goes into the solid). Lets scripts write
axis-aligned geometry for arbitrary face normals. Returns the builder's
Manifold. `part` is unused (legacy host arg). New-body Extrude / Revolve
Confirm uses `placeInFrame` and replaces `part` instead of `part.add`.

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


### clearanceHole(part, frame, u, v, size, spanOrOpts?, fit?)

Cut a **clearance** hole sized for fastener `size`. `size` accepts `'M3'`,
`3`, `'M2.5'`, `'#8-32'`, `'1/4-20'`, etc. `fit` is `'close'|'normal'|'loose'`
(aliases: tight/medium/coarse). `span` defaults to `holeSpan(part, frame)`.
You can also pass an options object as the 6th argument:
`{ fit: 'close', span: 12 }`.

```javascript
const fr = workplaneFromFace(part, facesByNormal(part, [0,0,1])[0]);
part = clearanceHole(part, fr, 10, 8, 'M3');                 // normal fit
part = clearanceHole(part, fr, -10, 8, 'M4', undefined, 'close');
part = clearanceHole(part, fr, 0, 0, 'M5', { fit: 'loose' });
```

Throws on unknown size/fit, non-positive derived diameter, bad frame, or empty /
non-manifold result.

### tapDrillHole(part, frame, u, v, size, span?)

Cut a **tap-drill** hole for fastener `size` (hole intended to be tapped).
`span` defaults to `holeSpan(part, frame)`.

```javascript
const fr = workplaneFromFace(part, facesByNormal(part, [0,0,1])[0]);
part = tapDrillHole(part, fr, 0, 0, 'M3');   // Ø2.5 for M3 coarse
part = tapDrillHole(part, fr, 12, 0, '#8-32');
```

### fastenerClearanceDia(size, fit = 'normal') / fastenerTapDrillDia(size)

Return the clearance or tap-drill diameter in **mm** without cutting. Useful
for custom patterns:

```javascript
const d = fastenerClearanceDia('M6', 'normal'); // 6.6
part = holePattern(part, fr, { n: 2, m: 2, spacingU: 20, spacingV: 20, dia: d });
```

`listFastenerSizes()` → `{ metric: ['M1.6','M2',…], unc: ['#4-40',…] }`.

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
  `L` is the edge length; individual edges that FAIL this guard are
  **skipped** when other edges still produce cutters. If **every** requested
  edge is skipped / rejected, `filletEdges` **throws** (no silent unchanged
  part). Closed-circular-run members are exempt — their per-segment `L` is a
  tessellation artifact, not a signal that the feature is too small.
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


---

## Cross-section substrate (Slice 21)

Reusable **plane + 2D profile** value for later edge→sweep path,
fillet-via-sweep, then extrude/revolve/loft siblings. This slice ships the
substrate only — those followers are **not** started here.

Plane comes from `workplaneFromFace` (primary mobile path: selected planar
face). Profile is a light 2D shape in plane UV. The returned value is a plain
object (no class inheritance):

```javascript
{
  kind: 'crossSection',
  plane: { center, normal, x, y },  // workplaneFromFace frame
  profile: { type: 'circle'|'rectangle'|'polygon', ... },
  contours: [ [[u,v], ...] ],       // ready for makeExtrude / sweep later
}
```

### profileCircle(radius, segments = 32)

Circle centered at UV origin.

```javascript
const p = profileCircle(5, 32);
```

### profileRectangle(width, height, centered = true)

Axis-aligned rectangle in UV.

```javascript
const p = profileRectangle(20, 12, true);
```

### profilePolygon(points)

Simple closed polyline / polygon (≥ 3 `[u,v]` points; explicit close optional;
winding normalized CCW). Enough for a quarter-circle fillet profile:

```javascript
const r = 3;
const filletProf = profilePolygon([
  [0, 0], [r, 0],
  [r * Math.cos(Math.PI / 4), r * Math.sin(Math.PI / 4)],
  [0, r],
]);
```

### makeCrossSection(plane, profile)

```javascript
let part = Manifold.cube([40, 30, 20], true);
const topFace = facesByNormal(part, [0, 0, 1])[0];
const fr = workplaneFromFace(part, topFace);
const xs = makeCrossSection(fr, profileCircle(5, 32));
// xs.plane / xs.profile / xs.contours — consume in later slices
return part;
```

**Parameters:**
- `plane` — frame from `workplaneFromFace` (`center`, `normal`, `x`, `y`)
- `profile` — `profileCircle` / `profileRectangle` / `profilePolygon` result,
  a `{ type, ... }` descriptor, or a contours / point list (same rules as
  `makeExtrude`)

**Returns:** `{ kind:'crossSection', plane, profile, contours }`

**Loud failures:** missing plane axes; non-positive sizes; < 3 polygon points;
degenerate (zero-area) profile.

**UI:** FEAT rail → **Profile** → param popup (circle / rectangle / polygon
presets including quarter-circle). Face select feeds the plane; Auto-Run
unchanged. Preview overlays the profile on the plane while editing.

**Non-goals (wait for Product brief):** fillet-via-sweep;
extrude/revolve/loft from this value; full sketch editor.
(Edge→sweep path is Slice 22 — see below.)

---

## Edge → sweep path (Slice 22)

Ordered **sweep path / wire** from the current edge selection (including
tangent-prop chains). Later slices consume this value to sweep a cross-section
cutter along it. This slice ships the path value only — fillet-via-sweep is
**not** started here (wait for Product brief).

```javascript
{
  kind: 'sweepPath',
  closed: false,                 // true for circular / loop selections
  points: [ [x,y,z], ... ],      // ordered polyline (closed: first ≠ last)
  length: 40,                    // total path length
  edgeCount: 3,
}
```

### Ordering

Selection is walked on the feature-edge graph (`buildEdgeVertexAdj` /
selection keys):

- **Open chain** — exactly two degree-1 endpoints; walk from an endpoint on
  the first-selected edge (stable direction).
- **Closed loop** — all vertices degree 2 (e.g. tangent-prop circular rim);
  walk from the first-selected edge.
- **Soft-fail** (toast, no broken JS): empty selection, disconnected
  components, or branched (Y/T) junctions.

### makeSweepPath(edges, opts?)

```javascript
let part = Manifold.cube([40, 30, 20], true);
const top = facesByNormal(part, [0, 0, 1])[0];
const fr = workplaneFromFace(part, top);
// Script path: pass convexEdges (or a filtered subset) — UI emits mid-matched selection.
const rim = convexEdges(part); // or selected edges from Edge pick + Tangent
const path = makeSweepPath(rim); // { kind:'sweepPath', closed, points, length, edgeCount }
// Later: sweepPoints(profile, path.points, { closed: path.closed })
return part;
```

**Parameters:**
- `edges` — array of feature edges `{ a, b, va, vb, length?, key? }` (from
  `convexEdges` / Edge pick selection)
- `opts.reverse` — optional; reverse polyline direction

**Returns:** `{ kind:'sweepPath', closed, points, length, edgeCount }`

**Loud failures (script):** empty / unusable edges; disconnected selection;
branched junctions; walk failure.

**UI:** FEAT rail → **Path** → param popup (Body, Reverse). Uses current Edge
selection + Tangent chip. Viewport preview shows order/direction (green→magenta
gradient polyline, chevron arrows, start/end markers) — distinct from the
orange #20 selection halo. Auto-Run unchanged.

**Non-goals (Slice 22):** fillet-via-sweep shipped in Slice 23; extrude/revolve/loft
still wait for Product brief; Profile API changes; full sketcher; C6 soft counters.


---

## Fillet via swept cross-section (Slice 23)

Unlock fillets on **compound / curved-adjacent** edges (cases where C6
`filletEdges` throws `curved-face fillet not supported`, e.g. post-fillet seams
or when you prefer Path-driven construction) by sweeping a cutter along
`makeSweepPath` and boolean-subtracting.

### filletAlongPath(part, path, radius, opts?)

```javascript
let part = Manifold.cube([40, 30, 20], true);
// Planar–planar (unchanged):
const e = convexEdges(part).filter(/* … */);
part = filletEdges(part, e, 3, { sphericalCorners: true });

// Sweep fillet (curved-adjacent / closed rim / post-fillet seam):
const rim = /* Edge pick + Tangent → selection, or convexEdges subset */;
const path = makeSweepPath(rim); // { kind:'sweepPath', closed, points, length, edgeCount }
part = filletAlongPath(part, path, 2);           // quarter-circle wedge
// part = filletAlongPath(part, path, 2, { profile: 'chamfer' }); // triangle
return part;
```

**Parameters:**
- `part` — manifold body
- `path` — `makeSweepPath` result, `{ points, closed }`, or `points[]` (+ `opts.closed`)
- `radius` — fillet / chamfer size (> 0)
- `opts.profile` — `'fillet'` (default, quarter-circle wedge) or `'chamfer'` (triangle)
- `opts.segments` — arc segments for the fillet wedge (default 12)
- `opts.initialNormal` — optional frame hint; otherwise probed from a nearby convex edge
- `opts.arcSamples` / `opts.extrudeSegments` — sweep quality (defaults scale with path size)

**Path / cutter:** open chains sweep the wedge along a **linear polyline** of the
edge wire (not Catmull-Rom — spline bulge left purple scraps). Closed paths that
fit a circle use a **revolved meridian wedge** (C6-style, phase-locked to the
tessellation). **Fillet-on-fillet / path on a prior blend:** keep the full wire,
including tessellated micro rim arcs — do **not** skip those segments (skipping
left a gap instead of wrapping the prior fillet). The quarter-circle / chamfer
cutter origin is pushed into a rear exterior bumper `(−e,−e)` plus thickness-`e`
strips so the boolean consumes coincident sliver sheets **without growing the
requested blend** (realized first-quadrant extent stays at `r`). Mixed-radius /
tighter follow-on sweeps use a deeper rear pad than the original 4%·r sliver.
Disconnected cutter scraps are dropped via `decompose` when present.
Loud-fail if the kept solid is still scrap-sheet dirty.

**Quarter-circle orientation:** the 2D wedge lives in the first quadrant `(u≥0,v≥0)`
with origin on the path. Sweep maps `(u,v) → u·N + v·B` (rotation-minimizing frame).
At path start, in-face rays `f0`/`f1` are probed from the part mesh (no planarity
assert — curved faces allowed). `initialNormal ≈ f0` so `N` tracks one face and
`B = T×N` the other; the path may be reversed so `B` aligns with `f1`. The wedge
is the **corner square minus the quarter-disk centered at `(r,r)`** — the material
a 90° external fillet removes (area `r²(1−π/4)` per unit length).

**Loud failures (script):** bad/empty path; radius ≤ 0; concave edge; cannot orient
cutter; sweep/boolean failure; ~0 volume removed (wrong orientation); near-no-op vs
expected wedge volume; empty result. Never silent wrong solid.

**Soft-fail (UI):** empty / disconnected / branched edge selection — same messages
as Path; no broken JS inserted.

### UI — Fillet Strategy

FEAT rail → **Fillet** → param popup:

| Strategy | Emits | When |
|---|---|---|
| **sweep** (default) | `makeSweepPath` + `filletAlongPath` | Universal fillet — opening Fillet without override |
| **auto** | same as **sweep** | Kept for older sheets; always resolves to sweep |
| **planar** | `filletEdges(…)` | Manual override for classic planar–planar / C6 closed-run |

**Radius slider:** defaults / max / step use the **effective** min edge length
(outliers dropped: short edges &lt;25% of median are ignored) so multi-edge /
tangent sets are not stuck near r≈0.03. The **0.45·L size guard is planar-only**
(`filletEdges` / Strategy=planar) — Strategy=sweep / `filletAlongPath`
uses path-length defaults (e.g. r≈6 on box-scale perimeters) and does **not**
clamp typed values under 0.45·L (tessellated prior-fillet rims would otherwise
pin the slider near ~0.04). Opening Fillet without override uses the sweep
slider (no 0.45·L clamp).

Sweep mode shows the Path order/direction preview (green→magenta). Auto-Run
unchanged. Keep using **Path** alone when you only need the wire value.

**Non-goals (wait for Product brief):** full industrial rolling-ball /
variable-radius fillets; Profile/Path API redesign; Loft through independent
(non-parallel) planes.

## Revolve & Extrude Helpers (C8)

### makeRevolve(contours, segments = 96, degrees = 360)

Revolve a 2D profile around its **Y** axis → result axis = **Z**.
`contours` = `[[x,y]...]` outer first + optional hole contours after;
winding is **auto-normalized** (outermost CCW, holes CW) — do NOT hand-roll
`new CrossSection(...).revolve()` and fight winding yourself (wrong winding
fails silently in raw CrossSection). Profile: **x = radial distance (≥ 0),
y = height along the axis**. If a polygon crosses the Y-axis, only the
positive-X side is used (Manifold clip). `degrees` is the sweep (default
360, must be > 0 and ≤ 360). Throws a named error on an invalid profile
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

**Contour-mode Extrude (Slice 25):** game-mode **Extrude** builds a profile on
the workplane, then Confirm emits:

```javascript
const fr = { center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
const xs = makeCrossSection(fr, profileCircle(5, 32));
part = placeInFrame(xs.plane, makeExtrude(xs.contours, 10), [0, 0, 0]);
```

`height` is always > 0. Sense **In** uses `w = −height`; **Both** uses
`w = −height/2`. Direction defaults to the plane normal; a world axis is
refused unless it is parallel to that normal. Loud-fail on a bad plane,
profile, or distance.

**Contour-mode Revolve (Slice 26):** game-mode **Revolve** builds a profile on
the workplane, then Confirm emits `makeCrossSection` + `makeRevolve` placed
so the axis lies **on the profile plane** (default: along V). The profile
is remapped with identity `(u,v)→(radial,height)` in the axis/radial basis
(axis through the workplane origin). A centered circle therefore revolves
about a diameter — a sphere. Profiles that cross the axis are clipped to
+radial (`makeRevolve` / Manifold); on-axis, zero-width, and entirely
−radial profiles loud-fail.

```javascript
const fr = { center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
const xs = makeCrossSection(fr, profileCircle(5, 32));
part = placeInFrame({
  center: xs.plane.center,
  x: xs.plane.x, y: xs.plane.normal, normal: xs.plane.y,
}, makeRevolve(xs.contours.map((ring) => ring.map(([u, v]) => [u, v])), 96, 360));
```

`angle` is always > 0 and ≤ 360 (default 360). Sense **In** starts at
`−angle`; **Both** starts at `−angle/2`. Axis defaults to plane **V**; a
world axis is refused unless it lies on the profile plane. Loud-fail on a
bad plane, profile, angle, or an on-axis / zero-width / entirely-negative
radial profile.

### makeLoft(sections, opts?) / offsetPlaneFrame(plane, offset)

Loft ≥2 `makeCrossSection` values into a solid. **v1 plane model:** all
planes must be parallel (same workplane + per-profile offset along the
normal). `offsetPlaneFrame(plane, offset)` copies a PlaneFrame and translates
`center` by `offset * normal`. The solid is **local** (XY = station UV, Z
along the shared normal, z=0 at the lowest station) — Confirm places it with
`placeInFrame`. The legacy `loft({ topCS, bottomCS, height })` cup helper is
unchanged.

```javascript
const fr = { center: [0, 0, 0], normal: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
const xs0 = makeCrossSection(fr, profileCircle(5, 32));
const xs1 = makeCrossSection(offsetPlaneFrame(fr, 20), profileCircle(8, 32));
part = placeInFrame(fr, makeLoft([xs0, xs1]));
```

**Contour-mode Loft (Slice 28):** game-mode **Loft** builds a multi-profile
list on the shared workplane (min 2, default circle r=5 @ 0 and circle r=8
@ 20). Circle / rect / polygon / polyline edit the selected profile. Confirm
emits one `makeCrossSection` per station (`offsetPlaneFrame` + profile) plus
`makeLoft`, then `part = placeInFrame(frame, makeLoft(…))` (replace, no host
add / no starter cube). Second Confirm replaces the same marked block.
**Back** exits with no commit. Live preview skins the stations as offsets /
shapes change.

**Loud failures:** < 2 profiles; coincident station offsets (zero-height);
non-parallel planes; degenerate / empty contours; empty result volume.
Never a silent wrong solid.

`opts.align` (default true) rotates neighboring contours to minimize
point-to-point distance. `opts.resolution` (default 64) is the resample
count for the warp.

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
