# Slice 01 golden cases (in-repo)

Authoritative geometry regression lives in **cadgen-workspace** (`npm run verify`).
These files are the in-repo puzzle vocabulary smoke + copy-paste scripts for
review while the private harness may be unavailable.

| File | What it proves |
|---|---|
| `smoke_slice01.mjs` | Fastener diameter tables + clearance/tap/cbore/csk/fillet/chamfer loud-fail via `manifold-3d` (npm) |
| `puzzle_clearance_plate.js` | Copy-paste SurfCAD script: plate + M3 clearance + M4 cbore + chamfer |
| `puzzle_fillet_box.js` | Copy-paste SurfCAD script: filleted box (convexEdges) |

Run smoke (no cadgen-workspace required):

```bash
node scripts/golden/smoke_slice01.mjs
```

Note: npm `manifold-3d` ≠ bundled `built/manifold.wasm`. Gate acceptance still
requires `test_real_worker.mjs` via `npm run verify` once the harness is present.

| `smoke_slice21_cross_section.mjs` | Slice 21 cross-section substrate: plane from planar face, profiles, preview, compose |
| `smoke_slice23_fillet_via_sweep.mjs` | Slice 23 sweep fillet: wedge contours, palette Strategy=sweep, closed-rim + post-fillet geometry via worker |
| `smoke_slice24_contour_mode.mjs` | Slice 24 contour-mode shell: plane refuse, Profile-in-mode compose (no Extrude), update-in-place, #30 fillet sweep default |
| `smoke_slice25_extrude.mjs` | Slice 25 Extrude solid: live preview params, Confirm compose (makeExtrude + placeInFrame replace), update-in-place, Back/no-orphan, #30 fillet sweep default |
| `smoke_slice26_revolve.mjs` | Slice 26 Revolve solid: identity (u,v)→(radial,height) remap (centered circle → sphere; washer → torus), live preview params, Confirm compose (makeRevolve + placeInFrame replace), update-in-place, Back/no-orphan, Extrude/Profile/Loft unchanged, #30 fillet sweep default |
| `smoke_slice28_loft.mjs` | Slice 28 Loft multi-profile: same workplane + offsets, live preview, Confirm compose (makeCrossSection × N + makeLoft + placeInFrame replace), update-in-place, Back/no-orphan, Extrude/Revolve/Fillet unchanged |
| `smoke_hotfix_frame_only_plane_undo_autorun.mjs` | Hotfix: empty Confirm is frame-only (no host cube / no part.add); existing part unions; Undo/Redo Auto-Run via setTextOnly + handleGameRun |
| `smoke_hotfix_contour_picker_additive.mjs` | Hotfix: saved contours list + ghosts, auto-pick last, Profile/Workplane in Advanced, additive Confirm keeps cube volume |
| `smoke_polish_adv_ux.mjs` | Polish: loft circle↔rect sharp corners + view-aligned default, Confirm exits contour mode, Sweep path selector inside the popup, Workplane is a plane (no host cube), blank/plane-only script clears the viewport |
| `smoke_slice27_fillet_mode.mjs` | Slice 27 Fillet-in-mode: enter without edges, live blend preview as edges accumulate, Accept compose (makeSweepPath + filletAlongPath) + replace-in-place, Back/no-commit, disconnected path stays visible, #27–#30 sweep stack |
| `smoke_fillet_followup.mjs` | Fillet follow-up: loft overlay stays bounded, blend strips are not candidates, sequential sharp-edge Accept appends, blend-only Accept fails loud |
| `smoke_fillet_easy_hard.mjs` | Slice B: box / extrude edges easy (no warn reason); circle↔square loft generator hard with a stable reason; Accept stays allowed; huge radius and long chains warn |
| `smoke_cad_palette_overlays.mjs` | CAD Model section promotes Profile/Workplane/Extrude/Revolve/Sweep/Loft (game Advanced rail unchanged); Plane/Contour toggles default on and gate overlay paint and picking |
| `smoke_cad_mobile_chrome.mjs` | CAD phone shell matches puzzle: viewport top, Monaco bottom budget, keyboard pin, mid-strip actions, vertical right rail |
