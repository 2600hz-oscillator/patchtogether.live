// packages/web/src/lib/ui/modules/scope/shell-extension.ts
//
// The SCOPE SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `scopeDef.face.extension: 'scope'` declares this file — the id IS this
// directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a scope component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ ONE SLOT. NO `glyph`, AND THE REFUSAL IS THIS MODULE'S HEADLINE.
// `dockscope` — the sibling that shipped this exact shape — refused `glyph:
// 'scope'` because it declares `outputs: []`, so `primaryAudioOutPortId`
// returns null, every literal falls to `{kind:'static'}` and the dead-glyph
// clause catches it. That refusal is MECHANICAL: a gate makes it for you.
//
// SCOPE HAS NO SUCH PROTECTION. `ch1_out` is `type: 'audio'`, so the binding
// short-circuits to `{ kind: 'live-audio', portId: 'ch1_out' }` — LIVE, green
// on the dead-glyph clause, green on `VALID_GLYPHS`, red nowhere. And
// `ch1_out` IS `gain1`, the module's own CH1 INPUT with nothing ever written to
// its gain, so the glyph would paint a raw analyser dump invariant to every
// single one of this module's nine controls. On a raster module that is merely
// uninformative; on a SCOPE it is the picture a player will believe is the
// scope's trace. See the `face` block on `scopeDef` for the full derivation and
// `scope-face-model.test.ts` for the assertion, which exists precisely because
// no gate makes it.
//
// ⚠ AND A LAYOUT-SOURCE GLYPH (`'algorithm'`, after #2160) IS NOT THE ESCAPE.
// `ShellExtensionGlyphProps` is `{ num, numbers?, testid? }` — no `nodeId`, no
// engine, no store — and `ModuleShell` hardcodes `topologyValue` to 0 when
// `paramId` is null. Every instance of scope in the rack would draw a
// BYTE-IDENTICAL SVG that cannot vary per node or over time. #2160 removed the
// refusal; it did not add a data path.
//
// ⚠ THE SAMPLES ARE REACHABLE THROUGH EXACTLY ONE SEAM: the engine handle's
// `read('snapshot')` key. No glyph binding calls `engine.read`, and a
// `fullViewBody` is the wired slot that can. This file is that.
//
// ⚠ AND IT IS THE SAME DRAWING ALL THREE SURFACES USE. `drawScope` is already a
// pure function of (snapshot, params, w, h) shared by the card's canvas and the
// cross-domain `drawFrame` that feeds the `out` mono-video texture, so the body
// hosts a canvas and calls it rather than plotting a third time — which is what
// stops the faceplate, the legacy card and the video output from ever
// disagreeing about what the trace looks like.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface. The lane consequence is stated rather than
// discovered — with `glyph: 'none'` and a dock-only body, scope's LANE tile
// paints its ranked cells and no trace at all.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import ScopeScreenBody from './ScopeScreenBody.svelte';

export default {
  fullViewBody: ScopeScreenBody,
} satisfies ShellExtension;
