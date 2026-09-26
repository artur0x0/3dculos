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
