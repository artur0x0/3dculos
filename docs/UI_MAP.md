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
┌───────────────────────────────┬───────────────────────────────┐
│ CodeEditor (w-1/2)            │ Viewport (w-1/2)              │
│ ┌───────────────────────────┐ │  top-right (lg) / top-center: │
│ │ mid-strip:   [Select All] │ │    Toolbar variant="overlay"  │
│ ├───────────────────────────┤ │    (collapsible)              │
│ │                           │ │                               │
│ │  Monaco (vs-dark, 12px)   │ │  left-4 bottom-4:             │
│ │                           │ │    HelperInsertPalette        │
│ │                           │ │    (or ContourModeRail)       │
│ ├───────────────────────────┤ │                               │
│ │ PromptInput (AI row)      │ │  right-4 bottom-4:            │
│ └───────────────────────────┘ │    CrossSectionPanel cluster  │
│                               │  left-16 bottom-4: info chips │
└───────────────────────────────┴───────────────────────────────┘
```

Desktop specifics:
- Toolbar floats **over** the viewport: top-right at `lg`, top-center below it
  (`src/components/Toolbar.jsx:332`). Collapses to a single chevron
  (`src/components/Toolbar.jsx:81`).
- Info chips (Selected Face, Edge pick, measurement readout) sit **bottom-left at
  `left-16 lg:left-[4.75rem]`** so they clear the helper rail
  (`src/components/Viewport.jsx:3704`, `:3868`, `:3961`).
- No title chip — the filename lives in the Toolbar.
- `PromptInput` is passed `isMobile={false}` explicitly (`src/App.jsx:1345`).

### Mobile shell (`src/App.jsx:1090`+) — stacked, viewport on top

```
┌─────────────────────────────────┐
│ Viewport (flex-1)               │  top-center: ViewportTitleChip
│   left-2 bottom-4: helper rail  │  (filename, or puzzle name)
│   right-2 bottom-4: cluster +   │  ← info chips move RIGHT here
│                     info chips  │
├─────────────────────────────────┤
│ mid-strip: [Toolbar strip]  [⌗] │  ← portal target
│ Monaco (16px font)              │  height = 32–38% of viewport
│ PromptInput (compact)           │  (36–42% when keyboard is open)
└─────────────────────────────────┘
```

Mobile specifics:
- **Editor budget** is computed at `src/App.jsx:1086-1088` (`mobileEditorPx`) as
  a clamped fraction of `visualViewport` height.
- **Keyboard handling:** `keyboardOverlap` / `keyboardOpen`
  (`src/App.jsx:1084-1085`). Closed → `h-dvh`. Open → the shell becomes
  `position: fixed` pinned to `visualViewport` (`mobileShellStyle`,
  `src/App.jsx:1094`). The comment there explains why: iOS refuses Monaco focus
  inside a fixed+overflow shell.
- **The Toolbar is portaled.** `CodeEditor` renders an empty host div
  (`src/components/CodeEditor.jsx:439`, `data-cad-toolbar-host`) and hands the
  node up via `onCadToolbarHost` → `cadToolbarHost` state (`src/App.jsx:75`) →
  down into `Viewport`, which `createPortal`s a `variant="strip"` Toolbar into it
  (`src/components/Viewport.jsx:3557`). So mobile CAD chrome is **rendered by
  Viewport but displayed in the editor header** — the most surprising wiring in
  the app, done so download/export busy state can stay in Viewport.
- The `CrossSectionPanel` cluster collapses to a **vertical** rail
  (`verticalRail={isMobile}`, `src/components/Viewport.jsx:3683`).
- Every overlay takes `compact={isMobile}` for tighter padding and icons.

---

## 2. Two app modes, orthogonal to the two shells

`appMode` (`src/App.jsx:60`) is `'cad'` or `'game'` (match-the-part puzzle).
That yields **four** layout combinations; check both flags when editing chrome.

| | `mode === 'cad'` | `mode === 'game'` |
| --- | --- | --- |
| Toolbar contents | account/open/upload/undo/save/download/quote/puzzle | back, undo/redo, run, picker, hint (`src/components/Toolbar.jsx:98`+) |
| Toolbar placement | overlay (desktop) / portaled strip (mobile) | strip inside CodeEditor, both shells |
| Title chip | mobile only (filename) | always (puzzle title) |
| Helper rail | `layout="cad"` — advanced tools folded into Model | `layout="game"` — keeps the Advanced group |
| Info chips | bottom-left on desktop | always bottom-right (dodges the palette) |
| PromptInput | shown | hidden (`appMode !== 'game'` guards) |
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
| top-right / top-center | Toolbar, desktop CAD | `Toolbar.jsx` `variant="overlay"` | `:3529` |
| *editor header* (portal) | Toolbar, mobile CAD | `Toolbar.jsx` `variant="strip"` | `:3557` |
| top-center | title chip | `ViewportTitleChip` (local, `:201`) | `:3588` |
| centered | "Match!" success banner | inline | `:3595` |
| left-2/4 bottom-4 | helper insert rail | `HelperInsertPalette.jsx:194` | `:3606` |
| left-2/4 bottom-4 | contour tool rail (replaces the helper rail) | `ContourModeRail.jsx:34` | `:3631` |
| right-2/4 bottom-4 | view / pick / cross-section cluster | `CrossSectionPanel.jsx:175` collapsed, `:327` expanded | `:3641` |
| inside that cluster | Front/Right/Top/Iso snap popup | `ViewSnapControl.jsx` | `CrossSectionPanel.jsx:180` |
| top-16 right-4 | execution error card | inline | `:3686` |
| bottom-left (desktop) / bottom-right | Selected Face readout | inline | `:3704` |
| bottom-4 right-2/4 | contour param chip | `ContourModeChip.jsx:176` | `:3733` |
| bottom-4 right-2/4 | fillet param chip | `FilletModeChip.jsx:43` | `:3835` |
| bottom-left / bottom-right | Edge-pick chip (`data-edge-selector`) | inline | `:3868` |
| top-16 center | toasts: edge-mode, contour, fillet-scrap, fillet | inline, four blocks | `:3924`, `:3932`, `:3940`, `:3952` |
| bottom-left | measurement readout | inline | `:3961` |
| fills the pane | WebGL canvas | `<canvas ref={canvasRef}>` | `:3985` |

**Mutual-exclusion rules.** The helper rail hides while `contourMode` or
`filletMode` is set; the Selected-Face chip hides during measurement or either
mode; the Edge-pick chip shows only when `pickMode === 'edge'` and no mode is
active. Break these and overlays stack on each other in the same corner.

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
| Helper params | any helper-rail button | `HelperParamModal.jsx` | also serves as the refuse/explain dialog |
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
Fillet / Chamfer: `src/utils/filletMode.js` + `FilletModeChip.jsx`;
enter/exit/accept at `src/components/Viewport.jsx:1476-1510`; kernels in
`src/utils/fillet*.js` and `src/utils/edgeSweepPath.js` — read
`.claude/skills/fillets/SKILL.md` first.
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
- **Responsive insets** are written `left-2 lg:left-4` / `right-2 lg:right-4`
  (phone-tight, desktop-roomy). Match this rather than inventing values.
- **z-index ladder:** overlays `z-10`; edge chip and success banner `z-20`;
  toasts `z-30`; modals and error banners `z-50`.
- **Icons** are `lucide-react` only. Overlay buttons carry `title` *and*
  `aria-label`; toggles carry `aria-pressed`.
- **Test hooks** — golden smoke tests select by data attributes:
  `data-toolbar-variant`, `data-cad-toolbar-host`, `data-palette-layout`,
  `data-palette-section`, `data-selector-group`, `data-edge-selector`,
  `data-fillet-scrap`. Do not rename them without updating `scripts/golden/`.
- Chrome changes must be checked on **both shells and both modes**. Relevant
  goldens: `npm run golden:cad-mobile-chrome`, `golden:cad-palette`,
  `golden:polish-adv-ux`.
