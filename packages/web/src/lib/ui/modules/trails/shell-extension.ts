// packages/web/src/lib/ui/modules/trails/shell-extension.ts
//
// The TRAILS SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on BOTH wired body slots.
//
// `trailsDef.face!.extension: 'trails'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a trails component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AT ALL, WHEN CONNECT IS A CELL — midiclock's and ptzcam's answer
// with a different second item. Two things on this module cannot be cells:
//
//   1. THE PAD MIRROR. It is live transient state read off the engine handle at
//      rAF — up to four touch points and their 48-point fading trails in the
//      pad's own 0..1 coordinates — with NO param behind it. No `ParamCellKind`
//      mounts a canvas, and it is deliberately NOT an `xyPads` cell: a declared
//      pad names the two params its axes DRIVE, and these axes drive nothing,
//      they report (trails.ts:596-603).
//   2. MON. A live readout of the raw MIDI the device is sending INCLUDING the
//      frames this module's decoder rejected. Its subject is a USB device
//      outside the rack, it is `<pre>`-formatted to be selected and pasted, and
//      it is the only affordance in the product that can falsify
//      `trails-decode.ts`'s wire constants against real hardware.
//
// ⚠ WHY THE MIRROR IS A BODY AND NOT THE `glyph` SLOT — the question this
// module invites more than any other adopter, because the mirror is exactly the
// picture a glyph would want. The `glyph` slot takes `{ num, numbers, testid }`
// and is scaled by viewBox alone into a `.topo-glyph` plate AND a ~26 px picker
// cell: it is a DATA-DERIVED IDENTITY picture bound to a topology param. The
// mirror is bound to no param at all. The slots are not interchangeable and the
// honest one is `tileBody`.
//
// ⚠ BOTH SLOTS, AND THE TWO ARE COUNTERPARTS RATHER THAN SIBLINGS. ModuleShell
// gates the tile slot on `!extBody`, so exactly one of them paints per shell
// instance — but a lane tile and an open dock pane for the SAME node are two
// instances mounted at once, which is why the tile is READ-ONLY (a mirror with a
// pointer handler would be two surfaces over one gesture, and read-only is what
// makes it honest as a mirror in the first place) and why the two bodies
// namespace their testids (`trails-face-*` / `trails-tile-*`).
//
// ⚠ AND THEY SHARE ONE MIRROR COMPONENT BY CONSTRUCTION, not by agreement.
// `face-rack-status-source`'s roster is structurally blind to a `tileBody`
// (its own blind-spot list), so the `picture` role is proven of the dock body
// alone; mounting the SAME `TrailsPadMirror.svelte` in both is what makes the
// proof carry to the tile. The audioIn argument.
//
// ⚠ NO STATUS REGISTRY AND NO PARKED CARD. `trails` appears in no
// `NON_SHELL_LANE_TYPES`, `CARD_PRODUCER_LANE_TYPES`, `DOM_SOURCE_LANE_TYPES` or
// `HEADLESS_MOUNT_LANE_TYPES` set, so promotion parks no live card off-screen
// and there is no second owner to coordinate with. The MIDI subscription, the
// decoder, the monitor and every `ConstantSource` live in the FACTORY and run
// with no UI mounted — which is also why no SCREEN switch arises: there is no
// producer here a hidden surface could stop, and the paint loop already
// self-suppresses on its own dirty check.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import TrailsPadBody from './TrailsPadBody.svelte';
import TrailsTileBody from './TrailsTileBody.svelte';

export default {
  fullViewBody: TrailsPadBody,
  // The LANE TILE's counterpart: the same mirror at 40 px with the LINK lamp
  // beside it, read-only. Without it the promoted tile is three control cells
  // over a jack rail, and the module's one live picture — the thing that answers
  // "did my hardware just do something" — would exist only behind the dock.
  tileBody: TrailsTileBody,
} satisfies ShellExtension;
