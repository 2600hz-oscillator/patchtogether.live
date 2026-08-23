// packages/web/src/lib/ui/modules/spectrograph/shell-extension.ts
//
// The SPECTROGRAPH SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `spectrographDef.face.extension: 'spectrograph'` declares this file — the id
// IS this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a spectrograph component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AND NOT A REGISTERED PANEL, which is what the migration note
// prescribes for this module. The discriminator is stated on `wavecel` in
// `shell-cells.ts`: a PANEL is right when the picture is DERIVED — from params
// and `node.data`, computable without an analyser — and a BODY is right when
// the surface carries a PER-FRAME ENGINE READ. This sonogram is the second
// kind and could not be the first: every column comes from
// `analyser.getFloatFrequencyData`, and the scroll buffer that holds 256 of
// them lives in the module's FACTORY CLOSURE, reachable only through
// `videoSources.get(port).drawFrame`. There is nothing on the node for a panel
// to derive it from.
//
// ⚠ AND THE BODY MUST NOT RE-IMPLEMENT THE SCROLL. `drawFrame` is the ONE
// entry point; the accumulator behind it is per-node closure state, so a second
// copy would advance at its own rate and the two surfaces would show different
// moments of the same signal. The module already guards the shared case — a
// 16 ms column gate makes a second and third caller in one frame idempotent —
// so calling `drawFrame` is both the simplest and the only correct option.
//
// ⚠ DETERMINISM IS FREE HERE, unlike dockscope's. `__spectrographVrtFreeze` is
// read INSIDE the module (`spectrograph.ts`), not in the card, so any surface
// that calls `drawFrame` inherits the frozen fill without knowing the global
// exists. Nothing has to be mirrored into this directory.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface. ⚠ And here the lane keeps NO picture at all —
// `hasVideoSurface` is `domain === 'video'` and this module is `domain:
// 'audio'` despite emitting video, so its tile paints its two ranked cells and
// nothing else. The sonogram is a dock surface by construction.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import SpectrographOutputBody from './SpectrographOutputBody.svelte';

export default {
  fullViewBody: SpectrographOutputBody,
} satisfies ShellExtension;
