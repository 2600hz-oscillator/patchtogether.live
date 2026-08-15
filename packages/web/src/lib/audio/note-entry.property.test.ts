// packages/web/src/lib/audio/note-entry.property.test.ts
//
// fast-check property suite for the note-name ⇄ MIDI ⇄ V/oct conversions
// (#1526) — the pitch seam behind sequencer step entry, Cartesian cells and
// every V/oct source.
//
// Why this core. These are ENCODE/DECODE pairs, and an encode/decode pair has
// exactly one law worth stating: the round trip is the identity, over the WHOLE
// domain. An example test can only ever pin the notes someone typed — and the
// interesting failures live at the spellings nobody types (`e#`-adjacent
// wrapping, the octave boundary at `b`/`c`, the MIN/MAX cliffs).
//
// The laws:
//   R1 ROUND TRIP   — parse(spell(m)) === m for every m in [MIN_MIDI, MAX_MIDI].
//   R2 TOTALITY     — spell() returns '' exactly outside that range, and
//                     parse() returns null for every out-of-range spelling.
//   R3 CANONICAL    — spell() is idempotent through the round trip and always
//                     lands on the SHARP spelling.
//   R4 INVARIANCE   — parse ignores case and whitespace.
//   R5 ENHARMONIC   — the flat spelling of a pitch class parses to the same
//                     MIDI int as its sharp spelling.
//   R6 VOCT         — vOctToMidi(midiToVOct(m)) === m (the CV round trip), and
//                     midiToVOct is affine with C4 at 0 V.
//   R7 HZ           — midiToHz is strictly increasing, A4 is exactly 440, and
//                     +12 semitones is exactly ×2.
//
// PERMANENT NEGATIVE CONTROL: `spellOffByOne` is the canonical speller with a
// one-semitone error. R1 must FAIL against it — otherwise R1 is comparing
// something other than the pitch it names.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  parseNoteName,
  noteNameForMidi,
  midiToVOct,
  vOctToMidi,
  midiToHz,
  MIN_MIDI,
  MAX_MIDI,
  A4_MIDI,
  A4_HZ,
  C4_MIDI,
} from './note-entry';

/** Every MIDI int the module claims to support. DERIVED from the exported
 *  bounds — never a typed count, so widening the range widens the test. */
const inRangeMidi = fc.integer({ min: MIN_MIDI, max: MAX_MIDI });
const outOfRangeMidi = fc.oneof(
  fc.integer({ min: -600, max: MIN_MIDI - 1 }),
  fc.integer({ min: MAX_MIDI + 1, max: 600 }),
);

/** Flat spelling ⇄ sharp spelling of the same pitch class. */
const ENHARMONICS: [flat: string, sharp: string][] = [
  ['db', 'c#'],
  ['eb', 'd#'],
  ['gb', 'f#'],
  ['ab', 'g#'],
  ['bb', 'a#'],
];

