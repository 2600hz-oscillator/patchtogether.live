// packages/web/src/lib/ui/modules/loopback/shell-extension.ts
//
// The LOOPBACK SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `loopbackDef.face!.extension: 'loopback'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a loopback component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ FOUR OF LOOPBACK'S AFFORDANCES CAN NEVER BE FACE CELLS, and under the shell
// this body is the ONLY surface a player can reach any of them from:
//
//   * the ACQUIRE gesture — "START CAPTURE" / "RE-CAPTURE" — is an ACTION, not
//     a value. ⚠ AND IT IS THE WHOLE MODULE. `getDisplayMedia` needs a real
//     user gesture EVERY time: a display capture has no "already granted"
//     state, so unlike CAMERA there is no auto-acquire path that could carry a
//     returning visitor. Without this body a promoted LOOPBACK cannot be
//     started at all, by anyone, ever.
//   * the STOP gesture, same shape — and it cannot become a param instead.
//     `loopback.ts` is in the WebGL attest basis, so a new param costs a
//     real-GPU re-attest window; and a SYNCED param would let one collaborator
//     stop a capture that only exists in another person's browser.
//   * the capture LAMP reports a state NO param carries. ⚠ Not "no single
//     param" — none at all: `gain` and `crop` are the only two, and neither
//     moves when a capture starts, stops, is refused, or is ended from the
//     browser's own share bar. A graph-derived lamp here could not be merely
//     imprecise; it would have nothing to read.
//   * the RECOVERY TEXT is prose the card composes per failure mode.
//
// `ModuleShell`'s `controlCell` renders a `static` face cell as a dead dashed
// label by design, so there is no generic cell that could hold any of them. The
// extension is the last rung of the ladder and the only rung that fits.
//
// ⚠ WHY "THE CARD STILL HAS THOSE" IS NOT AN ANSWER. Promotion moves the real
// card into `<HeadlessSourceHost>`, which parks it at `left:-9999px` with
// `pointer-events: none`. The card is MOUNTED — that is what keeps the stream
// alive — but nothing on it is CLICKABLE. Keeping the source alive and keeping
// the module usable are two different problems, and only the first one had a
// mechanism before this face.
//
// ⚠ WHAT THIS BODY MUST NEVER DO: adopt the node-owned `<video>` element. See
// the header of `LoopbackOutputBody.svelte` — the card owns the stream, a DOM
// node has one parent, and adopting it here would kill the capture. On this
// module that is unrecoverable rather than merely bad: re-acquiring means a
// fresh user gesture and a fresh trip through the browser's picker. It must
// also never call `getDisplayMedia` itself: it drives the card's commands
// through `$lib/ui/media/loopback-status-registry`, so ownership stays in one
// place.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import LoopbackOutputBody from './LoopbackOutputBody.svelte';

export default {
  fullViewBody: LoopbackOutputBody,
} satisfies ShellExtension;
