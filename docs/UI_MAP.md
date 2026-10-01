# UI Map — where every piece is on screen, and where its code lives

SurfCAD is a **single-page, two-pane app**: a Monaco script editor and a
Three.js viewport. There is no router and no page list. Everything the user sees
is either one of those two panes, a floating overlay inside the viewport, or a
full-screen modal.

Read this file to answer "where is X on screen?" and "which file do I edit?".
For blend/fillet internals read `.claude/skills/fillets/SKILL.md`; for the
script API read `HELPER_FUNCTIONS.md`.

- **Mount:** `src/main.jsx` → `AuthProvider` → `App`
- **Shell + all layout decisions:** `src/App.jsx`
- **Global CSS / Monaco overrides / touch fixes:** `src/index.css`
- **Everything inside the 3D pane:** `src/components/Viewport.jsx` (~4k lines)
- **Script execution sandbox:** `src/workers/sandboxWorker.js` (~4.9k lines)

---

## 1. The two shells

`App.jsx` renders **one of two completely separate JSX trees**, chosen by
`isMobile` state (`src/App.jsx:47`), set from `matchMedia("(max-width: 768px)")`
(`src/App.jsx:435`). There is no shared layout wrapper — if you change chrome in
one shell you must change the other.

### Desktop shell (`src/App.jsx:1280`+) — side by side

```
┌────────────────────────────┬───┬──────────────────────────────┐
│ CodeEditor (splitPct)      │▓▓▓│ Viewport (rest)              │
│                            │ ║ │   ↑ FeatureStrip (vertical   │
│ ┌────────────────────────┐ │ ║ │     seam) + SplitDivider     │
│ │ mid-strip: [Toolbar]   │ │ ║ │  top-center: title chip      │
│ ├────────────────────────┤ │ ║ │                              │
│ │ Monaco (vs-dark, 12px) │ │ ║ │  left: HelperInsertPalette   │
│ ├────────────────────────┤ │ ║ │  right: CrossSection cluster │
│ │ PromptInput (hidden)   │ │ ║ │  info chips bottom-left      │
│ └────────────────────────┘ │ ║ │                              │
└────────────────────────────┴───┴──────────────────────────────┘
```

**The seam between the two panes is draggable** in both shells
(`SplitDivider.jsx`, pointer-capture based): left/right on desktop
(`splitPct`, clamped 20-80%), up/down on mobile (`mobileEditorPxOverride`,
clamped so neither pane collapses; an open keyboard still overrides it).

**The AI prompt row is hidden, not deleted** — `PromptInput` stays mounted
behind `hidden` + `data-ai-prompt-row="hidden"` in both shells while a tighter
editor integration is designed. Remove the `hidden` class to bring it back.

**The title chip renames the part.** Click it (or the "Untitled" placeholder)
and it becomes an input: Enter or blur commits, Escape reverts, empty commits
nothing. Names are sanitised (`sanitizePartName`) because they end up in
`${name}.js` downloads. Wired through `onRenameFile` → `setCurrentFilename`.

Desktop specifics:
- **Feature strip (desktop seam):** `FeatureStrip.jsx` mounts **between** the
  editor column and the viewport (`data-desktop-feature-strip`,
  `data-feature-strip-placement="desktop-seam"`, `side="between"`). Vertical
  chips match mobile (cube / fillet / … from `parseFeatureMarkers`); tap jumps
  Monaco caret via `handleDesktopFeatureStripJump` (no feature sheet — sheets
  stay mobile-only). Hidden in game mode. SplitDivider stays immediately to the
  right of the strip.
- **The Toolbar is portaled into the editor mid-strip, exactly like mobile.**
  There is no floating overlay bar and no collapse chevron for CAD any more;
  `Toolbar.jsx` renders only the dark `variant="strip"` markup for CAD.
- Both viewport rails are **vertical** in this shell too (`verticalRail` is passed
  unconditionally), and both use the same size as each other: 20px icons,
  `p-2` buttons, `p-2` shell.
