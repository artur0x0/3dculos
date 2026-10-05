# Viewport popup style (contour / loft / fillet chips)

Mobile-first pattern for short-lived **mode chips** that sit over the 3D
viewport while the user picks geometry and tweaks params. Prefer this shell
over inventing a new modal layout.

## References

- **`ContourModeChip.jsx`** — cyan glass card; plane editor + profile / Extrude /
  Revolve / **Loft** / Sweep / **Workplane** sections. Loft (#94) and Workplane
  use the compact mobile max-height + internal scroll described below.
- **`FilletModeChip.jsx`** — amber glass card; same placement and scroll rules,
  edge-pick Accept / Back / grey X dismiss.
- **`ShellModeChip.jsx`** — cyan glass card (same shell as Contour / Loft /
  Workplane); face-pick opening + Wall `NumberField` + Face/Closed segmented
  control. Taps add faces with no modifier (tap a selected face to remove it,
  same as the edge picker). Undo drops the last face; Clear drops all.
  Confirm writes one `hollow()`; grey X exits with no write.
- **`DraftModeChip.jsx`** — cyan glass card (same shell as Shell); first tap
  is the neutral face (its normal is the pull), Flip reverses that normal,
  later taps are the faces to draft (tap again to remove). Undo drops only
  the last drafted face; Clear drops drafted faces and keeps the neutral.
  One angle, default 2°. Confirm writes one `draftFaces()`; grey X exits
  with no write. No shift-click.
- **`CutModeChip.jsx`** — cyan glass card (same shell as Shell). The plane is a
  planar face or an explicit XY / YZ / ZX plane. Offset is along that normal
  for both. A face is written as `{ center, normal }`, plus `offset` when it
  is not 0 — not a world-axis name. Bodies use the Shell sticky picker: tap
  to add, tap again to remove, Undo drops the last pick, Clear drops that
  list. Pieces shows each resulting body in its own slightly translucent
  color; tap hides that piece, tap again brings it back, Undo drops the last
  hide, Clear unhides every piece and keeps the plane. No shift-click.
  Confirm writes one `cut()`; grey X exits with no write.
- **`BooleanModeChip.jsx`** — cyan glass card (same shell as Cut). Union,
  Difference, or Intersect. Bodies use the Shell sticky picker: the first tap
  is the target, later taps are tools, tap again removes. Intersect opens
  Pieces: tap hides a leftover, tap again brings it back (the hidden piece
  stays in the scene at opacity 0 so it still hits). Undo and Clear follow
  Cut. No shift-click. Confirm writes one `booleanBodies()` for the active
  part and replaces a previous Boolean block; grey X exits with no write.
  The chip is not a scrim (`z-20`, `pointer-events-auto` on the card only).
  The cross-section panel stays at `z-40`, so section stays usable while
  picking. Hiding a part in the part manager does not clear that part's picks.
  `data-boolean-allow-section` and `data-boolean-survives-parts` mark that contract.
- **Contour Add / Subtract** — Extrude, Revolve, Sweep, and Loft (not Profile
  or Workplane) show Add and Subtract on `ContourModeChip` (`data-contour-combine`).
  Block solids use the same Mode select on the helper sheet. Default is Add.
- **`MoveModeChip.jsx`** — cyan glass card (same shell as Shell). Double-click
  selects the body (one click still selects the full face and does not change
  the target). XYZ are `NumberField` deltas, slider and type-in. Cut (when the
  previous operation is a cut) and Face (a picked face) take one distance along
  that normal. The body is previewed at the new translation until Confirm. No
  viewport arrows. Confirm writes one `move()` and replaces a previous Move
  block; grey X exits with no write.
- **`MoveFaceModeChip.jsx`** — cyan glass card (same shell as Shell). Tap adds a
  face, tap again removes it. Undo drops the last face. Clear drops the faces.
  Distance is along each face normal. Flip reverses that normal. No shift-click.
  A double click does not select the body. Confirm writes one `moveFace()` and
  replaces a previous Move Face block; grey X exits with no write. Live preview
  while the distance changes. This is not the body `move()` helper.
- **`DeleteFaceModeChip.jsx`** — cyan glass card (same shell as Shell). Tap adds a
  face, tap again removes it. The tap does not run `deleteFace`. Undo drops the
  last face. Clear drops the faces. No shift-click. A double click does not
  select the body. Confirm writes one `deleteFace()` for every picked face and
  replaces a previous Delete Face block; grey X exits with no write. A heal
  that cannot stay a closed solid throws when Confirm runs the script, not on
  the tap.

## Error toasts

Errors use this same glass card. They are not a blue rounded pill.

- **`ErrorPopup.jsx`** — `rounded-lg`, `surface-glass-chip`, and a tinted border
  (`border-red-400/70`, `border-amber-400/70`, or `border-cyan-400/70`).
- Undo stays on the card when there is history to pop.
- Soft-fail toasts are portaled at `fixed top-16 left-1/2 z-50` so they sit
  above the feature strip and the left rail.
- The execution-error toast is one card for every message: `fixed top-16
  inset-x-3 z-50` (most of the viewport width, the same card on desktop). It
  does not shrink to the text. The first line is the word `Error`, left
  justified, with Undo and the dismiss X right justified and a wider gap
  between those two controls. The description is the second line.

## Placement

| Context | Classes (chip root) |
| --- | --- |
| Desktop | `absolute bottom-2.5 left-1/2 -translate-x-1/2 max-w-[16rem]` (Loft / Sweep / Workplane may use `max-w-[18rem]`) |
| Mobile (`compact`) | `bottom-14 left-1/2 -translate-x-1/2 max-w-[min(16rem,calc(100%-9rem))]` — raised above the home-indicator stage pill; leave room for left/right rails |

Bottom-**centre** is reserved for mode chips. Bottom corners belong to the
helper / cross-section rails (`UI_MAP.md`).

## Chrome

- Tint + frost: `bg-cyan-950/80` (contour) or `bg-amber-950/80` (fillet) **plus**
  `surface-glass-chip` (frost only — supply your own tint).
- Border: `border border-cyan-400/70` / `border-amber-400/70`.
- Type: `text-xs` / `text-[13px]` controls; title in accent (`text-cyan-200`).
- z-index: `z-20` (with other overlays; see `UI_MAP.md` ladder).

## Mobile height + scroll

Keep the chip **below the feature strip** and leave finger clearance to pick
faces/edges in the viewport:

- Cap height: `max-h-[calc(100dvh-12rem)]` on the chip root (or scroll region).
- Put the long body in an inner `overflow-y-auto rail-scroll` region
  (`data-contour-chip-scroll` on Contour). Keep title + Confirm / Accept
  **outside** the scroll so actions stay visible.
- Prefer `flex flex-col min-h-0` on the root so the scroll child can shrink.

## Controls

- Numbers: **`NumberField`** from `src/components/controls/popupUI.jsx` — slider
  **and** typed box, one accent (`cyan` / `amber` / `slate`). Do not hand-roll
  `<input type="range">`.
- Segmented presets (X / Y / Z / Face, Out / In / Both): small rounded buttons
  with `aria-pressed`, active = filled accent, idle = `bg-*-950/80 border`.
- Selects: opaque `bg-*-950/80` (native option lists are not translucent).
- Primary action: accent **Confirm** / **Accept** with lucide `Check`.
- Cancel: grey lucide **X** on the left rail (`ContourModeRail`) and/or chip
  corner (`FilletModeChip` `onDismiss`). Cancel must exit **without** writing
  script.

## Behaviour contract

1. Enter mode from the left rail (do not dump a one-shot insert when an
   interactive chip exists).
2. Live preview in the viewport (workplane overlay, profile ghost, blend
   preview, …).
3. Confirm writes / updates the marked feature block and exits.
4. Grey X / Back dismisses with no write.

When adding a new tool, reuse this shell and `popupUI` rather than a slightly
different card.
