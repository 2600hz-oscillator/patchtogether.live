// packages/web/src/lib/ui/modules/ptzcam/shell-extension.ts
//
// The PTZCAM shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `ptzcamDef.face.extension: 'ptzcam'` declares this file; the id IS this
// directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AT ALL, WHEN CONNECT IS A CELL — the midiclock answer, with one
// more item on the list. Three things on this module cannot be cells:
//
//   1. THE CAMERA ROSTER. `listPtzOutputNames()` reads the app's live sysex
//      MIDI access, is empty until a grant, and changes when the helper starts
//      or a camera is plugged in. A `ShellSelectorCell.options` is a pure
//      function of the NODE, so it would be evaluated against a roster that did
//      not exist yet and stay stale across the async grant.
//   2. THE LINK STATE. Nine distinct binding kinds with nine distinct
//      sentences, several of which are the only instruction in the product for
//      getting the helper running.
//   3. THE PER-AXIS MODE. Whether each axis is absolute or velocity is reported
//      by the CAMERA in the caps handshake — it is not a setting, it is a fact
//      about hardware that is not in the rack, and it decides what every knob
//      on the face MEANS.
//
// ⚠ NO STATUS REGISTRY, for midiclock's reason rather than cameraInput's. The
// sysex send loop lives in the module FACTORY, on the scheduler tick, so it runs
// with no surface mounted and promotion parks no live card off-screen. This body
// talks to the engine handle directly and there is no second owner to
// coordinate with. It is also why `SCREEN`-style collapse semantics do not
// arise: there is no producer here that a hidden surface could stop.
//
// ⚠ NO `tileBody`. The 192 px lane tile already carries the CONNECT cell (an
// `action` cell is not dock-restricted) plus PAN and TILT at the compact tier,
// which is the half that matters where the module is met. The roster picker is
// a `<select>` over machine-specific device names and the axis lamps are
// meaningful only after a handshake — neither survives 192 px, and cameraInput's
// tileBody exists because its module had NO route to a first acquire without
// one. This one does.
//
// Dock-only by `dockFullViewHeadPlan`, exactly like midiclock's.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PtzcamDeviceBody from './PtzcamDeviceBody.svelte';

export default {
  fullViewBody: PtzcamDeviceBody,
} satisfies ShellExtension;
