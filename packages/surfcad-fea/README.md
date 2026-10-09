# surfcad-fea

SurfCAD finite-element solver compiled to a **single-threaded** WebAssembly module with **WASM SIMD** (`simd128`). It does not use shared memory or threads, so the page does not need `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy` headers.

Two entry points share the module:

- `solve` is still the phase-0 **stub**. It returns a deterministic fake von Mises field and always sets `source` to `"stub"`. The wasm `capabilities()` still reports `solvers: ["stub"]`. The app worker calls `solve_tet10` for a study and uses `solve` only when the request sets `fallback: "stub"`. The page reports `source: "tet10"` and `shells: false`.
- `solve_tet10` is a clean-room linear-elastic static solver for 10-node tetrahedra. It sets `source` to `"fem"`.
- `solve_shell` is a clean-room linear shell for 6-node triangles. It sets `source` to `"shell"`.

The linear algebra is [faer](https://crates.io/crates/faer) 0.24 (MIT / Apache-2.0), built **without** the `rayon` feature so the factorization stays single-threaded (`Par::Seq`). Tet meshing is not in this crate. The shell does not need a separate mesher: the caller passes the 6-node triangulation.

The crate is Apache-2.0, the same license as the rest of the project.

## TET10 solver

Units are millimetres, newtons and megapascals. They are consistent (`1 MPa = 1 N/mm²`), so a modulus in MPa, coordinates in mm and forces in N produce displacements in mm and stresses in MPa with no conversion.

- Elements are quadratic tetrahedra in VTK order: corners 0, 1, 2, 3, then edge midpoints 0-1, 1-2, 2-0, 0-3, 1-3, 2-3.
- Stiffness uses the 4-point tetrahedron rule (exact through degree 2). A straight-sided element therefore has an exact linear-elastic stiffness.
- The global matrix is symmetric sparse CSC, lower triangle including the diagonal. Dirichlet DOFs are eliminated. A prescribed displacement may be nonzero.
- Loads are nodal forces (N) and uniform pressure on 6-node faces (MPa). Face order is `(c0, c1, c2, mid01, mid12, mid20)`. Positive pressure pushes against the right-hand normal of `(c0, c1, c2)`.
- Two solvers, chosen per call. `"cholesky"` is faer's supernodal sparse Cholesky. `"pcg"` is Jacobi-preconditioned CG (`tol` default `1e-8`, `maxIter` default `20000`). `"auto"` (the default) uses Cholesky when the free-DOF count is at or below `choleskyMaxDofs` (default `20000`) and PCG otherwise.
- Stress is recovered at the Gauss points, extrapolated to the element nodes, and averaged (the tensor is averaged, then von Mises is taken). The result is a per-node von Mises field plus `min`, `max` and nearest-rank `p95`. `safetyFactor` is `yield_MPa / p95` when yield is set and `p95 > 0`.

## Shell solver

The element is a **6-node** MITC triangle, not a 3-node one. A linear triangle does not contain the quadratic transverse displacement of a constant-curvature patch, so MITC3 only passes that patch with extra constraints and converges slowly on a curved roof. The 6-node element has quadratic displacements and geometry (a curved edge can follow a cylinder) and a linear rotation field, so constant membrane strain and constant curvature are in the space.

Transverse shear uses the MITC6-b tying from Lee and Bathe (2004): along each edge the tangential covariant shear is sampled at the two Gauss points and replaced by a linear assumed field. Constant shear is reproduced exactly, which keeps the patch tests, and a thin element is not forced to satisfy the Kirchhoff constraint at every quadrature point. The drilling rotation about the director is stabilized with a Hughes–Brezzi penalty `G t (θ·n − ω)²`, where `ω` is the midsurface spin. That term is zero for a rigid rotation.

- Six DOF per node, `(ux, uy, uz, θx, θy, θz)`, translations in millimetres and rotations in radians. `Dirichlet` indices are `node * 6 + component`.
- Thickness is **per element**, in millimetres. Nodal directors are the area-weighted average of the geometric normals, so a smooth shell shares a director and a fold (two plates meeting at a kink) is not a separate junction model.
- Loads are nodal forces (N) and uniform normal pressure (MPa). Positive pressure pushes against the right-hand normal of corners `(n0, n1, n2)`.
- Fixtures are clamped (all six DOFs) and pinned (translations only).
- The shell solve **prefers supernodal Cholesky**, including above the 20 000-DOF auto threshold used by `solve_tet10`. Pass `solver: "pcg"` or `"auto"` to override.
- Stress is the plane-stress von Mises on the top (`ζ = +1`), mid, and bottom (`ζ = −1`) surfaces. Tensors are averaged at the node, then von Mises is taken. `min`, `max`, and `p95` are computed on the combined top and bottom samples. `nodal` is the pointwise maximum of top and bottom.

## Build

From the repository root, with [wasm-pack 0.15.0](https://github.com/wasm-bindgen/wasm-pack/releases/tag/v0.15.0) on `PATH` and rustup able to read `rust-toolchain.toml` in this directory (channel `1.99.0`, target `wasm32-unknown-unknown`):

```bash
npm run fea:build
```

That runs `scripts/fea/build-wasm.mjs`, which:

- builds `--target web --release` with `+simd128`
- runs wasm-opt with `--enable-simd`, `--enable-bulk-memory`, and `--enable-nontrapping-float-to-int` (wasm-opt 117, bundled in wasm-pack 0.15.0, does not turn those on by itself)
- remaps host paths out of the binary and sets `SOURCE_DATE_EPOCH=0` so the bytes do not depend on the machine
- writes `pkg/` and marks it `"type": "module"` so Node can load the glue
- deletes the generated `pkg/.gitignore` (wasm-pack's copy ignores the wasm) and `pkg/README.md`

`pkg/` is committed. Staging deploys this repository without a Rust toolchain, and Vite emits the committed wasm into `dist/`.

Regenerate and commit `pkg/` after any Rust change:

```bash
npm run fea:build
```

CI runs `node scripts/fea/check-wasm-fresh.mjs`, which rebuilds into a scratch directory and fails if any committed `pkg` file differs. `cargo test --locked` covers the stub, the TET10 checks (patch, cantilever, thick cylinder, plate with a hole, Cholesky versus PCG), and the shell checks (membrane and bending patches, Navier plate, clamped circular plate, cantilever strip, Scordelis–Lo roof, shear-locking ratios). `cargo deny --manifest-path packages/surfcad-fea/Cargo.toml check licenses` enforces `deny.toml`.

## CalculiX reference

[CalculiX](https://www.calculix.de/) (`ccx`) is **GPL-2.0-only**. It is not a dependency of this crate and it is not part of the wasm module. Nothing in the repository vendors, links, bundles, or commits CalculiX source or the `ccx` binary. `deny.toml` does not list GPL, so `cargo deny` rejects an attempt to depend on it.

The CI job `calculix reference` installs the binary with `apt install calculix-ccx` and runs it as a separate process. If that install fails, the job emits a warning annotation and exits 0. A comparison that runs and misses a gate fails the job.

The harness is the native example `calculix_reference`. It is not built by `cargo test`. It writes a temporary `.inp` (C3D10 for TET10, S6 for the 6-node shell), runs `ccx`, and reads `.dat` displacements and `.frd` stresses. Distributed loads are the same consistent nodal forces `solve_tet10` and `solve_shell` assemble, written as `*CLOAD`, so both codes see the same mesh and the same nodal loads. CalculiX's own C3D10 face pressure lumps onto the corner nodes; that is a different discrete load and is not what the example writes.

Cases: cantilever (C3D10), plate with a hole (C3D10), thick cylinder (C3D10), simply supported plate (S6), Scordelis–Lo roof (S6). Gates, against `ccx` on that mesh: peak translational displacement within 1%, nearest-rank p95 von Mises within 3%.

S6 in CalculiX is expanded into a solid wedge. Nodal stress in the `.frd` file is the extrapolated 3D stress on the outer nodes of that wedge. `solve_shell` reports plane-stress von Mises at ζ = ±1 of an MITC6 triangle. On a coarse plate those two p95 values differ by more than 3%, which is the reason a 5% shell gate was the fallback. The example uses a 24×24 plate and a 12×12 roof, where the measured gap stays inside 3%, so the gate is not loosened.

The roof comparison does not prescribe the classical θy/θz symmetry on the mid-span plane. Those global rotations include the shell drilling axis. CalculiX applies shell rotations through mean-rotation constraints and locks the expanded wedge when the prescribed rotation has a drilling component. Both solvers use the diaphragm (uy and uz fixed), translational symmetry (ux on the mid-span plane, uy on the crown), and θx on the crown, where the director is +z and θx is not drilling.

Run it locally when `ccx` is already on `PATH`. The example does not download or build CalculiX.

```bash
cd packages/surfcad-fea
cargo run --example calculix_reference --locked
```

`CCX` overrides the binary name. `CALCULIX_CASE` runs only the cases whose label contains that string.

A native scale check is not part of `cargo test`. Run one size per process so the peak is not cumulative:

```bash
cargo bench --bench scale -- 40000
cargo bench --bench scale -- 100000
cargo bench --bench scale -- shell 120000
```

It prints DOFs, assembly time, solve time and peak resident memory. Above the auto threshold the tet run uses Jacobi PCG. The shell run uses supernodal Cholesky.

## Units

Material numbers are **megapascals** for modulus and yield, and dimensionless for Poisson's ratio.

| Field | Meaning |
|---|---|
| `E_MPa` (alias `E`) | Young's modulus in MPa. 6061-T6 is `68900`, not `68.9`. |
| `nu` | Poisson's ratio, required, in the open interval `(-1, 0.5)`. |
| `yield_MPa` (alias `yield`) | Yield strength in MPa. |

If both a canonical name and its alias are present they must be equal. Mesh coordinates are millimetres. The stub does not convert them into a real stress; it still labels the field `MPa`. `solve_tet10` and `solve_shell` use the consistent mm / N / MPa system above.

## API

The main thread uses `createFeaClient()` in `src/fea/feaClient.js`. That spawns `src/workers/feaWorker.js`, which loads this module. A study solve meshes the surface and calls `solve_tet10`. The mesher is a separate chunk, loaded on that solve. Typed arrays on `solve` are **transferred** to the worker (not copied). The worker copies the render-vertex von Mises samples out of wasm memory, then transfers that `Float32Array` back. Passing a typed array into wasm still copies it across the bindgen ABI; that copy is inside the worker. On a phone the worker rewrites both wasm memories to a non-shared 512 MiB maximum before instantiate.

`cancel()` rejects the in-flight `solve` promise. The wasm call itself is synchronous, so cancel takes effect at the next stage (meshing, solving, post-processing) rather than inside it. `dispose()` terminates the worker. `capabilities()` from the client adds `tet10` to the wasm solver list and sets `shells` to false.

```js
const fea = await createFeaClient();

await fea.capabilities();
// {
//   version: "0.1.0",
//   solvers: ["stub", "tet10"],
//   shells: false,
//   simd: true,
//   threads: false,
//   maxDofs: { phone: 48000, desktop: 300000 }  // hints, not a hard cap
// }

await fea.solve({
  study,   // fixtures, loads, mesh.target; a shell model still solves TET10
  mesh: {
    positions: Float32Array,  // x,y,z per vertex
    indices: Uint32Array,     // three indices per triangle
    faceIDs: Uint32Array,     // faceID is also accepted
  },
  material: { E_MPa, nu, yield_MPa },
  profile,  // "phone" | "desktop"
}, { onProgress, signal });
// {
//   source: "tet10",          // "stub" only when the request sets fallback: "stub"
//   field: "von_mises",
//   units: "MPa",
//   nodal: Float32Array,     // one value per input vertex
//   min, max, p95,           // p95 is the nearest-rank 95th percentile
//   safetyFactor,            // yield_MPa / p95, or null when p95 is 0
//   fos,                     // same number as safetyFactor
//   warnings: [{ code, msg }],  // stub fallback includes code "stub"
//   stats: { dofs, ms, vertices, triangles }
// }

fea.cancel();
fea.dispose();
```

`p95` sorts the nodal values ascending and takes 1-based rank `ceil(0.95 * n)` (the only value when `n == 1`, and `0` when `n == 0`).

### Stub field

For each vertex:

```text
stress = distance * (load_magnitude / load_area)
```

`distance` is the distance to the nearest fixture face origin (`faces[].at`). With no finite fixture point, `distance` is `|z - z_min|` over the finite vertex Z coordinates. `load_magnitude` is the sum of the lengths of `loads[].vector`. `load_area` is the sum of the positive `loads[].faces[].area` values. A missing or non-positive sum is treated as `1`.

`E_MPa` and `nu` are validated and not used. `yield_MPa` is used only for the safety factor. Every result includes a warning whose text starts with `STUB, not a real result`.

`maxDofs` is a hint for a later solid model (about 16k nodes on a phone-class 512 MiB heap, more on desktop). The stub still returns a field when the hint is exceeded and adds a `dof-hint` warning.

### `solve_tet10`

Called on the wasm exports directly. Typed arrays are copied across the bindgen ABI. This is not yet wired through `createFeaClient()`.

```js
import init, { solve_tet10 } from './pkg/surfcad_fea.js';

await init();
const result = solve_tet10(
  {
    nodes: Float64Array,       // or positions: Float32Array, xyz in mm
    elements: Uint32Array,     // 10 indices per TET10
  },
  { E_MPa, nu, yield_MPa },    // yield_MPa may be null
  {
    fixedNodes: Uint32Array,   // three DOFs fixed at 0; optional
    fixedDofs: Uint32Array,    // node * 3 + axis; optional, overrides fixedNodes
    fixedValues: Float64Array, // mm, same length as fixedDofs, or omitted for 0
    forceNodes: Uint32Array,
    forceValues: Float64Array, // three components per node, N
    pressureFaces: Uint32Array,// six nodes per face
    pressures: Float64Array,   // one MPa value per face
  },
  { solver: 'auto', tol: 1e-8, maxIter: 20000, choleskyMaxDofs: 20000 },
);
// {
//   source: "fem",
//   field: "von_mises",
//   units: "MPa",
//   nodal: Float64Array,          // von Mises, one value per node
//   displacement: Float64Array,   // xyzxyz… in mm
//   min, max, p95,
//   safetyFactor, fos,            // yield / p95, or null
//   warnings: [{ code, msg }],
//   solver: "cholesky" | "pcg",
//   stats: { dofs, freeDofs, nodes, elements, iterations, residual, assemblyMs, solveMs, ms }
// }
```

`p95` uses the same nearest-rank rule as the stub. `iterations` and `residual` are 0 for Cholesky.

### `solve_shell`

Same calling convention as `solve_tet10`. Not wired through `createFeaClient()`.

```js
import init, { solve_shell } from './pkg/surfcad_fea.js';

await init();
const result = solve_shell(
  {
    nodes: Float64Array,        // xyz in mm
    elements: Uint32Array,      // 6 indices per triangle
    thickness: Float64Array,    // one mm value per element, or a single value
  },
  { E_MPa, nu, yield_MPa },
  {
    clampedNodes: Uint32Array,  // six DOFs fixed at 0
    pinnedNodes: Uint32Array,   // three translations fixed at 0
    fixedDofs: Uint32Array,     // node * 6 + component; optional
    fixedValues: Float64Array,  // omitted means 0
    forceNodes: Uint32Array,
    forceValues: Float64Array,  // three components per node, N
    pressures: Float64Array,    // one MPa per element, or one value for all
    pressureElements: Uint32Array, // optional subset
  },
  { solver: 'cholesky', tol: 1e-8, maxIter: 20000, choleskyMaxDofs: 20000 },
);
// {
//   source: "shell",
//   field: "von_mises",
//   units: "MPa",
//   nodal: Float64Array,           // max(top, bottom) per node
//   vonMisesTop: Float64Array,
//   vonMisesMid: Float64Array,
//   vonMisesBottom: Float64Array,
//   displacement: Float64Array,    // ux,uy,uz,θx,θy,θz per node
//   min, max, p95,                 // over the top and bottom samples together
//   safetyFactor, fos,
//   warnings: [{ code, msg }],
//   solver: "cholesky" | "pcg",
//   stats: { dofs, freeDofs, nodes, elements, iterations, residual, assemblyMs, solveMs, ms }
// }
```

Omitting `options` or `options.solver` selects supernodal Cholesky.
