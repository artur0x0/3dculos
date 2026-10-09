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
│                            │ ║ │  top-center: [part] in [asm] │
│ ┌────────────────────────┐ │ ║ │  under title: FeatureStrip   │
│ │ mid-strip: [Toolbar]   │ │ ║ │    (horizontal CAD bar)      │
│ ├────────────────────────┤ │ ║ │  left: HelperInsertPalette   │
│ │ Monaco (vs-dark, 12px) │ │ ║ │  right: CrossSection cluster │
│ ├────────────────────────┤ │ ║ │  info chips bottom-left      │
│ │ PromptInput (hidden)   │ │ ║ │  profile chip top-right      │
│ └────────────────────────┘ │ ║ │                              │
└────────────────────────────┴───┴──────────────────────────────┘
  Parts feed sits left of the CAD view. The script editor is a right drawer, closed
  by default. Desktop hides its profile chip.
```

- **Default CAD layout:** the parts feed and the viewport. Monaco is mounted but hidden (`data-script-editor-open="false"`).
- **Pencil** (`data-part-edit-script`) on each part row, blue, same size as the eye. It activates that part if needed and opens Monaco for it only.
- **Desktop drawer** (`data-script-drawer-side="right"`): under the feature ribbon (`top: 8rem`), inset so the left rail stays clear, drag the left edge to resize, Escape or Back closes it.
- **Phone sheet** (`data-script-sheet`, 390px): full-screen over the home pill, Back to CAD (`data-script-editor-close`). A stored Script stage is not restored on load.
- **Temporary tray** (`data-cad-io-tray`, viewport top-left) while the editor is closed: Upload, Download, Order, puzzle. Run, Select all, Undo, and Redo are not in that tray.

**The seam between the two panes is draggable** in both shells
(`SplitDivider.jsx`, pointer-capture based): left/right on desktop
(`splitPct`, clamped 20-80%), up/down on mobile (`mobileEditorPxOverride`,
clamped so neither pane collapses; an open keyboard still overrides it).

**The AI prompt row is hidden, not deleted** — `PromptInput` stays mounted
behind `hidden` + `data-ai-prompt-row="hidden"` in both shells while a tighter
editor integration is designed. Remove the `hidden` class to bring it back.

**The CAD title reads "part in assembly".** Part name, the word in, then the
assembly name (`data-viewer-title`, `data-title-in`, `data-viewer-title-text`).
Example: part1 in Assembly. The assembly name is the document `name`. A new
assembly starts as Assembly, then Assembly (1), Assembly (2) when that name
is taken. A copy, import, or colliding rename uses the part rule (`Name`, or
`Name (2)` when `Name` is taken). The repo folder is `assemblies/<Name>/`;
on the GitHub Contents API a space in that name is `%20` and parentheses are
left as-is. A blank or whitespace name is saved as Assembly when the document
is loaded. A custom name already saved is kept. A file name is used only
when the saved document has none. Both chips rename in place: click, then an
input. Enter or blur commits, Escape reverts, empty commits nothing. Part
names are sanitised
(`sanitizePartName`) because they end up in `${name}.js` downloads. The part
chip is `onRenameFile` → `setCurrentFilename`. The assembly chip is
`onRenameAssembly` → the document `name`. Game keeps a single puzzle-name
chip. A signed-in, GitHub-connected reload shows the last opened assembly.
Signed out, both chips are absent (`data-viewer-title-empty`, `showCadTitle`
off); reload does not load or create `Part (1)` in `Assembly`. Signed in
without a usable GitHub token reopens a real cached assembly read-only, or
shows an empty reconnect prompt. It does not plant the demo.

Desktop specifics:
- **Feature strip (desktop CAD viewer):** `FeatureStrip.jsx` mounts as a
  **horizontal** bar on the CAD viewport under the title
  (`data-desktop-feature-strip`, `data-cad-feature-strip="desktop"`,
  `data-feature-strip-placement="viewer-under-title-horizontal"`). Same chip
  set as mobile CAD. A sheet-metal chip uses the blue bent-plate glyph
  (`SheetMetalPlate`, `text-blue-400`), the same plate as the Shape rail.
  Tap jumps the Monaco caret and reopens the creation dialog
  for that feature (`handleDesktopFeatureStripJump` → `beginFeatureEdit`). The old vertical seam strip
  between editor and viewer is gone. Hidden in game mode. SplitDivider sits
  directly between editor and viewer.
- **Profile chip:** desktop (above the 768px mobile breakpoint) shows only
  the CAD viewport chip, top-right. Mobile shows that chip plus one on the
  Parts ribbon and one on the Script toolbar (same `ProfileChip`). Signed-out
  = grey User icon; signed-in and GitHub-connected = green initials. Signed in
  without a GitHub token = grey initials plus an exclamation badge
  (`data-profile-badge="reauth"`). Tap spins, tries a quiet refresh, then a
  silent GitHub popup; **Reconnect** is the full-page flow after that fails.
  Open follows the same phase and does not open local files in that state.
  Other features call `useAuthState()` (`src/hooks/useAuthState.js`): `signedIn`
  is that live session, `githubConnected` is the vault.
  The account menu includes
  **Clear local cache** (`data-clear-cache`), which opens the confirm popup
  (`data-clear-cache-dialog`) and warns about unpushed outbox entries and
  unsynced parts. GitHub Sign-in uses the runtime Client ID cache from
  `/api/config`.
- **The Toolbar is portaled into the editor mid-strip, exactly like mobile.**
  There is no floating overlay bar and no collapse chevron for CAD any more;
  `Toolbar.jsx` renders only the dark `variant="strip"` markup for CAD.
- Both viewport rails are **vertical** in this shell too (`verticalRail` is passed
  unconditionally), and both use the same size as each other: 20px icons,
  `p-2` buttons, `p-2` shell.
- Info chips (Selected Face, Edge pick, measurement readout) sit **bottom-left at
  `left-[4.5rem] lg:left-[5.25rem]`** so they clear the helper rail
  (`src/components/Viewport.jsx:3682`, `:3848`, `:3937`).
- CAD title is the same "part in assembly" line as mobile. No toolbar carries it.
- **Parts feed:** the same list as the mobile Parts stage, mounted to the left
  of the editor (`data-parts-feed-placement="desktop-left"`). The assembly
  name sits in the middle of the ribbon (`data-parts-ribbon-center`).
  Signed out (local, no GitHub token), the **+** menu (`data-part-add-dropdown`)
  and the folder menu (`data-part-open-dropdown`) both offer **Part** and
  **Assembly**. Part opens the name dialog and creates a local-only part
  (bare id, no repo path) — the same `startNewPart` path as a signed-in local
  part. Folder → Assembly still opens a `.json` file. Git mode folder → Part
  still opens the repo part list.
  On mobile the profile chip is right-justified in `data-parts-ribbon-end`;
  desktop leaves that slot empty. Each row thumbnail
  (`data-part-thumbnail`, `data-part-preview="manifold"`) is a cached snapshot
  of that part's solid. No solid is `data-part-preview="empty"`. Delete asks
  first; Cancel keeps the part, Confirm removes that part only. In git mode,
  **Open from repo** (folder): **Part** lists every part in the repo grouped
  by source assembly (loose `parts/` included); **Assembly** lists assemblies
  only. Picking one opens **Open assembly?** (`OpenAssemblyChoiceDialog`,
  `data-git-dialog="open-choice"`). **Cancel**, **Insert parts into current**,
  and **Open assembly** sit on one right-aligned row
  (`data-git-open-choice-stage`, no wrap) down to a 375px phone; the blue
  **Open assembly** button stays the primary. The folder Assembly list and
  the git open search both use that dialog. Each assembly row has a trash
  control (`data-assembly-delete`, the same gray trash as a branch row).
  It opens **Delete assembly?** (`data-git-dialog="delete-assembly"`): the
  assembly name, its part count, and **These parts are used elsewhere and
  will be kept in /parts** when another assembly references a part (part
  name and those assemblies). **Delete assembly, keep parts** is the
  primary: it deletes the folder and leaves `parts/` files in place, and an
  assembly-local copy moves into `parts/`. **Delete assembly and its parts**
  is the danger button and stays disabled until the name is typed. It removes
  a script only when no other assembly cites it (`parts[].id`, a path when the
  id is missing, or `groups[].partIds`, including the open document and this
  branch's queued outbox). A cited copy moves into `parts/`. Cancel leaves
  the assembly. While the dialog says Checking parts
  (`data-git-dialog-loading`), a small border spinner
  (`data-assembly-delete-checking-spinner`, the same `border-b-2 animate-spin`
  ring as the assembly-open spinner, 16px) sits under that line and leaves
  when the check finishes. While the delete runs, the clicked button shows a spinner
  (`data-assembly-delete-spinner`) and keeps its width. Both delete buttons
  and Cancel stay disabled, the scrim and Escape do not dismiss, and a
  second tap does not start another delete. Success closes the popup. A
  failure leaves it open with the message in `data-assembly-delete-error`
  and enables the buttons again. That wait includes the local IndexedDB
  update and the queued git sync. An assembly that is still opening
  (`assemblyOpenLockRef`) refuses the delete until that open finishes. Folder →
  Assembly and the open search share that list on desktop and on the phone.
  Live search is `data-git-open-search` / `filterVaultOpenIndex`; empty
  query shows the full list, no hits show *No matches*. Vault files,
  groups, and delete semantics are [`vault-schema.md`](vault-schema.md).
  A part from this
  assembly, and a part in `parts/`, opens by reference. A part from another assembly's folder
  links in (`links from …`). The row then shows **Caution: external part!**
  (`data-part-external`) and **Copy to this assembly**
  (`data-part-copy-to-assembly`). Parts inserted from another assembly sit
  under a group row (`data-part-group`, `data-part-group-row`): chevron
  (`data-part-group-chevron`), name, and count (`data-part-group-count`).
  Expanded parts are indented under a vertical thread
  (`data-part-group-thread`). Collapse stays in this list. The overflow
  button (`data-part-group-menu`) and a 450ms long-press open the same menu
  (`data-part-group-actions`): **Rename** (inline,
  `data-part-group-name-input`), **Ungroup**, **Copy all to this assembly**,
  **Remove group** (confirm `data-part-group-remove-dialog`; linked parts
  are unlinked, not deleted from the repo). Grouped part rows keep the
  caution label and the same select, rename, and delete controls. The gray subtitle under the name
  (`data-part-subtitle`) is the repo path, or the path Add to Repo would write (`parts/<Name>.js`). It never
  shows a `local:` id. Add to Repo (`data-part-add-to-repo`) shows when `isSynced` is false, and when the flag
  is unset and the row id is not a repo path. Text inputs on Parts/git
  use `partsChrome.js` `PARTS_TEXT_INPUT_CLASS` (≥16px) to block iOS Safari focus-zoom.
  Git create, Save, rename, copy, and delete show `data-part-pending` spinner in place of the Save icon while that branch's outbox op is queued or sending. A failed sync shows a red mark (`data-part-sync-failed`). A failed rename or assembly delete shows a toast with Retry and Revert (`data-rename-toast`). The delete popup also keeps that failure inline (`data-assembly-delete-error`) until the user retries or cancels. A moved remote tip opens the conflict popup and does not overwrite.
- `PromptInput` is passed `isMobile={false}` explicitly (`src/App.jsx:1345`).

### Mobile shell (`src/App.jsx` mobile branch) — CAD stages + game stack

**CAD (Slice Mobile A + B + C):** dual stage, not a cramped split. Default = CAD stage.
Toggle is session-sticky (`sessionStorage` key `3dculos.mobileStage`). Slice B
replaced the top text chrome with a bottom home-indicator pill + Script feature strip.
Slice C adds CAD-stage feature sheets (default edit path without Monaco).

```
CAD stage                          Script stage
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ [part] in [assembly]        │   ││feat│ mid-strip: Toolbar    │
│ [Undo | features… | Redo]   │   ││strip mid: Monaco (full)   │
│ Viewport + rails            │   ││icons PromptInput (hidden) │
│ feature sheet (glass)       │   ││vert  (viewport mounted)   │
│                             │   ││      pager icons          │
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
- **Page zoom lock:** a pinch in the CAD view zooms the camera, not the browser page (iOS Safari and the installed PWA). Viewport meta locks scale (`maximum-scale=1`, `user-scalable=no`; `viewport-fit=cover` stays). The canvas and the right rail are `touch-action: none`; the left rail is `pan-y` so the tool list still scrolls; buttons are `manipulation` so a double-tap does not zoom. Off-canvas two-finger moves and Safari `gesture*` events are cancelled. One-finger scroll in Parts, Script, and scrolling popups stays. Inputs stay ≥16px so focus does not zoom.
- **Stage toggle (Slice Mobile B):** `MobileStageToggle.jsx` is a bottom-centered
  iPhone Home Screen–style glass pill (`data-mobile-stage-home-indicator`,
  `data-home-indicator-pill`) with three Lucide icons: CAD (`Box`), Parts
  (`LayoutList`), Script (`square-text`). Tap a third to switch stage.
  Desktop has no mode toggle. The parts list sits left of the CAD view. The script
  editor is closed until the pencil or Edit script opens the right-hand drawer.
  The Parts stage is the part list, including group rows and the thread
  (same markup as desktop). Each row shows the same cached solid
  snapshot as desktop. Delete asks first. Confirm removes that part only
  (its script, its row, and its solid). Cancel leaves it. Folder → Assembly
  uses the same Open assembly list and **Delete assembly?** dialog as desktop.
  The ribbon centers
  the assembly name (Assembly when the document has none) and keeps Local or
  Git on the right. Mobile also keeps a profile chip on the Parts ribbon and
  the Script toolbar; desktop keeps only the CAD viewer chip. **Clear local
  cache** is on that chip's account menu.
  Session-sticky via `3dculos.mobileStage`.
  Top CAD|Script text chrome is gone. Inert `data-ai-prompt-hook` marks a
  future AI-on-tap site (not wired). Contour/Fillet chips use `bottom-14` on
  mobile so they clear the pill. Shell exposes `data-mobile-stage="cad"|"script"`.
