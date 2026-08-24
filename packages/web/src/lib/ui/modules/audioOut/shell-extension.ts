// packages/web/src/lib/ui/modules/audioOut/shell-extension.ts
//
// AUDIO OUT's bespoke surface. `audioOutDef.face.extension = 'audioOut'`
// resolves to this directory through `shell-extensions.ts`'s non-eager glob.
//
// ONE slot: `fullViewBody`. It carries the two things this module has that no
// `ParamDef` can express — the terminal stereo meter (new; the taps existed and
// nothing read them) and the `setSinkId` output-device picker (carried forward
// from the card, on the `cameraInput` precedent that `legacy-fallback.ts` names
// by name: the extension body "is the one slot that can hold a control no
// `ParamDef` can express").
//
// NO `glyph`. `audioOut` declares `outputs: []`, so `primaryAudioOutPortId` is
// null and every live-glyph binding would resolve to the STATIC placeholder —
// and the pinned instance is canvas-hidden and has no lane tile to paint one on
// anyway. `face.glyph: 'none'` says so; a glyph slot here would be a component
// nothing ever mounts.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import AudioOutOutputBody from './AudioOutOutputBody.svelte';

export default {
  fullViewBody: AudioOutOutputBody,
} satisfies ShellExtension;
