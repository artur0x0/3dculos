# Edges — architecture plan

Status: **proposal, not implemented.** For discussion before any code moves.

Scope: how edges are found, stored, picked, propagated and drawn. Covers Edge
pick, Fillet/Chamfer edge selection, and Sweep path picking — they all share one
graph today and should keep sharing one tomorrow.

Companion docs: `.claude/skills/fillets/SKILL.md` (blend kernels — unchanged by
this plan), `docs/fillet-kernel-spike-c.md`, `VALIDATION.md`.

---

## 1. Why now — three bugs, one shape

Repro (Artur's part, `main` @ 324b1a6):

```js
let box1 = Manifold.cube([40, 30, 20], true);
let part = box1;
const selEdges = edgesBetween(part, 3, 5);
const path = makeSweepPath(selEdges);
part = filletAlongPath(part, path, 4);
part = part.subtract(shell(part, 2.5, 'z'));
```

Tapping the outer vertical edge on the `+x` cap with Tangent on selects **9
edges**. Measured, that set is:

| edge | where | wanted? |
| --- | --- | --- |
| `coh-12-0` | outer vertical, x=20 — the seed | yes |
| `coh-22-0`, `coh-22-1` | outer blend arc, x=20 | yes |
| `coh-22-2`, `coh-22-3` | **rest of the outer arc** | yes — but **missing** |
| `coh-17-0` | **inner** vertical, x=16.7 | no — through the wall |
| `coh-25-0..3` | **inner** blend arc, x=16.7 | no — through the wall |
| `coh-18-0` | **inner** top rail, x=16.7 | no — through the wall |

So the walk stops two chords into the outer round, and simultaneously jumps the
2.5 mm wall and traverses the *inner* feature instead. All three reported
symptoms — half a fillet, the nearby internal edge, through-wall picks — come
out of this one traversal.

### The three root causes, measured

**(a) A 5 mm "parallel face bridge" reaches straight through the wall.**
`edgeTangencyField.js:243 _parallelFaceBridge` links the seed to any
near-parallel edge sharing a face id whose midpoint lies within
`max(0.25·L, 5)` mm. The inner wall edge sits **4.37 mm** from the seed — inside
the 5 mm band. It is enqueued *before the walk starts*, so everything reachable
from it comes along.

**(b) Face ids cannot tell inner from outer.** Both the outer edge `coh-12-0`
and the inner edge `coh-17-0` report `faceA=5, faceB=6`. After a `shell`
subtract the cavity wall inherits the same `faceID`s as the outer wall, so the
bridge's "same face" guard is not a guard at all here. Any fix that leans on
face identity alone will not hold.

**(c) The turn thresholds are coupled and marginal.** The outer arc is four
chords, but chord `22-1 → 22-2` turns **25.5°** against a `TANGENT_PROP_DEG`
tolerance of **25°**. It misses by half a degree, so the smooth branch rejects
it, the corner branch's seed-plane lock also rejects it, and the walk dies
mid-arc. My `CHAIN_MAX_TURN_DEG = 20` cap (PR #84) bounds the turn *within* one
simplified chord's span; it does **not** bound the turn *between* adjacent
chords, which is what the walk actually tests. It happened to work on the
unshelled part and is one rounding error from failing, as it does here.

### The structural problem behind all three

Tangency is currently derived from the **simplified display polyline**. RDP is a
drawing concern; G1 continuity is a semantic one. Today the first governs the
second, so every change to simplification silently moves selection behaviour and
vice versa — and six independent heuristics have accreted in the gap between
them:

1. `chainId` fragment union (`selectEdge.js:1104`)
2. G1 tangent walk (`edgeTangencyField.js:275`)
3. spatial endpoint bridging (`_neighborsOf`, `SPATIAL_VERT_EPS`)
4. parallel same-face bridging (`_parallelFaceBridge`, 5 mm band)
5. seed-plane lock (`cornerOutOfPlaneDeg`, 30°)
6. collapsed-corner window (`cornerDeg` 95° / `cornerSharpDeg` 85°)

Each was added to rescue a real case; together they have no single owner and no
invariant anyone can state. That is what this plan replaces.

---

## 2. How it works today

```
worker: script → Manifold solid → mesh {vertProperties, triVerts, faceID}
  │
UI (Viewport.syncFeatureEdges, :2257)
  ├─ buildFeatureEdges(geometry)        every tri pair, dihedral > gate   O(tris)
  ├─ annotateFeatureEdges(raw, topo)    stamp boundaryId/faceA/faceB
  └─ buildCoherentEdges(...)            merge collinear → trace chains →
                                        order → RDP simplify → emit segments
  │
tap → pickNearestEdgeScreen()           screen-space, finger slop, partial occlusion
  └─ toggleEdgeSelectionPropagated()    the six heuristics above
```

Measured build cost (this machine, cold):

| part | tris | raw feature edges | coherent | buildFeatureEdges | buildCoherentEdges |
| --- | --- | --- | --- | --- | --- |
| shelled filleted box | 220 | 164 | 38 | 1 ms | 1 ms |
| cylinder 128-seg | 508 | 384 | 34 | 3 ms | 2 ms |
| sphere 64 | 2 048 | 2 664 | 0 | 18 ms | 0 ms |
| sphere 128 | 8 192 | 8 040 | 0 | 56 ms | 1 ms |
| loft circle→rect 128 | 32 732 | 2 543 | 35 | **138 ms** | 3 ms |

Two things to note. `buildFeatureEdges` is **O(tris)** and dominates — 138 ms on
a 32 k-tri part is a visible hitch. And it is not actually computed once at
render: `featureEdgesSourceRef` caches by geometry identity, but
`Viewport.jsx:2352` force-invalidates it (`featureEdgesSourceRef.current = null`)
on leaving Fillet mode, and `pickSweepPath` rebuilds too — so toggling modes
re-pays the full cost.

Visibility today: `pickNearestEdgeScreen` (`selectEdge.js:469`) has a partial
occlusion test — it skips an edge only when it is farther than the raycast hit
**and** `edgeFacesAwayFromCamera`. That is a heuristic, and it applies **only to
the tapped seed**. Propagation has no visibility awareness at all, which is why
a chain happily continues through a wall.

---

## 3. Target architecture

Three layers, each with one job. The load-bearing idea is the split between
**semantic** edge data (what the part's edges *are*) and **presentation** data
(what we draw), so simplification can never again change selection.

### Layer 1 — `EdgeGraph`, solved once at script render, in the worker

The worker already holds the Manifold solid and `faceID`. It is the right place
to solve topology; the UI should receive an answer, not a mesh to re-analyse.

```
EdgeGraph {
  curves: Curve[]           // semantic features
  nodes:  Node[]            // curve endpoints / junctions
  spatial: BVH | grid       // for picking
  version: string           // mesh identity; invalidates the cache
}

Curve {
  id
  polyline:  Vec3[]         // FULL resolution, from mesh topology
  render:    Vec3[]         // RDP-simplified, drawing only — never walked
  faceA, faceB              // adjacent face ids
  kind:      'line' | 'arc' | 'general'
  dihedral:  { min, max, mean }   // signed
  sign:      'convex' | 'concave' | 'mixed'
  closed:    bool
  tangentAt(s)              // analytic where kind is known
}

Node {
  id, position
  incident: [{ curveId, end, tangent }]
  tangentLinks: [[curveIdA, curveIdB], ...]   // PRECOMPUTED G1 pairs
}
```

`tangentLinks` is the key field. G1 continuity between two curves is decided
**once, at build time, on full-resolution geometry**, and stored. Tap-time
propagation becomes a graph walk over stored links — no angle thresholds, no RDP
chords, no plane locks, no bridges. It is also the only place a tangency
threshold exists, so there is exactly one number to tune and one golden to pin.

Why this kills the three bugs:

- **(a)/(b)** vanish: there is no proximity bridge. Two curves link only if they
  share a `Node` — i.e. actually meet in the topology. A wall 2.5 mm away shares
  no node, so it can never be reached, regardless of face ids.
- **(c)** vanishes: tangency is computed on the full polyline, where the blend
  arc's per-segment turn is ~4°, not on 25.5° RDP chords. `render` may be
  simplified as aggressively as looks good; the walk never sees it.

### Layer 2 — visibility

Two filters, cheap first:

1. **Front-face prefilter** (free): an edge is a silhouette/visible candidate if
   at least one adjacent face is front-facing. Generalises today's
   `edgeFacesAwayFromCamera`.
2. **Occlusion test** (needed for the wall case). Options:

   | option | accuracy | cost | notes |
   | --- | --- | --- | --- |
   | **A. depth prepass + sample test** | high | GPU, ~1 ms/camera change | render solid depth to an offscreen target once per camera settle; test N samples per curve. Scales with pixels, not tris. |
   | **B. raycast per candidate** | high | ~30 ms @ 32 k tris × 100 rays without a BVH | simple, no render plumbing; add `three-mesh-bvh` to make it ~1 ms |
   | **C. GPU id-buffer pick** | exact | readback stall | also solves seed picking exactly |

   **Recommendation: A**, with B as the fallback if the offscreen target fights
   the existing render loop. Both are far more honest than the current partial
   heuristic.

Visibility is applied to **seed pick and every propagation step**, and is a pure
filter over Layer 1 — it never changes the graph, so the same part behaves
identically from every camera except for which edges are *offered*.

### Layer 3 — selection semantics

```
tap  → spatial query → visible candidates → nearest in screen space → seed
Tangent on → walk tangentLinks from the seed, subject to:
     stop at a node with no tangent link (a genuine sharp corner)
     stop at a node where >2 curves are tangent (ambiguous Y/T junction)
     stop when the candidate is not visible
     stop at the chain cap
```

Plus the **curvature-coherence rule** Artur asked for, which is what catches the
loft zig-zag: along a real tangent chain the *signed* turn is monotone in sign —
consistently curving one way, or straight. Tessellation noise alternates sign
every segment or two. So: track the signed turn along the walk and stop when the
sign alternates more than once within a short window. This is a property of the
walk, not another threshold on the geometry, and it subsumes the seed-plane lock
and the collapsed-corner window — both of which exist only to suppress
zig-zag/T-junction flooding.

---

## 4. Requirements → how they're met

| Artur's requirement | Mechanism |
| --- | --- |
| **1. Fast; solve and store at render** | `EdgeGraph` built in the worker on the same pass that produces the mesh, keyed by mesh version, shipped to the UI with the result. Mode toggles reuse it — no invalidation on entering/leaving Fillet. Tap cost becomes a spatial query + stored-link walk. |
| **2. Only visible edges; never through walls** | Layer 2, applied to seed **and** every propagation step. Through-wall selection becomes structurally impossible for propagation (no proximity bridges) and camera-correct for picking. |
| **3. Complete tangency; catch zig-zag** | `tangentLinks` precomputed on full-resolution geometry, so a chain completes or stops at a real corner. Curvature-coherence rule stops tessellation zig-zag by sign alternation, as Artur suggested. |

---

## 5. Migration plan

Each phase ships on its own, keeps the app working, and lands with goldens. No
phase requires the next.

**Phase 0 — stop the bleeding (small, independent of the rest).**
Remove `_parallelFaceBridge`, or gate it on a shared *node*, not proximity. This
alone kills the through-wall and internal-edge picks in the report. Also widen
the gap between `CHAIN_MAX_TURN_DEG` and `TANGENT_PROP_DEG` so the outer arc
stops failing by 0.5°. Ugly but immediate; buys time for the rest.
*Risk: the roundedBox rim cases the bridge was added for (#78) may regress —
`golden:mobile-c3-roundedbox-fillet-tangent` is the arbiter.*

**Phase 1 — `EdgeGraph` in the worker, built but unused.**
Emit it alongside the mesh; UI ignores it. Add goldens asserting curve counts,
tangent links, convex/concave signs on: cube, roundedBox, filleted box, the
shelled part above, loft. Zero behaviour change, fully reviewable.

**Phase 2 — selection reads `EdgeGraph`.**
Swap `buildFeatureEdges`/`buildCoherentEdges` for graph queries behind a flag.
Port the existing goldens. Delete the six heuristics once green. This is the
phase that actually fixes tangency.

**Phase 3 — visibility.**
Add the depth prepass and wire the filter into pick + propagate.

**Phase 4 — cleanup.**
Remove the display/semantic coupling in the fillet path: `makeSweepPath` should
consume `Curve.polyline`, not the simplified segments it gets today.

---

## 6. Risks and open questions — for discussion

1. **Where does the graph get built?** Worker is right in principle (it has the
   solid), but it means shipping the graph over `postMessage` on every run and
   keeping it in sync with undo/redo. UI-side keeps today's plumbing but re-pays
   O(tris). *Leaning worker; want your call.*

2. **How much does `faceID` actually give us?** The shelled case shows ids are
   reused across cavity and outer wall. If `faceID` cannot separate connected
   components, Layer 1 needs its own component labelling. Worth a spike before
   committing to the data model.

3. **Occlusion option A vs B** (depth prepass vs BVH raycast). A is faster and
   scales; B is ~20 lines and no render plumbing. Which fits how you want the
   viewport to evolve?

4. **Does "visible only" apply to Fillet Accept too?** If a user orbits, the
   selectable set changes. Selecting a chain, orbiting, then Accept — should the
   now-hidden half stay selected? *My assumption: yes, selection is sticky once
   made; visibility filters only what you can newly pick.* Needs confirming.

5. **Spheres produce zero pickable edges** (measured above — every dihedral is
   under the 15° gate). Correct in principle, but worth deciding whether smooth
   bodies should expose silhouette curves for picking.

6. **Scope check.** Phases 1–3 are a real chunk of work. Phase 0 is hours. If
   the goal is to unblock your CAD work now, Phase 0 first and the rest
   deliberately is probably the right sequencing — but that is a product call,
   not a technical one.

---

## 7. Non-goals

- The blend kernels. `filletAlongPath`, the easy/hard split and the cutter math
  are untouched; this plan changes only what gets handed to them.
- Re-tessellation or mesh repair.
- Face selection (a separate picker today; may later share the spatial index).
- Chamfer/fillet UI and the Accept → script emitter.