- **Feature strip (Slice Mobile B → B.1 → C → C.1 → C.4 + UI polish):** `FeatureStrip.jsx`.
  **Script stage:** vertical right rail (`data-feature-strip-side="right"`), starting
  below the top ribbon. Icon chips **jump caret only** (`handleFeatureStripJump`
  → `revealRange`; no FeatureSheet). Rail scroll uses `rail-scroll` and auto-scrolls
  to the **last** chip when the feature list grows.
  **CAD stage (mobile feature bar):** full width of its row (`inset-x-0`, strip
  `w-full`, `data-feature-bar-row="full"`, `data-feature-bar-layout="undo-features-redo"`).
  Three sections: fixed **Undo** at the start (`data-feature-bar-section="undo"`),
  a middle section (`data-feature-bar-section="features"`, `px-3` on both sides so
  chips do not collide with the history buttons), and fixed **Redo** at the end
  (`data-feature-bar-section="redo"`). While the chips fit they are centered in
  the middle (`justify-center`, `data-feature-bar-window="fit"`). When they
  overflow, the visible window is the **tail** (`data-feature-bar-window="tail"`):
  the latest chips stay on screen and earlier ones sit outside that window.
  Undo and Redo stay visible, call the same `handleUndo` / `handleRedo` as the
  editor toolbar, and do not change which chips appear. Strip taps / long-press
  reopen that feature's **creation dialog** (same path on mobile and desktop).
  Sheet-metal chips use `SheetMetalPlate` (blue), same as desktop.
  `hideWhenEmpty` skips the "No features" caption;
  the bar itself stays mounted so Undo and Redo remain. A chip whose block holds a
  frozen copy of another part's geometry (`externalBody`) has a 2px yellow border
  (`data-feature-external="1"`), active or not; its feature sheet says External copy.
  Chip highlight (`featureStripActiveId`)
  clears on sheet cancel/accept/delete (and after script jump). C.4+: Script-stage
  editor stack is full-bleed (`absolute inset-0`) so the top ribbon
  (`data-editor-ribbon`, `w-full`) spans the viewport; the vertical strip overlays
  `right-0` with `top: ribbonPx` (`data-feature-strip-ribbon-spacer-h="measured"`),
  `z-20`, and Monaco uses `pr-11` so chips stay below the ribbon without covering code.
  Per-type index badges (`data-feature-type-badge`,
  1…n per kind) sit bottom-right on each icon. The horizontal bar pads its
  scroller, so those badges stay inside the strip on mobile and desktop.
  Icons match the CAD toolbar
  (Contour/`NotebookPen`, Extrude/`ArrowUpFromLine`, Revolve/`Rotate3d`,
  Loft/`Pyramid`, Sweep/`Route`, Fillet/`SquareRoundCorner`,
  Chamfer/`TriangleRight`). Markers from `parseFeatureMarkers` (`typeIndex`).
  Desktop's strip is the horizontal bar under the title (see Desktop
  specifics above); mobile CAD/Script mounts stay as documented here.
