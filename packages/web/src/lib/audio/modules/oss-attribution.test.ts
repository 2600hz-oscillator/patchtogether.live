// packages/web/src/lib/audio/modules/oss-attribution.test.ts
//
// Locks down the per-module `ossAttribution` field for modules whose code is a
// direct port of an upstream OSS project. The card-side <OssAttribution>
// component reads this field — if a future refactor of a def silently drops
// it, the disclaimer disappears from the UI; this test catches the regression
// in the ~1s vitest pass before anyone ships.
//
// This sweep is the SINGLE owner of attribution assertions (per-module
// def-shape copies were folded in here by the LoC-reduction row-1 sweep):
//   1. Every module in `EXPECTED_ATTRIBUTIONS` must credit its exact author.
//   2. DENY-BY-DEFAULT: any registered def carrying an `ossAttribution` that
//      is NOT in the table fails — so an attribution can neither silently
//      vanish nor silently appear (a from-scratch module gaining a disclaimer
//      is just as wrong as a port losing one). See the header rules in
//      packages/dsp/src/*.ts for the port-vs-from-spec distinction.
//
// Adding/removing a ported module is a one-line edit to the table.

import { describe, expect, it } from 'vitest';

// Side-effect barrel import so the registry holds every audio def (the
// deny-by-default sweep iterates the LIVE registry, not a hand list).
import '$lib/audio/modules';
import { listModuleDefs } from '$lib/audio/module-registry';

import { cloudsDef } from './clouds';
import { ringsDef } from './rings';
import { marblesDef } from './marbles';
import { macrooscillatorDef } from './macrooscillator';
import { cloudseedDef } from './cloudseed';
import { callsineDef } from './callsine';
import { froggerDef } from './frogger';
import { resofilterDef } from './resofilter';
import { sidecarDef } from './sidecar';
import { skifreeDef } from './skifree';
import { treeohvoxDef } from './treeohvox';
import type { AudioModuleDef } from '$lib/audio/module-registry';

interface AttributionExpectation {
  type: string;
  def: AudioModuleDef;
  author: string;
}

// Modules whose DSP/game code is a direct port of an upstream OSS project.
// Authors verified against the corresponding source header comment — each
// cites the upstream repo + the original copyright line.
const EXPECTED_ATTRIBUTIONS: AttributionExpectation[] = [
  { type: 'clouds',          def: cloudsDef,          author: 'Émilie Gillet' },
  { type: 'rings',           def: ringsDef,           author: 'Émilie Gillet' },
  { type: 'marbles',         def: marblesDef,         author: 'Émilie Gillet' },
  { type: 'macrooscillator', def: macrooscillatorDef, author: 'Émilie Gillet' },
  { type: 'cloudseed',       def: cloudseedDef,       author: 'Ghost Note Audio' },
  { type: 'callsine',        def: callsineDef,        author: "callsine contributors (Warren's Spectrum)" },
  { type: 'frogger',         def: froggerDef,         author: 'Adrian Eyre (frogger, MIT)' },
  { type: 'resofilter',      def: resofilterDef,      author: 'Gabriel Soule (Resonarium, MultiFilter)' },
  {
    type: 'sidecar',
    def: sidecarDef,
    author: 'Algorithm: Giannoulis-Massberg-Reiss 2012 JAES; Faust co.compressor_stereo as reference',
  },
  { type: 'skifree',         def: skifreeDef,         author: 'skifree.js / Daniel Hough (MIT)' },
  // Found BY the deny-by-default sweep when it first ran — the old
  // hand-table sweep had never covered it.
  { type: 'treeohvox',       def: treeohvoxDef,       author: 'Robin Schmidt (Open303, MIT)' },
];

describe('OSS attribution', () => {
  describe.each(EXPECTED_ATTRIBUTIONS)('$type', ({ def, author }) => {
    it('carries an ossAttribution field', () => {
      expect(def.ossAttribution, `${def.type} must declare ossAttribution`).toBeDefined();
    });

    it(`credits ${author}`, () => {
      expect(def.ossAttribution?.author).toBe(author);
    });
  });

  it('no OTHER registered module carries an ossAttribution (deny-by-default)', () => {
    // From-scratch modules must NOT show the "ported from OSS" disclaimer —
    // an unexpected attribution is as much a bug as a missing one. Any new
    // port adds its row to EXPECTED_ATTRIBUTIONS (with the verified author).
    const expected = new Set(EXPECTED_ATTRIBUTIONS.map((e) => e.type));
    const unexpected = listModuleDefs()
      .filter((d) => d.ossAttribution !== undefined && !expected.has(d.type))
      .map((d) => `${d.type}: ${JSON.stringify(d.ossAttribution)}`);
    expect(
      unexpected,
      `unexpected ossAttribution (add to EXPECTED_ATTRIBUTIONS if a real port):\n  ${unexpected.join('\n  ')}`,
    ).toEqual([]);
  });
});
