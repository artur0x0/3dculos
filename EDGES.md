# Edges & Faces — architecture plan

Status: **proposal, not implemented.** For discussion before any code moves.

Scope: how faces and edges are solved, stored, picked, propagated and drawn.
Edge pick, Fillet/Chamfer selection, Sweep path picking and Face pick all share
one substrate today by accident; this plan makes them share one on purpose.

Decisions taken (Artur, this round):
- graph is built in the **worker** and kept in state
- **faceIDs must be unique**; build a **face graph** too, reusing the existing
  planar/curved face selection work
- **single tap should select a curved face** (no double-click)
- work **chunked into playtestable PRs**

Companion docs: `.claude/skills/fillets/SKILL.md` (blend kernels — unchanged),
`docs/fillet-kernel-spike-c.md`, `VALIDATION.md`.

---

## 1. Why now — three bugs, one traversal

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
edges**: the seed, two of the four outer blend chords, and then the **inner**
wall edge, the **inner** blend arc and the **inner** top rail. Measured causes:

**(a) A 5 mm proximity bridge reaches through the 2.5 mm wall.**
`edgeTangencyField.js:243 _parallelFaceBridge` links the seed to any
near-parallel edge sharing a face id whose midpoint is within `max(0.25·L, 5)`
mm. The inner wall edge is **4.37 mm** away — inside the band — and is enqueued
*before the walk starts*, so everything reachable from it follows.

