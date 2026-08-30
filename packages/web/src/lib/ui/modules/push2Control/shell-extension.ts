// packages/web/src/lib/ui/modules/push2Control/shell-extension.ts
//
// The PUSH 2 CONTROL shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `push2ControlDef.face!.extension: 'push2Control'` declares this file; the id
// IS this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ── WHY A BODY, WHEN THE CONNECT GESTURE IS A CELL ─────────────────────────
//
// Four of this module's five gesture groups cannot be face cells, for reasons
// that are mechanical rather than aesthetic:
//
//   * BIND / UNBIND — one gesture with two names. `ShellActionCell.label` is a
//     plain `string` (`shell-cells.ts`), so a cell cannot say which of the two
//     it is about to do; and the gesture is a NO-OP until a clip-player exists,
//     while an action cell has no `disabled`. A ranked BIND would look alive
//     and not be, in the state every fresh rack is in.
//   * CONNECT DISPLAY — a SEPARATE WebUSB permission that is never required by
//     design (the def's header: the display "degrades to nothing"). An
//     unconditional cell that is inert on every browser without WebUSB is the
//     same defect one kind over.
//   * THE EIGHT-LANE SELECT and THE FOUR-ROLE VIEW SEGMENT — and here the
//     reason is REACTIVITY rather than the shape of the control, which is worth
//     stating precisely because the obvious answer is wrong. A
//     `ShellSelectorCell` is `options(node)` / `value(node)` / `onchange(nodeId,
//     value)`: plain functions that could perfectly well ignore their `node`
//     and read a module-scope rune. What they cannot do is NOTICE. ModuleShell
//     re-projects a cell from `liveCell`, which is keyed on `nodeVersion(id)` —
//     the node's Y.Doc revision — and this module writes to `node.data` ZERO
//     times (`mutateNode` and `setNodeParam` both appear 0× in
//     `push2-control.svelte.ts` and in the card; the selected lane is
//     `localStorage` and the rest is module-level runes). A selector cell would
//     therefore paint the position it held at mount and never move again: not
//     when this body changes it, not when the EIGHT BUTTONS ON THE HARDWARE
//     change it, not when a reload restores it from `localStorage`. A body is
//     an ordinary component and can subscribe to `statusRune()`, which is
//     exactly what the legacy card already did.
//     ⚠ AND THAT STATE PLACEMENT IS CORRECT, not a debt to pay later. Two
//     collaborators on one rack each have their own Push on their own lane, so
//     syncing `selectedChannel` would make one player's lane button move the
//     other player's hardware screen. The def and the control layer both say so
//     in their headers; this note records why a face cannot route around it.
//   * THE 960×160 REPLICA — a picture, not a control. It is not a `panel` cell
//     either: `ShellPanelProbe` is REQUIRED and names an element to click or
//     drag, and this canvas has never carried a pointer handler. A panel could
//     only have shipped by inventing a control the module does not have. A
//     `fullViewBody` needs no probe because it is a SLOT rather than a cell.
//
// The CONNECT gesture is NOT here, deliberately: it is the ranked action cell
// in the band below, which is what puts it on the lane tile. A second button on
// this plate would be one gesture with two affordances.
//
// ── AND NEVER `editorSurface` ──────────────────────────────────────────────
//
// `shell-extensions.ts` describes `editorSurface` as the slot for "controls
// that are not cell-shaped at all (a clip arranger, A PAD MATRIX)", and this
// module drives an 8×8 pad matrix. It is still the wrong slot, twice over: the
// slot is DECLARED AND UNWIRED (`WIRED_SHELL_EXTENSION_SLOTS`) and its own note
// requires the first adopter to wire the ModuleShell render site in the same
// diff; and — the half that settles it — THERE IS NO PAD MATRIX TO PUT IN IT.
// The matrix is on the hardware. What the app mirrors is the DISPLAY, and it
// mirrors it byte-for-byte through `pushDisplayOps()` rather than at half
// fidelity, which is why the replica is a picture in `fullViewBody` and not an
// invented editor.
//
// ⚠ THIS MODULE NEEDS NO CARD-STATUS REGISTRY. `cameraInput` had to build one
// because promotion parks its real card in `<HeadlessSourceHost>` — mounted so
// the stream survives, `pointer-events: none` so nothing on it is clickable.
// `push2Control` is in NEITHER half of `HEADLESS_MOUNT_LANE_TYPES`
// (`DOM_SOURCE_LANE_TYPES` ∪ `CARD_PRODUCER_LANE_TYPES`): it owns no media
// element, and its card pushes nothing into an engine handle — the display
// frames are packed and shipped by the push2-display singleton on its own
// keepalive, not by a card rAF loop. So its card is simply not mounted after
// promotion and there is no second owner to coordinate with. What DID have to
// move outside a component is the CONNECT outcome, because a ranked cell is
// rendered by the shared shell — that store is in
// `$lib/ui/modules/push2-cell-actions.ts`, scoped the way the device singleton
// is scoped.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface, and at 192 px the replica scales to 0.20× — eight coloured bars with
// no legible text, a picture that MISREPRESENTS the hardware, which is worse
// than no picture. The lane keeps the CONNECT cell, which is the half that
// matters there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import Push2SurfaceBody from './Push2SurfaceBody.svelte';

export default {
  fullViewBody: Push2SurfaceBody,
} satisfies ShellExtension;
