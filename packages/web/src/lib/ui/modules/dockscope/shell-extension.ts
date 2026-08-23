// packages/web/src/lib/ui/modules/dockscope/shell-extension.ts
//
// The DOCKSCOPE SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `dockscopeDef.face.extension: 'dockscope'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a dockscope component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ WHY A BODY AND NOT A GLYPH — the correction this face is built around.
// The migration inventory recommends `glyph: 'scope'` for this module, on the
// reading that "the trace IS the scope glyph". It is not. `glyphBinding`
// resolves a declared glyph to a LIVE trace only through
// `primaryAudioOutPortId` — the first declared `audio` OUTPUT — and dockscope
// declares `outputs: []`, because it is a TERMINAL VISUALISER that observes and
// never passes through. With no audio output the binding falls through every
// live branch to `{ kind: 'static' }`, the deterministic placeholder waveform.
//
// So the glyph would have compiled, passed `VALID_GLYPHS`, and painted a trace
// that is not this module's signal — a green gate certifying a dead display.
// analogVco, the precedent the note cites, reaches the live branch only because
// it declares six audio outputs.
//
// The samples are reachable through exactly one seam: the engine handle's own
// `read('snapshot')` key, which returns the analyser's time-domain window. No
// glyph binding calls `engine.read`, and a `fullViewBody` is the wired slot that
// can. This file is that.
//
// ⚠ AND IT IS THE SAME DRAWING THE CARD USES. `drawDockscope` is already a pure
// function of (samples, sampleRate, params, w, h), so the body hosts a canvas
// and calls it rather than re-plotting a second time — which is what stops the
// two surfaces from ever disagreeing about what the trace looks like.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot carry
// a module surface. ⚠ The lane consequence is worth stating rather than
// discovering — with `glyph: 'none'` and a dock-only body, dockscope's LANE tile
// paints its two ranked cells and no trace. That is the honest outcome for an
// audio module at 192 px, and it is the same trade `analogVco` took when it put
// its real picture in a dock panel.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import DockscopeOutputBody from './DockscopeOutputBody.svelte';

export default {
  fullViewBody: DockscopeOutputBody,
} satisfies ShellExtension;
