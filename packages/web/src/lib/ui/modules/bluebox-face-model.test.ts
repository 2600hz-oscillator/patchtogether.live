// packages/web/src/lib/ui/modules/bluebox-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for BLUEBOX's faceplate, plus the pin that
// anchors the model to the ARTIFACT rather than to a comment.
//
// Two things this file has to prove, and the second is the unusual one:
//
//  1. THE MODEL IS THE DSP. `bluebox-face-model` mirrors ONE number out of the
//     worklet (`BLUEBOX_ACTIVATION_PEAK` = BUTTON_VOICE_AMP × OUTPUT_NORM),
//     because both constants are private to a worklet ENTRY that exports
//     nothing at module scope. A mirrored literal is the "a CARD can silently
//     disagree with its DEF" class one layer down, so it is not left as a
//     comment: §1 below renders the REAL processor class through the
//     registerProcessor shim and asserts the measured RMS and peak match what
//     the model predicts, on twelve key sets. A worklet-side edit to either
//     constant — or to the `+=`, or to the `>= 0.5` threshold — turns this red.
//     That is strictly more than a shared import would buy: an import pins the
//     NUMBER and says nothing about the FORMULA.
//
//  2. EACH READOUT IS BLIND TO SOMETHING ANOTHER ONE SEES. This module has no
//     value knobs at all — twelve identical binary keys — so the ONLY way a
//     readout can say anything is by modelling the shared-oscillator `+=`, and
//     the only way to know it does is to perturb the thing a naive readback
//     would be invariant to and watch the number move. §2 does that in BOTH
//     directions for every pair: `level` must move where `headroom` cannot,
//     `headroom` must move where `keys held` cannot, and `decodes` must move
//     where all three are identical.
//
// MEASURED FIGURES quoted below are from the real processor at 48 kHz, RMS over
// 4 s skipping the first 100 ms of one-pole attack.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  BLUEBOX_ACTIVATION_PEAK,
  BLUEBOX_COL_HZ,
  BLUEBOX_MAX_SLOT_KEYS,
  BLUEBOX_ROW_HZ,
  BLUEBOX_SLOT_BAND,
  BLUEBOX_SLOT_HZ,
  BLUEBOX_SLOT_KEYS,
  blueboxBankBars,
  blueboxBarCaption,
  blueboxDecodeText,
  blueboxHeadroomDb,
  blueboxHeld,
  blueboxKeyCount,
  blueboxLevelDb,
  blueboxSlotCounts,
} from './bluebox-face-model';
import { BLUEBOX_BUTTON_NAMES, blueboxDef, buttonParamId } from '$lib/audio/modules/bluebox';
import type { BlueboxButtonName } from '$lib/audio/modules/bluebox';

const SR = 48000;
const BLOCK = 128;

/** Held-key set from a plain list — the shape every clause below reasons in. */
function keys(...names: string[]): ReadonlySet<BlueboxButtonName> {
  return new Set(names as BlueboxButtonName[]);
}

/** A `read` that reports the listed keys at 1 and everything else at rest. */
function readHolding(...names: string[]): (id: string) => number | undefined {
  const held = new Set(names);
  return (id) => {
    for (const n of BLUEBOX_BUTTON_NAMES) if (buttonParamId(n) === id) return held.has(n) ? 1 : 0;
    return undefined;
  };
}

// ── §1 · THE PIN: the model against the REAL worklet processor ──────────────

interface WorkletLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
type ProcCtor = new (opts?: unknown) => WorkletLike;

let Proc: ProcCtor;

beforeAll(async () => {
  // Per memory `dsp-worklet-no-top-level-export`, the worklet entry exports
  // nothing — capture the class by swapping in a recording registerProcessor.
  const g = globalThis as unknown as {
    sampleRate?: number;
    registerProcessor?: (n: string, c: ProcCtor) => void;
  };
  g.sampleRate = SR;
  const prev = g.registerProcessor;
  let registered: ProcCtor | null = null;
  g.registerProcessor = (_n, ctor) => {
    registered = ctor;
  };
  await import('../../../../../dsp/src/bluebox');
  g.registerProcessor = prev;
  if (!registered) throw new Error('bluebox.ts did not registerProcessor()');
  Proc = registered;
});

