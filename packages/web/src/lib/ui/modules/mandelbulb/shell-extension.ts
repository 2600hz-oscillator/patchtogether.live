// packages/web/src/lib/ui/modules/mandelbulb/shell-extension.ts
//
// The MANDELBULB SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), joining `backdraft`, `videoOut`, `spirographs`, `mirrorpool`,
// `freezeframe`, `outlines`, `b3ntb0x`, `4plexvid`, `grainsOfVision`,
// `warrensvisions`, `rasterize` and `bentbox` on the `fullViewBody` slot.
//
// `mandelbulbDef.face.extension: 'mandelbulb'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a mandelbulb component itself, which is what
// keeps `module-shell-import-guard` green.
//
// ⚠ WHY (#1928 / #1935): promotion stops BOTH surfaces rendering
// `MandelbulbCard.svelte`, and that card is the only home of TWO pictures —
// the ray-marched preview AND the slice waveform readout. The second one is
// the module's audio half made visible: with SLICE on, `audio_out` plays the
// bulb's cross-section, and that trace is the only way to SEE the waveform you
// are hearing. Losing it would leave a module that is half oscillator with no
// oscilloscope.
//
// ONE slot: `fullViewBody`. Dock-only, enforced by `dockFullViewHeadPlan`,
// because a 192 px lane tile cannot carry a module surface; the lane keeps the
// generic `VideoTileThumb`.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import MandelbulbOutputBody from './MandelbulbOutputBody.svelte';

export default {
  fullViewBody: MandelbulbOutputBody,
} satisfies ShellExtension;
