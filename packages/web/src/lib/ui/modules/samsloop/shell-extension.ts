// packages/web/src/lib/ui/modules/samsloop/shell-extension.ts
//
// The SAMSLOOP SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `samsloopDef.face.extension: 'samsloop'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a samsloop component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AND NOT A REGISTERED PANEL — the discriminator, stated on
// `wavecel` in `shell-cells.ts`, is whether the picture is DERIVED (from params
// and `node.data`, computable without a live read) or carries a PER-FRAME LIVE
// READ. Samsloop's waveform is BOTH, and the live half decides it:
//
//   * IDLE it is derived — the PCM is on `node.data` and the window is two
//     params. A panel could draw that.
//   * MID-TAKE it is not. The running peak bar lives in the record registry's
//     per-node CLOSURE (`node-samsloop-registry.svelte.ts`) and is published on
//     its own 20 Hz clock; there is nothing on the node for a panel to derive it
//     from, by deliberate design — a take commits ONCE, on stop, rather than
//     writing the Y.Doc every frame.
//   * And the PLAYHEAD is a third live read: the cursor is on the audio thread
//     and arrives through the handle's `playhead` key.
//
// ⚠ AND A PANEL COULD NOT HAVE SHIPPED ANYWAY, which is the sharper reason.
// `ShellPanelProbe` is REQUIRED and names a testid inside the panel to click or
// drag. This surface has no interactive affordance — the card's canvas has never
// had a pointer handler, and the window is edited by the two faders beside it.
// The honest options were a body or inventing a control the module does not
// have; `shell-cells.ts` refuses the latter by name ("a control that only
// relabels itself is indistinguishable from a dead one"). A `fullViewBody` has
// no probe requirement because it is a SLOT rather than a cell — the faces
// gates reach it through the dock VRT scenes instead.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface. ⚠ And the lane keeps NO picture at all — `hasVideoSurface`
// is `domain === 'video'` and this module is `domain: 'audio'`, so its tile
// paints its ranked cells and nothing else. The waveform is a dock surface by
// construction.
//
// ⚠ NO SCREEN ON/OFF SWITCH, by derivation rather than omission. The 2026-08-18
// fleet standard covers VIDEO defs and `video-face-screen-source.test.ts` runs
// over `STRICT_FACES ∩ video defs`; this is `domain: 'audio'`, so the gate does
// not reach it and no exemption entry is owed. The substantive reason is
// dockscope's: when the picture IS how you operate the module — you cannot place
// a loop point you cannot see — a switch that collapses it deletes the product
// instead of reclaiming space beside it.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import SamsloopOutputBody from './SamsloopOutputBody.svelte';

export default {
  fullViewBody: SamsloopOutputBody,
} satisfies ShellExtension;