- Info chips (Selected Face, Edge pick, measurement readout) sit **bottom-left at
  `left-[4.5rem] lg:left-[5.25rem]`** so they clear the helper rail
  (`src/components/Viewport.jsx:3682`, `:3848`, `:3937`).
- Title chip shows the filename, same as mobile — no toolbar carries it now.
- `PromptInput` is passed `isMobile={false}` explicitly (`src/App.jsx:1345`).

### Mobile shell (`src/App.jsx` mobile branch) — CAD stages + game stack

**CAD (Slice Mobile A + B + C):** dual stage, not a cramped split. Default = CAD stage.
Toggle is session-sticky (`sessionStorage` key `3dculos.mobileStage`). Slice B
replaced the top text chrome with a bottom home-indicator pill + Script feature strip.
Slice C adds CAD-stage feature sheets (default edit path without Monaco).

```
CAD stage                          Script stage
┌─────────────────────────────┐   ┌─────────────────────────────┐
││feat│ Viewport + rails      │   ││feat│ mid-strip: Toolbar    │
││strip Contour/Fillet chips  │   ││strip mid: Monaco (full)   │
││(edit) title chip           │   ││icons PromptInput (hidden) │
││      feature sheet (glass) │   ││vert  (viewport mounted)   │
│         ( ●  ○ ) pill       │   ││      ( ○  ● ) pill        │
└─────────────────────────────┘   └─────────────────────────────┘
```

**Game:** still the old stacked split (viewport on top, Monaco bottom budget +
draggable seam). Stages do not apply in puzzle mode.

```
┌─────────────────────────────────┐
│ Viewport (flex-1)               │  top-center: ViewportTitleChip
│   left-2 bottom-4: helper rail  │  (puzzle name)
│   right-2 bottom-4: cluster     │
╞═════════════════════════════════╡  ← draggable seam
│ mid-strip: [Toolbar strip]      │
│ Monaco (16px font)              │  height = 32–38% of viewport
└─────────────────────────────────┘
```

Mobile specifics:
- **Stage toggle (Slice Mobile B):** `MobileStageToggle.jsx` is a bottom-centered
  iPhone Home Screen–style glass pill (`data-mobile-stage-home-indicator`,
  `data-home-indicator-pill`) with two dots (left = CAD, right = Script).
  Tap left/right half switches stage. Session-sticky via `3dculos.mobileStage`.
  Top CAD|Script text chrome is gone. Inert `data-ai-prompt-hook` marks a
  future AI-on-tap site (not wired). Contour/Fillet chips use `bottom-14` on
  mobile so they clear the pill. Shell exposes `data-mobile-stage="cad"|"script"`.
- **Feature strip (Slice Mobile B → B.1 → C → C.1 → C.4 + UI polish):** `FeatureStrip.jsx` mounts as a
  **vertical right rail** (`data-feature-strip-side="right"`), starting below the
  top ribbon. **Script stage:** icon chips **jump caret only** (`handleFeatureStripJump`
  → `revealRange`; no FeatureSheet). **CAD stage:** strip taps / long-press open a
  **feature sheet** (`hideWhenEmpty`). Strip scroll uses `rail-scroll` (visible thin
  thumb; horizontal CAD strip shows a bottom bar on overflow) and auto-scrolls to the
  **last** chip when the feature list grows. Chip highlight (`featureStripActiveId`)
  clears on sheet cancel/accept/delete (and after script jump). C.4+: Script-stage
  editor stack is full-bleed (`absolute inset-0`) so the top ribbon
  (`data-editor-ribbon`, `w-full`) spans the viewport; the vertical strip overlays
  `right-0` with `top: ribbonPx` (`data-feature-strip-ribbon-spacer-h="measured"`),
  `z-20`, and Monaco uses `pr-11` so chips stay below the ribbon without covering code.
  Per-type index badges (`data-feature-type-badge`,
  1…n per kind) sit bottom-right on each icon. Icons match the CAD toolbar
  (Contour/`NotebookPen`, Extrude/`ArrowUpFromLine`, Revolve/`Rotate3d`,
  Loft/`Pyramid`, Sweep/`Route`, Fillet/`SquareRoundCorner`,
  Chamfer/`TriangleRight`). Markers from `parseFeatureMarkers` (`typeIndex`).
  Desktop mounts its own vertical strip in the editor↔viewer seam (see Desktop
  specifics above); mobile CAD/Script mounts stay as documented here.
