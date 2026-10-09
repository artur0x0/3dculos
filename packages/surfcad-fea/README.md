# surfcad-fea

Phase 0 scaffold for the SurfCAD finite-element solver. The crate compiles to a **single-threaded** WebAssembly module with **WASM SIMD** (`simd128`). It does not use shared memory, so the page does not need `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy` headers.

The solver in this phase is a **stub**. `solve` returns a deterministic fake von Mises field and always sets `source` to `"stub"`. A real TET10 / shell solver is a later phase. `faer` is not a dependency yet: it is unused here and expensive to compile.

The crate is Apache-2.0, the same license as the rest of the project.

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

CI runs `node scripts/fea/check-wasm-fresh.mjs`, which rebuilds into a scratch directory and fails if any committed `pkg` file differs. `cargo test` covers the stub on the host. `cargo deny --manifest-path packages/surfcad-fea/Cargo.toml check licenses` enforces `deny.toml`.

## Units

Material numbers are **megapascals** for modulus and yield, and dimensionless for Poisson's ratio.

| Field | Meaning |
|---|---|
| `E_MPa` (alias `E`) | Young's modulus in MPa. 6061-T6 is `68900`, not `68.9`. |
| `nu` | Poisson's ratio, required, in the open interval `(-1, 0.5)`. |
| `yield_MPa` (alias `yield`) | Yield strength in MPa. |

If both a canonical name and its alias are present they must be equal. Mesh coordinates stay in the length unit the caller already uses (the study schema uses millimetres). The stub does not convert them into a real stress; the returned unit label is `MPa` because that is the contract the later solver will keep.

## API

The main thread uses `createFeaClient()` in `src/fea/feaClient.js`. That spawns `src/workers/feaWorker.js`, which loads this module. Typed arrays on `solve` are **transferred** to the worker (not copied). The worker copies the result out of wasm memory, then transfers that `Float32Array` back. Passing a typed array into wasm still copies it across the bindgen ABI; that copy is inside the worker.

`cancel()` rejects the in-flight `solve` promise. The stub is synchronous, so cancel does not interrupt an evaluation that has already started on the worker. `dispose()` terminates the worker.

```js
const fea = await createFeaClient();

await fea.capabilities();
// {
//   version: "0.1.0",
//   solvers: ["stub"],
//   simd: true,
//   threads: false,
//   maxDofs: { phone: 48000, desktop: 300000 }  // hints, not a hard cap
// }

await fea.solve({
  study,   // fixtures[].faces[].at, loads[].vector, loads[].faces[].area; other keys ignored
  mesh: {
    positions: Float32Array,  // x,y,z per vertex
    indices: Uint32Array,     // three indices per triangle
    faceIDs: Uint32Array,     // faceID is also accepted
  },
  material: { E_MPa, nu, yield_MPa },
  profile,  // "phone" | "desktop"
}, { onProgress, signal });
// {
//   source: "stub",
//   field: "von_mises",
//   units: "MPa",
//   nodal: Float32Array,     // one value per input vertex
//   min, max, p95,           // p95 is the nearest-rank 95th percentile
//   safetyFactor,            // yield_MPa / p95, or null when p95 is 0
//   fos,                     // same number as safetyFactor
//   warnings: [{ code, msg }],  // always includes code "stub"
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