/** Render `seconds` of the real processor with `held` keys down, and report the
 *  absolute peak + RMS over everything after the one-pole attack settles. */
function measure(held: readonly string[], seconds = 4): { peak: number; rms: number } {
  const p = new Proc();
  const params: Record<string, Float32Array> = {};
  for (const n of BLUEBOX_BUTTON_NAMES) {
    params[buttonParamId(n)] = new Float32Array([held.includes(n) ? 1 : 0]);
  }
  // 12 inputs, all unpatched — the param is the only source, exactly as a
  // faceplate/group-bar write reaches the worklet.
  const inputs: Float32Array[][] = BLUEBOX_BUTTON_NAMES.map(() => []);
  const total = Math.floor((seconds * SR) / BLOCK) * BLOCK;
  const skip = Math.floor(SR / 10);
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < total; i += BLOCK) {
    const buf = new Float32Array(BLOCK);
    p.process(inputs, [[buf]], params);
    for (let j = 0; j < BLOCK; j++) {
      if (i + j < skip) continue;
      const v = buf[j]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
      n++;
    }
  }
  return { peak, rms: Math.sqrt(sumSq / n) };
}

describe('bluebox face model — §1 PINNED to the real worklet processor', () => {
  // Every case: the held keys, and the MEASURED peak from the shipping class.
  // The peak column is a BOUND check, not equality — see the note below.
  const CASES: readonly (readonly string[])[] = [
    ['1'],
    ['5'],
    ['bluebox'],
    ['redbox'],
    ['1', '4'],
    ['1', '5'],
    ['1', '2'],
    ['2', '5'],
    ['1', '2', '3'],
    ['2', '5', '8', '0'],
    ['1', '2', '3', '4', '5', '6', '7', '8'],
    [...BLUEBOX_BUTTON_NAMES],
  ];

  it('the RMS law reproduces the shipping DSP to 0.01 dB on twelve key sets', () => {
    const rows: string[] = [];
    for (const held of CASES) {
      const m = measure(held);
      const predictedDb = blueboxLevelDb(keys(...held));
      const measuredDb = 20 * Math.log10(m.rms);
      rows.push(
        `{${held.join(',')}} measured ${measuredDb.toFixed(3)} dB, model ${predictedDb.toFixed(3)} dB`,
      );
      expect(
        Math.abs(measuredDb - predictedDb),
        `{${held.join(',')}}: the RMS law drifted from the DSP — ${rows[rows.length - 1]}`,
      ).toBeLessThan(0.01);
    }
  }, 60_000);

  it('the HEADROOM law is a true upper bound, TIGHT at one key and loose at twelve', () => {
    // The coherent bound `P · activations` is only reached when every slot's
    // phase aligns. Two incommensurate sines get there; ten do not inside any
    // window a player waits through. So the bound must never be EXCEEDED (that
    // would make the readout a lie in the dangerous direction) and must be
    // tight where the module actually lives.
    for (const held of CASES) {
      const m = measure(held);
      const bound = BLUEBOX_ACTIVATION_PEAK * blueboxSlotCounts(keys(...held)).activations;
      expect(m.peak, `{${held.join(',')}}: measured peak EXCEEDS the headroom bound`).toBeLessThanOrEqual(
        bound + 1e-4,
      );
    }
    // Tight at one key (measured 0.0625 / 0.1250 — the bound exactly)…
    expect(measure(['bluebox']).peak).toBeCloseTo(BLUEBOX_ACTIVATION_PEAK, 4);
    expect(measure(['1']).peak).toBeCloseTo(BLUEBOX_ACTIVATION_PEAK * 2, 3);
    // …and knowingly loose at twelve: 1.3304 measured against a 1.4375 bound.
    const all = measure([...BLUEBOX_BUTTON_NAMES]);
    expect(all.peak).toBeGreaterThan(1.3);
    expect(all.peak).toBeLessThan(BLUEBOX_ACTIVATION_PEAK * 23);
  }, 60_000);

  it('BLUEBOX_ACTIVATION_PEAK is the MEASURED per-activation peak, not a typed constant', () => {
    // THE ANCHOR for the one mirrored number. BLUEBOX (a single 2600 Hz tone)
    // is the only key that makes exactly one activation, so its peak IS
    // BUTTON_VOICE_AMP × OUTPUT_NORM read straight off the shipping worklet.
    // Change either constant in packages/dsp/src/bluebox.ts and this fails.
    expect(measure(['bluebox']).peak).toBeCloseTo(BLUEBOX_ACTIVATION_PEAK, 5);
  }, 30_000);

  it('the bank MEMBERSHIP and ORDER match the worklet’s own dedup', () => {
    expect(BLUEBOX_SLOT_HZ).toEqual([697, 770, 852, 941, 1209, 1336, 1477, 1700, 2200, 2600]);
    expect([...BLUEBOX_SLOT_HZ].sort((a, b) => a - b)).toEqual([...BLUEBOX_SLOT_HZ]);
    // TEN slots for TWELVE keys and 23 tone activations — the sentence the
    // whole faceplate exists to make visible, as an assertion.
    expect(BLUEBOX_SLOT_HZ.length).toBe(10);
    expect(blueboxSlotCounts(keys(...BLUEBOX_BUTTON_NAMES)).activations).toBe(23);
    expect(blueboxSlotCounts(keys(...BLUEBOX_BUTTON_NAMES)).lit).toBe(10);
  });

  it('the picture’s FIXED scale is DERIVED — 4, column 1336, keys 2/5/8/0', () => {
    expect(BLUEBOX_MAX_SLOT_KEYS).toBe(4);
    const i1336 = BLUEBOX_SLOT_HZ.indexOf(1336);
    expect(BLUEBOX_SLOT_KEYS[i1336]).toEqual(['2', '5', '8', '0']);
    // No bar can ever exceed the axis — which is the claim "a bar growing is a
    // bar growing rather than the axis rescaling" reduces to.
    for (const bar of blueboxBankBars(keys(...BLUEBOX_BUTTON_NAMES))) {
      expect(bar.height, `slot ${bar.hz} overflows the fixed axis`).toBeLessThanOrEqual(1);
    }
  });

  it('the worklet’s `>= 0.5` threshold is the model’s threshold', () => {
    // NOT a rounding detail: `curve: 'discrete'` on the def says 0.00-0.49 is
    // one state and 0.50-1.00 is the other, and this is what makes that true of
    // the faceplate too. A linear readback would smear it.
    const at = (v: number) => blueboxHeld((id) => (id === buttonParamId('5') ? v : 0));
    expect(at(0.49).size, '0.49 must contribute NOTHING').toBe(0);
    expect(at(0.5).size, '0.50 must contribute FULLY').toBe(1);
    expect(blueboxLevelDb(at(0.49))).toBe(-Infinity);
    expect(blueboxLevelDb(at(0.5))).toBeCloseTo(blueboxLevelDb(keys('5')), 10);
  });
});