- **Feature sheets (Slice Mobile C → C.1):** `FeatureSheet.jsx` — full-width
  **horizontal** glass bar just below the part name (`top-14`,
  `data-feature-sheet-layout="under-title-horizontal"`) on **CAD and Script**
  stages. Caps at `max-h-[calc(100dvh-10rem)]` with internal `rail-scroll` so
  mobile popups stay below the feature strip with finger clearance for viewport
  picks (Contour/Fillet chips use `max-h-[calc(100dvh-12rem)]` similarly).
  Horizontal scroll when params overflow. Open via long-press (~450ms)
  on the viewport or CAD strip tap. Real param writeback for **Extrude**
  (distance/sense), **Fillet** (radius), **Revolve** (angle) via
  `featureSheetWriteback.js` into the marked block + Auto-Run; other kinds stub
  → Edit script. Accept / Cancel / Edit script stay. Desktop/game sheets off
  (`featureSheetEnabled` false).
- **Viewport backdrop:** `viewport-shell` + Three.js clear/background use Monaco
  gray `#1e1e1e` (not Tailwind `gray-900` / `#111827`).
- **Face description popup:** removed in Slice Mobile C.1 (was under-title B.1
  `data-face-info-popup`). Selection still drives the left palette / PromptInput;
  no empty reserved band.
- **Edge-pick chip (C.1):** horizontally centered + raised
  (`left-1/2 -translate-x-1/2`, `bottom-20` mobile / `bottom-14` desktop) so it
  clears the right rail and home-indicator / CAD|Script dots.
- **Left ↔ right rail height (C.1):** helper / contour left rail uses the same
  bottom inset as the right cluster (`bottom-2.5`) and
  `h-[min(26rem,calc(100%-5.5rem))]` (shared `RAIL_PAIR_HEIGHT_CLASS`) so left/right match pixel-perfect;
  Edge-pick **Tangent on** (C.3): seed-plane G1 + same-face parallel bridge so a
  `roundedBox` top rim floods the full coherent loop (not 1 leftover segment).
  C.4: `buildCoherentEdges` traces tagged vs untagged sharp pools separately so
  post-fillet rounded rails (untagged open arcs) stay pickable for Tangent-on.
  overflow scrolls inside (`data-rail-pair="left"|"right"`).
- **Ribbon / top chrome bg (C.1):** editor mid-strip is `bg-gray-900`
  (`data-ribbon-bg="editor"`), matching the code editor shell.
- **Default view snaps (Slice Mobile B.1):** `VIEW_SNAP_MARGIN = 1.35` (was
  implicit 1.15) for top / right / front / iso (and other `VIEW_PRESETS`).
  Zoom-to-Fit keeps `fitView` default 1.15; game puzzle enter keeps 1.55.
- **Both panes stay mounted** across stages (WebGL + Monaco + editor refs /
  portal host). Off-stage pane is `invisible pointer-events-none`.
- **Editor budget** (`mobileEditorPx`) still applies to the **game** stack as a
  clamped fraction of `visualViewport` height.
- **Keyboard handling:** `keyboardOverlap` / `keyboardOpen`. Closed → `h-dvh`.
  Open → the shell becomes `position: fixed` pinned to `visualViewport`
  (`mobileShellStyle`). iOS refuses Monaco focus inside a fixed+overflow shell
  until the keyboard is already open.