**(b) The outer arc's `22-1 → 22-2` chord turns 25.5°** against a
`TANGENT_PROP_DEG` tolerance of 25°. It misses by half a degree, so the walk
dies mid-arc. `CHAIN_MAX_TURN_DEG` (PR #84) bounds the turn *within* one
simplified chord's span, not *between* adjacent chords — which is what the walk
actually tests. It worked on the unshelled box by luck.

**(c) The structural cause.** Tangency is derived from the **RDP-simplified
display polyline**. A drawing concern governs a semantic one, so every
simplification tweak silently moves selection. Six heuristics have accreted in
that gap with no single owner: `chainId` union, G1 walk, spatial endpoint
bridge, parallel-face bridge, seed-plane lock, collapsed-corner window.

---

## 2. What the codebase already has — and the duplication

**The worker already builds a topological face + edge graph.**
`sandboxWorker.js:1068 c4MeshData(m)` returns:

```js
{ V, faces: [{ id, tris, normal, center, verts }],
     edges: [{ a, b, va, vb, tris, tangent, faces: [faceIdx, faceIdx] }] }
```

It already splits each `faceID` group into **connected components** (union-find
over shared edges, `sandboxWorker.js:1096`) precisely because "Manifold may merge
coplanar-but-DISCONNECTED regions into one faceID". This is the script API's
backing store — it is what `edgesBetween(part, 3, 5)` in Artur's own script
resolves against.

**But it is neither stored nor cached.** `c4MeshData` is called fresh at seven
call sites (`:1323, :1336, :1354, :1377, :1617, :1714`) and rebuilds the whole
union-find every time; the single `laz()` memo at `:1617` is local to one
helper. So "solve once at render and keep it in state" is a real change, not
just a relocation — today the graph is rebuilt several times per script run and
then thrown away.

**The UI ignores all of it.** `Viewport.syncFeatureEdges` re-derives everything
from the three.js `BufferGeometry`: `buildFeatureEdges` (O(tris) dihedral scan)
→ `annotateFeatureEdges` → `buildCoherentEdges` (merge → trace → order → RDP).
`selectFace.js` separately re-floods the mesh on every click.

So there are **two parallel implementations of "what are this solid's faces and
edges"** — a topological one in the worker and a geometric one in the UI. Every
bug in this report is in the second. "Leverage the existing work" means
promoting the first and deleting the second.

### Measured: what `faceID` actually gives us

On the shelled part above (220 triangles):

| | count |
| --- | --- |
| distinct raw `faceID` | **60** |
| after connected-component split | **118 patches** |
| faces a human would name | ~10 |

Two facts fall out, and one of them inverts the premise of decision #2:

1. **The connected-component split works.** Every faceID split into exactly 2
   components — outer surface and cavity. The outer `+x` wall lands in patch 4,
   the inner `-x` wall in patch 9. **Separated.** So the inner/outer ambiguity I
   reported last round is already solved by code that exists; the UI just never
   sees it.

2. **`faceID` is over-fragmented, not under-unique.** The fillet blend — one
   face to any user — is shredded into ~30 faceIDs of **one triangle each**
   (601, 605, 615, 555, 1704, …). That is why blend arc edges come back with
   `faceA/faceB = undefined`, and it is the real reason a curved face needs a
   double-click today: single-click coplanar matching can only ever get one
   triangle of it.

**So the job is not "make faceIDs unique". It is merge *and* split:** merge
co-surface triangles into one patch, split disconnected regions apart. The split
half already exists.

### The crux risk: tangent junctions

A fillet meets its neighbouring planar faces **tangentially** — that is what G1
means — so a naive "flood until the dihedral is sharp" merge will swallow the
top face, the blend and the side face into one patch. Measured on this part:

| junction | dihedral |
| --- | --- |
| within the blend, facet→facet | ~3.75° |
| blend → adjacent flat face | ~1.9° |

These are **not separable by a fixed angle**, and the ratio moves with
tessellation density, so any threshold we pick is resolution-dependent. The
discriminator has to be **curvature continuity**, not angle: the flat face has
zero curvature, the blend has constant non-zero curvature, and the boundary
between them is a curvature (C2) discontinuity even though it is G1.

Proposed formulation, which leans on what we already have:

> **Atoms** = `faceID` connected components. These over-split but never
> under-split, so merging is safe and splitting is already done.
> **Merge** two adjacent atoms when the dihedral is smooth **and** their
> curvature class agrees (flat↔flat, or curved↔curved at a consistent rate).

That yields one patch per real face — planar or curved — with unique ids by
construction.

---

## 3. Target architecture

Three layers. The load-bearing idea is the split between **semantic** data (what
the part's faces and edges *are*) and **presentation** data (what we draw), so
simplification can never again change selection.

### Layer 1 — `PartGraph`, solved once per run in the worker

Faces and edges are **duals**: a patch boundary *is* a feature edge. One
segmentation produces both, from one threshold, so they cannot disagree.

```
PartGraph {
  patches: Patch[]          // the face graph
  curves:  Curve[]          // the edge graph = patch boundaries
  nodes:   Node[]           // curve endpoints / junctions
  spatial: BVH              // picking
  version                   // mesh identity; invalidates the cache
}

Patch {
  id                        // unique by construction
  tris, normal, center, area
  kind: 'planar' | 'cylindrical' | 'blend' | 'general'
  curvature                 // mean + variance; drives the merge rule
  neighbors: [{ patchId, curveId }]
}

Curve {
  id
  polyline: Vec3[]          // FULL resolution, from topology
  render:   Vec3[]          // RDP-simplified — drawing ONLY, never walked
  patchA, patchB            // unique patch ids
  kind: 'line' | 'arc' | 'general'
  dihedral: { min, max, mean }   // signed
  sign: 'convex' | 'concave' | 'mixed'
  closed
}

Node {
  id, position
  incident: [{ curveId, end, tangent }]
  tangentLinks: [[curveIdA, curveIdB], ...]   // PRECOMPUTED G1 pairs
}
```

`tangentLinks` is the key field. G1 continuity is decided **once, at build time,
on full-resolution geometry**, and stored. Tap-time propagation becomes a walk
over stored links — no angle thresholds, no RDP chords, no plane locks, no
bridges. It is the only place a tangency threshold exists: one number, one
golden.

Why this kills all three bugs:

- **(a)** dies: no proximity bridge exists. Two curves link only if they share a
  `Node` — actually meet in the topology. A wall 2.5 mm away shares no node and
  is unreachable regardless of ids.
- **(b)** dies: tangency is computed on the full polyline, where the blend's
  per-facet turn is ~3.75°, not on 25.5° RDP chords. `render` can be simplified
  as hard as looks good; the walk never sees it.
- **(c)** dies by construction: semantic and presentation are different fields.

### Layer 2 — visibility

1. **Front-face prefilter** (free): at least one adjacent patch front-facing.
2. **Occlusion test:**

   | option | accuracy | cost | notes |
   | --- | --- | --- | --- |
   | **A. depth prepass + sample test** | high | GPU, ~1 ms per camera settle | scales with pixels, not triangles |
   | **B. BVH raycast per candidate** | high | ~1 ms with `three-mesh-bvh`; ~30 ms without | ~20 lines, no render plumbing |

   **Recommendation: B first** (it is small, and the BVH also speeds up seed
   picking and Layer 1's spatial query), **A later** if profiling demands it.
   I flip-flopped from last round because the BVH earns its keep three times
   over, not just for occlusion.

Applied to seed pick **and every propagation step**. It is a pure filter over
Layer 1 — it never mutates the graph.

### Layer 3 — selection semantics

```
tap  → spatial query → visible candidates → nearest in screen space → seed
Tangent on → walk tangentLinks, stopping at:
     a node with no tangent link          (genuine sharp corner)
     a node with >2 tangent curves        (ambiguous Y/T junction)
     a candidate that is not visible
     the chain cap
```

Plus the **curvature-coherence rule** Artur asked for, which is what catches the
loft zig-zag: along a real tangent chain the *signed* turn is monotone in sign —
consistently curving one way, or straight. Tessellation noise alternates sign
every segment or two. Track the signed turn and stop when the sign alternates
more than once in a short window. This is a property of the walk, not another
geometric threshold, and it subsumes both the seed-plane lock and the
collapsed-corner window — which exist only to suppress zig-zag/T flooding.

**Face selection on the same substrate.** A tap resolves to a patch id, so:

| gesture | today | with patches |
| --- | --- | --- |
| single | coplanar flood — one triangle of a curved face | **whole face, planar or curved** |
| double | 3° neighbour flood (the curved-face workaround) | extend to tangent-connected patches (face + its blends) |
| triple | all connected | unchanged |

The "small face detection" side note falls out for free: once the blend is one
patch, a single tap selects it. No new algorithm, and the double-click stops
being a workaround and becomes a real widen gesture.

---

## 4. Requirements → mechanism

| Requirement | Mechanism |
| --- | --- |
| Fast; solved and stored at render | `PartGraph` built in the worker on the pass that produces the mesh, shipped with the result, held in state, keyed by mesh version. Mode toggles reuse it. Tap = spatial query + stored-link walk. |
| Only visible edges; never through walls | Layer 2 on seed **and** propagation. Through-wall becomes structurally impossible (no proximity bridges), not merely filtered. |
| Complete tangency; catch zig-zag | `tangentLinks` precomputed on full-resolution geometry; signed-turn coherence rule for tessellation noise. |
| Unique face ids + face graph | Patch segmentation: faceID-CC atoms + curvature-consistent merge. Unique by construction. |
| Single tap selects a curved face | Falls out of patches. |

---

## 5. Chunking — playtestable PRs

Each lands independently, keeps the app working, and has something specific for
Artur to try. Goldens on every one.

| PR | What | Playtest |
| --- | --- | --- |
| **1. Stop the bleeding** | Remove / node-gate `_parallelFaceBridge`; decouple the turn thresholds. No new architecture. | The shelled part: tap the outer edge, Tangent on → outer only, whole round. |
| **2. Patch segmentation + debug overlay** | faceID-CC atoms + curvature-consistent merge, in the worker. Ships in the payload. Behaviour unchanged; adds a patch-colour overlay toggle. | Turn on the overlay on your parts: is every face you'd *call* a face exactly one colour? This is the one that most needs your eye. |
| **3. Face pick reads patches** | Single tap = whole face, curved or planar. Double/triple re-mapped to widen. | Face selection everywhere, especially curved faces and fillets. |
| **4. Edge graph from patch boundaries** | Curves, nodes, `tangentLinks` built as the dual. Shipped but unused by the UI. | Nothing visible — goldens only. Skip playtest. |
| **5. Edge pick + propagation read the graph** | Delete the six heuristics. | All the fillet tangent cases: loft, roundedBox, shelled box, concave edges. |
| **6. Visibility** | BVH + occlusion filter on pick and propagate. | Orbit and try to pick through walls. |
| **7. Cleanup** | `makeSweepPath` consumes `Curve.polyline`; remove dead paths. | Fillet Accept end-to-end. |

PR 1 is hours and fixes the reported bug on its own. PR 2 is the one with real
technical risk (the tangent-junction merge rule) and is deliberately shipped
behind an overlay so we find out *visually* whether the segmentation is right
before anything depends on it.

### What lands where — read this before assuming PR 1 does more than it does

**PR 1 changes no architecture.** Both implementations stay exactly where they
are; it only removes the dishonest bridge and decouples the two turn thresholds.
It is the unblock, not the fix.

**The two parallel implementations die in PR 5**, when the UI starts reading the
graph and `buildFeatureEdges` / `buildCoherentEdges` / `selectFace`'s per-click
floods are deleted. `faces` becomes *correct* (rather than merely present) in
PR 2; edges-inferred-from-face-joints arrives in PR 4. So the arc is
1 → unblock, 2 → faces right, 4 → edges as their dual, 5 → one implementation.

**PR 1 risk and fallback.** The proximity bridge was added in #78 specifically
to make roundedBox rims chain, so deleting it may regress those cases.
`golden:mobile-c3-roundedbox-fillet-tangent` is the arbiter. If it goes red, the
fallback is to **node-gate** rather than delete: require a shared topological
node instead of 5 mm proximity. Same honest result, smaller blast radius, and it
is the same shape the bridge takes in the target architecture anyway.

### Sequencing choice

- **(a) PR 1 first.** Hours, low risk, Artur unblocked immediately, architecture
  untouched. The code it deletes is code PR 5 deletes anyway, so nothing is
  wasted.
- **(b) Straight to the unified path.** No interim work at all, but nothing
  playtestable for a while and PR 2's merge rule — the unproven part — gates
  everything behind it.

**Recommendation: (a)**, so the CAD work moves while the segmentation gets the
scrutiny it actually needs.

---

## 6. Risks and open questions

1. **The merge rule is the whole ballgame.** If curvature-consistent merging
   mis-segments — swallowing a face into a blend, or shredding a cylinder —
   everything downstream inherits it. Hence PR 2's overlay before PR 3+.
2. **Variable-radius / conic blends** have non-constant curvature, so "curvature
   agrees" needs a tolerance that does not re-split them. Needs a spike on real
   parts.
3. **Graph size over `postMessage`.** Full-resolution polylines on a 32 k-tri
   part are not large, but worth measuring before committing to shipping every
   run; may need transferables.
4. **Undo/redo and graph staleness.** Keyed by mesh version, but the invalidation
   path needs care so a stale graph is never picked against.
5. **Does "visible only" apply after orbiting?** Select a chain, orbit, Accept —
   should the now-hidden half stay selected? *My assumption: yes, selection is
   sticky once made; visibility filters only what you can newly pick.*
6. **Spheres expose zero pickable edges** today (every dihedral under the 15°
   gate). Correct in principle; worth deciding whether smooth bodies should
   offer silhouette curves.

---

## 7. Non-goals

- The blend kernels. `filletAlongPath`, the easy/hard split and the cutter math
  are untouched; only what gets handed to them changes.
- Re-tessellation or mesh repair.
- Chamfer/fillet UI and the Accept → script emitter.
- The script-facing C4 API (`edgesBetween`, `faceAt`) keeps its current
  signatures; it gains a better backing store, not a new contract.