// ── §2 · THE NEGATIVE CONTROLS, in both directions ──────────────────────────

describe('bluebox face model — §2 each readout is BLIND to what another one sees', () => {
  const A = keys('1', '4'); // share COLUMN 1209 → one slot at 2×
  const B = keys('1', '5'); // share nothing      → four independent slots
  const C = keys('1', '2'); // share ROW 697      → one slot at 2×

  it('LEVEL sees the shared-oscillator `+=` — {1,4} is 1.76 dB over {1,5}', () => {
    const delta = blueboxLevelDb(A) - blueboxLevelDb(B);
    expect(delta).toBeGreaterThan(1.7);
    expect(delta).toBeLessThan(1.82);
    // …and it is not merely "a bigger number": the mechanism is one slot at 2A
    // carrying 4× the power of two at A.
    expect(blueboxSlotCounts(A).counts[BLUEBOX_SLOT_HZ.indexOf(1209)]).toBe(2);
    expect(Math.max(...blueboxSlotCounts(B).counts)).toBe(1);
  });

  it('HEADROOM is BLIND to it — identical for {1,4} and {1,5} (the negative control)', () => {
    // If this ever starts DIFFERING, `headroom` has stopped being level's
    // control and one of the two readouts is now redundant.
    expect(blueboxHeadroomDb(A)).toBe(blueboxHeadroomDb(B));
    expect(blueboxSlotCounts(A).activations).toBe(blueboxSlotCounts(B).activations);
  });

  it('…and LEVEL is blind where HEADROOM is not — {1} vs {BLUEBOX}', () => {
    // The mirror leg. One digit makes two activations, BLUEBOX one, so headroom
    // differs by exactly 6.02 dB while `keys held` reads 1 for both.
    expect(blueboxHeadroomDb(keys('bluebox')) - blueboxHeadroomDb(keys('1'))).toBeCloseTo(6.02, 1);
    expect(blueboxKeyCount(keys('1'))).toBe(blueboxKeyCount(keys('bluebox')));
  });

  it('THE FOILS are blind to everything that matters — keys held and activations', () => {
    // Published on the faceplate ON PURPOSE, next to the hero, so a player can
    // watch which number moved. Both read the same for A and B.
    expect(blueboxKeyCount(A)).toBe(blueboxKeyCount(B));
    expect(blueboxSlotCounts(A).activations).toBe(blueboxSlotCounts(B).activations);
    // `lit of activations` is the two-digit statement of the collapse.
    expect(blueboxSlotCounts(A).lit).toBe(3);
    expect(blueboxSlotCounts(B).lit).toBe(4);
  });

  it('DECODES is not a function of counts — {1,4} and {1,2} agree on every number', () => {
    expect(blueboxKeyCount(A)).toBe(blueboxKeyCount(C));
    expect(blueboxSlotCounts(A).activations).toBe(blueboxSlotCounts(C).activations);
    expect(blueboxSlotCounts(A).lit).toBe(blueboxSlotCounts(C).lit);
    expect(blueboxLevelDb(A)).toBeCloseTo(blueboxLevelDb(C), 10);
    expect(blueboxHeadroomDb(A)).toBe(blueboxHeadroomDb(C));
    // …and they are different things to a receiver.
    expect(blueboxDecodeText(A)).toBe('2 rows · 1 col');
    expect(blueboxDecodeText(C)).toBe('1 row · 2 cols');
  });

  it('DECODES is INVARIANT to an in-band tone while all three others move', () => {
    // The historical fact the module is named after, as an assertion: 2600 Hz
    // is outside the DTMF band, so a Bell receiver still hears digit 1.
    const one = keys('1');
    const oneAndTrunk = keys('1', 'bluebox');
    expect(blueboxDecodeText(one)).toBe('digit 1');
    expect(blueboxDecodeText(oneAndTrunk)).toBe('digit 1');
    expect(blueboxKeyCount(oneAndTrunk)).not.toBe(blueboxKeyCount(one));
    expect(blueboxLevelDb(oneAndTrunk)).not.toBeCloseTo(blueboxLevelDb(one), 2);
    expect(blueboxHeadroomDb(oneAndTrunk)).not.toBeCloseTo(blueboxHeadroomDb(one), 2);
  });

  it('every digit decodes as itself, and the two phreak keys decode as neither', () => {
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(blueboxDecodeText(keys(d))).toBe(`digit ${d}`);
    }
    expect(blueboxDecodeText(keys('bluebox'))).toBe('in-band only');
    expect(blueboxDecodeText(keys('redbox'))).toBe('in-band only');
    expect(blueboxDecodeText(keys())).toBe('silent');
  });

  it('SILENCE is a distinct answer, not a zero', () => {
    expect(blueboxLevelDb(keys())).toBe(-Infinity);
    expect(blueboxHeadroomDb(keys())).toBe(Infinity);
    expect(blueboxSlotCounts(keys()).lit).toBe(0);
  });
});