- **The Toolbar is portaled.** `CodeEditor` renders an empty host div
  (`src/components/CodeEditor.jsx:439`, `data-cad-toolbar-host`) and hands the
  node up via `onCadToolbarHost` → `cadToolbarHost` state (`src/App.jsx:75`) →
  down into `Viewport`, which `createPortal`s a `variant="strip"` Toolbar into it
  (`src/components/Viewport.jsx:3530`). So CAD chrome is **rendered by Viewport
  but displayed in the editor header** — the most surprising wiring in the app,
  done so download/export busy state can stay in Viewport, and so the green Run
  button can call Viewport's own `executeScript()` on the live buffer without a
  round trip through App (`runCadScript`). Game's Run is a different handler
  (`onRun`); CAD's is `onRunScript`. Select-all sits beside Run at the same
  18px: the button is in the strip, the editor is in `App`, so it routes
  `onSelectAll` → `codeEditorRef.current.selectAll()`. Both shells do this.
- The `CrossSectionPanel` cluster is a **vertical** rail (`verticalRail`,
  `src/components/Viewport.jsx:3656`) — in both shells.
- Overlays still take `compact={isMobile}`, but it no longer changes rail button
  size: the two rails are locked to one size (see Conventions).

---

## 2. Two app modes, orthogonal to the two shells

`appMode` (`src/App.jsx:60`) is `'cad'` or `'game'` (match-the-part puzzle).
That yields **four** layout combinations; check both flags when editing chrome.

| | `mode === 'cad'` | `mode === 'game'` |
| --- | --- | --- |
| Toolbar contents | **run + select-all** (green run first, own section) then account/open/upload/undo/save/download/quote/puzzle | back, undo/redo, run, picker, hint (`src/components/Toolbar.jsx:98`+) |
| Toolbar placement | portaled strip above the editor, both shells | strip inside CodeEditor, both shells |
| Title chip | always (filename) | always (puzzle title) |
| Helper rail | `layout="cad"` — advanced tools folded into Model | `layout="game"` — keeps the Advanced group |
| Info chips | bottom-left on desktop | always bottom-right (dodges the palette) |
| PromptInput | mounted but `hidden` (see shells) | not rendered (`appMode !== 'game'` guards) |
| Extras | — | ghost mesh, timer, confetti, "Match!" banner (`src/components/Viewport.jsx:3595`) |

Game logic: `src/utils/gamePuzzle.js`, `gamePuzzles.js`, `gameWins.js`;
best times persist via `POST /api/wins`.

---

## 3. Viewport overlay inventory (in render order)

All of these are absolutely positioned inside the shell at
`src/components/Viewport.jsx:3527` (`relative w-full h-full`), with the
`<canvas>` rendered last.

