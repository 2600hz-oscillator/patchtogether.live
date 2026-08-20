// packages/web/src/lib/ui/modules/charlottes-echos-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for CHARLOTTE'S ECHOS's five derived values.
//
// A derived readout earns its slot only if it is negative-controlled on the
// input a KNOB READBACK IS BLIND TO — permanently, on every run, not once at
// authoring time (`face-readout-values.ts`, and the kick-drum TAIL case that put
// the rule there). Each one below therefore ships with the exact knob it beats,
// asserted as an INVARIANCE on that knob's own value and a MOVEMENT on the
// readout, in the same leg.
//
//   tail    beats BOTH loop dials, and the leg that proves it is a pair of
//           patches with the SAME FEEDBACK where one stops and one does not —
//           and a second pair with the same DECAY. Its negative control is MIX,
//           which moves the level 9.8 dB and the tail 0.00 s.
//   climb   beats PITCH, which reads `0.10` for a +990 ¢ interval, and is
//           INVARIANT to all four other params — the leg that makes it a third
//           readout rather than a third view of the tail.
//   spacing beats DELAY, which prints the same number on both sides of the
//           +45 ms step PITCH introduces.
//   loop gain / margin are the same law in two units and BOTH are flat in MIX
//           and in DELAY — while `tail`, sitting beside them, moves 76× across
//           the DELAY travel at a bit-identical loop gain. Two readouts that
//           respond differently to one knob is the cheapest possible proof that
//           one is a law and the other includes the clock.
//
// The claims that are about AUDIO — the law itself, the boundary, the grain
// discontinuity, the climb, MIX's flatness — are re-derived from the SHIPPING
// worklet by `art/scenarios/charlottes-echos/face-law.test.ts`. This file is the
// pure half: it never renders, so it is free to run on every unit sweep.

import { describe, expect, it } from 'vitest';
import { charlottesEchosDef } from '$lib/audio/modules/charlottes-echos';
import {
  CE_CLIMB_EXPONENT,
  CE_GRAIN_LAG_MS,
  CE_SHIFTER_BYPASS_EPS,
  CE_STAGES,
  CE_TAIL_HORIZON_S,
  ceClimbCents,
  ceClimbText,
  ceDecayMargin,
  ceDecays,
  ceFeedbackMargin,
  ceGrainLagMs,
  ceLoopGain,
  ceLoopText,
  ceMarginText,
  ceShifterEngaged,
  ceSpacingText,
  ceStageLoopGain,
  ceTailSeconds,
  ceTailText,
  charlottesEchosFaceParams,
} from './charlottes-echos-face-model';

/** A param reader over an explicit override map — the shape `FaceReadoutValue`
 *  is handed, including `undefined` for untouched params. */
function reader(over: Record<string, number> = {}) {
  return (id: string): number | undefined => over[id];
}
const at = (over: Record<string, number> = {}) => charlottesEchosFaceParams(reader(over));

/** Every param at its declared default — a freshly spawned node. */
const SPAWN = at();

const IDS = ['ce-tail', 'ce-climb', 'ce-spacing', 'ce-loop-gain', 'ce-margin'] as const;
const PARAM_IDS = charlottesEchosDef.params.map((p) => p.id);

describe('charlottes-echos face model: the params the readouts read', () => {
  it('an UNTOUCHED param reads its DEF DEFAULT, not zero', () => {
    // `node.params` is a sparse overlay of what has been touched. Reading it
    // bare would print a tail for a module whose loop is not where it says.
    for (const p of charlottesEchosDef.params) {
      expect(
        (SPAWN as unknown as Record<string, number>)[p.id],
        `${p.id} must fall back to its def default`,
      ).toBe(p.defaultValue);
    }
  });

  it('an out-of-range value is CLAMPED to the def range, not believed', () => {
    // A corrupt save saying `feedback: 99` must not print a tail the module
    // cannot produce; the AudioParam would clamp it, so the readout does too.
    const wild = at({ feedback: 99, decay: -5, delay: 99, pitchUp: 99, mix: -1 });
    for (const p of charlottesEchosDef.params) {
      const v = (wild as unknown as Record<string, number>)[p.id]!;
      expect(v, `${p.id} must be inside [${p.min}, ${p.max}]`).toBeGreaterThanOrEqual(p.min);
      expect(v, `${p.id} must be inside [${p.min}, ${p.max}]`).toBeLessThanOrEqual(p.max);
    }
  });

  it('the CLIMB exponent is DERIVED from the stage count, never typed', () => {
    // 1 + 2 + … + (CE_STAGES − 1): stage 0 always runs at rate 1. A fifth stage
    // must flow through every function here untouched.
    let sum = 0;
    for (let k = 1; k < CE_STAGES; k++) sum += k;
    expect(CE_CLIMB_EXPONENT).toBe(sum);
  });
});

