// packages/web/src/lib/audio/modules/oss-attribution.test.ts
//
// Locks down the per-module `ossAttribution` field for modules whose DSP code
// is a direct port of an MIT-licensed upstream project. The card-side
// <OssAttribution> component reads this field — if a future refactor of a
// def silently drops it, the disclaimer disappears from the UI; this test
// catches the regression in the ~1s vitest pass before anyone ships.
//
// Adding/removing a port is a one-line edit to the `EXPECTED_PORTS` table.
// Modules NOT in the table MUST NOT carry an attribution (the second
// `forbids attribution on non-ported modules` test enforces that — see the
// header rules in packages/dsp/src/*.ts for the port-vs-from-spec
// distinction).

import { describe, expect, it } from 'vitest';
import { cloudsDef } from './clouds';
import { ringsDef } from './rings';
import { peaksDef } from './peaks';
import { macrooscillatorDef } from './macrooscillator';
import { cloudseedDef } from './cloudseed';
import { stagesDef } from './stages';
import { warpsDef } from './warps';
import { meowboxDef } from './meowbox';
import { drummergirlDef } from './drummergirl';
import { bladesDef } from './blades';
import { veilsDef } from './veils';
import type { AudioModuleDef } from '$lib/audio/module-registry';

interface PortExpectation {
  type: string;
  def: AudioModuleDef;
  author: string;
}

// Modules whose DSP is a direct port of an MIT-licensed upstream project.
// Authors verified against the corresponding packages/dsp/src/<module>.ts
// header comment — each cites the upstream repo + the original MIT
// copyright line.
const EXPECTED_PORTS: PortExpectation[] = [
  { type: 'clouds',          def: cloudsDef,          author: 'Émilie Gillet' },
  { type: 'rings',           def: ringsDef,           author: 'Émilie Gillet' },
  { type: 'peaks',           def: peaksDef,           author: 'Émilie Gillet' },
  { type: 'macrooscillator', def: macrooscillatorDef, author: 'Émilie Gillet' },
  { type: 'stages',          def: stagesDef,          author: 'Émilie Gillet' },
  { type: 'warps',           def: warpsDef,           author: 'Émilie Gillet' },
  { type: 'cloudseed',       def: cloudseedDef,       author: 'Ghost Note Audio' },
];

// Modules whose DSP is original (no upstream code crossed over) and which
// MUST NOT carry the "Ported from MIT-licensed OSS" disclaimer. Two
// categories:
//   1. From-scratch Faust DSP (MEOWBOX, DRUMMERGIRL) — never had an
//      upstream; their packages/dsp/src/*.dsp headers carry no attribution.
//   2. From-spec implementations of Mutable Instruments analog hardware
//      (BLADES, VEILS) — eurorack/{blades,veils}/ upstream contains only
//      hardware_design, no firmware DSP to port. The header in
//      packages/dsp/src/{blades,veils}.ts explicitly says "from-spec, not
//      a port", so per the user's wording these are "inspired by", not
//      "ported from".
const EXPECTED_NOT_PORTS: { type: string; def: AudioModuleDef }[] = [
  { type: 'meowbox',     def: meowboxDef },
  { type: 'drummergirl', def: drummergirlDef },
  { type: 'blades',      def: bladesDef },
  { type: 'veils',       def: veilsDef },
];

describe('OSS attribution', () => {
  describe.each(EXPECTED_PORTS)('$type', ({ def, author }) => {
    it('carries an ossAttribution field', () => {
      expect(def.ossAttribution, `${def.type} must declare ossAttribution`).toBeDefined();
    });

    it(`credits ${author}`, () => {
      expect(def.ossAttribution?.author).toBe(author);
    });
  });

  describe.each(EXPECTED_NOT_PORTS)('$type', ({ def }) => {
    it('does NOT carry an ossAttribution field (from-scratch, not a port)', () => {
      expect(
        def.ossAttribution,
        `${def.type} is a from-scratch implementation; attribution must be omitted to keep the disclaimer accurate`,
      ).toBeUndefined();
    });
  });
});
