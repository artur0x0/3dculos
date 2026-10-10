# Licences compiled into the volume mesher

This developer note is not copied into the production build. The notice that ships is `public/THIRD_PARTY_NOTICES.txt` (the production build copies `public/` into the site output).

The wasm module is a separate emscripten build. Nothing in it is GPL, AGPL, or LGPL. The build script checks the CMake cache and the link line and fails if TetGen, Triangle, HLBFGS, FPG, GMP, or MPFR is pulled back in.

`EIGEN_MPL2_ONLY` is a compile definition, so Eigen's LGPL headers (`NonMPL2.h`, including IncompleteCholesky) error out if a translation unit includes them.

## Shipped

| Component | Pin | Licence |
| --- | --- | --- |
| fTetWild (wildmeshing/fTetWild) | `8118f810478e0e65a7bf2d8cecdc5e203a876e97` | MPL-2.0 |
| Geogram | v1.9.6 | BSD-3-Clause |
| Geogram / amgcl | submodule `ab57038d68ee372ed5df280631051b91f17ed2d1` | MIT |
| Geogram / libMeshb | submodule `952a157c9d516b28cc6c69cd1550c3e48d4792f9` | MIT |
| Geogram / rply | submodule `4296cc91b5c8c26d4e7d7aac0cee2b194ffc5800` | MIT |
| Geogram / zlib | vendored in the Geogram tree | Zlib |
| Geogram / PoissonRecon | vendored (Kazhdan and Bolitho, JHU) | BSD-3-Clause style |
| Geogram / xatlas | vendored | MIT |
| libigl | v2.6.0, core and predicates only | MPL-2.0 |
| Shewchuk predicates (`libigl-predicates` `decb7bc1260e689cbe008109e3cc5d3a5a433aea`) | fetched by libigl | public domain |
| Eigen | 3.4.0, via libigl, `EIGEN_MPL2_ONLY` | MPL-2.0 (MPL2 subset) |
| fmt | 11.2.0 | MIT |
| spdlog | v1.15.3, external fmt | MIT |
| json (jdumas/json) | `0901d33bf6e7dfe6f70fd9d142c8f5c6695c6c5b` | MIT |
| libtommath | v1.3.0 | Unlicense (public domain) |
| getRSS.c (David Robert Nadeau), compiled inside fTetWild | upstream `src/external/getRSS.c` | CC-BY-3.0 |

fTetWild's exact rationals are the overlay in `scripts/fea/overlay/Rational.h` (MPL-2.0) on top of libtommath. The logger overlay uses spdlog's synchronous null sink so meshing does not start a thread.

CC-BY-3.0 attribution for getRSS: David Robert Nadeau, NadeauSoftware.com, Creative Commons Attribution 3.0 Unported.

## Not compiled

| Component | Why it is excluded |
| --- | --- |
| GMP | `Rational.h` upstream calls `mpq_*`. GMP is LGPL-3.0-or-later OR GPL-2.0-or-later. Replaced with libtommath. `find_package(GMPfTetWild)` is patched out. |
| MPFR | Not linked. The link line is rejected if `libmpfr` appears. |
| TetGen | AGPL. `GEOGRAM_WITH_TETGEN=OFF`. The fTetWild executable (the only target that includes `igl/copyleft/tetgen`) is not built, because this project is not the top-level CMake project. `LIBIGL_COPYLEFT_TETGEN=OFF` and `LIBIGL_COPYLEFT_CORE=OFF`. |
| Triangle (Shewchuk) | Custom non-commercial licence. `GEOGRAM_WITH_TRIANGLE=OFF` and `LIBIGL_RESTRICTED_TRIANGLE=OFF`. |
| HLBFGS | The line search in Geogram's copy is GPL, and the README is non-commercial. `GEOGRAM_WITH_HLBFGS=OFF`. Upstream fTetWild does not force this off; the build script does. |
| FPG / the CGAL subset under `geogram/src/bin/fpg` | LGPL. `GEOGRAM_WITH_FPG=OFF` (Geogram's own default is already off; the script forces it). |
| oneTBB | Apache-2.0, but it needs threads. `FLOAT_TETWILD_ENABLE_TBB=OFF`, so it is not fetched. |
| fast-envelope | `FLOAT_TETWILD_WITH_EXACT_ENVELOPE=OFF`. Not fetched. |
| CLI11 | BSD-3-Clause. Fetched only for the top-level executable, which is not built. |
| Eigen LGPL headers | Blocked by `EIGEN_MPL2_ONLY`. |
| libigl copyleft and restricted modules | Not compiled. libigl 2.6's switches are `LIBIGL_COPYLEFT_CORE`, `LIBIGL_COPYLEFT_CGAL`, `LIBIGL_COPYLEFT_COMISO`, `LIBIGL_COPYLEFT_TETGEN`, `LIBIGL_RESTRICTED_MATLAB`, `LIBIGL_RESTRICTED_MOSEK`, and `LIBIGL_RESTRICTED_TRIANGLE`, all OFF. libigl also ships `LICENSE.GPL` for the copyleft modules. |
| Geogram legacy numerics, exploragram, Lua, graphics | Forced off. ANN (LGPL) lives under Geogram's tests and is not built when `GEOGRAM_LIB_ONLY` is on. |
| OpenMP | fTetWild's `cmake/geogram.cmake` forces `-fopenmp` on Linux. That block is removed. The wasm platform file does not add `-fopenmp`. The module is single-threaded and does not use shared memory. |

The native self-test (`surfcad_mesh --self-test`) is not shipped. Geogram's Linux gcc platform still passes `-fopenmp` to that binary. The wasm build uses Geogram's Emscripten-clang platform with those flags cleared, and the committed artifact is only `packages/surfcad-mesh/pkg`.
