# Fillet and graph speed

For operators and cloud agents. #154 (`d87b983`) is the speed work on Artur's fillet script. Read this before changing sweeps or the face, edge, or contour graphs. Do not relearn it, and do not put the slow paths back.

## Goal

Artur's script (`scripts/golden/fixtures/artur_wrap_hollow.txt`):

- Centered cube 40×30×20.
- Four disjoint r=6 vertical corners: `edgesBetween`, then `filletAlongPath`.
- One long r=6 wrap along +Y of coherent edge segments.
- `hollow` 2.5, opening −Y.

**Target:** about **1 s** Run-to-ready on Safari latest iOS, iPhone Air.

Before #154 it was over 5 s on that phone, and **5.9 s** in desktop WebKit against https://surfcad.com.

## What was slow

The public site and Spark load the same single-threaded wasm (`built/manifold.wasm`, 480700 bytes). There is no COOP/COEP, so there are no pthreads. The Oct 3 / later main build is not a debug or unminified worker. Chasing a "site vs Spark" or "debug wasm" theory wastes the run.

Worker execute was a minority of Run-to-ready. After the mesh came back, main-thread face, edge, and contour graph builds took several seconds on the denser mesh.

Two kernel choices made that mesh, and the graphs, expensive:

- Face-graph curvature walked every adjacency once per triangle. Manifold gives each triangle its own `faceID`, so that scan was quadratic.
- Fillet sweeps used `extrudeSegments = max(48, frames * 4)`. Each semi-arc cutter carried about 48 rings. The same-radius semi-arc split then multiplied that across cutters. Frame densify at 5° and face-join were not the jump. The 48-slice floor was.

## What #154 changed

Merge `d87b983`. Keep all of this.

- One extrusion ring per 5° path knot (`_s23SweepKnotRings`, sweep frames). No 48-slice floor. Cross-section stays `FILLET_ARC_SEGMENTS = 24`. Same-radius semi-arc split stays. No sphere caps. No extra concave pad.
- N-way `difference([part, ...cutters])` instead of chaining cutter unions.
- `signedFeatureEdges` cached on the same part object across semi-arc runs (`_s23ProbeFeatureEdges`). The boolean result is a new object, so the next fillet misses and rebuilds.
- Face-id vertex dedup is a `Set` of vertex indices, not `array.includes` on vector refs.
- Face graph walks each atom's own neighbors. A plane is flooded only when another triangle lies on it (0.5° / 0.05 mm). A fillet facet with nothing else on its plane stays as it is.
- One interpolated ring on a ruling longer than 29 mm (`_S23_LONG_CHORD_MM`) so the rounded top rim stays one loop. Near-duplicate verts are welded inside face runs (`_S23_RESULT_WELD_MM`, 0.001 mm) so wrap-chamfer fins stay under the ceiling. The weld is kept only when volume moves by less than 0.001 mm³.

## Measured timings

Warm runs of Artur's script. Hollow confirmed (2.5 mm, opening −Y). Desktop WebKit with no throttle is the proxy that matched the live site, not a phone measurement.

| Target | Engine | CPU | Click→ready | Notes |
| --- | --- | --- | --- | --- |
| This branch (#154) | WebKit | none | ~0.49 s | Proxy that matched the live site |
| This branch | Chromium | 4× | ~1.45 s | Phone-ish main-thread throttle; wasm barely slows |
| surfcad.com pre-#154 | WebKit | none | ~5.87 s | Worker ~0.63 s; main thread after the result ~5.2 s |
| surfcad.com pre-#154 | Chromium | 4× | ~13.8 s | Main thread dominated |

In-app split on this branch at 4×: worker ~0.20 s, face ~0.44 s, edge ~0.30 s, contour ~0.23 s.

The surfcad.com rows are the site **before** #154. After that deploy, the public site should match this branch. Re-time both anyway.

## Quality bar — what not to undo

Do not buy speed by:

- Dropping arc segments below 24, or densifying on a turn coarser than 5° (`FRAME_DENSIFY_MAX_TURN_DEG`).
- Removing the same-radius semi-arc split, or adding sphere caps or an extra concave pad.
- Putting back `extrudeSegments = max(48, frames * 4)`.
- Putting back the all-adjacency-per-triangle curvature scan.

Gate the fillet surface against a high-res reference: the same quads with extra 0.5 mm stations (`__FILLET_REF_STATION_MM`). Do not gate it against main's 48-slice mesh. Main's mesh is coarser than the reference.

| Surface | This branch vs reference | Main vs reference |
| --- | --- | --- |
| Fillet | ~0.0003 mm | ~0.0125 mm |
| After hollow | ~0.24 mm | ~1.13 mm |
| After `chamferEdges` | ~0.73 mm | ~0.93 mm |

`golden:fillet-sweep-quality` locks that comparison (fillet under 0.02 mm; hollow and `chamferEdges` ceilings 0.35 mm and 0.8 mm, and closer than main). Related wrap and shell goldens: `golden:fillet-wrap-draft`, `golden:fillet-tangent-round-wrap`, `golden:fillet-chamfer-rounded-wrap`, `golden:artur-playtest-wrap-chamfer`, `golden:artur-playtest-shell-after-fillets`.

`golden:edges-pr2-patches` and `golden:artur-playtest-fillet-after-hollow` were already red on main before #154. A red result there is not a regression from this speed work.

## Open follow-ups

Do not start these unless asked.

- Faster boundary, coherent-edge, and contour graphs: string keys → numeric bins, the same idea as the face graph. Expected to bring 4× Chromium in-app nearer ~1.0 s. In flight after Artur's pick.
- Hollow and `chamferEdges` that sample the fine surface. Large. That is what closes the remaining millimetre-scale gaps.

## How to re-time

Playwright against `vite preview` (this branch) and against https://surfcad.com. The public site needs no login.

- WebKit, no CPU throttle, for Safari parity.
- Chromium with a 4× CPU throttle for main-thread pressure. Wasm barely moves under that throttle; the graphs do.
- Warm run. Confirm the hollow (opening on −Y, thickness 2.5) before recording.
- Wall-clock the Run click until the mesh is ready.

If the timing hook is present, a successful run sets `window.__SURFCAD_RUN_TIMING`:

| Field | Split |
| --- | --- |
| `workerExecMs` | Worker execute |
| `faceGraphMs` | Face graph |
| `edgeGraphMs` | Edge graph (feature + boundary topo + annotate) |
| `contourGraphMs` | Contour graph (coherent chains + contact seam) |
| `totalMs` | From the start of that execute to ready, not from the click |
