// packages/web/src/lib/meta/modules/matrixmix.ts
//
// MATRIXMIX — an EMS-Synthi / Buchla-style patch MATRIX card.
//
// Pick an X-axis module and a Y-axis module from everything currently in the
// patch (by their user-facing display name). The card draws a grid: one COLUMN
// per the X-module's jacks (every input AND output), one ROW per the Y-module\'s
// jacks. Each cell is a potential connection between the row-jack + column-jack:
//   - a FILLED CIRCLE (coloured by cable type) where a direct cable already
//     runs between the two matrixed jacks,
//   - a RED ✕ where the cell's input is already fed by a THIRD module
//     (re-patching here would replace that source),
//   - a GRAY ✕ where the cell's output already feeds a THIRD module
//     (outputs fan out — patching here only ADDS a cable),
//   - CLICKABLE where one side is an input, the other an output, and the types
//     are compatible — click creates that edge instantly,
//   - a RED-✕ CURSOR (no-op click) where the pair is illegal (in→in, out→out,
//     or incompatible types).
//
// Like CONTROL SURFACE, MATRIXMIX is a META-domain card: it READS + EDITS the
// patch graph but binds to NO engine (no audio nodes, no FBOs) and declares NO
// ports of its own. The reconciler skips domain==='meta', so this def carries
// no factory. Everything except the two AXIS SELECTIONS is derived live from
// the patch on every render.
//
// Persisted state (node.data): only `xAxisModuleId` + `yAxisModuleId`. Every
// connection shown is read live from patch.edges — never cached.
//
// Inputs: none. Outputs: none. Params: none.

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const matrixmixDef: MetaModuleDef = {
  type: 'matrixMix',
  // Palette: show it where users look for routing/patch utilities (Audio
  // modules → Utility), even though it's a meta-domain card.
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'meta',
  label: 'matrixmix',
  category: 'tools',
  inputs: [],
  outputs: [],
  params: [],

  // ── THE TWO AXIS PICKERS, DECLARED AS ONE-MEMBER FAMILIES ─────────────────
  //
  // The dx7 / videocube / kria convention, and for a meta def it is the ONLY
  // route: `params` is empty by construction, so every key `face.order` can
  // hold is a NON-param key, and module-face-lint legitimizes one of those only
  // as a declared family template or a committed `.legend.json` entry. Without
  // these two declarations the face could rank nothing at all.
  //
  // Each `testidPrefix` is a literal the CARD already emits
  // (`matrixmix-x-select` / `matrixmix-y-select`), which is what
  // module-docs-lint's card grep checks — so a rename on either surface is red.
  //
  // ⚠ THE LABELS ARE THE MOCKUP'S, TERSELY. They were `X-axis module` /
  // `Y-axis module` and are now `X axis` / `Y axis`, which is what the reviewed
  // dock + lane mockups both print. The word `module` said nothing the roster
  // did not — every option in the dropdown IS a module — and it cost ~7
  // characters of caption on a 246 px lane tile, against a standing ruling that
  // compact is the default and screen real estate is expensive.
  //
  // ⚠ THE CAPTION IS NOT REDUNDANT WITH THE CHIP'S `X` / `Y` TAG, which is the
  // `face.bareCells` question and resolves the other way here. That ruling drops
  // a per-control label when a SECTION HEADING already conveys it; this face's
  // only heading is the module name, so nothing but these two captions
  // distinguishes two otherwise-identical dropdowns. The tag is inside the chip
  // and vanishes at the lane tiers that render no caption, so dropping either
  // one leaves a tier where the two controls are indistinguishable.
  controlFamilies: [
    { id: 'matrixmix-x', label: 'X axis', kind: 'other', testidPrefix: 'matrixmix-x' },
    { id: 'matrixmix-y', label: 'Y axis', kind: 'other', testidPrefix: 'matrixmix-y' },
  ],

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // matrixMix is the program's ZERO-PARAM case, and `order: []` is the wrong
  // answer to it. A face that ranks nothing is LEGAL (module-face-lint puts it
  // out of scope, naming `flipper` and `videoOut`) but it paints a BLANK lane
  // tile — strictly worse than the placeholder it replaces, which at least
  // announces that a real surface is one click away.
  //
  // These two cells answer the only question anybody has about a matrix node at
  // a glance — WHICH TWO MODULES IS IT LOOKING AT — without opening anything.
  // Today that costs a dock full-view open. They are `selector` shell cells
  // over a roster derived from the live patch (matrixmix-cell-actions.ts), the
  // same derivation the card uses, EXTRACTED rather than copied.
  //
  // ⚠ `glyph: 'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN, and
  // an author who never thinks about it ships the right thing. `laneGlyphFor`
  // returns 'picture' only for `domain === 'video'`; a 'trace' glyph resolves
  // through `glyphBinding()` to `{kind:'static'}` because `primaryAudioOutPortId`
  // finds no audio output — matrixMix has no outputs at all — and
  // module-face-lint reddens a dead glyph unconditionally.
  //
  // ⚠ NO TAB RAIL. Two selector cells is ONE band against
  // `DOCK_TAB_MIN_BANDS = 7`; nothing here is padded to reach a rail.
  //
  // The GRID is not a cell. It is `face.extension`'s `fullViewBody` — see
  // $lib/ui/modules/matrixmix/MatrixMixGridBody.svelte for why it is that slot
  // and not a PF-14 `panel` (a panel's `minWidth` is a required number, and
  // this grid's width is 4 columns or 40 depending on two OTHER modules — any
  // number written there would be a fiction in a required field).
  face: {
    glyph: 'none',
    order: ['matrixmix-x-{n}', 'matrixmix-y-{n}'],
    extension: 'matrixmix',
  },
};