describe('note-entry properties', () => {
  it('R1: parse ∘ spell is the identity over the whole supported range', () => {
    fc.assert(
      fc.property(inRangeMidi, (m) => {
        const name = noteNameForMidi(m);
        expect(name, `spell(${m}) returned empty inside [${MIN_MIDI}, ${MAX_MIDI}]`).not.toBe('');
        expect(
          parseNoteName(name),
          `round trip broke: MIDI ${m} spelled as ${JSON.stringify(name)} parsed back as ` +
            `${parseNoteName(name)}`,
        ).toBe(m);
      }),
      { numRuns: 300, seed: 15301 },
    );
  });

  it('R2: the range boundary is total in both directions', () => {
    fc.assert(
      fc.property(outOfRangeMidi, (m) => {
        expect(noteNameForMidi(m), `spell(${m}) must be '' outside the range`).toBe('');
      }),
      { numRuns: 300, seed: 15302 },
    );
    // …and a well-formed spelling outside the range parses to null rather than
    // to a clamped value (a clamp here would silently retune a loaded patch).
    fc.assert(
      fc.property(fc.integer({ min: -1, max: 9 }), fc.integer({ min: 0, max: 11 }), (oct, cls) => {
        const names = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
        const name = `${names[cls]}${oct}`;
        const midi = (oct + 1) * 12 + cls;
        const got = parseNoteName(name);
        if (midi < MIN_MIDI || midi > MAX_MIDI) {
          expect(got, `${name} (MIDI ${midi}) is out of range and must parse to null`).toBeNull();
        } else {
          expect(got, `${name} should parse to ${midi}`).toBe(midi);
        }
      }),
      { numRuns: 400, seed: 15303 },
    );
  });

  it('R3: spelling is canonical — idempotent, and sharps only', () => {
    fc.assert(
      fc.property(inRangeMidi, (m) => {
        const name = noteNameForMidi(m);
        expect(noteNameForMidi(parseNoteName(name) as number)).toBe(name);
        // A flat is a `b` in the ACCIDENTAL position (index 1). Anchoring
        // matters: `/b\d/` also matches the NOTE B — `b7` (MIDI 107) is a
        // perfectly canonical sharp-spelling name, and an unanchored pattern
        // reported it as a flat.
        expect(name, `${name} used a flat spelling; sharps are canonical`).not.toMatch(
          /^[a-g]b/,
        );
        expect(name).toMatch(/^[a-g]#?-?\d+$/);
      }),
      { numRuns: 300, seed: 15304 },
    );
  });

  it('R4: parsing ignores case and surrounding whitespace', () => {
    fc.assert(
      fc.property(
        inRangeMidi,
        fc.stringMatching(/^[ \t]{0,4}$/),
        fc.stringMatching(/^[ \t]{0,4}$/),
        (m, pre, post) => {
          const name = noteNameForMidi(m);
          const noisy = `${pre}${name.toUpperCase()}${post}`;
          expect(
            parseNoteName(noisy),
            `${JSON.stringify(noisy)} must parse the same as ${JSON.stringify(name)}`,
          ).toBe(m);
        },
      ),
      { numRuns: 300, seed: 15305 },
    );
  });

  it('R5: the flat spelling of a pitch class is enharmonic with its sharp spelling', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENHARMONICS),
        fc.integer({ min: 0, max: 8 }),
        ([flat, sharp], oct) => {
          const a = parseNoteName(`${flat}${oct}`);
          const b = parseNoteName(`${sharp}${oct}`);
          expect(a, `${flat}${oct} and ${sharp}${oct} must be the same pitch`).toBe(b);
        },
      ),
      { numRuns: 200, seed: 15306 },
    );
  });

  it('R6: the V/oct round trip is the identity, and C4 sits at exactly 0 V', () => {
    expect(midiToVOct(C4_MIDI)).toBe(0);
    fc.assert(
      fc.property(inRangeMidi, (m) => {
        expect(
          vOctToMidi(midiToVOct(m)),
          `V/oct round trip broke at MIDI ${m} (${midiToVOct(m)} V)`,
        ).toBe(m);
      }),
      { numRuns: 300, seed: 15307 },
    );
    // Affine: one octave is exactly one volt, everywhere.
    fc.assert(
      fc.property(
        fc.integer({ min: MIN_MIDI, max: MAX_MIDI - 12 }),
        (m) => {
          expect(midiToVOct(m + 12) - midiToVOct(m), `1 octave must be 1 V at MIDI ${m}`)
            .toBeCloseTo(1, 12);
        },
      ),
      { numRuns: 200, seed: 15308 },
    );
  });

  it('R7: midiToHz is strictly increasing, anchored at A4 = 440, doubling per octave', () => {
    expect(midiToHz(A4_MIDI)).toBe(A4_HZ);
    fc.assert(
      fc.property(inRangeMidi, inRangeMidi, (a, b) => {
        fc.pre(a < b);
        expect(midiToHz(b), `hz(${b}) must exceed hz(${a})`).toBeGreaterThan(midiToHz(a));
      }),
      { numRuns: 400, seed: 15309 },
    );
    fc.assert(
      fc.property(fc.integer({ min: MIN_MIDI, max: MAX_MIDI - 12 }), (m) => {
        expect(midiToHz(m + 12) / midiToHz(m), `+12 semitones must double the Hz at ${m}`)
          .toBeCloseTo(2, 12);
      }),
      { numRuns: 200, seed: 15310 },
    );
  });

  // -------------------------------------------------------------------
  // PERMANENT NEGATIVE CONTROL.
  // -------------------------------------------------------------------
  it('CONTROL: an off-by-one speller FAILS R1 (so R1 really compares the pitch)', () => {
    /** The canonical speller with a one-semitone error — the single most likely
     *  regression in a note table, and exactly the class R1 exists to catch. */
    const spellOffByOne = (m: number): string => noteNameForMidi(m + 1);

    let broken = 0;
    const examples: string[] = [];
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const name = spellOffByOne(m);
      if (name === '' || parseNoteName(name) !== m) {
        broken++;
        if (examples.length < 3) {
          examples.push(`MIDI ${m} spelled ${JSON.stringify(name)} → ${parseNoteName(name)}`);
        }
      }
      // …and the REAL speller is clean on the identical input.
      const real = noteNameForMidi(m);
      expect(parseNoteName(real), `the real round trip broke at MIDI ${m}`).toBe(m);
    }
    expect(
      broken,
      'a speller shifted by one semitone still round-tripped for every MIDI int in ' +
        'range. R1 is then not comparing pitch at all, and would pass on a ' +
        'transposed note table.',
    ).toBe(MAX_MIDI - MIN_MIDI + 1);
    expect(examples.join('\n')).toMatch(/MIDI /);
  });
});
