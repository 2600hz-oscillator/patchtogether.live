// packages/web/src/lib/meta/modules/matrixmix.ts
//
// MATRIXMIX — an EMS-Synthi / Buchla-style patch MATRIX card.
//
// Pick an X-axis module and a Y-axis module from everything currently in the
// patch (by their user-facing display name). The card draws a grid: one COLUMN
// per the X-module's jacks (every input AND output), one ROW per the Y-module's
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
  card: 'MatrixMixCard',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
};
