// packages/web/src/lib/ui/modules/cameraInput/shell-extension.ts
//
// The CAMERA SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `cameraInputDef.face.extension: 'cameraInput'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a camera component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS SLOT IS DOING MORE WORK HERE THAN ON ANY OTHER VIDEO FACE, and the
// reason is structural rather than stylistic. Two of CAMERA's affordances can
// NEVER be face cells:
//
//   * the DEVICE PICKER is `node.data.deviceId` populated from
//     `enumerateDevices()` at runtime — not a `ParamDef`, and not expressible as
//     an `options` roster either, because a roster is a fixed set known when the
//     def is authored and this one differs per machine and changes when hardware
//     is plugged in; and
//   * the capture LAMP reports graph state that no single param carries.
//
// `ModuleShell`'s `controlCell` renders a `static` face cell as a dead dashed
// label by design, so there is no generic cell that could hold either. The
// extension is the last rung of the ladder and the only rung that fits.
//
// ⚠ WHAT THIS BODY MUST NEVER DO: adopt the node-owned `<video>` element. See
// the header of `CameraInputOutputBody.svelte` — the card owns the stream, a DOM
// node has one parent, and adopting it here would kill the capture.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface. ⚠ And on THIS module the lane does not get a tile at all —
// `cameraInput` is in `NON_SHELL_LANE_TYPES`, so the lane keeps its real card,
// which is exactly what the 2026-08-23 owner directive asked for ("camera face
// and authored minimalist card").

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import CameraInputOutputBody from './CameraInputOutputBody.svelte';

export default {
  fullViewBody: CameraInputOutputBody,
} satisfies ShellExtension;
