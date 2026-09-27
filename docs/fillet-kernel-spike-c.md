# Fillet Slice C — Kernel spike (hard edges)

**Date:** 2026-09-25  
**Repo:** artur0x0/3dculos  
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

**Quality:** Boxy easy unchanged. Loft generators should lose most zero-area sweep scraps; `#50` red Hard edge warn remains (junction quality may still be imperfect).

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
