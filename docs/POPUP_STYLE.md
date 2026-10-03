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
