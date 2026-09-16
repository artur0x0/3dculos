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
