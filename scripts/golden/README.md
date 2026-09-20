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
| `smoke_slice25_extrude.mjs` | Slice 25 Extrude solid: live preview params, Confirm compose (makeExtrude + placeOnFace), update-in-place, Back/no-orphan, #30 fillet sweep default |
| `smoke_slice26_revolve.mjs` | Slice 26 Revolve solid: identity (u,v)→(radial,height) remap (centered circle → sphere; washer → torus), live preview params, Confirm compose (makeRevolve + placeOnFace), update-in-place, Back/no-orphan, Extrude/Profile/Loft unchanged, #30 fillet sweep default |
| `smoke_slice27_fillet_mode.mjs` | Slice 27 Fillet-in-mode: enter without edges, live blend preview as edges accumulate, Accept compose (makeSweepPath + filletAlongPath) + replace-in-place, Back/no-commit, disconnected path stays visible, #27–#30 sweep stack |