// ── §3 · THE PICTURE + THE RANKING ──────────────────────────────────────────

describe('bluebox face model — §3 the bank picture and the keypad ranking', () => {
  it('every slot is drawn at rest, carrying its band, capacity and keys', () => {
    const bars = blueboxBankBars(keys());
    expect(bars).toHaveLength(10);
    expect(bars.every((b) => b.count === 0 && b.height === 0)).toBe(true);
    // A silent rack still shows the ARCHITECTURE — capacity and key list are
    // what make the picture legible before anything is held.
    expect(bars.map((b) => b.capacity)).toEqual([3, 3, 3, 1, 3, 4, 3, 1, 1, 1]);
    expect(bars.map((b) => b.band)).toEqual([
      'row', 'row', 'row', 'row', 'col', 'col', 'col', 'inband', 'inband', 'inband',
    ]);
    expect(BLUEBOX_SLOT_BAND.filter((b) => b === 'row')).toHaveLength(BLUEBOX_ROW_HZ.length);
    expect(BLUEBOX_SLOT_BAND.filter((b) => b === 'col')).toHaveLength(BLUEBOX_COL_HZ.length);
  });

  it('the two CAPTION MODES always differ — the panel’s operability probe', () => {
    // faces-parity drives the label button and asserts the caption row's TEXT
    // changed. That is only a real liveness claim if the two modes can never
    // render the same string, so it is asserted here rather than assumed there.
    for (const bar of blueboxBankBars(keys())) {
      expect(blueboxBarCaption(bar, 'hz')).not.toBe(blueboxBarCaption(bar, 'keys'));
      expect(blueboxBarCaption(bar, 'keys').length).toBeGreaterThan(0);
    }
  });

  it('THE RANKING IS THE KEYPAD — face.order is DERIVED from the pad layout', () => {
    // ⚠ THE ONE DESIGN CLAIM THIS FACE MAKES, made checkable.
    //
    // `face.order` is a PRIORITY ranking for the tiers that show a subset, and a
    // telephone keypad has no priority — so this face ranks by LAYOUT instead,
    // and the property that buys is that EVERY PREFIX OF THE RANKING IS STILL A
    // RECOGNISABLE KEYPAD FRAGMENT (the 6-cell lane plate is the top two rows of
    // a phone; the compact tile is `1 2`). Any "principled" reorder — importance,
    // ascending frequency, or the genuinely minimal bank cover
    // {1,5,9,0,BLUEBOX,REDBOX}, which really is the smallest set of keys that
    // lights all ten oscillators — produces a truncation that is not a keypad.
    //
    // Asserting it against BLUEBOX_BUTTON_NAMES (the array the CARD lays out
    // from) is what stops it drifting into a hand-typed order that merely looks
    // like one.
    const ranked = blueboxDef.face?.order ?? [];
    expect(ranked.slice(0, BLUEBOX_BUTTON_NAMES.length)).toEqual(
      BLUEBOX_BUTTON_NAMES.map(buttonParamId),
    );
    // The hero panel is rank 13 — after every key, because a panel's first legal
    // rank is 7 (module-face-lint: a panel selected at a lane tier is a 380 px
    // picture in a 46 px knob column) and the keys already fill 1-12.
    expect(ranked[BLUEBOX_BUTTON_NAMES.length]).toBe('bluebox-tonebank-{n}');
    expect(ranked).toHaveLength(13);
  });

  it('all twelve keys are declared MOMENTARY — none latches', () => {
    expect([...(blueboxDef.face?.momentary ?? [])].sort()).toEqual(
      BLUEBOX_BUTTON_NAMES.map(buttonParamId).sort(),
    );
  });

  it('the READ is total over the def’s params, and rest-safe', () => {
    // A node with no stored params (fresh spawn) must read as silence, not NaN.
    expect(blueboxHeld(() => undefined).size).toBe(0);
    expect(blueboxHeld(() => Number.NaN).size).toBe(0);
    expect(blueboxHeld(readHolding('5')).size).toBe(1);
    expect(blueboxDecodeText(blueboxHeld(readHolding('5')))).toBe('digit 5');
    // …and it reads exactly the def's twelve params, no more.
    expect(blueboxDef.params.map((p) => p.id).sort()).toEqual(
      BLUEBOX_BUTTON_NAMES.map(buttonParamId).sort(),
    );
  });
});