describe('charlottes-echos LOOP GAIN: the product neither dial can print', () => {
  it('the largest stage gain is the LAST one, and it is scanned rather than assumed', () => {
    // The face model takes a max over stages instead of indexing CE_STAGES−1, so
    // a sign change in the drive law cannot leave it reading the wrong stage.
    for (const p of [SPAWN, at({ decay: 1 }), at({ decay: 0 }), at({ feedback: 1, decay: 0.5 })]) {
      const gains = Array.from({ length: CE_STAGES }, (_, k) => ceStageLoopGain(p, k));
      expect(ceLoopGain(p)).toBe(Math.max(...gains));
    }
  });

  it('THE HEADLINE — the shipped default sits 0.12 of DECAY and 0.11 of FEEDBACK from never stopping', () => {
    expect(ceLoopGain(SPAWN), 'units: dimensionless in-loop gain at the last stage')
      .toBeCloseTo(0.8159, 4);
    expect(ceDecays(SPAWN)).toBe(true);
    expect(ceDecayMargin(SPAWN), 'units: DECAY dial units to the boundary').toBeCloseTo(0.1156, 4);
    expect(ceFeedbackMargin(SPAWN), 'units: FEEDBACK dial units').toBeCloseTo(0.1128, 4);
    expect(ceMarginText(SPAWN)).toBe('DECAY +0.12 · FBK +0.11');
    expect(ceLoopText(SPAWN)).toBe('0.82x');
  });

  it('at DECAY 0 the FEEDBACK dial alone CANNOT reach the boundary — and it says so', () => {
    // 1 / 0.995 = 1.005, past the dial's own max. The margin prints an em dash
    // rather than a number, because "0.505 more feedback" would name a position
    // that does not exist.
    expect(ceFeedbackMargin(at({ decay: 0 }))).toBe(Number.POSITIVE_INFINITY);
    expect(ceMarginText(at({ decay: 0 }))).toContain('FBK —');
    expect(ceDecays(at({ decay: 0, feedback: 1 })), 'the top of the FEEDBACK dial still decays')
      .toBe(true);
  });

  it('NEGATIVE CONTROL — both numbers are EXACTLY flat in MIX and in DELAY', () => {
    // MIX is outside every loop and DELAY is not in the expression at all. This
    // is the leg that separates them from `tail`, which moves on both.
    const seen = new Set<string>();
    const gains = new Set<number>();
    for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
      for (const delay of [0.001, 0.05, 0.4, 1.5]) {
        const p = at({ mix, delay });
        seen.add(ceMarginText(p));
        gains.add(ceLoopGain(p));
      }
    }
    expect([...seen], 'the margin must not move with MIX or DELAY').toEqual([ceMarginText(SPAWN)]);
    expect(gains.size, 'the loop gain must not move with MIX or DELAY').toBe(1);
  });

  it('POSITIVE CONTROL — it moves on EACH loop dial separately', () => {
    expect(ceLoopGain(at({ feedback: 0.6 }))).toBeGreaterThan(ceLoopGain(SPAWN));
    expect(ceLoopGain(at({ decay: 0.3 }))).toBeGreaterThan(ceLoopGain(SPAWN));
    expect(ceMarginText(at({ decay: 0.45 }))).toBe('PAST');
    expect(ceLoopText(at({ decay: 0.45 }))).toMatch(/PAST$/);
  });
});

