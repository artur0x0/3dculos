---
name: navigate-project
description: "Where things are in SurfCAD — the two-shell (desktop/mobile) layout, every on-screen overlay and modal, and which file owns each feature. Load BEFORE hunting for a component, adding or moving any UI, or changing responsive behavior, so you edit the right shell and don't stack overlays. Also load when the UI map itself needs updating after a change. Triggers on: where is, which file, find the component, UI map, layout, shell, responsive, mobile, desktop, isMobile, breakpoint, toolbar, overlay, chip, toast, rail, palette, panel, modal, bottom sheet, z-index, viewport chrome, portal, cadToolbarHost, App.jsx, Viewport.jsx, add a button, move a control, new overlay, screen position, docs/UI_MAP.md."
---

# Navigating SurfCAD

The full screen-position map and feature→file index is **`docs/UI_MAP.md`**.
Read it before searching the tree; it is faster and more accurate than grep for
"where does X live".

This file is the operating procedure around that map: how to use it, and how to
keep it true as the code moves.

## The five facts that orient you

1. **One page, two panes.** No router. `src/main.jsx` → `App`. Left/top =
   Monaco (`CodeEditor.jsx`), right/bottom = Three.js (`Viewport.jsx`).
2. **Two separate shells, not one responsive tree.** `App.jsx` branches on
   `isMobile` (`matchMedia("(max-width: 768px)")`) and renders two independent
   JSX trees. **Any chrome change must be made in both**, or verified absent
   from one on purpose.
3. **Two modes on top of that.** `appMode` is `'cad'` or `'game'`. Four
   combinations. Check both flags.
4. **Mobile CAD chrome is portaled.** `Viewport` renders the strip Toolbar but
   `createPortal`s it into a host div inside `CodeEditor`'s header, via
   `cadToolbarHost` state in `App.jsx`. If a mobile toolbar button misbehaves,
   the code is in `Viewport.jsx`, not `CodeEditor.jsx`.
5. **Everything else on screen is an absolutely-positioned overlay inside
   `Viewport.jsx`,** or a `z-50` modal mounted from `App.jsx`.

## Working rules

- **Adding a control?** Put it where its family already lives: tool buttons on
  the left rail (`HelperInsertPalette.jsx`), view/pick toggles in the
  right cluster (`CrossSectionPanel.jsx`), file/account/commerce in
  `Toolbar.jsx`, per-mode params in that mode's chip.
- **Adding an overlay?** Pick a corner that is free *in all four*
  shell×mode combinations, and add the mutual-exclusion guard (see UI_MAP §3).
  The bottom-left/bottom-right swap on mobile is the usual trap.
- Copy the existing idiom rather than inventing one: `absolute … bg-white/60
  backdrop-blur-sm rounded-lg shadow-lg z-10`, insets as `left-2 lg:left-4`,
  `compact={isMobile}`, `lucide-react` icons, `title` + `aria-label`.
- Respect the z-ladder: overlays 10, edge chip/banner 20, toasts 30, modals 50.
- Never rename a `data-*` attribute without updating `scripts/golden/` — the
  smoke tests select by them.
- Verify chrome work with `npm run golden:cad-mobile-chrome`,
  `golden:cad-palette`, `golden:polish-adv-ux`, plus `npm run lint`.

## Companion docs

| Need | Read |
| --- | --- |
| Screen positions, feature→file index | `docs/UI_MAP.md` |
| Fillets / chamfers / blend kernels | `.claude/skills/fillets/SKILL.md` |
| Script API available to user code | `HELPER_FUNCTIONS.md` |
| The gate every PR must pass | `VALIDATION.md` |

---

# Self-maintenance

`docs/UI_MAP.md` cites **file paths and line numbers**, which rot. Treat the map
as code: whoever moves the UI updates the map in the same commit.

## When you must update the map

Update `docs/UI_MAP.md` in the same change if you:

- add, delete, rename, or **move** any component under `src/components/`;
- change where something sits on screen (position classes, insets, which corner,
  which shell, which mode);
- add or remove a modal, overlay, chip, rail, toast, or panel;
- change `isMobile` / breakpoint / `visualViewport` / keyboard logic in
  `App.jsx`;
- change the portal wiring (`cadToolbarHost`, `onCadToolbarHost`);
- add or change a mode (`appMode`, `pickMode`, `contourMode`, `filletMode`) in a
  way that shows or hides chrome;
- add, remove, or rename a `data-*` test hook, an API route, or a `utils/`
  module that owns a feature listed in §5;
- shift the z-index ladder or the overlay styling idiom.

Also refresh the ASCII diagrams in §1 when the pane split or stacking order
changes — a wrong picture misleads faster than missing prose.

## Drift check (run it before trusting the map)

Line numbers are the fragile part. Confirm the anchors still point at what the
map claims, from the repo root:

```bash
# Shell branch points and mobile layout math
grep -n "const \[isMobile\|matchMedia(\"(max-width\|keyboardOverlap\|mobileEditorPx\|if (isMobile)" src/App.jsx
# Portal wiring, both ends
grep -n "cadToolbarHost\|onCadToolbarHost\|createPortal\|data-cad-toolbar-host" src/App.jsx src/components/Viewport.jsx src/components/CodeEditor.jsx
# Every overlay render site, in order
grep -n "ViewportTitleChip\|<Toolbar\|HelperInsertPalette\|ContourModeRail\|CrossSectionPanel\|ContourModeChip\|FilletModeChip\|edgeModeToast\|data-edge-selector\|canvas ref" src/components/Viewport.jsx
# Positioning classes — catches a moved corner even when line numbers hold
grep -rn "absolute \(top\|bottom\|left\|right\)\|left-16\|lg:left-\[4.75rem\]\|verticalRail\|compact={isMobile}" src/components/*.jsx
# Inventory drift: components and utils the map should list
ls src/components src/components/order src/utils
# Test hooks and routes the map names
grep -rno "data-[a-z-]*=" src/components | sort -u
ls backend/routes
```

Then reconcile: every cited `file:line` should land on the construct named in
the map, and every component/util/route on disk should appear somewhere in §3–§5.
Fix what moved; delete what is gone; add what is new.

Cheap heuristic for staleness: if `git log --oneline -1 -- docs/UI_MAP.md` is
older than the newest commit touching `src/App.jsx` or `src/components/`, assume
drift and run the check.

## How to edit the map

- Keep the five sections and their order: shells → modes → overlay inventory →
  modals → feature index → conventions.
- Keep it a **map, not a tutorial**. One line per item, pointing at code. Detail
  belongs in the code's own comments or a `docs/` deep-dive.
- Prefer a stable anchor to a bare number: name the function, component, or
  attribute alongside the line (`HelperInsertPalette.jsx:194`) so a reader can
  re-find it with grep after the number rots.
- If the app grows a genuinely new surface (a second route, a settings screen, a
  dashboard), add a sixth section rather than stretching §3.
- When this skill's own trigger list stops matching how the UI is described, add
  the new vocabulary to the `description` frontmatter — an unloaded skill helps
  nobody.
