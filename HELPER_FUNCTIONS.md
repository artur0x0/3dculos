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

## Example: Complex Part

```javascript
// Create a flanged tube with mounting holes

// Main tube
const mainTube = tube(15, 12, 40, 64);

// Bottom flange
const flange = Manifold.cylinder(5, 25, 25, 64);

// Mounting holes in flange
const hole = Manifold.cylinder(10, 3, 3, 32);
const holes = polarArray(hole, 4, 20, 'z');

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