describe('charlottes-echos TAIL: the readout neither loop dial can give you', () => {
  it('THE JOIN — the SAME FEEDBACK, one patch that stops and one that never does', () => {
    // This is the whole argument for deriving it. A `paramId: 'feedback'` readout
    // prints `0.50` in both rows below; the module rings for 1.9 s in one and
    // forever in the other.
    const stops = at({ feedback: 0.5, decay: 0.2, delay: 0.15 });
    const never = at({ feedback: 0.5, decay: 0.35, delay: 0.15 });
    expect(stops.feedback, 'the FEEDBACK readback in both rows').toBe(never.feedback);
    expect(ceTailText(stops)).toBe('1.9 s');
    expect(ceTailText(never)).toMatch(/^NEVER DECAYS/);

    // …and the mirror: the SAME DECAY, one that stops and one that does not.
    const stops2 = at({ feedback: 0.5, decay: 0.25, delay: 0.15 });
    const never2 = at({ feedback: 0.65, decay: 0.25, delay: 0.15 });
    expect(stops2.decay).toBe(never2.decay);
    expect(ceDecays(stops2)).toBe(true);
    expect(ceDecays(never2)).toBe(false);

    // ⚠ AND THE FLIP POINT ITSELF DEPENDS ON THE OTHER DIAL, which is why no
    // per-dial threshold could stand in for the product.
    const flipAt = (decay: number) => {
      let fb = 0;
      while (fb <= 1 && ceDecays(at({ decay, feedback: fb }))) fb += 0.001;
      return fb;
    };
    // 1 / (0.995 · (1 + DECAY·3.2)) — the law's own root, and it moves by a
    // sixth of the FEEDBACK dial across two ordinary DECAY settings.
    expect(flipAt(0.2), 'units: FEEDBACK dial position at DECAY 0.2').toBeCloseTo(0.613, 2);
    expect(flipAt(0.4), 'units: FEEDBACK dial position at DECAY 0.4').toBeCloseTo(0.441, 2);
  });

  it('NEGATIVE CONTROL — MIX cannot move it at all', () => {
    // MIX is a pure output crossfade, after every loop. A tail derived from
    // LEVEL would track it (measured: 9.8 dB of level across this sweep); this
    // one must not move by a character.
    const seen = new Set<string>();
    for (const mix of [0, 0.1, 0.25, 0.5, 0.75, 1]) seen.add(ceTailText(at({ mix })));
    expect([...seen], 'MIX is outside every loop — see the ART face-law MIX leg')
      .toEqual([ceTailText(SPAWN)]);
  });

  it('THIRD LEG — DELAY moves it 76× while the loop gain is BIT-IDENTICAL', () => {
    // The round trip is DELAY / CE_STAGES, so the same loss per round trip is a
    // different loss per second. A readout derived from the loop gain alone —
    // `ce-loop-gain`, sitting right beside this one — is blind to all of it, and
    // that difference is asserted rather than described.
    const short = at({ delay: 0.02 });
    const long = at({ delay: 1.5 });
    expect(ceLoopGain(short), 'the loop gain is not a function of DELAY').toBe(ceLoopGain(long));
    expect(ceLoopText(short)).toBe(ceLoopText(long));
    expect(ceMarginText(short)).toBe(ceMarginText(long));
    const ratio = ceTailSeconds(long) / ceTailSeconds(short);
    expect(ratio, 'units: ratio of tail SECONDS across the DELAY travel').toBeGreaterThan(50);
    expect(ceTailText(short)).not.toBe(ceTailText(long));
  });

  it('the tail is the FOUR-STAGE cascade, not a dominant pole', () => {
    // At DECAY 0 the drive is an exact bypass, so all four stage gains are
    // IDENTICAL and the cascade has a repeated pole that rings far longer than
    // one stage would. The dominant-pole form gives 0.6 s here; the worklet is
    // still audible at 12 s (art face-law), and this model says 9.8 s.
    const p = at({ feedback: 0.95, decay: 0, delay: 0.15 });
    const gains = Array.from({ length: CE_STAGES }, (_, k) => ceStageLoopGain(p, k));
    expect(new Set(gains).size, 'at DECAY 0 every stage has the same loop gain').toBe(1);
    const dominantPole = (60 / (-20 * Math.log10(ceLoopGain(p)))) * (p.delay / CE_STAGES);
    expect(dominantPole, 'units: seconds, the WRONG (one-pole) estimate').toBeCloseTo(4.6, 1);
    expect(ceTailSeconds(p), 'units: seconds, the cascade estimate').toBeCloseTo(9.8, 1);
    expect(
      ceTailSeconds(p) / dominantPole,
      'the repeated pole more than DOUBLES the tail — that gap is why the model runs ' +
        'the recurrence instead of closing the form',
    ).toBeGreaterThan(2);
  });

  it('past the declared HORIZON it says so, and that is not the same as NEVER', () => {
    // Two different statements: "the loop gain reached 1" is a stability fact;
    // "longer than we looked" is a measurement limit. Conflating them would
    // print a stability warning on a patch that is merely very long.
    const long = at({ feedback: 1, decay: 0, delay: 0.15 });
    expect(ceDecays(long), 'the loop gain is still under 1 here').toBe(true);
    expect(ceTailSeconds(long)).toBe(Number.POSITIVE_INFINITY);
    expect(ceTailText(long)).toBe(`> ${CE_TAIL_HORIZON_S} s`);
    expect(ceTailText(at({ decay: 0.45 }))).toMatch(/^NEVER DECAYS/);
  });
});

