// packages/web/src/lib/ui/modules/twotracks/shell-extension.ts
//
// TWOTRACKS' faceplate surface: the two reel pictures, carried forward from the
// legacy card.
//
// ── WHY A BODY AND NOT A PANEL ──────────────────────────────────────────────
//
// The discriminator is mechanical rather than aesthetic: a picture DERIVED FROM
// PARAMS is a panel; a PER-FRAME ENGINE READ is a `fullViewBody`. This surface
// is the second kind twice over — the peak envelope and the live playhead are
// both pulled off the engine every frame (`engine.read(node,'peaksA')`,
// `'playheadA'`), and neither exists anywhere on the node for a panel to derive
// them from. The worklet owns the tape; `node.data` carries only the transport
// state and the recorded LENGTH, deliberately, because a Float32Array cannot
// ride the Y.Doc envelope and a per-frame playhead write is the render storm.
//
// `ShellPanelCell` would also have been dishonest in a second way: it REQUIRES
// an operability probe — an element the parity sweep clicks or drags to prove
// the panel is alive. This surface has one (the markers ARE draggable), but the
// params it drags are `start_*` / `end_*`, and those already ship as ordinary
// param cells in the TAPE bands. Declaring the picture as the panel for them
// would claim the cells do not exist.
//
// ── WHY IT SHOWS BOTH REELS, WHICH IS NOT WHAT THE BUILD SPEC ASKED FOR ─────
//
// ⚠ THE SPEC ASKED FOR THE SELECTED REEL — the picture following the active tab,
// A on bands 1-3 and B on bands 4-6. THAT IS NOT BUILDABLE WITHOUT A PLATFORM
// CHANGE, and the measurement is one line: `ShellExtensionFullViewBodyProps` is
// `{ nodeId: string }` and `ModuleShell` renders the slot as
// `<ExtFullViewBody nodeId={id} />` — the body is never told which tab is
// showing, and there is no other route to it. Threading `activePage` into the
// slot is a change to a shared contract every extension implements, for one
// module's convenience.
//
// Showing BOTH is not a consolation prize, and it settles a question the spec
// left open (*"the MIX tab shows… only a baseline will settle it"*). This is a
// two-reel machine whose rank-1 control is the A/B crossfader: seeing both tapes
// at once is what tells you what the crossfader is blending and what the
// cross-feeds are feeding. There is no tab on which the answer is "neither".
//
// ── SCREEN ON/OFF ───────────────────────────────────────────────────────────
//
// PRESENT, on `node.data.previewCollapsed` — the fleet-standard key, verbatim.
// The video-screen ruling runs over `listVideoModuleDefs() ∩ STRICT_FACES` and
// this module is `domain: 'audio'`, so no gate can see this either way; it is
// here on the merits and asserted at source in `twotracks-face-model.test.ts`
// because nothing else would notice its deletion.
//
// The merits: unlike `samsloop` or `dockscope`, where the picture IS the module,
// here it is a preview beside a large control set. With it collapsed you still
// have transport, rate, echoes, EQ, filter and the whole mix — a complete,
// usable tape machine — and on a SEVEN-BAND face reclaiming that vertical space
// on the four bands where the tape is not the subject is worth real screen.
//
// ⚠ AND THE MODULE KEEPS RENDERING WHILE OFF. The collapse skips the PAINT and
// never the engine read, so switching it back on shows the LIVE tape rather
// than a stale frame — the same rule the video bodies follow, and the reason
// `twotracks-face-model.test.ts` asserts the ORDER rather than merely the
// presence of the bail.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import TwotracksReelBody from './TwotracksReelBody.svelte';

export default {
  fullViewBody: TwotracksReelBody,
} satisfies ShellExtension;
