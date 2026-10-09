# surfcad-mesh

Closed triangle surface in, TET4 volume mesh out. The JavaScript in `src/fea/meshVolume.js` turns that into the TET10 mesh `solve_tet10` accepts and copies each input face id onto the boundary triangles.

## Why this is not part of surfcad-fea

`packages/surfcad-fea` is Rust, built with wasm-pack for `wasm32-unknown-unknown`. fTetWild is C++ and needs libc++, exceptions, and Geogram's Emscripten platform. Folding it into the solver crate would replace that reproducible wasm-pack pipeline. This module is loaded only when a study asks for a volume mesh. It is single-threaded, uses simd128, and does not allocate a `SharedArrayBuffer`, so the page does not need COOP/COEP headers.

The app worker is not wired up here. `meshVolume` is the API a later change can call from the FEA worker.

## API

```js
import { meshVolume } from './src/fea/meshVolume.js';

const mesh = await meshVolume(
  { positions, indices, faceIds },
  { edgeLength, epsilon, maxTets },
);
```

`positions` is xyz in the caller's length unit (millimetres for a study). `indices` is three indices per triangle. `faceIds` (or `faceIDs`) is one id per triangle. `edgeLength` `0` leaves fTetWild's default, 1/20 of the bbox diagonal. `epsilon` `0` leaves the relative envelope at `1e-3`. `maxTets` `0` means no cap.

The result is TET10 `nodes` and `elements` (VTK order: corners, then mid-edge nodes of edges 01, 12, 20, 03, 13, 23). `faces` are 6-node boundary triangles in the same order `solve_tet10` uses for pressure, with the corner normal pointing out. `faceIds` is one id per boundary triangle, taken from the nearest input triangle. Boundary mid-edge nodes are snapped back onto input triangles of the incident face ids when they land inside the snap tolerance. `stats` includes volume, the input volume, the relative volume error, dihedral angles, aspect ratios, time, the wasm heap size, and the degree-of-freedom count.

## Build

```sh
npm run fea:mesh
```

That runs `scripts/fea/build-mesh-wasm.mjs`. Pins: Emscripten 6.0.12, fTetWild `8118f810478e0e65a7bf2d8cecdc5e203a876e97`, Geogram v1.9.6, libtommath v1.3.0. `SOURCE_DATE_EPOCH=0` and `-ffile-prefix-map` keep the wasm bytes stable. CI rebuilds into a scratch directory (`scripts/fea/check-mesh-wasm-fresh.mjs`) and fails if `packages/surfcad-mesh/pkg` differs.

`node scripts/fea/build-mesh-wasm.mjs --native` links a host binary and meshes the unit cube. That binary is not committed.

Licences for every library that is compiled, and for every copyleft dependency that is switched off, are in `LICENSES.md`.

## Size and a ~100k-DOF mesh

Measured with the committed module (Emscripten 6.0.12, `-O3`, simd128, no shared memory):

| | |
| --- | --- |
| `surfcad_mesh.wasm` | 2,758,700 bytes |
| gzip (`gzip -c -n`) | 788,578 bytes |
| glue `surfcad_mesh.js` | 35,274 bytes |

An 18 mm cube with target edge 1.35 mm (node, one process):

| | |
| --- | --- |
| degrees of freedom | 157,182 |
| TET10 nodes / elements | 52,394 / 37,199 |
| mesh time | 3.8 s |
| wasm heap after the call | 64 MiB (the initial allocation; it did not grow) |
| process RSS | 175 MiB |

That stays inside a 512 MiB non-shared worker. The same was true of a finer 18 mm cube (edge 1.2 mm, 192,102 DOF, 4.8 s, RSS 192 MiB, heap still 64 MiB).