describe('charlottes-echos CLIMB: the interval the dial does not print', () => {
  it('POSITIVE CONTROL — the dial reads 0.10 and the interval is most of an octave', () => {
    expect(ceClimbCents(at({ pitchUp: 0.05 })), 'units: cents').toBeCloseTo(506.8, 1);
    expect(ceClimbCents(at({ pitchUp: 0.1 })), 'units: cents').toBeCloseTo(990.0, 1);
    expect(ceClimbText(at({ pitchUp: 0.1 }))).toBe(`+990 ¢ by head ${CE_STAGES}`);
  });

  it('the BYPASS is a step, not a ramp — and it is the shifter’s own threshold', () => {
    expect(ceShifterEngaged(at({ pitchUp: 0 }))).toBe(false);
    expect(ceShifterEngaged(at({ pitchUp: CE_SHIFTER_BYPASS_EPS / 10 }))).toBe(false);
    expect(ceShifterEngaged(at({ pitchUp: CE_SHIFTER_BYPASS_EPS }))).toBe(true);
    expect(ceClimbText(at({ pitchUp: 0 }))).toBe('at pitch');
    expect(ceGrainLagMs(at({ pitchUp: 0 })), 'units: ms').toBe(0);
    expect(ceGrainLagMs(at({ pitchUp: CE_SHIFTER_BYPASS_EPS })), 'units: ms')
      .toBe((CE_STAGES - 1) * CE_GRAIN_LAG_MS);
  });

  it('NEGATIVE CONTROL — no other param can move it, while TAIL moves on three of them', () => {
    // Publishing both is the instrument's own control: a shared bug in the
    // reader would move them together.
    const seen = new Set<string>();
    for (const feedback of [0, 0.5, 1]) {
      for (const decay of [0, 0.5, 1]) {
        for (const delay of [0.001, 0.4, 1.5]) {
          for (const mix of [0, 1]) seen.add(ceClimbText(at({ feedback, decay, delay, mix })));
        }
      }
    }
    expect([...seen], 'CLIMB is a function of PITCH alone').toEqual(['at pitch']);
    const tails = new Set(
      [0.1, 0.5, 0.9].flatMap((feedback) =>
        [0.02, 0.4, 1.5].map((delay) => ceTailText(at({ feedback, delay }))),
      ),
    );
    expect(tails.size, 'TAIL moves across the same sweep — the pair is each other’s control')
      .toBeGreaterThan(5);
  });
});