- **Feature sheets (Slice Mobile C → C.1):** `FeatureSheet.jsx` — full-width
  **horizontal** glass bar just below the part name (`top-14`,
  `data-feature-sheet-layout="under-title-horizontal"`) on **CAD and Script**
  stages. Caps at `max-h-[calc(100dvh-10rem)]` with internal `rail-scroll` so
  mobile popups stay below the feature strip with finger clearance for viewport
  picks (Contour/Fillet chips use `max-h-[calc(100dvh-12rem)]` similarly).
  Horizontal scroll when params overflow. The CAD strip, the desktop strip, and
  long-press reopen the **creation dialog** for that feature (`beginFeatureEdit`),
  pre-filled from the block. Confirm rewrites that block in place
  (`confirmFeatureEdit`); Cancel writes nothing. The red Delete button sits
  opposite Confirm. Delete removes that one block and rebuilds immediately.
  When a later feature uses this feature's edges, faces, or variables, a
  toast names it and offers Undo. No dependents means no toast. Undo restores
  the script in one step. A stored
  edge or face the
  prefix graph cannot resolve stays listed (`N edges not found`) with Clear.
  The under-title `FeatureSheet` remains for a failed-chip read and for kinds
  with no creation dialog. Accept / Cancel / Edit script / Delete stay on that
  sheet. Desktop/game do not mount it (`featureSheetEnabled` false).
