# Architecture

**Maintenance:** every PR that changes kernel helpers, face/edge/contour graphs, multi-body rules, or UI pickers must update this file in the same PR (or a tiny follow-up before the next feature). Drop stale sections when behavior changes.

Runtime map for SurfCAD on current `main` (#129, `82508fa`). Screen placement is `docs/UI_MAP.md`. Popup chrome is `docs/POPUP_STYLE.md`. Blend kernels are `.claude/skills/fillets/SKILL.md`. `EDGES.md` is an older plan; the graphs below are what the code builds.

Two different things are called contours. **Sketch contours** are `makeCrossSection` profiles (contour mode). **Body contours** are the coherent edge chains the viewport paints and that Fillet / Sweep path picks walk. This file uses those names.

## Layers

```mermaid
flowchart TD
  script["Monaco script + feature chips"] --> worker["sandboxWorker: Manifold WASM + HELPER_FUNCTIONS"]
  worker --> mesh["mesh: verts, tris, faceID"]
  mesh --> face["Face graph: PartGraph, lazy on click"]
  mesh --> edge["Edge graph: feature edges, dihedral at least 2 deg"]
  edge --> contour["Body contours: coherent chains, dihedral ≥ 15°"]
  mesh --> seam["Keep-both shared edge: 1px black line"]
  face --> pick["Viewport pickers"]
  contour --> pick
  pick --> script
```

1. **Script.** Monaco holds the program. Feature chips come from `parseFeatureMarkers`. Confirm writes text into that buffer and Auto-Runs. The worker does not see picker state.
2. **Helpers.** `executeScript` prefixes the script with `"use strict";\n` and runs `new Function(...helperNames, wrappedScript)`. `HELPER_FUNCTIONS` are the parameters. Those names are bindings of the user script. See Goldens.
3. **Mesh.** A successful run replaces the three.js geometry and stores `faceID` on it. `c4MeshData` is a separate worker graph, rebuilt on each helper call that needs faces or edges. It is not the viewport PartGraph. `edge` / `edgesBetween` use `indexBoundaryEdges`, cached in a WeakMap on that Manifold object.
4. **Viewport.** Pickers and paint read the three.js mesh. They do not read `c4MeshData`.

## Helpers

Injected names are the keys of `HELPER_FUNCTIONS` in `src/workers/sandboxWorker.js`. Anything not in that object is not a script helper.

| Helper | Inputs → output | Multi-body |
| --- | --- | --- |
| `makeExtrude`, `makeRevolve`, `makeLoft` | contours or sections → a new solid | No split. UI unions onto `part` when `part` already exists. |
| `loft`, `sweep`, `sweepPoints` | profiles / path → a new solid | Same. |
| `makeCrossSection`, `profileCircle`, `profileRectangle`, `profilePolygon` | plane + 2D profile → a sketch contour, not a solid | — |
| `makeSweepPath` | edge list → one ordered path | Orders the edges it is given. It does not walk bodies. |
| `filletAlongPath` | solid, path, radius, opts → blend (subtract, or union for a concave run) | Does not split the input. After the boolean, `decompose()` can throw. See below. |
| `filletEdges` | solid, edges, radius → planar blend | No `decompose` scrap check. |
| `chamferEdges` | solid, edges, size → chamfer | No `decompose` scrap check. Fillet-mode Chamfer emits `filletAlongPath(..., { profile: 'chamfer' })`, not this. |
| `shell` | solid, thickness, opening → the cavity | No `decompose` / `compose`. Offsets the mesh it is given. |
| `hollow` | same → the walls (`solid − shell`) | Same. |
| `draftFaces` | solid, faces, angle, `{ pull, reference, sense }` → tilted solid | Moves vertices of the selected faces only. No `decompose`. A fillet between the neutral plane and the wall hinges at the blend tangency; the blend face is not drafted. |
| `addDraft` | solid, degrees, axis → `draftFaces(..., 'sides', { reference: 'min' })` | Same. |
| `cut` | solid, plane, `{ bodies, keep, drop }` → kept pieces | `decompose`, cut the named bodies, `compose` what remains. Default `keep` is `'both'`. |
| `move` | solid, `[dx,dy,dz]`, `{ bodies: [{ at }] }` → that body translated | Same split as `cut`. Exactly one body. Other bodies stay. |
| `edge`, `edgesBetween`, `boundaryEdges` | current solid + ids → segments | Ids are for this mesh. A miss throws `re-pick edges`. |
| `facesByNormal`, `planarFaceAt`, `edgesByOrientation`, `convexEdges`, `concaveEdges`, `signedFeatureEdges`, `workplaneFromFace`, `placeInFrame`, `transformByFrame`, `placeOnFace` | queries / frames on one solid | Worker faces do not merge across bodies (below). |
| `hole`, `holeSpan`, `cboreHole`, `cskHole`, `holePattern`, `clearanceHole`, `tapDrillHole`, fastener lookups | solid + frame → solid with holes | No body split. |
| `roundedBox`, `tube`, `rectTube`, `hexPrism`, `mirror`, `array3D`, `polarArray`, `center`, `align`, `getDimensions`, loft/sweep vector helpers | as named | No body split. |

`cut` and `move` are the helpers that `decompose` the input and `compose` the output. `shell`, `hollow`, and `draftFaces` do not. A second body already in the solid is just more triangles in that mesh.

Worker faces (`c4MeshData`): a Manifold `faceID` is split into edge-connected components, then components on the **same plane and the same body** are merged. The 0.1° coplanar merge also skips an edge whose two triangles are in different bodies. Body id is the vertex-connected component (`_triComponentIds`): a keep-both cut does not share vertices, so each piece is its own body even when `faceID` is reused. That is what the comment means by each body keeping its own contour. Curved components are not re-merged.

## When to rebuild graphs

There is no `rebuildGraphs()` and no per-op hook. Cut and Draft do not rebuild anything while the picker is open.

| Graph | Where | Built | Invalidated | Rebuilt |
| --- | --- | --- | --- | --- |
| **Face** (PartGraph) | `faceGraphFor` WeakMap on the BufferGeometry. Overlay copy in `partGraphRef`. | Next non-legacy face click, or when the patch-colour overlay is on. | `renderMeshData` drops `partGraphRef`. A new geometry is a WeakMap miss. The 250k-tri cap applies to the **overlay only**; a click still builds. | That next click / overlay pass. Not during Cut or Draft. |
| **Edge** | `buildFeatureEdges` inside `syncFeatureEdges`. Cache key is the geometry object (`featureEdgesSourceRef`). | Dihedral **≥ 2°**. Each edge gets `bodyId` from `meshBodyComponents` (shared vertex index = one body). | Success path sets the source ref to null, then syncs. An empty script clears and does not rebuild. | End of every successful run, including Cut and Draft confirm. Also on Fillet enter, leaving Fillet while still in Edge, and Sweep path pick. |
| **Body contours** | `buildCoherentEdges` in that same sync. Not a third cache. | Feature edges with dihedral **≥ 15°**, traced into chains. A keep-both cut shares no vertices, so a vertex walk cannot cross pieces. `bodyId` also blocks collinear merge and the spatial / parallel-face bridges (those links do not require a shared index). | Same as the edge graph. | Same call. If `faceID` is present, `indexBoundaryEdges` also runs and annotates those edges (fillet `fN` / `eN`). |

`indexBoundaryEdges` (worker `edge()` and viewport labels) keeps a boundary when dihedral ≥ 15° **and** the smaller face is ≥ 5% of the largest face. That is a stricter set than the coherent chains. Shallow blend facets stay out of both.

**After Cut confirm and after Draft confirm** the path is the same: Confirm writes one call, Auto-Run, `renderMeshData`, then `syncFeatureEdges` on the new geometry.

- Edge graph and body contours are rebuilt in that success path.
- The face graph is not. It waits for the next click (or the overlay).
- Face and edge picks are cleared, except Fillet mode and Sweep contour mode, which keep the edge wire and re-stamp boundary ids.
- The live Cut preview (`previewCut` on a clone) and the Move preview (translated triangles) do not replace `resultRef.geometry`. Graphs stay on the uncut / unmoved solid. Preview meshes do not raycast.
- Draft highlights do not change the mesh. Taps before Confirm still read the pre-draft graphs.
- Shell confirm uses this same run path. Nothing in the graph code special-cases shell.

What the new mesh contains is the difference, not the rebuild:

- **Keep-both cut.** Two vertex-disjoint bodies. Vertex walks cannot cross them; `bodyId` also blocks the bridges that would. `selectGraphFace` drops triangles that are not in the seed body when more than one body exists. The shared edge is painted (below).
- **Draft.** One body, unless the input was already split. Vertices of the drafted faces move, so dihedrals change, so the 2° / 15° gates can drop or keep different edges. No draft flag is stored on an edge.

## One click, one face

`resolveViewportFaceClick`:

- **Default (one click).** The PartGraph patch of the hit triangle: coplanar triangles of a flat face, or the curvature-merged band of a curved face. If the mesh has more than one body, triangles outside the seed body are removed. The hit triangle alone is not the face.
- **Default (double click).** The vertex-connected body (`selectOwningBody`), not a wider face.
- **Shell, Draft, Cut** pass `legacy`. One click is the coplanar region, two clicks are the 3° neighbour walk, three clicks are the connected component. A double click does **not** become the body, so Confirm still writes the tapped face.
- **Move.** One click is the full face and does not change the target. Double click sets that body (`{ at }` centroid).

Worker face picks (`{ center, normal }` passed to `hollow` / `draftFaces` / `cut`) resolve in `c4MeshData`, not in PartGraph. The two face graphs are not kept in sync.

## Contour paint

What you see as an edge is not one list.

1. **Crease.** The solid uses flat `MeshNormalMaterial`. A crease is wherever two adjacent triangles have different view-space normals. The shader has no angle cutoff. A coplanar diagonal (same normal) does not show. This is not stored.
2. **Pick contour.** `paintEdgeLines` draws `edgePolyline` of the **selected** or hovered coherent chain (and saved sketch-contour wires). It does not draw every coherent edge. Fillet and Sweep path consume those selected chains (`assembleSweepPath` / `makeSweepPath`). An edge enters that chain only through the gates above: dihedral ≥ 2° to exist, ≥ 15° to join a contour, and the chain must survive the simplify / spine tests. Pieces of a keep-both cut do not share vertices, and `bodyId` blocks the bridges that would join them anyway. The tangent walk stops when the next edge's tangents diverge by more than 28°.
3. **Shared cut.** Only `contactSeamSegments`. See below.

**Edges that end on a drafted face.** No painter checks "drafted". After Draft confirm the mesh is new and the same gates run on the new dihedrals. Draft moves vertices of the selected faces (`draftFaces`); a fillet between the neutral plane and the wall stays put and the hinge moves to the tangency. How many degrees that leaves on the tangency edge is not computed in the paint path. What the paint path does compute: an edge under 15° is absent from the coherent contour, so selection paint and path picks stop before it, while a material crease can still show if the normals differ at all. A wall that stays well above 15° stays eligible. The 28° tangent walk stops when the next tangent diverges, which a tilted edge can cause. Nothing extends the chain onto the drafted face to finish it.

That is the open seam: a wrap fillet plus these contours can stop short on a drafted face. The source has no branch for it. This note does not claim which gate fired in the playtest; those gates are the only rules, and none of them mention draft.

## Keep-both cut and the shared edge

`cut` defaults to `keep: 'both'`. Each selected body is `splitByPlane`. Kept pieces are `Manifold.compose`d when more than one remains. `decompose()` splits them apart again. They do not share vertices, so each piece is its own body. A body that does not cross the plane is returned unchanged. `faceID` may still be reused across the cut; worker face merge will not join those faces (body id is part of the plane key).

The new faces on the cut are real 90° edges on each piece, but the two side faces have the same normal, so the material crease never changes and the cut disappears. `contactSeamSegments` lists only that pair: a feature edge (not a coplanar diagonal) that two different bodies occupy, side normals agreeing (dot ≥ 0.85) and cap normals opposing (dot ≤ −0.85). One body, or a cut that keeps one side, produces no segments.

`attachContactSeam` draws those segments as `gl.LINES` in black (`vec4(0, 0, 0, 1)`), on the edge itself. There is no side-face lift (`CONTACT_SEAM_LIFT` is gone). `mvPosition.z += 0.5` is a depth bias so the line is not lost against the face (far plane is 2000). It is not a second, offset edge.

## filletAlongPath on a multi-body solid

The helper never looks at how many bodies came in. It booleans the whole solid, then `out.decompose()`.

| Result of `decompose` | What it does |
| --- | --- |
| 1 component | Keep it. |
| Closed path, 2+ | Throw `decompose found N components on closed path`. No keep-largest. The message has no "scrap vol". |
| Open path, 2+ | Keep the largest, unless scrap volume `> 5%` of that largest **and** `> 0.01`. Then throw `decompose found N components with scrap vol …`. |
| Semi-arc batch (`plan.mode === 'runs'`, a wrap split at corners) | Same 5% / 0.01 test. The message is `semi-arc batch decompose found N components with scrap vol …`. |

Scrap volume is `(sum of component volumes) − largest`. The comment describes disconnected cutter scraps (thin sheets), not a second designed body. A keep-both cut's other piece is a real component. If that piece is more than 5% of the larger body and more than 0.01 volume, the open-path and semi-arc paths throw. They do not ask whether the input was already two bodies. A closed wrap hits the other message even when the second component is the other kept body.

The playtest line `decompose found 2 components with scrap vol …` is the open-path or semi-arc throw. Both strings are still in `filletAlongPath`. Not fixed here.

Fillet after hollow is a different path. A concave segment forces the variable-profile builder inside `filletAlongPath`; that is not this scrap check. `golden:draft-fillet-tangency` covers draft hinge vs a fillet. Nothing registered in `package.json` covers keep-both plus `filletAlongPath`.

## UI confirm

Sticky pickers (Shell, Draft, Cut, Move) write **one** call and **replace** the previous marked block of that kind. A second confirm does not append. Grey X writes nothing. Chip behaviour is `docs/POPUP_STYLE.md`.

| Mode | Tap | Confirm emits | Next confirm |
| --- | --- | --- | --- |
| Shell | add / remove opening faces. Closed → `'none'`. | one `hollow()` | replace |
| Draft | first tap = neutral (pull). Later taps toggle drafted faces. Undo drops the last drafted face. | one `draftFaces()` | replace |
| Cut | plane, then bodies (tap add/remove), then pieces (tap hides). | one `cut()`. `keep` omitted means both. | replace |
| Move | double-click one body. XYZ, or a distance along the previous cut normal or a face normal. | one `move()` | replace |
| Fillet / Chamfer | edge pick. Tangent on by default. | `makeSweepPath` + `filletAlongPath` | **append** if that kind's markers are already in the buffer, else replace |
| Sketch contour (Extrude, Revolve, Loft, Sweep, Profile) | profile on a plane | profile, and a solid for the four tools | replace that marked block |

Fillet's marker comment still says the second Accept replaces. The call site passes `commitMode: 'append'` when `hasFilletModeBlock` (Chamfer the same). `composeFilletCommit` keeps the old block only in that append case.

## Interaction matrix

| | Face graph | Edge + body contours | Shared-edge line | Notes |
| --- | --- | --- | --- | --- |
| Cut confirm (keep both) | lazy, then clipped to the seed body | rebuilt; pieces share no vertices | 1px black, on the edge | `filletAlongPath` afterwards can throw scrap (open) |
| Cut confirm (one side) | lazy | rebuilt; one body | none | |
| Draft confirm | lazy | rebuilt from new dihedrals | recomputed; one body still has none | contour can stop short of a drafted face (open) |
| Fillet / Chamfer confirm | lazy | rebuilt; picked wire kept | recomputed from the new mesh | |
| Shell / hollow confirm | lazy | rebuilt; no shell-specific rule | recomputed from the new mesh | |
| Move confirm | lazy | rebuilt | recomputed from the new mesh | preview does not rebuild graphs |
| Enter Cut / Draft / Move | unchanged | unchanged | unchanged | highlights and clones only |

## Open seams

Still true in source. Do not treat this doc as the fix.

- **`filletAlongPath` after a keep-both cut** throws `decompose found 2 components with scrap vol …` (or the semi-arc / closed-path variants above) when the other piece survives as a second component. The guard cannot tell a kept body from cutter scrap.
- **A wrap fillet plus body contours can stop short on a drafted face.** Paint and path picks use the 15° coherent gate and the 28° tangent walk. Neither knows the face was drafted.

## Goldens and fixtures

- Runners live in `scripts/golden/`. Playtest scripts live in `scripts/golden/fixtures/*.txt`.
- Each runner is a `package.json` script named `golden:…` (`node scripts/golden/smoke_….mjs`). `npm run verify` is the full gate (`VALIDATION.md`).
- `golden:helper-binding-clash` scans those fixtures. The user script is still the body of `new Function(...helperNames, script)`. A top-level `const cut` in a fixture is a SyntaxError because `cut` is already a parameter. Nesting the script in another function would hide that and is not the fix. Do not name a fixture binding after an injected helper (`cut`, `move`, `shell`, `hollow`, `draftFaces`, …).
