// packages/web/src/lib/ui/modules/launchpadControl/shell-extension.ts
//
// The LAUNCHPAD CONTROL shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `launchpadControlDef.face!.extension: 'launchpadControl'` declares this file;
// the id IS this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ── WHY A BODY, WHEN BOTH HANDSHAKES ARE CELLS ─────────────────────────────
//
// Two of this module's four affordances cannot be face cells, for reasons that
// are mechanical rather than aesthetic:
//
//   * BIND / UNBIND — one gesture with two names. `ShellActionCell.label` is a
//     plain `string`, not a function of the node (`shell-cells.ts`), so a cell
//     cannot say which of the two it is about to do; and the gesture is a NO-OP
//     until a clip-player exists, while an action cell has no `disabled`. A
//     ranked BIND would look alive and not be, in the state every fresh rack is
//     in.
//   * THE FOUR-ROLE VIEW SEGMENT — it exists only in SINGLE mode. A
//     `ShellSelectorCell` whose roster is empty in the other deployment is the
//     same defect one kind over.
//
// The body also carries the ERROR and EMPTY-STATE branches and the two lamps
// that absorbed the card's nine-branch status line — see
// `launchpad-binder-status-model.ts`, where every string it can produce is
// decided so a unit test can read the ones no baseline will ever show.
//
// ── AND NEVER `editorSurface`, EVEN THOUGH ITS DOC NAMES THIS MODULE ────────
//
// `shell-extensions.ts` describes `editorSurface` as the slot for "controls
// that are not cell-shaped at all (a clip arranger, A PAD MATRIX)", and this
// module drives an 8×8 pad matrix. It is still the wrong slot, twice over:
// the slot is DECLARED AND UNWIRED (`WIRED_SHELL_EXTENSION_SLOTS`) and its own
// note requires the first adopter to wire the ModuleShell render site in the
// same diff; and — the half that settles it — THERE IS NO PAD MATRIX TO PUT IN
// IT. The matrix is on the hardware. Nothing in this app has ever painted it
// (`grep -n "legend\|canvas" LaunchpadControlCard.svelte` → no match, since the
// LEFT+RIGHT consolidation moved the colour language to `LaunchpadDocs.svelte`),
// so nothing loses a surface by its absence and inventing one on a module PR
// would make a half-fidelity mirror the fleet's vocabulary by accident of being
// first.
//
// ⚠ UNLIKE cameraInput, THIS MODULE NEEDS NO CARD-STATUS REGISTRY. Camera had
// to build one because promotion parks its real card in `<HeadlessSourceHost>`
// — mounted so the stream survives, `pointer-events: none` so nothing on it is
// clickable. `launchpadControlLeft` is in NEITHER half of
// `HEADLESS_MOUNT_LANE_TYPES` (it owns no media element and its card pushes
// nothing into an engine handle), so its card is simply not mounted after
// promotion and there is no second owner to coordinate with. What DID have to
// move outside a component is the handshake OUTCOME, because a ranked cell is
// rendered by the shared shell — that store is in
// `$lib/ui/modules/launchpad-cell-actions.ts`, scoped the way the device
// singleton is scoped.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps the two handshake cells, which is the half that
// matters there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import LaunchpadBinderBody from './LaunchpadBinderBody.svelte';

export default {
  fullViewBody: LaunchpadBinderBody,
} satisfies ShellExtension;
