// packages/web/src/lib/ui/modules/gamepad/shell-extension.ts
//
// The GAMEPAD shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `gamepadDef.face.extension: 'gamepad'` declares this file; the id IS this
// directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ⚠ WHY A BODY, WHEN THE PICKER IS A CELL — the inverse of midiclock's note,
// and the difference is the whole reason this module was cheap to promote.
// midiclock's DEVICE ROSTER cannot be a cell (it lives behind
// `requestMIDIAccess()` and differs per machine), while its division is an
// ordinary param. Here it is the other way round: the SLOT is a `ParamDef` with
// a four-value `options` roster — the Gamepad API caps at four pads and indexes
// them 0..3, which is a fixed set known when the def was authored, exactly the
// condition a runtime roster fails — so it is a segmented cell that reaches the
// lane tile. What cannot be a cell is the MAPPING BOARD: twelve button LEDs, two
// trigger rows and two stick pads whose lit state IS the surface a remap is
// armed from, plus both calibrations, the four inverts and the save/load row.
//
// ⚠ AND IT IS *ONLY* THAT. The SLOT is not duplicated in the body. A second
// picker on the same plate would be one gesture with two affordances — clutter
// under "compact is the default", and a second thing to keep in sync.
//
// ⚠ NO STATUS REGISTRY, unlike cameraInput. Camera had to build one because
// promotion parks its real card in `<HeadlessSourceHost>` — mounted so the
// stream survives, `pointer-events: none` so nothing on it is clickable — and
// the body needs the card's own published state. `gamepad` is in neither
// `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so no card is kept
// alive anywhere: the poll that writes the eighteen outputs lives in the
// FACTORY and is node-lifetime already. A registry here would be a second owner
// of state the engine node owns.
//
// Dock-only by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry a module
// surface. The lane keeps the SLOT cell, which is the half that matters there —
// it is the only control on this module a player changes without watching the
// controller.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import GamepadMappingBody from './GamepadMappingBody.svelte';

export default {
  fullViewBody: GamepadMappingBody,
} satisfies ShellExtension;
