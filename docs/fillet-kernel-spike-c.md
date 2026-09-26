# Fillet Slice C — Kernel spike (hard edges)

**Date:** 2026-09-25  
**Repo:** artur0x0/3dculos  
**Context:** After #50 easy/hard split, loft-generator fillets still produce slivers / Area≈0 scrap under the dihedral sweep (`filletAlongPath`). Playtest: loft fillet sliver with selected face Area 0.0 mm².

## Goal

Compare hard-edge blend options under browser/WASM Manifold and recommend a default for the **hard** class without rewriting the easy path (#45–#46 / #50).

## Stack constraints

| Capability | Status |
| --- | --- |
| `filletAlongPath` dihedral sweep + boolean subtract | Production path (easy + hard today) |
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

`#50` already classifies. Easy keeps dihedral sweep + goldens. Hard routes to (1)’s segment rolling-ball once wired. Slice C does **not** flip Accept to that path (flag `FILLET_HARD_KERNEL_TRIAL` stays false).

### 4. Adaptive / multi-pass sweep

**Feasible:** weak / no clear win.

Extra passes cost mobile time (loft stand-in sweep ~200 ms already) without fixing variable-frame error. Per-segment `filletEdges` try/catch on curved gens mostly no-ops. Ruled out as the default hard path.

## Recommendation

| Class | Kernel | Effort |
| --- | --- | --- |
| **Easy** | Keep current dihedral sweep (`filletAlongPath`) | none |
| **Hard** | **Segment-wise rolling-ball** (reuse `filletEdges` singleton cutter math on `#49` coherent segments; relax planar-adjacent assert for generator walls; optional corner caps) | **1 follow-up PR** (C2) |

Face-offset stays a later multi-slice only if Manifold gains solid offset or we invest in a custom offsetter.

**Perf:** Expect hard path similar to or slightly above planar `filletEdges` per segment; avoid naive sphere-hull. Still need Slice Speed/spinner for long loft chains — out of scope here.

**Quality:** Boxy easy unchanged. Loft generators should lose most zero-area sweep scraps; warn from `#50` remains until C2 proves clean Accept.

## What shipped in Slice C

- This doc + `src/utils/filletKernelSpike.js` (recommendation helpers; **not** wired to Accept).
- Selector spacing (Plane / Contour / Edge / Face gap).
- Persist Face/Edge pick mode (and Plane/Contour toggles) after Fillet Accept / clean exit.

## Non-goals (unchanged)

Hard-block Accept; Slice D warn heuristics; spinner/speed; game mode; easy-path rewrite.
