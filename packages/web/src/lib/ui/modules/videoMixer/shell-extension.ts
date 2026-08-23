// packages/web/src/lib/ui/modules/videoMixer/shell-extension.ts
//
// The V-MIXER SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `mixerVideoDef.face.extension: 'videoMixer'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a v-mixer component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THE DIRECTORY IS `videoMixer`, NOT `mixer`. The def's TYPE is `videoMixer`
// (its own comment: "Type id is 'videoMixer' to avoid clashing with the audio
// 'mixer' module") even though the file is `video/modules/mixer.ts` and the
// label is `v-mixer`. The extension id must match the string in
// `face.extension`, and `shell-extensions.test.ts` checks that both directions
// resolve — a `mixer` directory here would collide with the AUDIO mixer's
// namespace, which is exactly the clash the type id was chosen to avoid.
//
// ⚠ WHY (#1928): promotion stops BOTH surfaces rendering the legacy card, so a
// faced video module has NO route to a SCREEN ON/OFF switch except this slot.
// On this module the switch is an ADDITION rather than a port —
// `VideoMixerCard.svelte` never drew a preview at all — and so is the picture:
// four faders that SUM have no per-channel observable. There is no MONITOR mode
// to carry across; this card mounts no `hideControls`.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VideoMixerOutputBody from './VideoMixerOutputBody.svelte';

export default {
  fullViewBody: VideoMixerOutputBody,
} satisfies ShellExtension;
