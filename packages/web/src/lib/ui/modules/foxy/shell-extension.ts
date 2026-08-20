// packages/web/src/lib/ui/modules/foxy/shell-extension.ts
//
// The foxy SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), and an adopter of the `fullViewBody` slot alongside `backdraft`,
// `videoOut`, `spirographs` and `rasterize`.
//
// `foxyDef.face.extension: 'foxy'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a foxy component itself, which is what keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY THIS MODULE NEEDS THE SLOT — the `rasterize` reason, five pictures over
// rather than one. `hasVideoSurface(def)` is literally `def.domain === 'video'`;
// foxy is `domain: 'audio'` with three video OUTs whose frames are painted in
// JS (RasterPainter for the three rasters, foxy-draw / foxy-shapes-draw for the
// field, wavecel-draw for the table). So there is no generic route to any of
// them, and the pictures ARE the module: foxy's whole proposition is that the
// wavetable is BUILT in front of you from an internal three-source world, and
// promoting it without this slot would replace that world with knobs.
//
// ⚠ AND NOT FIVE PF-14 PANEL CELLS. A panel REQUIRES an operability probe, and
// for a read-only picture the only probe available watches a DIFFERENT control —
// an aliveness check that cannot observe the thing it certifies, which is the
// blind-gate shape rasterize's inventory entry declined by name. `fullViewBody`
// needs no such proxy. It also keeps the five pictures TOGETHER and PERSISTENT
// across all seven tabs, which is the owner's backdraft ruling ("the preview
// screen can stay present in all views") and is what lets a player watch raster
// B move while turning SRC B's knobs one tab over.
//
// ONE slot: `fullViewBody` — the five live pictures plus the three non-param
// affordances (SCOPE/3D flip, SCREEN ON/OFF, EXPORT TABLE). Dock-only, enforced
// by `dockFullViewHeadPlan`, because a 192px lane tile cannot carry a module
// surface; the lane keeps the `waveform` glyph for identity.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import FoxyOutputBody from './FoxyOutputBody.svelte';

export default {
  fullViewBody: FoxyOutputBody,
} satisfies ShellExtension;
