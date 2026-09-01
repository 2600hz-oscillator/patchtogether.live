// packages/web/src/lib/ui/modules/audioIn/shell-extension.ts
//
// AUDIO IN's bespoke surface. `audioInDef.face.extension = 'audioIn'` resolves
// to this directory through `shell-extensions.ts`'s non-eager glob.
//
// TWO slots, and they are counterparts rather than siblings — `ModuleShell`
// renders `tileBody` only `{#if !extBody}`, so exactly one of them paints on any
// given surface:
//
//   * `fullViewBody` — the DOCK full view, and (via `view='drawer'`, which
//     `dockFullViewHeadPlan` treats as a faceplate view) the 🎧 topbar tray that
//     is `pinned-audioIn`'s ONLY surface.
//   * `tileBody`     — the LANE tile, where a player normally meets an added
//     instance.
//
// ⚠ BOTH ARE REQUIRED, AND THE SECOND ONE IS THE INTERESTING ONE. `cameraInput`
// shipped `fullViewBody` alone and the lane tile could neither pick a device nor
// START one; that regression is recorded in `CameraSourceControls.svelte`'s own
// header. AUDIO IN would have inherited it in a worse form: ENABLE is the only
// route to a FIRST microphone grant, and `audioIn` is in neither
// `DOM_SOURCE_LANE_TYPES` nor `CARD_PRODUCER_LANE_TYPES`, so after promotion no
// card is mounted ANYWHERE to reach instead — not even the off-screen
// `<HeadlessSourceHost>` copy that keeps camera's stream alive.
//
// NO `glyph` slot. `audioIn` declares two real audio outputs, so
// `primaryAudioOutPortId` resolves `audio_l_out` and `glyphBinding` returns a
// LIVE `{kind:'live-audio'}` for `face.glyph: 'meter'` — the shell's own
// generic picture, with nothing module-specific to draw. An extension glyph here
// would be a component the shell never mounts.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import AudioInSourceBody from './AudioInSourceBody.svelte';
import AudioInTileBody from './AudioInTileBody.svelte';

export default {
  fullViewBody: AudioInSourceBody,
  tileBody: AudioInTileBody,
} satisfies ShellExtension;