| Screen position | What | Component | Site in Viewport.jsx |
| --- | --- | --- | --- |
| *editor header* (portal) | Toolbar, all CAD | `Toolbar.jsx` `variant="strip"` | `:3530` |
| top-center | title chip | `ViewportTitleChip` (local, `:201`) | `:3588` |
| centered | "Match!" success banner | inline | `:3595` |
| left-2/4 bottom-2.5 | helper insert rail (height paired to right) | `HelperInsertPalette.jsx` | Viewport |
| left-2/4 bottom-2.5 | contour tool rail (replaces the helper rail) | `ContourModeRail.jsx` | Viewport |
| right-2/4 bottom-4 | view / pick / cross-section cluster | `CrossSectionPanel.jsx:175` collapsed, `:327` expanded | `:3641` |
| inside that cluster | Front/Right/Top/**Iso** snap popup | `ViewSnapControl.jsx` | `CrossSectionPanel.jsx:181` |
| top-16 right-4 | execution error card | inline | `:3686` |
| *(removed C.1)* | Selected Face readout | — | — |
| bottom-4 right-2/4 | contour param chip | `ContourModeChip.jsx:176` | `:3733` |
| bottom-4 right-2/4 | fillet param chip | `FilletModeChip.jsx:43` | `:3835` |
| bottom-center (raised) | Edge-pick chip (`data-edge-selector`) | inline | Viewport |
| top-16 center | toasts: edge-mode, contour, fillet-scrap, fillet | inline, four blocks | `:3924`, `:3932`, `:3940`, `:3952` |
| bottom-left | measurement readout | inline | `:3961` |
| fills the pane | WebGL canvas | `<canvas ref={canvasRef}>` | `:3985` |

**Mutual-exclusion rules.** The helper rail hides while `contourMode` or
`filletMode` is set; the Edge-pick chip needs `pickMode === 'edge'`, no active mode, **and at
least one selected edge**. Break these and overlays stack in the same corner.

**View snaps.** `ViewSnapControl`'s button only opens and closes its popup —
Front / Right / Top / Iso all live *inside* the popup. The popup flies out **to
the left** of the trigger (`absolute right-full`, vertically centred on it),
because the cluster hugs the right edge of the viewport. While it is open the
button shows an `ArrowLeft`, pointing the same way the menu unfurled. There is
no alignment prop — both call sites render `<ViewSnapControl onSnap={…} />`.

---

## 4. Modals (full-screen, mounted from `App.jsx` in both shells)

All use `fixed inset-0 z-50 flex items-end sm:items-center` — **bottom sheet on
phones, centered dialog on desktop**.

| Modal | Opened by | File | Notes |
| --- | --- | --- | --- |
| Login | Toolbar → Account, signed out | `LoginModal.jsx` | `/api/auth/login`, `/register` |
| Account | Toolbar → Account, signed in | `AccountModal.jsx` | tabs `info` / `orders` (`:160`) |
| Quote | Toolbar → Truck | `QuoteModal.jsx` | process / material / infill → `utils/quoting.js` |
| Order | Quote → Order | `OrderModal.jsx` + `components/order/*` | six steps, `STEPS` at `OrderModal.jsx:13`: Auth → Address → Shipping → Payment → Confirmation → Convert |
| Helper params | any helper-rail button | `HelperParamModal.jsx` | **not** a full-screen modal: docks bottom-centre *of the viewport* (`absolute inset-0`, click-through overlay, no scrim) so the rails and the live preview stay visible and usable. No click-outside-to-cancel — X / Cancel only. Also serves as the refuse/explain dialog |
| Puzzle picker | Toolbar → List (game) | `PuzzlePickerModal.jsx` | |
| Hints | Toolbar → BookOpen (game) | `GameHintsModal.jsx` | |
| Terms | order flow | `TermsModal.jsx` | |
| Confetti | puzzle win | `GameConfetti.jsx` | full-viewport canvas, not a modal |

Error banners (`gameError`, `uploadError`) are inline at
`absolute top-4 left-1/2 … z-50`, duplicated in both shells.

---

## 5. Feature → code index

### Shell, layout, responsiveness
`src/App.jsx` — both shells, `isMobile`, keyboard/visualViewport math, modal
mounting, and every top-level handler: `handleExecute`, `handleSave`,
`handleOpen`, `handleImport`, `handleQuote`, `handleStartOrder`, undo/redo
history, `handleInsertHelper`, `handleCommitContourProfile`,
`handleCommitFillet`.

### Code editing
`src/components/CodeEditor.jsx` — Monaco wrapper, mid-strip, the Select All
context-menu action (`registerSelectAllMenu`, `:14`), and the imperative ref API
(`getContent`, `loadContent`, `setTextOnly`, `insertAtCursor`). Starting
document: `src/utils/defaultScript.js`. Draft persistence:
`src/utils/editorStorage.js`.

### Running a script
`src/components/PromptInput.jsx` (AI prompt → `POST /api/generate`) →
`src/utils/scriptValidator.js` → `src/utils/scriptExecutor.js` →
`src/workers/sandboxWorker.js` (every helper function and the real geometry
work), with Manifold booted by `src/utils/ManifoldWorker.js`. Timeout/memory
caps: `EXECUTION_LIMITS`, `src/components/Viewport.jsx:212`.

### Selection
Faces: `src/utils/selectFace.js`, `src/utils/faceFeaturePlacement.js`.
Edges: `src/utils/selectEdge.js` (`pickNearestEdgeScreen`,
`buildCoherentEdges`, `toggleEdgeSelectionPropagated`),
`src/utils/boundaryEdgeIds.js`, `src/utils/edgeTangencyField.js`. Pick mode is
one `pickMode` state (`src/components/Viewport.jsx:282`), toggled from the
`CrossSectionPanel` cluster.

### The "in-mode" pattern
Contour / Extrude / Revolve / Loft / Sweep: `src/utils/contourMode.js` +
`ContourModeRail.jsx` + `ContourModeChip.jsx`; enter/exit/confirm at
`src/components/Viewport.jsx:1337-1401`.
Fillet / Chamfer: `src/utils/filletMode.js` + `FilletModeChip.jsx` (same
edge-pick chip; Chamfer commits `chamferEdges`, Fillet commits the sweep).
Enter/exit/accept at `src/components/Viewport.jsx` `enterFilletMode` /
`acceptFillet`. Kernels in `src/utils/fillet*.js` and
`src/utils/edgeSweepPath.js` — read `.claude/skills/fillets/SKILL.md` first.
A Create-contour Confirm on a script with no `part` writes a plane literal
and does not insert the starter cube, so the following Extrude is
`let part = placeInFrame`, the same shape as Workplane-then-Extrude.
Both modes share the shape: tool rail on the left, param chip on the right,
commit writes script text back through `App.jsx`.

### Viewport furniture
Camera and snaps `src/utils/viewCamera.js`; cutting plane
`src/utils/cuttingPlaneWidget.js`, `crossSection.js`,
`crossSectionSubstrate.js`; measurement `src/utils/measurementTool.js`; saved
wires `src/utils/savedContours.js`.

### Files and commerce
Import `src/utils/importModel.js` (+ `POST /api/convert/step`); export
`src/utils/exportModel.js`, `src/utils/model-io.js`. Quoting
`src/utils/quoting.js`; checkout resume `src/utils/checkoutStorage.js`; auth
`src/hooks/useAuth.jsx`. Backend: `backend/server.js`,
`backend/routes/{auth,convert,orders,shipping,webhooks,wins}.js`,
`backend/services/{stripe,email,ups}.js`, `backend/systemPrompt.js`.

---

## 6. Conventions to keep

- **Tailwind only**, no CSS modules. Overlay idiom:
  `absolute … bg-white/60 backdrop-blur-sm rounded-lg shadow-lg z-10`.
- **Inserting a solid APPENDS, it never replaces.** Every build that creates a
  new solid — the six Shapes and the one-shot Extrude / Revolve / Loft — goes
  through `emitPartPlace(names, expr, partDeclared, true)`, which emits
  `part = part.add(expr)` when a part already exists and `let part = expr` when
  it does not. Emitting a bare `part = <newSolid>` strands whatever was there as
  dead code; that was a real bug in all six Shapes until it was fixed. Mutating
  an existing body (holes, shell, transforms) is different — that keeps
  `syncPartLines`, which points `part` at the body you edited.
- **Feature popups all use `src/components/controls/popupUI.jsx`** — one type
  scale (`POPUP_TEXT`), one set of fields, accents per surface (`cyan` contour,
  `amber` fillet, `slate` helper sheets). **Every number renders a slider AND a
  typed box**: `NumberField` never gives you one without the other, so don't
  hand-roll an `<input type="range">` in a popup. Accent classes are spelled out
  in `ACCENTS` because Tailwind purges computed class names — extend the map,
  never interpolate.
- **Circle segments default to 64** everywhere (palette items, contour profiles,
  starter snippets). The contour slider goes to 128 so the default is not pinned
  at the top of its range.
- **Everything over the 3D view is translucent.** `src/index.css` defines the
  three surfaces: `surface-glass` (panels and modal sheets),
  `surface-glass-chip` (small viewport overlays — supply your own tint, it only
  adds the frosting) and `surface-scrim` (modal backdrops). They share one
  `--surface-blur` token, and there is an `@supports not (backdrop-filter)`
  fallback that goes more opaque so text stays legible. Never put a flat
  `bg-gray-900` / `bg-[#1e1e1e]` slab over the viewport. The one exception is
  native `<select>` / `<option>`: the OS renders the option list and a
  translucent one is unreadable.
- **Cross-section buttons name their action**: the collapsed rail opens the
  options with the section-cut glyph (`TrianglesCenterlineDashedVertical`), and
  the expanded panel closes with a green `Check`. No chevrons — they said
  "up/down", not what would happen.
- **Bottom-centre is for mode chips and the param popup**; the bottom corners
  belong to the rails. Contour and Fillet chips are
  `bottom-2.5 left-1/2 -translate-x-1/2`, the right-hand cluster is
  `bottom-2.5 right-2.5` (10px off both edges), and the helper rail keeps
  `left-2 lg:left-4`.
- **Responsive insets** are written `left-2 lg:left-4` / `right-2 lg:right-4`
  (phone-tight, desktop-roomy). Match this rather than inventing values.
- **z-index ladder:** overlays `z-10`; edge chip and success banner `z-20`;
  toasts + mobile stage pill `z-30`; **cross-section panel/popup `z-40`** (above
  the CAD↔Script home-indicator so expanded options win); modals and error
  banners `z-50`. Cross-section popup **Dismiss** is a grey lucide `X` (not the
  red FlipHorizontal); the collapsed rail still uses FlipHorizontal to
  enable/disable. Contour-mode rail dismiss is the same grey `X`. Check stays
  green Done.
- **Feature-entry toasts:** Contour / Extrude / Revolve / Loft / Sweep / Fillet /
  Chamfer open **without** an informational toast. Soft-fail / enterRefuse /
  validation / workplane-miss toasts stay.
- **Icons** are `lucide-react` only, with three vendored exceptions in
  `src/components/icons/`: `SquareRoundCorner.jsx` (Fillet), `Angle.jsx`
  (Draft) and `TrianglesCenterlineDashedVertical.jsx` (cross-section options).
  All three postdate lucide 0.469, which this project pins. Delete them and
  import from `lucide-react` once the dep moves.
  Overlay buttons carry `title` *and*
  `aria-label`; toggles carry `aria-pressed`. **No two buttons in the same rail
  share a glyph** — the right rail's selectors are deliberately distinct:
  `RectangleHorizontal` = Face pick, `Layers3` = plane overlays,
  `NotebookPen` = sketch (contour) overlays, `Spline` = Edge pick. In the left
  rail, Loft is `Pyramid` (a tapered stack of profiles), not `Layers`, and
  Fillet is `SquareRoundCorner` — so `Squircle` now means roundedBox alone.
  Chamfer is `TriangleRight`.
  **Two left-rail tools deliberately share a glyph with a right-rail toggle:**
  Create contour = `NotebookPen` (= sketch overlays) and Workplane = `Layers3`
  (= plane overlays). The tool that makes a thing wears the icon that shows it;
  the no-duplicates rule is per rail, so this is intended, not a slip.
- **Rail sections are Block / Model / Polish / Move**, in that order
  (`CAD_RAIL_ORDER` in `helperPaletteSnippets.js` for the order,
  `GROUP_SHORT_LABEL` in `HelperInsertPalette.jsx` for the captions). The
  internal group keys are still `Primitives` / `Advanced` / `Features` /
  `Transforms` — display names only. The order is the modelling order: make a
  shape, model it, polish it, move it.
- **Previews all share one recipe** (`src/utils/previewStyle.js`): unlit
  translucent cyan skin + brighter outline. **Never paint a preview with a lit
  material** — MeshLambert/MeshStandard take the scene lights, so faces angled
  away go dark, which is exactly the bug that made Extrude look muddy next to
  Loft. Add a preview → call `makePreviewSkinMaterial` /
  `makePreviewOutlineMaterial`.
- **`railHidden` items** are palette entries with no button:
  `paletteRailSections` filters them, `itemsByGroup` does not. `sweepPath`
  (Path) stays so Sweep can still compose an edge wire. `clearanceHole`,
  `tapDrillHole`, `cboreHole`, and `cskHole` stay so older scripts and goldens
  can still emit them, but the rail shows one Hole button: Type is clearance
  or tap drill, and c-bore / c-sink are the Near end and Far end dropdowns.
  `polarArray` stays the same way: one Array button whose Type param is Grid or
  Polar, and the `array3D` build delegates to `polarArray`'s for Polar.
  `holePattern` likewise: Hole's "n×m pattern" tick emits `holePattern()`.
  Hide a tool this way rather than deleting an item other code builds with.
- **The right rail is content-height**, not paired: it carries 10 tools (~422px)
  and the shared 26rem cap cropped the last one (Cross-section) off the bottom,
  where — being bottom-anchored 10px above the viewport edge — it was out of
  reach. It keeps `overflow-visible` plus a `max-h` that respects the pane.
- **The view-snap flyout must never `flex-wrap`.** It is absolutely positioned
  with only `right` set inside a ~36px-wide parent, so its shrink-to-fit width
  is near zero; wrapping collapses the row into a vertical stack. `w-max` +
  `flex-nowrap` keep it the horizontal row it is meant to be.
- **Rail height and rail scrolling are separate classes** (`utils/railPair.js`).
  Both rails share `RAIL_PAIR_HEIGHT_CLASS` so they match pixel-perfect; only
  the LEFT rails add `RAIL_SCROLL_CLASS`. The right rail takes
  `RAIL_NO_CLIP_CLASS` (`overflow-visible`) because the view-snap flyout is
  positioned **outside** the rail box (`absolute right-full`) — any `overflow`
  on that rail deletes the flyout from the screen and adds a scrollbar it does
  not need. Merging the two classes caused exactly that regression once.
- **Scrolling rails** carry `rail-scroll` alongside `overflow-y-auto`
  (`src/index.css`, bottom). Desktop Chrome's default gutter is square and cuts
  the corners off the rail's `rounded-lg` shell; `rail-scroll` gives a thin
  pill thumb over a transparent track, plus the Firefox equivalents. Add it to
  any new rail that scrolls.
- **Rail size is shared.** `HelperInsertPalette`, `ContourModeRail` and
  `CrossSectionPanel` all use 20px icons, `p-2` buttons and a `p-2` shell, in
  both shells. Left rails also share `RAIL_PAIR_WIDTH_CLASS` (`w-16`) so the
  Contour caption cannot widen ContourModeRail past the helper rail. If you
  change one, change all three (`golden:ui-polish` fails otherwise) and
  re-check the bottom-left chip insets that clear the left rail.
- **Test hooks** — golden smoke tests select by data attributes:
  `data-toolbar-variant`, `data-cad-toolbar-host`, `data-palette-layout`,
  `data-palette-section`, `data-selector-group`, `data-edge-selector`,
  `data-fillet-scrap`. Do not rename them without updating `scripts/golden/`.
- Chrome changes must be checked on **both shells and both modes**. Relevant
  goldens: `npm run golden:cad-mobile-chrome`, `golden:cad-palette`,
  `golden:polish-adv-ux`.
