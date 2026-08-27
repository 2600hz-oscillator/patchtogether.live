// packages/web/src/lib/ui/modules/cameraInput/shell-extension.ts
//
// The CAMERA SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `cameraInputDef.face!.extension: 'cameraInput'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a camera component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS DOING MORE WORK HERE THAN ON ANY OTHER VIDEO FACE, and the
// reason is structural rather than stylistic. FOUR of CAMERA's affordances can
// never be face cells, and under the shell this body is the ONLY surface a
// player can reach any of them from:
//
//   * the DEVICE PICKER is `node.data.deviceId` populated from
//     `enumerateDevices()` at runtime — not a `ParamDef`, and not expressible as
//     an `options` roster either, because a roster is a fixed set known when the
//     def is authored and this one differs per machine and changes when hardware
//     is plugged in;
//   * the ACQUIRE gesture — "Request access" / "Retry" — is an ACTION, not a
//     value. It is also the only route to `getUserMedia` for a visitor this
//     origin has not granted before;
//   * the capture LAMP reports a state no single param carries; and
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
// the header of `CameraInputOutputBody.svelte` — the card owns the stream, a DOM
// node has one parent, and adopting it here would kill the capture. It must also
// never call `getUserMedia` itself: it drives the card's command through
// `$lib/ui/media/camera-status-registry`, so ownership stays in one place.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import CameraInputOutputBody from './CameraInputOutputBody.svelte';
import CameraInputTileBody from './CameraInputTileBody.svelte';

export default {
  fullViewBody: CameraInputOutputBody,
  // The LANE TILE's counterpart. Same controls, compact — the tile is where a
  // player most often meets this module, and until now it could do nothing
  // there but look at an empty thumbnail.
  tileBody: CameraInputTileBody,
} satisfies ShellExtension;
