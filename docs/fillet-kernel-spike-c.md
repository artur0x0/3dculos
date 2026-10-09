# Fillet Slice C — Kernel spike (hard edges)

**Date:** 2026-09-25  
**Repo:** artur0x0/surfcad  
**Context:** After #50 easy/hard split, loft-generator fillets still produce slivers / Area≈0 scrap under the dihedral sweep (`filletAlongPath`). Playtest: loft fillet sliver with selected face Area 0.0 mm².

## Goal

Compare hard-edge blend options under browser/WASM Manifold and recommend a default for the **hard** class without rewriting the easy path (#45–#46 / #50).

## Stack constraints

| Capability | Status |
| --- | --- |
| `filletAlongPath` dihedral sweep + boolean subtract | Production path (**easy**; hard until C2) |
| `filletEdges` parallelepiped − cylinder (planar) | Exact on boxy edges; throws on curved-adjacent faces |
| `Manifold.sphere` / hull / boolean | Available; used for convexity probes + corner caps |
| Solid `offset()` / minkowski | **Not** in bundled Manifold (shell fakes round via corner spheres) |
| `CrossSection.offset` | 2D only — useful for planar profiles, not loft walls |
| `#49` `buildCoherentEdges` / `#50` `classifyFilletEdges` | Edge graph + easy/hard gate to keep |

## Candidates

### 1. Rolling-ball / sphere (or disk) boolean along the edge

**Feasible:** yes, with the right construction.

Measured (WASM worker, cube 40×30×20, r=3, one long edge):

| Method | Removed vol | Analytic r²(1−π/4)·L | Wall time |
| --- | ---: | ---: | ---: |
| Current dihedral sweep | ~77.5 | ~77.3 | ~50 ms |
| `filletEdges` planar | ~77.3 | ~77.3 | ~18 ms |
| Naive sphere-hull on bisector | ~919 | ~77.3 | ~16 ms |

A sausage of spheres **is not** a rolling-ball fillet — it over-cuts by an order of magnitude. The real rolling-ball cross-section is already in `filletEdges` (box − cylinder on the incenter). For hard loft generators that construction must be applied **per coherent segment** with a relaxed planar assert (today it loud-fails: `curved-face fillet not supported`).

**Loft quality expectation:** Better than a single RMF sweep when dihedral varies, because each segment uses local face frames. Junctions between segments still need care (optional spherical/cusp caps like the existing `sphericalCorners` path). Not magic on Area-0 scrap until junctions are sealed.

### 2. Face-offset / pair-blend

**Feasible:** blocked for 3D solids in this stack.

No solid offset/minkowski. Building offset surfaces for non-planar loft walls is a multi-slice project. 2D `CrossSection.offset` does not help the hard class.

### 3. Hybrid (easy = sweep, hard = new)

**Feasible:** yes — preferred product shape.

`#50` already classifies. Easy keeps dihedral sweep + goldens. **C2** wires hard Accept to (1)’s segment rolling-ball (`FILLET_HARD_KERNEL_TRIAL=true`, production-on).

### 4. Adaptive / multi-pass sweep

**Feasible:** weak / no clear win.

Extra passes cost mobile time (loft stand-in sweep ~200 ms already) without fixing variable-frame error. Per-segment `filletEdges` try/catch on curved gens mostly no-ops. Ruled out as the default hard path.

## Recommendation

| Class | Kernel | Effort |
| --- | --- | --- |
| **Easy** | Keep current dihedral sweep (`filletAlongPath`) | none |
| **Hard** | **Segment-wise rolling-ball** (reuse `filletEdges` singleton cutter math on `#49` coherent segments; `relaxPlanar` for generator walls; optional corner caps) | **Done in C2** |

Face-offset stays a later multi-slice only if Manifold gains solid offset or we invest in a custom offsetter.

**Perf:** Expect hard path similar to or slightly above planar `filletEdges` per segment; avoid naive sphere-hull. Still need Slice Speed/spinner for long loft chains — out of scope here.

**Quality:** Boxy easy unchanged. Loft generators should lose most zero-area sweep scraps. The chip no longer shows the `#50` hard-edge warning (junction quality may still be imperfect). Easy/hard class still selects the kernel.

## What shipped in Slice C

- This doc + `src/utils/filletKernelSpike.js` (recommendation helpers; Accept wired in C2).
- Selector spacing (Plane / Contour / Edge / Face gap).
- Persist Face/Edge pick mode (and Plane/Contour toggles) after Fillet Accept / clean exit.

## Slice C2 — Accept wired (2026-09-25)

- Hard-class Fillet Accept → `filletEdges(..., { relaxPlanar: true, sphericalCorners })` on the selected `#49` coherent segments (lean-A `edge` / `edgesBetween` when tagged).
- Easy-class Accept unchanged (`makeSweepPath` + `filletAlongPath`).
- Flag **`FILLET_HARD_KERNEL_TRIAL=true`** (production-on for hard class).
- Loud fail on scrap-sheet needles for the hard path (keeps prior solid via Auto-Run restore); Undo still restores.
- No naive sphere-hull; face-offset still out of scope.

## Non-goals (unchanged)

Hard-block Accept; Slice D warn heuristics; spinner/speed; game mode; easy-path rewrite.


## Slice C3 — Variable-profile hard sweep (2026-09-26)

- Shared **tangency + normal field** (`src/utils/edgeTangencyField.js`) for Tangent-on and fillet framing.
- Hard Accept supersedes C2 `filletEdges+relaxPlanar` with `filletAlongPath(..., { variableProfile: true })`: densified path-normal frames, inscribed arc of radius R in the local wall square (side ~2R).
- Viewport scrap banner is **delta-based** (loft baseline needles no longer false-trigger “zero-area faces”).
- Easy Prim/boxy path unchanged. Red Hard-edge warn from B stays. Face-offset still out of scope.


## Slice C3.3 — Varying cross-section (2026-09-27)

Playtest regression after C3.2: the loft ridge stopped staircasing and started
**gouging** — a clean cut straight into the smooth part of the wall.

**Root cause.** On the playtest ridge (circle ⌀10 → 20×12 rect loft) the
dihedral genuinely ramps **161.5° at the circle end → 92.8° at the rect
corner**. The θ probe was correct all along; all 48 knots matched real mesh
edges at 0.003–0.16 mm. C3.2's `singleRun` collapsed that ramp to one median
θ = 109.7°, which sets the wall back 1.39 mm where the geometry wants 0.32 mm.

C3.1 and C3.2 were the same defect: **a constant cross-section swept along a
path whose cross-section must change.** C3.1 spread the error over 17 steps
(staircase); C3.2 concentrated it (gouge).

**Why no guard fired.** Measured on that ridge:

| | total removed |
| --- | ---: |
| true per-knot integral | 7.202 |
| C3.2 median θ | 8.556 (1.19×) |
| C3.3 per-knot | 7.274 (1.01×) |

The error was **distributional, not integral** — per quarter of the path,
correct is 0.29 / 1.26 / 2.35 / 3.29 and C3.2 produced 3.32 / 2.39 / 1.52 /
1.32, an inverted ramp with 11× over-cut at the shallow end. Every volume guard
in `filletAlongPath` integrates, so none of them could see it. That is the real
lesson of C3.0–C3.2.

**Fix.** `_s23VaryingProfileCutter` builds the cutter mesh directly — one
profile ring per knot, stitched into a tube (`varyingProfileTubeMesh`) — instead
of `extrude + warp`, which can only reorient ONE fixed profile. Every θ
tessellates to the same vertex count, so rings stitch without special-casing.
Caps are a fan from the rear bumper vertex, valid for every θ because the
section is a convex wedge minus a convex disk bite and that vertex lies outside
the bite.

`expectVol` is now the true per-knot integral, which makes the existing volume
guards meaningful again rather than self-confirming.

**Verified.** Loft ridge quarters 0.324 / 1.302 / 2.371 / 3.278 (within 25% of
analytic, pad included); constant-θ box edge stays analytically exact within
2%; closed rim matches the easy path to 0.013 mm³. Scrap on the loft fell below
baseline (99 vs 218 needles); triangles 42 760 vs C3.2's 49 260.

**Still open (not this slice):** `convexEdges` costs 5.5 s of the 5.6 s runtime
(per-edge CSG sphere probe; a winding-aware local test measured 5 ms for the
same answer at a 12–15° gate). The rear pad `e` is a function of `r` only, so on
shallow edges it is as large as the blend itself — it should scale with the
local setback `t`. Closed rims over-cut ~34% vs Pappus on **both** easy and
hard paths, which predates C3.


## Slice C4 — Signed feature edges + concave fillets (2026-09-27)

Three changes that are one chain of consequence.

### `convexEdges` — the ball probe was a dihedral test in disguise

It intersected a small sphere at each edge midpoint with the whole solid and
kept `f < 0.45`. Measured across box / cylinder / sphere / L-shape / loft, that
fraction is exactly `(180 − dihedralDeg) / 360`, so `f < 0.45` ⇔ **dihedral >
18°** — at ~4.5 ms per edge, which was **5.5 s of the 5.6 s** loft fillet.

It was also **wrong on fine meshes**: on a 384-segment filleted box the probe
sphere shrinks to ~0.012 mm, where Manifold's boolean reports `f = 0.5` for
plainly 90° edges and even *negative* volumes. So it was never trustworthy
ground truth there, and "reproduce it exactly" was the wrong bar — the goldens
and the pilot tier are.

Replaced by a local winding test: `dot(cross(n0, n1), dir) > 0` is convex, `< 0`
concave, with `dir` the edge as wound in n0's triangle. Normals come from the
adjacent **triangles**, not face groups — a group normal is an area-weighted
average and on a curved group (a fillet sail) points nowhere near the local
surface, which flips the cross product (measured: 2101 false concaves on a
filleted box). Where a triangle is a degenerate sliver, its group normal stands
in.

**Loft fillet end-to-end: 5647 ms → 414 ms**, removed volume bit-identical.

### Latent bug found on the way

`c4MeshData` sums a face group's triangle normals; on a difference-derived
solid a group can span opposing patches and cancel to the **zero vector**.
Measured on an L-shape: **13 of 17** convex edges carried a zero normal, which
flowed straight into the fillet framing as `n0`/`n1`. Present on `main` since
long before C4. Now falls back to the triangle normal.

### Convexity is per-knot

Both probes set `checkedConvex` after the first matched segment, so a chain that
changed sign mid-way was cut as whatever its first segment was. The sign now
rides alongside the per-knot frames from C3.3.

### Concave = the same wedge, unioned

For a concave edge the angle between the two in-face directions IS the
empty-side angle, so **the same contour that carves a convex corner fills a
concave one**. Only two things change: `inFaceDirsFromNormals` negates both rays
(the convex orientation points them into solid material, measured `f0=−Y,
f1=−X` on an L where the walls actually run `+Y`, `+X`), and the boolean becomes
`union` instead of `difference`. `varyingProfileTubeMesh` is untouched.

The path splits into maximal same-**sign** runs: convex runs become cutters,
concave runs fillers, and the two booleans run and are **measured separately** —
a single net-volume check could pass while both halves were wrong.

**Verified**: L-shape interior edge r=3 adds 38.73 vs analytic 38.63 (1.003) in
11 ms; a mixed chain splits into 1 cutter + 1 filler run; box edge still
analytically exact within 2%; all 34 goldens and `npm run verify` green.

### Still open

Junction quality where a chain changes sign is unpolished (the cutter and filler
overlap at the corner; measured net +6.4 on a mixed L chain where ideal is ~0) —
the same class of cusp problem as `sphericalCorners`. The rear pad still scales
with `r` rather than the local setback `t`. Closed rims over-cut ~34% vs Pappus
on both paths, predating C3. `buildCoherentEdges`' 15° `minDeg` gate drops ~63%
of loft feature edges before they can be picked — a picking-UX question, not a
kernel one.
