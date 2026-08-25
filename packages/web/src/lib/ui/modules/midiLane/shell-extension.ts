// packages/web/src/lib/ui/modules/midiLane/shell-extension.ts
//
// The MIDI LANE shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `midiLaneDef.face.extension: 'midiLane'` declares this file; the id IS this
// directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AT ALL, WHEN TEN CONTROLS ARE CELLS. Exactly one affordance on
// this module cannot be a cell: the DEVICE ROSTER. It lives on the engine
// handle behind `requestMIDIAccess()`, it differs on every machine, and it
// changes when hardware is plugged in — so it is not a `ParamDef` and not an
// `options` roster either, since a roster is a fixed set known when the def is
// authored. That is the same constraint `CameraInputOutputBody` was built for,
// and this slot is the shipped answer to it.
//
// ⚠ AND IT IS *ONLY* THAT, PLUS THE LAMPS. Every control the face ranks —
// CONNECT, CH, MODE, NOTE, PRIO, RETRIG and the four CC gestures — is a real
// cell and none of them is duplicated here. A body that also carried them would
// be a second implementation of controls the face already owns.
//
// ⚠ MIDI LANE NEEDS NO STATUS REGISTRY, and the reason is worth stating because
// `cameraInput` needed one. Camera had to build a registry because promotion
// parks its real card in `<HeadlessSourceHost>` — mounted so the stream
// survives, `pointer-events: none` so nothing on it is clickable — and the body
// needs the card's own published state. midiLane is in NEITHER
// `DOM_SOURCE_LANE_TYPES` NOR `CARD_PRODUCER_LANE_TYPES`, so its card is not
// kept alive anywhere after promotion: the MIDI handler is installed
// engine-side through an identity-scoped claim in the factory, so this body
// talks to the engine directly and there is no second owner to coordinate with.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps the ranked cells, which is the half that matters
// there — and CONNECT, the gesture this module is dead without, is one of them.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MidiLaneDeviceBody from './MidiLaneDeviceBody.svelte';

export default {
  fullViewBody: MidiLaneDeviceBody,
} satisfies ShellExtension;