- **Viewport backdrop:** `viewport-shell` + Three.js clear/background use Monaco
  gray `#1e1e1e` (not Tailwind `gray-900` / `#111827`).
- **Face description popup:** removed in Slice Mobile C.1 (was under-title B.1
  `data-face-info-popup`). Selection still drives the left palette / PromptInput;
  no empty reserved band.
- **Edge-pick chip (C.1):** horizontally centered + raised
  (`left-1/2 -translate-x-1/2`, `bottom-20` mobile / `bottom-14` desktop) so it
  clears the right rail and home-indicator / CAD|Script dots. Buttons: Tangent / Undo / Clear. Undo removes the last selected edge only.
- **Left ↔ right rail height (C.1 → content-max):** helper / contour left rail
  uses the same bottom inset as the right cluster (`bottom-2.5`) and
  `max-h-[min(26rem,calc(100%-5.5rem))]` (shared `RAIL_PAIR_HEIGHT_CLASS`) —
  content-height up to just below the part-name chip; scrolls when the window
  is too short; when buttons fit, width yields to `w-14` (`data-rail-fit`).
  Edge-pick **Tangent on** (C.3): seed-plane G1 + same-face parallel bridge so a
  `roundedBox` top rim floods the full coherent loop (not 1 leftover segment).
  C.4: `buildCoherentEdges` traces tagged vs untagged sharp pools separately so
  post-fillet rounded rails (untagged open arcs) stay pickable for Tangent-on.
  Overflow scrolls inside (`data-rail-pair="left"|"right"`).
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
| Toolbar contents | **run + select-all** (green run first, own section) then open/upload/undo/save/download/quote/puzzle (Account moved to viewport profile chip, G9) | back, undo/redo, run, picker, hint (`src/components/Toolbar.jsx`) |
| Toolbar placement | portaled strip above the editor, both shells | strip inside CodeEditor, both shells |
| Title chip | always (filename) | always (puzzle title) |
| Helper rail | `layout="cad"` — Block, Build, Shape, Polish, Move | `layout="game"` — the same five sections |
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
| top-center | CAD: part, the word in, assembly. Game: puzzle name | `data-viewer-title` / `ViewportTitleChip` | Viewport |
| bottom, centered in the gap between the rails (same card as Shell; `bottom-14` on a phone) | Paint popup: 8 swatches (grid padded so the selection ring is not clipped), custom `#rrggbb`, Part, Undo, Clear, Remove unmatched colors, Confirm, Cancel. A tap paints the face immediately. Double-tap paints that body. Confirm saves the session. X and Cancel revert it | `PaintModeChip` `data-paint-mode` | Viewport |
| centered | "Match!" success banner | inline | `:3595` |
| left-2/4 bottom-2.5 | helper insert rail (height paired to right). Block, Build, Shape, Polish, Move. Shape includes Sheet Metal (blue plate with a bent flange, `data-sheet-metal-button`) with the other shape tools | `HelperInsertPalette.jsx` | Viewport |
| left-2/4 bottom-2.5 | contour tool rail (replaces the helper rail) | `ContourModeRail.jsx` | Viewport |
| left-2/4 bottom-2.5 | sheet-metal rail (replaces the helper rail while `sheetMetalMode`): **Shape** section, SCS tools for the SKU, Tab first, ✕ exit | `sheetMetal/SheetMetalRail.jsx` | Viewport |
| bottom, centered in the gap between the measured side rails (22rem cap on desktop; full gap on a phone). Material line truncates, hint wraps. Does not cover either toolbar | sheet-metal chip: bound SKU + step hint, **Check & Export** (edit), ✕ exits | `sheetMetal/SheetMetalModeChip.jsx` | Viewport |
| bottom sheet `z-50` | Sheet Metal picker: material + gauge (out-of-stock gauges disabled, “out of stock”), Start designing | `sheetMetal/SheetMetalPicker.jsx` | Viewport |
| bottom sheet `z-50` | Base flange popup: X / Y, mm\|in toggle, Back, Accept, ✕ | `sheetMetal/SheetMetalFlow.jsx` | Viewport |
| bottom sheet `z-50` (short) | Bend popup: Angle, Flange length, Flip, R·K·BD, Back / Accept / Delete, ✕ | `sheetMetal/SheetMetalFlow.jsx` | Viewport |
| bottom sheet `z-50` (short) | Tab popup (Width, Depth, Centered, Offset) / Hole popup (Ø or Thread, Csk Ø, U, V) | `sheetMetal/SheetMetalFlow.jsx` | Viewport |
| bottom sheet `z-50` | Check & Export popup: DFM fails (red) / warnings (amber) in the mm\|in display unit, Download DXF, Download STEP, Order on SendCutSend (opens the app; all disabled on a hard fail), ✕ | `sheetMetal/SheetMetalFlow.jsx` | Viewport |
| scene | plane quads / sheet preview / bendable-edge lines (2.5px core, opacity 0.65; undrawn pick box; taps route here first) | `utils/sheetMetal/sheetOverlay.js` | Viewport |
| right-2/4 bottom-4 | view / pick / paint / inspection cluster. Paint (`data-paint-chip`) is in the plane and contour group, green only while paint mode is on, hidden in game | `CrossSectionPanel.jsx` collapsed rail | Viewport |
| inside that cluster | Front/Right/Top/**Iso** snap popup | `ViewSnapControl.jsx` | `CrossSectionPanel.jsx:181` |
| top-16, portaled `z-50`, `inset-x-3` (most of the viewport width, same card on desktop) | execution error toast: fixed card, label "Error", Undo and dismiss on the right, description on the next line (`ErrorPopup` `layout="stacked"`), glass `rounded-lg` | `ErrorPopup.jsx` | Viewport |
| centered on the viewport pane (desktop) and the phone shell | assembly-open spinner: ring + `Opening <name>…`, optional `part 3 of 7`. Hidden for the first 150ms. `pointer-events-none`, `z-[45]`, under the toasts | `AssemblyOpenSpinner.jsx` `data-assembly-open-spinner` | App |
| *(removed C.1)* | Selected Face readout | — | — |
| bottom-4 right-2/4 | contour param chip | `ContourModeChip.jsx:176` | `:3733` |
| bottom-4 right-2/4 | fillet param chip | `FilletModeChip.jsx:43` | `:3835` |
| bottom-center (raised) | Edge-pick chip (`data-edge-selector`): Tangent / Undo / Clear | inline | Viewport |
| top-16 center, portaled `z-50` | toasts: edge-mode, contour, fillet-scrap, fillet, shell — same `ErrorPopup` card | `ErrorPopup.jsx` | Viewport |
| bottom-left | measurement readout | inline | `:3961` |
| fills the pane | WebGL canvas | `<canvas ref={canvasRef}>` | `:3985` |

The canvas draws a face-color skin on top of a part when that assembly has `colors` (`src/utils/faceColorSkin.js`). The skin is under crease lines and pick highlights. `?debugFaces=1` or `localStorage` key `surfcad.debugFaces` = `1` paints each face patch a different color. The flag is off unless set, and it is not a rail button. The right rail has no patch-colour toggle.

**Paint.** The paint button is on the right rail and is CAD-only. A tap paints that face immediately on the skin, in the selected color. There is no selection step. A second tap on the same face within 300 ms paints every face of that body and stays one undo entry. Part paints the whole part (`colors[surfId].part`), which is every body, so it stays next to double-tap. Confirm writes the session once through the assembly save (local document, and one git outbox op in Git mode) and closes. X, Cancel, and Esc revert every paint from this session and write nothing. Undo steps back one paint. Clear restores the colors from when the popup opened. The swatch grid is padded so the selection ring stays inside the scroller. Game mode hides the button. The helper rail hides while the popup is open, same as Shell.

**Opening an assembly.** `data-assembly-open-spinner` sits centered over the
viewport (the viewport pane on desktop, the full shell on a phone) while a
document loads. Paths: the Open assembly dialog (Cancel, Insert parts into
current, and Open assembly on one right-aligned row), the folder menu's Assembly
action, git open search, a branch switch, and the initial restore of the last
assembly. The wait is the `.surf.json` and part-script fetch (IndexedDB
cache-first, and GitHub when the vault is open; see [`vault-schema.md`](vault-schema.md)) plus the worker build that
refresh paints. The label is `Opening <name>…` (`data-assembly-open-label`).
While a part is in flight it also reads `part 3 of 7`
(`data-assembly-open-progress`). The ring is the same border spinner as the
boot loader. It stays hidden for 150ms so a fast open does not flash, and it
clears on success, failure, or cancel. Silence for 45s clears it and shows
the failure toast (`data-assembly-open-toast`, same `ErrorPopup` card) with
Retry (`data-assembly-open-retry`). The overlay does not take clicks
(`pointer-events-none`, `z-[45]`), so those toasts (`z-50`) stay usable.
`prefers-reduced-motion` stops the ring (`data-assembly-open-ring`).

**Mutual-exclusion rules.** The helper rail hides while `contourMode`,
`filletMode`, or paint mode is set (and the other feature modes); the Edge-pick chip needs `pickMode === 'edge'`, no active mode, **and at
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
| Login | Profile chip → Sign in (signed out / guest) | `LoginModal.jsx` / `ProfileChip.jsx` | `/api/auth/login`, `/register` |
| Account | Viewport profile chip (signed in) | `AccountModal.jsx` / `ProfileChip.jsx` | tabs `info` / `orders` |
| Quote | Toolbar → Truck | `QuoteModal.jsx` | process / material / infill → `utils/quoting.js` |
| Order | Quote → Order | `OrderModal.jsx` + `components/order/*` | six steps, `STEPS` at `OrderModal.jsx:13`: Auth → Address → Shipping → Payment → Confirmation → Convert |
| Helper params | any helper-rail button | `HelperParamModal.jsx` | **not** a full-screen modal: docks bottom-centre *of the viewport* (`absolute inset-0`, click-through overlay, no scrim) so the rails and the live preview stay visible and usable. No click-outside-to-cancel — X / Cancel only. Also serves as the refuse/explain dialog |
| Puzzle picker | Toolbar → List (game) | `PuzzlePickerModal.jsx` | |
| Hints | Toolbar → BookOpen (game) | `GameHintsModal.jsx` | |
| Terms | order flow | `TermsModal.jsx` | |
| Confetti | puzzle win | `GameConfetti.jsx` | full-viewport canvas, not a modal |

Error banners (`gameError`, `uploadError`) and viewport soft-fail / scrap /
execution cards all use `ErrorPopup.jsx` (always includes an **Undo** button
wired to App undo history). App banners sit at `absolute top-4 left-1/2 …
z-50`, duplicated in both shells.

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
One face tap is the PartGraph patch (`src/utils/partGraphPatches.js`). A fillet
band is the G1 chain: the walk crosses separate fillet calls when the dihedral
is within both gates, and it stops at a flat, the loft, a hole, a chamfer, or
a crease above the gate.
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
edge-pick chip; both commit path sweeps — Fillet → `filletAlongPath`,
Chamfer → `filletAlongPath({ profile: 'chamfer' })`). Chip: Tangent / Clear / Undo / Accept. Undo undoes the last edge pick only; X / Escape / dismiss without Accept clears all picks and exits; no hard-edge warning; no
strategy helper line; Accept row spaced below Clear/Undo.
Enter/exit/accept at `src/components/Viewport.jsx` `enterFilletMode` /
`acceptFillet`. Disjoint edge picks split via `splitEdgePathComponents` and
Accept emits one `makeSweepPath` + `filletAlongPath` pair per contiguous
component inside the same mode markers (connected chains unchanged).
Kernels in `src/utils/fillet*.js` and
`src/utils/edgeSweepPath.js` — read `.claude/skills/fillets/SKILL.md` first.
A Create-contour Confirm on a script with no `part` writes a plane literal
and does not insert the starter cube, so the following Extrude is
`let part = placeInFrame`, the same shape as Workplane-then-Extrude.
Both modes share the shape: tool rail on the left, param chip on the right,
commit writes script text back through `App.jsx`.
Sheet metal (SendCutSend): left rail **Shape** → Sheet Metal (no separate
Sheet section) → `SheetMetalPicker`. Start designing binds the SKU on the
open part (`part.sheetMetal`). A fresh part (empty or the 20 mm starter cube)
gets the default base flange (`sheetStarterScript` → `sheetMetalSolid`, Top
plane, SKU thickness) and enters `sheetMetalMode` still on the plane step.
A part that already has features stays put: Start does not rewrite it and
does not create `Sheet (n)`. Plane Accept appends one sheet block
(`part = part.add(sheetMetalSolid(sheetSpec))`, chosen plane, SKU thickness)
after the existing blocks. `Sheet (n)` is created only when no part is open.
The rail then lists
Tab / Bend / Hole / Tap under **Shape**. The chip (material, hint, Check &
Export) is centered in the measured gap between the side rails. An mm|in
toggle on the popups is display only (stored mm, preference in localStorage).
Out-of-stock gauges stay visible and disabled. Catalog/cache in `src/utils/scs/`.
The committed script is the sheet block plus `return part;`. The worker and
`runScript` unwrap a sheet wrapper (`solid` + spec or flat pattern) and still
reject any other non-Manifold.

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
- **Inserting a solid merges with the part.** Add unions. Subtract cuts. Every build that creates a
  new solid — the six Block solids and Extrude / Revolve / Loft / Sweep — goes
  through `emitPartPlace(names, expr, partDeclared, true, op)`, which emits
  `part = part.add(expr)` when a part already exists and Mode is Add, and
  `part = part.subtract(expr)` when Mode is Subtract. `let part = expr` is
  still the first solid, including Subtract on an empty script. Default Mode
  is Add. Emitting a bare `part = <newSolid>` strands whatever was there as
  dead code; that was a real bug in all six Block solids until it was fixed.
  A Block pop previews that solid before Confirm (flat normal shading, the CAD mesh). Position and rotation are fields on the sheet; Subtract keeps the cutter translucent. Cancel clears the preview.
  Sweep's one-shot fallback stays a replace when Mode is Add. Mutating
  an existing body (holes, shell, transforms, Boolean) is different — that keeps
  `syncPartLines`, which points `part` at the body you edited.
- **Mode-chip popup style** (placement, cyan/amber glass, mobile
  `max-h-[calc(100dvh-12rem)]` + `rail-scroll`, Confirm/X): see
  [`docs/POPUP_STYLE.md`](./POPUP_STYLE.md). References: `ContourModeChip` (incl.
  Loft / Workplane), `FilletModeChip`, `ShellModeChip` (face-pick opening —
  not axis X/Y/Z), `DraftModeChip` (neutral-plane draft, not a world-axis guess),
  `CutModeChip` (plane cut — a face plane or an explicit XY/YZ/ZX, offset along
  the normal, Shell sticky picker for bodies and pieces, one `cut()`),
  `BooleanModeChip` (Union / Difference / Intersect, same sticky body picker,
  Intersect pieces, one `booleanBodies()`; picks may span parts and tools from
  another part are copied into the target). Contour Extrude / Revolve / Sweep /
  Loft and every Block solid share an Add / Subtract mode on that same feature.
  Subtract also cuts every other visible part the cutter overlaps (a yellow
  chip on each of those parts).
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
  banners `z-50`. Error cards (`ErrorPopup`) are the glass `rounded-lg` chip
  from `POPUP_STYLE.md`, not a rounded pill. They are portaled to `document.body`
  at `z-50` so the full message sits above the feature strip and the left rail. Cross-section popup **Dismiss** is a grey lucide `X` (not the
  red FlipHorizontal); the collapsed rail still uses FlipHorizontal to
  enable/disable. Contour-mode rail dismiss is the same grey `X`. Check stays
  green Done.
- **Feature-entry toasts:** Contour / Extrude / Revolve / Loft / Sweep / Fillet /
  Chamfer / Shell open **without** an informational toast. Soft-fail / enterRefuse /
  validation / workplane-miss toasts stay.
- **Icons** are `lucide-react` only, with vendored exceptions in
  `src/components/icons/`: `SquareRoundCorner.jsx` (Fillet), `Angle.jsx`
  (Draft), `TrianglesCenterlineDashedVertical.jsx` (cross-section options),
  and `SquareText.jsx` (Script pager). They postdate lucide 0.469, which this
  project pins. Delete them and import from `lucide-react` once the dep moves.
  `SheetMetalPlate.jsx` is the bent-plate glyph (not a lucide icon). The Shape
  rail and every sheet-metal feature badge use it.
  Overlay buttons carry `title` *and*
  `aria-label`; toggles carry `aria-pressed`. **No two buttons in the same rail
  share a glyph** — the right rail's selectors are deliberately distinct:
  `RectangleHorizontal` = Face pick, `Layers3` = plane overlays,
  `NotebookPen` = sketch (contour) overlays, `Spline` = Edge pick,
  `Palette` = Paint. In the left
  rail, Sheet Metal is `SheetMetalPlate` (a plate with a bend line and a bent flange, Shape, after Loft, same blue as the other rail icons; feature badges use the same glyph in `text-blue-400`), Loft is `Pyramid` (a tapered stack of profiles), not `Layers`, and
  Fillet is `SquareRoundCorner` — so `Squircle` now means roundedBox alone.
  Chamfer is `TriangleRight`.
  **Two left-rail tools deliberately share a glyph with a right-rail toggle:**
  Create contour = `NotebookPen` (= sketch overlays) and Workplane = `Layers3`
  (= plane overlays). The tool that makes a thing wears the icon that shows it;
  the no-duplicates rule is per rail, so this is intended, not a slip.
- **Rail sections are Block / Build / Shape / Polish / Move**, in that order
  (`CAD_RAIL_ORDER` in `helperPaletteSnippets.js` for the order,
  `GROUP_SHORT_LABEL` in `HelperInsertPalette.jsx` for the captions). Shape is
  the old Model section, same buttons. Build is hole, cut, boolean, shell, draft,
  pattern. Boolean (`RectangleCircle`, lucide `rectangle-circle`, vendored in `icons/`) is the body boolean: Union, Difference, or
  Intersect, then leftover pieces on Intersect. It is not a second glyph of Cut.
  Polish is fillet, chamfer, move face, delete face. Move is every
  remaining button. The first button in Move is Move (`Move` glyph, directly
  above Center): it opens the delta X/Y/Z chip and translates one body. Move
  Face (`SquareArrowOutUpRight`) offsets the picked faces along their normals.
  Delete Face (`SquareX`) is the next Polish button: a tap only adds or removes
  a face. Confirm writes one `deleteFace()` for every picked face. A heal that
  cannot stay a closed solid throws on Confirm, not on the tap.
  The right-rail axis helper (`Move3d`) only
  shows the `AxesHelper`. It does not move a body and it does not grow
  viewport arrows.
- **Previews all share one recipe** (`src/utils/previewStyle.js`): unlit
  translucent cyan skin + brighter outline. **Never paint a preview with a lit
  material** — MeshLambert/MeshStandard take the scene lights, so faces angled
  away go dark, which is exactly the bug that made Extrude look muddy next to
  Loft. Add a preview → call `makePreviewSkinMaterial` /
  `makePreviewOutlineMaterial`.
  Sheet-metal parts are the exception: faces are light gray brushed metal
  (`#c8ccd2`, both sides), not the normal material. Bendable edges are unlit
  screen-space lines (2.5 CSS px core, opacity 0.65, 5px halo at 0.16) on top.
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
- **The right rail is content-height**, not paired: view-snap then zoom-to-fit (`Maximize2`) at the top, then Face, Edge, plane overlays, contour overlays, and Paint, then a divider, then the XYZ triad (`Move3d` / `AxesHelper`), measure, and cross-section. There is no patch-colour toggle. The green Lucide `Frame` (`#` / auto-fit-on-run) was removed — it duplicated zoom-to-fit. A shared 26rem cap used to crop Cross-section off the bottom,
  where — being bottom-anchored 10px above the viewport edge — it was out of
  reach. It keeps `overflow-visible` plus a `max-h` that respects the pane.
- **The view-snap flyout must never `flex-wrap`.** It is absolutely positioned
  with only `right` set inside a ~36px-wide parent, so its shrink-to-fit width
  is near zero; wrapping collapses the row into a vertical stack. `w-max` +
  `flex-nowrap` keep it the horizontal row it is meant to be.
- **Rail height and rail scrolling are separate classes** (`utils/railPair.js`).
  Left rails share `RAIL_PAIR_HEIGHT_CLASS` as a **max-height** (content-sized,
  capped just below the part name); only the LEFT rails add `RAIL_SCROLL_CLASS`.
  When buttons fit without scroll, `useLeftRailFit` switches to
  `RAIL_PAIR_WIDTH_FIT_CLASS` (`w-14`). The right rail takes
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
