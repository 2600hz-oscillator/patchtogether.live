// packages/web/src/lib/ui/modules/clipplayer/shell-extension.ts
//
// The CLIP PLAYER shell extension — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` AND `tileBody` slots.
//
// `clipplayerDef.face!.extension: 'clipplayer'` declares this file; the id IS
// this directory's name, resolved by the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts`. ModuleShell imports nothing from
// here, which is what keeps `module-shell-import-guard` green.
//
// ── WHAT IS A CELL AND WHAT IS A BODY, AND WHY THE LINE FALLS THERE ─────────
//
// SIX declared control families resolve to PF-14 panel CELLS: the launch grid
// (the hero), the piano roll, and the four eight-wide lane/scene rows. Each is
// a picture-you-edit with a natural gesture and an honest operability probe —
// kria's argument, and this module is the same shape one size up.
//
// Everything in the two BODIES is what remains when those are taken out, and
// none of it could be a cell for a reason the registry states rather than a
// preference:
//
//   · the TRANSPORT and the tempo nudge write TIMELORDE'S params — a param on
//     ANOTHER NODE, which no `face.order` key can address (the electraControl
//     addressability argument, verbatim);
//   · the clip UNDO/REDO stack, the monome GRID bind and the arranger pop-out
//     are one-shot gestures with no ParamDef and no family;
//   · the two RECORDERS and the AUTOMATION status are `node.data` state whose
//     surfaces are lamps and mode buttons, not a roster or a switch;
//   · the per-lane MUTE/STOP deck is a second eight-wide row that belongs with
//     the transport rather than with the launch grid's own rows.
//
// ── WHY A `tileBody` TOO ────────────────────────────────────────────────────
//
// Because `clipplayer` LEAVES `NON_SHELL_LANE_TYPES` in this PR (owner ruling
// 2026-08-31, owner-decisions item 10), and at the lane tier the ranked cells
// are STEP / QNT / S&H. A launcher on the canvas has to be able to say whether
// anything is playing, and a shell GLYPH cannot: `ShellExtensionGlyphProps`
// carries no nodeId, so every clip player in the rack would draw the same
// picture. The tile strip is per-node by construction.
//
// ⚠ AND IT CARRIES NOTHING ELSE. The tile mounts on every rack boot for every
// clip player, so it does one pure projection of `node.data` and no engine
// read, no rAF and no subscription — the #2314 rule. The rAF poll, the engine
// reads and the pop-out all live in `fullViewBody`, which exists only while the
// dock full view is open, exactly as the legacy card's did while it was open.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ClipplayerDeckBody from './ClipplayerDeckBody.svelte';
import ClipplayerTileBody from './ClipplayerTileBody.svelte';

export default {
  fullViewBody: ClipplayerDeckBody,
  tileBody: ClipplayerTileBody,
} satisfies ShellExtension;
