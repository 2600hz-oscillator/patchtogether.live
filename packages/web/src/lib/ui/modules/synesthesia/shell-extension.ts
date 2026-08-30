// packages/web/src/lib/ui/modules/synesthesia/shell-extension.ts
//
// The SYNESTHESIA SHELL EXTENSION — the module-owned end of the extension seam
// (#1512), on the `fullViewBody` slot.
//
// `synesthesiaDef.face.extension: 'synesthesia'` declares this file — the id IS
// this directory's name, and the non-eager glob in
// `$lib/ui/workflow/shell-extensions.ts` is the one resolver. ModuleShell loads
// it lazily and never imports a synesthesia component itself, which keeps
// `module-shell-import-guard` green.
//
// ⚠ ONE SLOT. NO `glyph`, AND THE REFUSAL IS THIS MODULE'S HEADLINE.
// `a_band1_audio` is a declared `type: 'audio'` output — the FIRST one on the
// def — so `primaryAudioOutPortId` returns it and `glyphBinding` short-circuits
// to `{ kind: 'live-audio', portId: 'a_band1_audio' }`. That is LIVE: green on
// the dead-glyph clause, green on `VALID_GLYPHS`, red nowhere. And it is copy
// A's BASS BAND and nothing else, so the trace it paints is invariant to the
// other three bands, to copy B entirely, to both envelope stages, to all eight
// depths, to both polarities and to VIDEO mode. On a module whose whole product
// is the COMPARISON ACROSS BANDS, that picture would MISINFORM rather than
// merely fail to inform. See the `face` block on `synesthesiaDef` for the full
// derivation and `synesthesia-face-model.test.ts` for the assertion, which
// exists precisely because no gate makes it.
//
// ⚠ AND A LAYOUT-SOURCE GLYPH (`'algorithm'`, after #2160) IS NOT THE ESCAPE.
// `ShellExtensionGlyphProps` is `{ num, numbers?, testid? }` — no `nodeId`, no
// engine, no store — and `ModuleShell` hardcodes `topologyValue` to 0 when
// `paramId` is null. Every instance of synesthesia in the rack would draw a
// BYTE-IDENTICAL SVG that cannot vary per node or over time, which is the exact
// opposite of what a level meter is for. #2160 removed the refusal; it did not
// add a data path.
//
// ⚠ THE LEVELS ARE REACHABLE THROUGH EXACTLY ONE SEAM: the engine handle's
// `read('snapshot')` key, which returns the `{ levelsA, levelsB }` the worklet
// posts. No glyph binding calls `engine.read`, and a `fullViewBody` is the
// wired slot that can. This file is that.
//
// ⚠ AND IT IS THE SAME DRAWING BOTH SURFACES USE. `drawVuMeters` is already a
// pure function of (levels, w, h) that `SynesthesiaCard` calls, so the body
// hosts two canvases and calls it rather than plotting a third time — which is
// what stops the faceplate and the legacy card from ever disagreeing about what
// the meters look like.
//
// Dock-only, enforced by `dockFullViewHeadPlan`: a 192 px lane tile cannot
// carry a module surface. The lane consequence is stated rather than
// discovered — with `glyph: 'none'` and a dock-only body, synesthesia's LANE
// tile paints its three ranked cells and no meters at all.

import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import SynesthesiaVuBody from './SynesthesiaVuBody.svelte';

export default {
  fullViewBody: SynesthesiaVuBody,
} satisfies ShellExtension;
