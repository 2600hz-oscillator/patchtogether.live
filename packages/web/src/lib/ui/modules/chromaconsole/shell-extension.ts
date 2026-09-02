// packages/web/src/lib/ui/modules/chromaconsole/shell-extension.ts
//
// The CHROMA CONSOLE shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `chromaconsoleDef.face.extension: 'chromaconsole'` declares this file; the id
// IS this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from here,
// which is what keeps `module-shell-import-guard` green.
//
// ── WHY A BODY, WHEN CONNECT AND PUSH ALL ARE CELLS ────────────────────────
//
// Three things on this module cannot be cells, and only three:
//
//   THE OUTPUT ROSTER — it lives on the engine handle behind
//     `requestMIDIAccess()`, differs per machine and changes when hardware is
//     plugged in, so it is neither a `ParamDef` nor an `options` roster (a
//     roster is a fixed set known when the def is authored). midiclock's
//     constraint, verbatim; `CameraInputOutputBody` was the first answer to it.
//   THE CHANNEL — a fixed roster, so it COULD be a `ShellSelectorCell`, and the
//     blocker is the other half of that interface: `value: (node) => …` is a
//     pure function of the NODE, and the channel lives on the device HANDLE, not
//     on the graph. A cell would paint a channel that never changed. (ptzcam
//     records the same finding for its port picker, from the async-grant side.)
//   THE EIGHT ASSIGNMENTS — `node.data.assign`, a per-NODE map over a 27-entry
//     grouped roster, plus the NAMES it gives the eight otherwise-identical
//     slot params. A cell caption is `ParamDef.label` with no node input
//     anywhere in the shell, so the names have no other home; the assignment
//     picker itself is a 27-row grouped `<select>` per slot, which is not a cell
//     shape at any rank.
//
// ⚠ AND IT IS *ONLY* THOSE. CONNECT and PUSH ALL are ranked `action` cells that
// reach the lane tile, and the eight slot VALUES are ranked knob cells; neither
// is duplicated here. A body that also carried them would be a second
// implementation of controls the face already owns — the drift the shared-body
// headers elsewhere in this tree keep arguing against. The board's chips are
// NAMES, not knobs, with one exception the body's own header explains (a slot
// assigned to a named-range selector, which cannot be an honest knob).
//
// ⚠ NO STATUS REGISTRY, UNLIKE cameraInput. Promotion parks no live card
// off-screen here: the MIDI transmitter, the ramp drain and the port listener
// all live in the module FACTORY (`createDeviceHandle`) and have always run with
// no surface mounted, so this body talks to the engine handle directly and there
// is no second owner to coordinate with. That is also why unmounting the dock
// pane costs nothing the module needs — the #1531/#1574/#1583 class does not
// reach a module whose resources are node-lifetime by construction.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps CONNECT, PUSH ALL and the first slots, which is the
// half that matters there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ChromaconsoleDeviceBody from './ChromaconsoleDeviceBody.svelte';

export default {
  fullViewBody: ChromaconsoleDeviceBody,
} satisfies ShellExtension;
