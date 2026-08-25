// packages/web/src/lib/ui/modules/outToLaunch/shell-extension.ts
//
// The OUT TO LAUNCH shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `outToLaunchDef.face!.extension: 'outToLaunch'` declares this file; the id IS
// this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from here,
// which is what keeps `module-shell-import-guard` green.
//
// ── WHY A BODY, WHEN THE CONNECT GESTURE IS A CELL ─────────────────────────
//
// This module has FOUR gesture groups. One is ranked; the other three cannot be
// cells, for reasons that are mechanical rather than aesthetic:
//
//   * CONNECT LAUNCHPAD → RANKED, not here. It is the ranked `action` cell in
//     the band below, which is what puts it on the lane tile. See
//     `out-to-launch-cell-actions.ts` for why the ranked half is the PRIVILEGED
//     half (a gesture-gated, per-origin Web MIDI sysex grant) even though —
//     unlike the three ranked CONNECT cells before it — it does not itself
//     complete a binding.
//   * THE PORT PICKER → BODY. The roster is enumerated from the MACHINE, so it
//     is not a `ParamDef`'s `options` (a def roster is fixed when the def is
//     authored, and this one differs per machine). Nor can it be a
//     `ShellSelectorCell`: ModuleShell re-projects a cell's `value(node)` from
//     `liveCell`, keyed on `nodeVersion(id)` — the node's Y.Doc revision — and
//     `bindMonitor` writes to `node.data` ZERO times by design (the claim lives
//     in the device layer's node-keyed `monitors` map, so that one map
//     arbitrates across BOTH consumers and two maps cannot disagree about who
//     owns a physical surface). A selector cell would paint the roster it held
//     at mount and never move again — not when this body binds, not when a
//     Launchpad is unplugged.
//   * UNBIND → BODY. One control with two OPPOSITE actions to CONNECT's, and
//     `ShellActionCell.label` is a plain `string`, so a cell could not say which
//     it is about to do. It is also a no-op until something is bound — the state
//     every fresh rack is in — and an action cell has no `disabled`. A ranked
//     UNBIND would be a control that looks alive and is not.
//   * THE 9x9 PICTURE → BODY. A picture, not a control. It is not a `panel`
//     cell either: `ShellPanelProbe` is REQUIRED and names an element to click
//     or drag, and this canvas has never carried a pointer handler, so a panel
//     could only have shipped by inventing a control the module does not have.
//     A `fullViewBody` needs no probe because it is a SLOT rather than a cell.
//
// ⚠ THIS MODULE NEEDS NO CARD-STATUS REGISTRY. `cameraInput` had to build one
// because promotion parks its real card in `<HeadlessSourceHost>` — mounted so
// the stream survives, `pointer-events: none` so nothing on it is clickable.
// `outToLaunch` is in NEITHER half of `HEADLESS_MOUNT_LANE_TYPES`
// (`DOM_SOURCE_LANE_TYPES` ∪ `CARD_PRODUCER_LANE_TYPES`), and the reason is
// #1728's fix rather than an accident: it owns no media element, and its card
// stopped being the LED producer when the 30 fps pump moved onto the NODE
// (`node-launchpad-monitor-registry`). So its card is simply not mounted after
// promotion and there is no second owner to coordinate with. What DID have to
// move outside a component is the CONNECT outcome and the port roster, because
// a ranked cell is rendered by the shared shell — that store is
// `$lib/ui/modules/out-to-launch-cell-actions.ts`.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps CONNECT plus the generic video thumbnail, which is
// the half that matters there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import OutToLaunchMonitorBody from './OutToLaunchMonitorBody.svelte';

export default {
  fullViewBody: OutToLaunchMonitorBody,
} satisfies ShellExtension;