describe('charlottes-echos SPACING: the +45 ms a DELAY readback cannot see', () => {
  it('NEGATIVE CONTROL — PITCH 0 → 1e-9 moves it while DELAY is untouched', () => {
    const before = at({ delay: 0.4, pitchUp: 0 });
    const after = at({ delay: 0.4, pitchUp: CE_SHIFTER_BYPASS_EPS });
    // The knob readback a face would reach for first is bit-identical…
    expect(after.delay, 'the DELAY readback in both states').toBe(before.delay);
    // …and the real first echo moved 45 ms (art face-law measures it on the
    // shipping worklet).
    expect(ceSpacingText(before)).not.toBe(ceSpacingText(after));
    expect(ceGrainLagMs(after) - ceGrainLagMs(before), 'units: ms').toBe(
      (CE_STAGES - 1) * CE_GRAIN_LAG_MS,
    );
  });

  it('it REFUSES to print a total once the grain is engaged', () => {
    // The offset is +45.000 ms in the limit and then anywhere in 16.6–25.2 ms
    // depending on grain phase, which is not a function of any param. Printing
    // `416.6 ms` would invent precision the DSP does not have — so the assertion
    // is on the STRING FORM, not just the value.
    expect(ceSpacingText(at({ delay: 0.4, pitchUp: 0 }))).toBe('400 ms');
    expect(ceSpacingText(at({ delay: 0.4, pitchUp: 0.05 }))).toBe('400 ms + grain');
    expect(
      ceSpacingText(at({ delay: 0.4, pitchUp: 0.05 })).match(/\d+(\.\d+)?/g),
      'exactly ONE number may appear — a second would be the invented total',
    ).toHaveLength(1);
  });

  it('the UNIT is ms while the param is s — the 1000× a shared label would hide', () => {
    expect(charlottesEchosDef.params.find((p) => p.id === 'delay')!.units).toBe('s');
    expect(ceSpacingText(at({ delay: 1.5 }))).toBe('1500 ms');
    expect(ceSpacingText(at({ delay: 0.001 }))).toBe('1.0 ms');
  });
});

describe('charlottes-echos face.order: FEEDBACK is ranked FIRST', () => {
  it('the ranking premise, asserted: FEEDBACK is the only loop dial with no CV jack', () => {
    // Rank 1 is what MINI shows. DELAY is ranked below both loop controls partly
    // because it is the one control a patcher can reach WITHOUT the dial — if a
    // second CV jack ever lands on `feedback`, this argument needs re-making,
    // and this assertion is what forces that.
    const cvTargets = new Set(
      charlottesEchosDef.inputs.filter((i) => i.paramTarget).map((i) => i.paramTarget!),
    );
    expect([...cvTargets].sort(), 'the declared paramTarget inputs').toEqual(['delay']);
    expect(charlottesEchosDef.face?.order[0]).toBe('feedback');
    expect(charlottesEchosDef.face?.hero?.control).toBe('feedback');
  });

  it('face.order is exactly the declared params, and pages partition it', () => {
    // Derived membership in both directions — never a count.
    const order = [...(charlottesEchosDef.face?.order ?? [])];
    expect(order.slice().sort()).toEqual([...PARAM_IDS].sort());
    const paged = (charlottesEchosDef.face?.pages ?? []).flatMap((p) => [...p.controls]);
    expect(paged.slice().sort(), 'every ranked key appears on exactly one page')
      .toEqual(order.slice().sort());
  });
});

describe('charlottes-echos readouts are TOTAL — they run on every frame', () => {
  const HOSTILE: (number | undefined)[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    99,
    0,
    undefined,
  ];

  it('the tail model TERMINATES on every corner of the param space', () => {
    // It runs a bounded recurrence, so an unreachable −60 dB point must return
    // the horizon rather than spin. The corners are where a `while` would.
    for (const feedback of [0, 1]) {
      for (const decay of [0, 1]) {
        for (const delay of [0.001, 1.5]) {
          const t = ceTailSeconds(at({ feedback, decay, delay }));
          expect(
            Number.isFinite(t) || t === Number.POSITIVE_INFINITY,
            `tail at fb=${feedback} decay=${decay} delay=${delay}`,
          ).toBe(true);
        }
      }
    }
  });
});
