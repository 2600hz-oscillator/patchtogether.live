// packages/web/src/lib/ui/modules/videocube/shell-extension.ts
//
// The VIDEOCUBE SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `videocubeDef.face.extension: 'videocube'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a videocube component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ THIS BODY CARRIES THREE SURFACES, NOT ONE, and that is what makes it the
// widest `fullViewBody` in the fleet. `VideocubeCard.svelte` draws all three and
// `migrated(type)` deletes the card, so promotion without them loses:
//   • the video_out RAY-MARCH — the picture the whole module exists to produce;
//   • the SLICE cross-section — the 2-D readout of the exact cutting plane, and
//     the only surface on which "where am I cutting?" is answerable at all;
//   • the WAVE trace — the derived surface-height wave `audio_out` plays, and
//     the only place the module's SOUND is visible.
// The third is the one a reader would be tempted to drop as decoration. It is
// not: this module's whole claim is that the picture and the drone are two
// readings of ONE field, and the wave beside the slice is where that claim is
// checkable.
//
// ⚠ WHY THE SCREEN SWITCH IS HERE AT ALL (#1928): promotion leaves a faced video
// module with NO route to a SCREEN ON/OFF toggle except this slot.
//
// ⚠ AND IT IS NOT `screen_on`. The def's `screen_on` param is very nearly the
// OPPOSITE of the ruling's switch — it skips the RAY-MARCH ITSELF — so it stays
// a band cell (relabelled `ray-march` to end the collision) and the fleet's
// `previewCollapsed` key is what this body toggles. OFF stops the BLIT and keeps
// the engine running, which is the ruling.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface, so the lane keeps the generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import VideocubeOutputBody from './VideocubeOutputBody.svelte';

export default {
  fullViewBody: VideocubeOutputBody,
} satisfies ShellExtension;
