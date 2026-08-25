// packages/web/src/lib/ui/modules/midiOutBuddy/shell-extension.ts
//
// The MIDI-OUT-BUDDY shell extension — the module-owned end of the extension
// seam (#1512), on the `fullViewBody` slot.
//
// `midiOutBuddyDef.face.extension: 'midiOutBuddy'` declares this file; the id
// IS this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AT ALL, WHEN BOTH CONTROLS ARE CELLS. Exactly one thing on this
// module cannot be a cell: the OUTPUT-PORT ROSTER. It lives on the engine
// handle behind `requestMIDIAccess()`, it is different on every machine, and it
// changes when hardware is plugged in — so it is not a `ParamDef` and not an
// `options` roster either, since a roster is a fixed set known when the def is
// authored. This is the same constraint the sibling module and `midiclock`
// both hit, and this slot is the shipped answer to it. The three lamps ride
// along because the card's NOTE readout and its violet CH-vs-LANE badge have to
// go somewhere, and `StatusLed` is the only status surface a face may use.
//
// ⚠ AND IT IS *ONLY* THAT. CONNECT and CHANNEL are real ranked cells that reach
// the lane tile; neither is duplicated here.
//
// ⚠ NO STATUS REGISTRY: `midiOutBuddy` is in neither `DOM_SOURCE_LANE_TYPES`
// nor `CARD_PRODUCER_LANE_TYPES`, so promotion parks no live card off-screen
// and the note sender lives on the engine handle. There is no second owner.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps the two cells, which is the half that matters there.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MidiOutBuddyDeviceBody from './MidiOutBuddyDeviceBody.svelte';

export default {
  fullViewBody: MidiOutBuddyDeviceBody,
} satisfies ShellExtension;
