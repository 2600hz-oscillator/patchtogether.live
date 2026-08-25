// packages/web/src/lib/ui/modules/midiCvBuddy/shell-extension.ts
//
// The MIDI-CV-BUDDY shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `midiCvBuddyDef.face.extension: 'midiCvBuddy'` declares this file; the id IS
// this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AT ALL, WHEN ALL FOUR CONTROLS ARE CELLS. Exactly one thing on
// this module cannot be a cell: the DEVICE ROSTER. It lives on the engine
// handle behind `requestMIDIAccess()`, it is different on every machine, and it
// changes when hardware is plugged in — so it is not a `ParamDef` and not an
// `options` roster either, since a roster is a fixed set known when the def is
// authored. That is the same constraint `CameraInputOutputBody` was built for,
// and this slot is the shipped answer to it. The lamps ride along because the
// two readout rows the card painted have to go somewhere, and `StatusLed` is
// the only status surface a face may use.
//
// ⚠ AND IT IS *ONLY* THAT. CONNECT, CHANNEL, PRIORITY and RETRIGGER are all
// real ranked cells that reach the lane tile. None is duplicated here — a body
// that also carried them would be a second implementation of controls the face
// already owns.
//
// ⚠ UNLIKE cameraInput, THIS NEEDS NO STATUS REGISTRY. Camera had to build one
// because promotion parks its real card in `<HeadlessSourceHost>` — mounted so
// the stream survives, `pointer-events: none` so nothing on it is clickable —
// and the body needs the card's own published state. `midiCvBuddy` is in
// neither `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so its card
// is not kept alive at all: the MIDI handler is installed engine-side through
// an identity-scoped claim in the factory, so this body talks to the engine
// directly and there is no second owner to coordinate with.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps the four cells, which is the half that matters there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MidiCvBuddyDeviceBody from './MidiCvBuddyDeviceBody.svelte';

export default {
  fullViewBody: MidiCvBuddyDeviceBody,
} satisfies ShellExtension;
