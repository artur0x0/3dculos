# Joints — judgment calls

Artur asked for the recommended default on every open question, with no separate review. Each item below is that default. It is locked for the implementation. The pull request column is where the behavior lands.

The word is joints. Part scripts stay untouched. The file stays version 1.

| # | Call | Where |
| --- | --- | --- |
| 1 | File version stays 1. `joints` and `placement` are optional keys. Unknown keys are still rejected. | PR 1 |
| 2 | Omit `placement` when the quaternion is identity and no joint names the part. Always keep `position` equal to the translation. A pre-joints file stays byte-identical. `position` is written when `t` is not `[0, 0, 0]`, and also when a legacy row already stored `[0, 0, 0]`. `placement` is written when `q` is not identity, or when a joint names the part, including a grounded part at the origin. On load, a row with `position` and no `placement` is identity in memory (`partPlacement`). It is not rewritten until another edit saves. | PR 1 |
| 3 | The part key on a joint is the surf id only. Confirm is refused when the part has no surf id. A path is not stored on the joint. | PR 1 stores the surf id. PR 4 refuses confirm. |
| 4 | `fixed` is one reference: the part. No geometry key, no `value`, no `b`. The grounded pose is the row's placement at confirm. | PR 1 schema. PR 2 keeps that pose. PR 4 creates it. |
| 5 | Distance is two planar faces, forced parallel, with a signed gap in millimetres. The sign is `sense` (`1` or `-1`). Coincident is the opposed zero-gap joint. It is not distance 0. | PR 1 schema. PR 2 equations. PR 4 field. |
| 6 | Angle is degrees in the file and on the card. | PR 1 schema. PR 4 card. |
| 7 | Move Body has no special case. A move past the paint tolerance breaks the joint and keeps the last placement. The script is the only thing Move writes. | PR 4 |
| 8 | A conflict names the newest single joint whose removal makes the rest succeed. If none does, it names the newest, with "conflicts with more than one joint". Placements roll back to the last success. The write is all or nothing. The message is `Joint "<name>" conflicts`. | PR 2 names the joint and rolls back. PR 4 shows the message. |
| 9 | There is no hidden ground. The solver damps toward the current placement (the trust region starts at the current pose). | PR 2 |
| 10 | An ambiguous match is `broken`, the same as a missing reference, with a different sentence. The resolver does not pick the nearest. | PR 3 |
| 11 | Strip Undo uses the assembly history while `cadPartId` is null, and the part script history otherwise. Redo is session-only. Reload does not restore joint undo. The undo title distinguishes (`Undo joint` vs `Undo`). | PR 4 |
| 12 | The desktop and mobile CAD strips show joints. The script-stage strip stays on part features. | PR 4 |
| 13 | An empty click clears `cadPartId` and the geometric selection. It leaves `activeId`. | PR 4 |
| 14 | `fixed` is created from the type picker after one tap, or from a Ground control. The two-face flow never suggests it. | PR 4 |
| 15 | References on the same part are refused, except `fixed`. The message is `A joint needs two parts`. | PR 1 rejects it in the file. PR 4 shows the message. |
| 16 | A hidden part is still solved when its last success resolves. A failed run breaks the joint. The solver does not use a leftover mesh. | PR 3 |
| 17 | The rigid body is the part, not a body inside the part. | PR 2 and PR 3 |
| 18 | The joints solver is `solveResiduals`. It stays separate from the contour solver. SolveSpace is not used. The core does not import `src/joints/`. The contour solver is not an adapter of this core. | PR 2 owns the core. The contour solver stays its own. |
| 19 | Joints owe FEA a current `matrixWorld` and nothing else. They do not write `contacts`. Bonded contact keeps discovering pairs. If a study needs the `.surf.json` `placement` field without a live mesh, that change belongs to the FEA owner. `feaPartFrame` already copies `matrixWorld`. | PR 3 writes the pose onto the meshes. No FEA files change. |
| 20 | A cross-part Boolean whose either pose is rotated refuses the confirm and writes nothing. `externalBody` stays translational. | PR 3 |
| 21 | A failed part run marks every joint that names that part `broken`. The solver does not run against the leftover mesh. | PR 3 |
| 22 | Re-resolution keeps the confirmed key. The matcher absorbs the tolerance. The new centroid is not stored back into the joint. | PR 3 |
| 23 | Deleting a part drops every joint that names it. A broken joint is not left behind. | PR 1, in `serializeAssembly` |
| 24 | Copy to this assembly does not copy joints onto the new surf id. Same as colors. The dangling prune drops a joint whose surf id left. | PR 1 |
| 25 | Joint names are `Coincident 1` via `nextNumberedName`. The card can rename. The id stays the surf id from `mintSurfId`. | PR 4 mints and names. PR 1 stores the id and the name. |
| 26 | The pick-and-apply flow is shared with contour: sticky-pick 1–2 faces, lines, or points, then a suggested property, then Confirm. The joints card adopts the contour component (for example `StickyPickApply` and its hook) if that has merged. If it has not, the card uses that same contract so the two can be unified later. Which of those two shipped is logged on the UI pull request. | PR 4 |

Distance on the card uses the global display unit (`src/utils/displayUnit.js`). The file and the script stay millimetres. That field is PR 4.

The joint card leaves `fullLeft` off. It sits between the rails, like Measure.
