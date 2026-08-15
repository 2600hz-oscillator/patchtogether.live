// packages/web/src/lib/ui/modules/buggles-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS FOR THE BUGGLES FACEPLATE.
//
// A derived readout earns its slot by being negative-controlled on the input a
// KNOB READBACK WOULD BE BLIND TO — permanently, on every run, not once at
// authoring time (`module-faceplates.md`, and the kick-drum TAIL case that put
// the rule there). This module has FIVE readouts, one per jack, and each one
// names the knob it beats:
//
//   smooth-glide  beats SMOOTH, which reads `0.50` for a glide of 2895 ms and
//                 for a glide of 79 ms depending on a knob it cannot see.
//   stepped-hold  beats RATE, which is blind to the +/-50% x CHAOS jitter term.
//   woggle-hz     beats RATE, which is a normalised 0..1 dial over a LOG map
//                 spanning 500x and prints no frequency at all.
//   burst-rate    beats BURST *and* every naive formula: the cluster is CUT by
//                 the next woggle event, so `p x rate x 5` is 5x wrong at the
//                 top of the RATE travel.
//   ring-hz       beats RATE by a factor of 4, and is the readout that puts the
//                 audit's finding on the panel — four doc strings called RING
//                 "audio-rate" while its carrier tops out at 12.5 Hz.
//
// ⚠ AND LEVEL MOVES NONE OF THEM, asserted in the same file as its inverse
// (every OTHER param moves at least one). That pair is deny-by-default over the
// module's whole param roster and is the table's own negative control — in the
// `clap-q` / `clap-bandwidth-hz` shape, where publishing both makes the
// instrument control itself.
//
// ⚠ THE GLYPH IS TESTED HERE TOO, because on a FIVE-OUTPUT module the glyph is
// a claim about WHICH output, and this def has the shape that makes the wrong
// answer invisible: exactly one jack is typed `audio`, so a glyph binds LIVE
// (no static fallback for a gate to notice) and paints one fifth of the module
// as the module. Both directions are asserted, so the `'none'` cannot silently
// become either a tap or an accident.
//
// PURE — no DOM, no engine. Every number is re-derived from the module's own
// exported constants on every run.

import { describe, expect, it } from 'vitest';
import {
  BUGGLES_AUDIBILITY_FLOOR_HZ,
  BUGGLES_BURST_GAP_MS,
  BUGGLES_BURST_MAX_PULSES,
  BUGGLES_BURST_MIN_PULSES,
  BUGGLES_BURST_PULSE_MS,
  BUGGLES_OUTPUT_READOUTS,
  BUGGLES_RING_DIVISOR,
  bugglesDef,
  bugglesMath,
  bugglesPrng,
} from '$lib/audio/modules/buggles';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import { isUsableReadout, readoutText } from '$lib/ui/workflow/dock-faceplate-model';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  bugglesBurstText,
  bugglesDeliveredBurstPulses,
  bugglesExpectedDeliveredPulses,
  bugglesFaceParams,
  bugglesNaiveBurstTriggersPerS,
  bugglesRingHz,
  bugglesRingText,
  bugglesSmoothGlideS,
  bugglesSmoothGlideText,
  bugglesSteppedHoldText,
  bugglesWoggleHz,
  bugglesWoggleText,
} from './buggles-face-model';

/** A reader over an explicit param map — the shape `FaceReadoutValue` gets. */
const reader =
  (params: Record<string, number | undefined>) =>
  (id: string): number | undefined =>
    params[id];

/** The def's own shipped spawn defaults. */
const DEFAULTS = Object.fromEntries(
  bugglesDef.params.map((p) => [p.id, p.defaultValue]),
) as Record<string, number>;

const P = (over: Record<string, number> = {}) => bugglesFaceParams(reader({ ...DEFAULTS, ...over }));

const PARAM_IDS = bugglesDef.params.map((p) => p.id);
/** The registered ids, DERIVED from the def's own declaration rather than
 *  typed — so a renamed readout is red from both directions. */
const VALUE_IDS = [
  ...(bugglesDef.face?.hero?.readouts ?? []),
  ...(bugglesDef.face?.sidebar ?? []).flatMap((b) => (b.kind === 'readouts' ? [...b.entries] : [])),
]
  .map((r) => r.valueId)
  .filter((v): v is string => !!v);

describe('buggles face model / the output table IS the declared jack roster', () => {
  it('BUGGLES_OUTPUT_READOUTS equals `outputs`, in order, in BOTH directions', () => {
    // The anchor that lets the roster be a second declaration of the port ids
    // without being a second SOURCE OF TRUTH. `outputs` stays a literal because
    // the module-manifest docs parser reads the def's source (the ninelives
    // finding), so the two are joined here instead.
    expect(BUGGLES_OUTPUT_READOUTS.map((r) => r.port)).toEqual(bugglesDef.outputs.map((o) => o.id));
  });

  it('every jack has a row and every row resolves a registered readout', () => {
    const block = bugglesDef.face?.sidebar?.find((b) => b.kind === 'readouts');
    expect(block, 'the face declares a readouts sidebar block').toBeDefined();
    const entries = (block as { entries: readonly { label: string; valueId?: string }[] }).entries;
    // Row labels ARE the port ids — a table of five holes, named for the holes.
    expect(entries.map((e) => e.label)).toEqual(bugglesDef.outputs.map((o) => o.id));
    for (const e of entries) {
      expect(faceReadoutValueFor(e.valueId!), `${e.valueId} must be registered`).not.toBeNull();
    }
    for (const r of bugglesDef.face?.hero?.readouts ?? []) {
      expect(faceReadoutValueFor(r.valueId!), `${r.valueId} must be registered`).not.toBeNull();
    }
  });

  it('EVERY declared readout PAINTS a value through the shell’s own resolver, not `—`', () => {
    // ⚠ THE LEG THAT CATCHES A REGISTRATION THAT IS PRESENT BUT WRONG.
    // `readoutText` prints `'—'` for an unresolvable id AND swallows a throw
    // into the same `'—'`, deliberately — a faceplate must keep rendering — so
    // a mis-registered or throwing readout is INVISIBLE at the pixel lane,
    // where the sidebar sweep only asks whether a block "renders a BODY".
    const read = reader({ ...DEFAULTS });
    const declared = [
      ...(bugglesDef.face?.hero?.readouts ?? []),
      ...(bugglesDef.face?.sidebar ?? []).flatMap((b) =>
        b.kind === 'readouts' ? [...b.entries] : [],
      ),
    ];
    // Non-vacuity: the walk must find the hero row AND one row per jack.
    expect(declared.length).toBe(
      (bugglesDef.face?.hero?.readouts ?? []).length + bugglesDef.outputs.length,
    );
    for (const r of declared) {
      expect(isUsableReadout(r), `${r.label}: exactly one of paramId/valueId/text`).toBe(true);
      const printed = readoutText(r, bugglesDef.params, read);
      expect(printed, `${r.label} must paint a value, not the unresolvable placeholder`).not.toBe(
        '—',
      );
      expect(printed.length, `${r.label} must not paint an empty string`).toBeGreaterThan(0);
    }
    // NEGATIVE CONTROL on this very leg: the same resolver DOES say `—` for an
    // id nobody registered, so the green above is a fact about the readouts
    // rather than about a resolver that never refuses.
    expect(readoutText({ label: 'x', valueId: 'buggles-nope' }, bugglesDef.params, read)).toBe('—');
  });
});

describe('buggles face model / LEVEL is the table’s own negative control', () => {
  it('LEVEL moves NONE of the five readouts, across its whole travel', () => {
    // It scales SMOOTH, STEPPED and RING and reaches neither gate jack, so it
    // changes no timing, no character and no derived quantity. A readout that
    // twitched here would be reading the wrong thing.
    const levelDef = bugglesDef.params.find((p) => p.id === 'level')!;
    for (const id of VALUE_IDS) {
      const fn = faceReadoutValueFor(id)!;
      const baseline = fn(reader({ ...DEFAULTS }));
      for (const level of [levelDef.min, 0.1, 0.5, 0.9, levelDef.max]) {
        expect(fn(reader({ ...DEFAULTS, level })), `${id} at LEVEL ${level}`).toBe(baseline);
      }
    }
  });

  it('INVERSE — every OTHER param moves at least one readout, so the pair is total', () => {
    // Without this leg an always-constant registry would pass the invariance
    // above. Deny-by-default over the module's whole param roster: a new param
    // with no derived consequence has to be argued for here.
    for (const paramId of PARAM_IDS) {
      const def = bugglesDef.params.find((p) => p.id === paramId)!;
      const moved = VALUE_IDS.filter((id) => {
        const fn = faceReadoutValueFor(id)!;
        const a = fn(reader({ ...DEFAULTS }));
        return [def.min, def.max].some((v) => fn(reader({ ...DEFAULTS, [paramId]: v })) !== a);
      });
      if (paramId === 'level') {
        expect(moved, 'LEVEL is the declared exception — see the leg above').toEqual([]);
      } else {
        expect(moved.length, `${paramId} must move at least one readout`).toBeGreaterThan(0);
      }
    }
  });
});

describe('buggles face model / SMOOTH GLIDE: the readout SMOOTH cannot give you', () => {
  it('THE JOIN — the SAME SMOOTH dial, a glide 36.5× apart', () => {
    // The whole argument in one assertion. A `paramId: 'smoothness'` readout
    // prints `0.50` in both rows; the module glides for nearly three seconds in
    // one and for a twelfth of a second in the other.
    const slow = P({ smoothness: 0.5, rate: 0.2 });
    const fast = P({ smoothness: 0.5, rate: 0.8 });
    expect(slow.smoothness, 'the SMOOTH readback in both rows').toBe(fast.smoothness);
    expect(bugglesSmoothGlideS(slow) * 1000, 'units: ms').toBeCloseTo(2895.4, 1);
    expect(bugglesSmoothGlideS(fast) * 1000, 'units: ms').toBeCloseTo(79.3, 1);
    expect(
      bugglesSmoothGlideS(slow) / bugglesSmoothGlideS(fast),
      'units: ratio of glide SECONDS across the RATE travel at a fixed SMOOTH',
    ).toBeGreaterThan(30);
    expect(bugglesSmoothGlideText(slow)).toBe('2.90 s');
    expect(bugglesSmoothGlideText(fast)).toBe('79 ms');
  });

  it('THE FLOOR — at SMOOTH 0 it is RATE-INVARIANT at exactly 10 ms', () => {
    // The leg a "glide is proportional to the period" model would fail, on the
    // one setting a player is most likely to check. `slewS = 0.01 + …`.
    const seen = new Set<string>();
    for (const rate of [0, 0.2, 0.4, 0.8, 1]) {
      seen.add(bugglesSmoothGlideText(P({ smoothness: 0, rate })));
      expect(bugglesSmoothGlideS(P({ smoothness: 0, rate })), 'units: seconds').toBeCloseTo(0.01, 9);
    }
    expect([...seen]).toEqual(['10 ms']);
  });

  it('WHY the two adjacent readouts print near-identical numbers at spawn', () => {
    // `glide` reads 843 ms and `stepped hold` reads 833 ms on a fresh module,
    // which looks like one number printed twice. It is not: `slewS = 0.01 +
    // smoothness * 2 * period`, so SMOOTH 0.5 is EXACTLY the setting where the
    // glide is one woggle period plus the 10 ms floor — SMOOTH is perpetually
    // chasing, arriving 10 ms after the next value has already been rolled.
    // Asserted so the coincidence is a documented property rather than
    // something a future reader "fixes".
    const smoothDef = bugglesDef.params.find((p) => p.id === 'smoothness')!;
    expect(smoothDef.defaultValue, 'the setting the identity holds at').toBe(0.5);
    for (const rate of [0, 0.2, 0.4, 0.8, 1]) {
      const p = P({ rate, smoothness: 0.5 });
      expect(
        bugglesSmoothGlideS(p) - 1 / bugglesWoggleHz(p),
        `at SMOOTH 0.5, rate ${rate}: glide minus period (units: seconds) is the 10 ms floor`,
      ).toBeCloseTo(0.01, 9);
    }
    expect(bugglesSmoothGlideText(P())).toBe('843 ms');
    expect(bugglesSteppedHoldText(P())).toBe('833 ms ±15%');
    // NEGATIVE CONTROL — the identity is a property of SMOOTH 0.5 alone, so
    // the two readouts must part company anywhere else on that dial.
    expect(bugglesSmoothGlideText(P({ smoothness: 0.9 }))).not.toBe('843 ms');
  });

  it('POSITIVE CONTROL — it does move on its own dial, 168× at the shipped rate', () => {
    const at = (smoothness: number) => bugglesSmoothGlideS(P({ smoothness }));
    expect(at(0) * 1000, 'units: ms').toBeCloseTo(10, 6);
    expect(at(1) * 1000, 'units: ms').toBeCloseTo(1675.1, 1);
    expect(at(1) / at(0), 'units: ratio across the SMOOTH travel').toBeGreaterThan(100);
  });
});

describe('buggles face model / STEPPED HOLD: the jitter term RATE cannot see', () => {
  it('the SAME RATE, a steady hold and a jittered one', () => {
    const steady = P({ rate: 0.4, chaos: 0 });
    const wobbly = P({ rate: 0.4, chaos: 0.6 });
    expect(steady.rate, 'the RATE readback in both rows').toBe(wobbly.rate);
    expect(bugglesSteppedHoldText(steady)).toBe('833 ms steady');
    expect(bugglesSteppedHoldText(wobbly)).toBe('833 ms ±30%');
    // The jitter fraction is the DSP's own `0.5 * chaos`, at both ends.
    expect(bugglesSteppedHoldText(P({ chaos: 1 }))).toBe('833 ms ±50%');
  });

  it('and it moves on RATE too — both terms, or it is a relabelled dial', () => {
    expect(bugglesSteppedHoldText(P({ rate: 0, chaos: 0 }))).toBe('10.00 s steady');
    expect(bugglesSteppedHoldText(P({ rate: 1, chaos: 0 }))).toBe('20 ms steady');
  });
});

describe('buggles face model / WOGGLE Hz and RING Hz: the log map, and the ÷4', () => {
  it('the 0..1 dial prints a POSITION; these print the frequencies', () => {
    // 500× of log map hidden behind a linear 0..1 fader.
    expect(bugglesWoggleText(P({ rate: 0 }))).toBe('0.100 Hz');
    expect(bugglesWoggleText(P())).toBe('1.20 Hz');
    expect(bugglesWoggleText(P({ rate: 1 }))).toBe('50.0 Hz');
    expect(
      bugglesWoggleHz(P({ rate: 1 })) / bugglesWoggleHz(P({ rate: 0 })),
      'units: ratio across the RATE travel',
    ).toBeCloseTo(500, 6);
  });

  it('RING is the SAME dial over BUGGLES_RING_DIVISOR — so each checks the other', () => {
    // Publishing both is the instrument's own control: a bug in the shared rate
    // map would move them TOGETHER and this relation would still hold, so it is
    // asserted alongside the absolute values rather than instead of them.
    for (const rate of [0, 0.25, 0.4, 0.5, 0.75, 1]) {
      const p = P({ rate });
      expect(bugglesRingHz(p) * BUGGLES_RING_DIVISOR, `rate ${rate}`).toBeCloseTo(
        bugglesWoggleHz(p),
        9,
      );
    }
    expect(bugglesRingText(P())).toBe('0.300 Hz sub-audio');
    expect(bugglesRingText(P({ rate: 1 }))).toBe('12.5 Hz sub-audio');
  });

  it('THE AUDIT’S FINDING, as a permanent gate — the carrier never reaches hearing', () => {
    // Four doc strings called RING "audio-rate". The ceiling is 12.5 Hz. This
    // is asserted over the WHOLE travel including both endpoints, because the
    // top of the dial is where the claim would be true if it were true anywhere.
    const rateDef = bugglesDef.params.find((p) => p.id === 'rate')!;
    for (let i = 0; i <= 100; i++) {
      const rate = rateDef.min + ((rateDef.max - rateDef.min) * i) / 100;
      const hz = bugglesRingHz(P({ rate }));
      expect(hz, `RATE ${rate.toFixed(2)} → ${hz.toFixed(5)} Hz (units: Hz)`).toBeLessThan(
        BUGGLES_AUDIBILITY_FLOOR_HZ,
      );
    }
    // POSITIVE CONTROL on the comparison: the WOGGLE rate — the same map
    // without the divisor — DOES cross the floor, so the sweep above is a fact
    // about the ÷4 rather than about a threshold nothing can reach.
    expect(bugglesWoggleHz(P({ rate: rateDef.max })), 'units: Hz').toBeGreaterThan(
      BUGGLES_AUDIBILITY_FLOOR_HZ,
    );
    // …and the word is on the panel, at every position, so a player reading the
    // face cannot repeat the mistake the docs made.
    for (const rate of [0, 0.5, 1]) expect(bugglesRingText(P({ rate }))).toContain('sub-audio');
  });
});

describe('buggles face model / BURST: the truncation no naive formula has', () => {
  it('THE 5× GAP — `p × rate × 5` is wrong at the top of the RATE travel', () => {
    // The obvious closed form and the real answer, side by side. Below the knee
    // they AGREE, which is the half that makes the disagreement above it a
    // measurement rather than an off-by-something.
    const full = P({ burst_probability: 1, rate: 0.4 });
    expect(bugglesNaiveBurstTriggersPerS(full)).toBeCloseTo(6.01, 2);
    expect(bugglesExpectedDeliveredPulses(full), 'nothing is being cut here').toBeCloseTo(5, 9);

    const top = P({ burst_probability: 1, rate: 1 });
    expect(bugglesNaiveBurstTriggersPerS(top), 'units: triggers/s, the WRONG form').toBeCloseTo(
      250,
      6,
    );
    expect(bugglesExpectedDeliveredPulses(top), 'units: pulses delivered of 5.00 rolled').toBeCloseTo(
      1,
      9,
    );
    expect(bugglesBurstText(top)).toBe('50/s · 1.0 of 5.0 cut');
  });

  it('the delivered length is DERIVED from the burst geometry, not a stored table', () => {
    // Recompute the answer independently, from the module's own constants, and
    // require agreement at every rate on a sweep. A model that had frozen a
    // per-rate table would pass one row and fail the rest.
    for (const rate of [0, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 1]) {
      const p = P({ rate });
      const periodMs = (1 / bugglesMath.rateKnobToHz(rate)) * 1000;
      for (let len = BUGGLES_BURST_MIN_PULSES; len <= BUGGLES_BURST_MAX_PULSES; len++) {
        let want = 0;
        for (let i = 0; i < len; i++) {
          if (i * BUGGLES_BURST_GAP_MS + BUGGLES_BURST_PULSE_MS <= periodMs) want++;
        }
        expect(
          bugglesDeliveredBurstPulses(p, len),
          `rate ${rate} (period ${periodMs.toFixed(1)} ms), rolled ${len} (units: pulses)`,
        ).toBe(want);
      }
    }
  });

  it('AT THE TOP OF RATE, BURST IS A COPY OF CLOCK — one pulse, not a cluster', () => {
    const top = P({ rate: 1 });
    for (let len = BUGGLES_BURST_MIN_PULSES; len <= BUGGLES_BURST_MAX_PULSES; len++) {
      expect(bugglesDeliveredBurstPulses(top, len), `rolled ${len} at RATE 1`).toBe(1);
    }
    // …and at the shipped rate nothing is cut at all, so the readout does not
    // print the "cut" clause where it would be noise.
    expect(bugglesBurstText(P({ burst_probability: 1 }))).toBe('6.0/s');
    expect(bugglesBurstText(P({ burst_probability: 1 }))).not.toContain('cut');
  });

  it('BURST 0 says `never` rather than dressing up a zero in four numbers', () => {
    expect(bugglesBurstText(P({ burst_probability: 0 }))).toBe('never');
    // POSITIVE control on the same string: it is not always `never`.
    expect(bugglesBurstText(P({ burst_probability: 0.2 }))).not.toBe('never');
  });

  it('the rolled bounds the model uses ARE the ones `rollBurst` draws', () => {
    // The join between the model's distribution and the DSP's. A model assuming
    // 3..7 while the module rolled 2..9 would print a confident wrong rate.
    const rand = bugglesPrng(4242);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(bugglesMath.rollBurst(1, rand));
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from(
        { length: BUGGLES_BURST_MAX_PULSES - BUGGLES_BURST_MIN_PULSES + 1 },
        (_, i) => BUGGLES_BURST_MIN_PULSES + i,
      ),
    );
  });
});

describe('buggles face model / THE GLYPH would tap RING, which is why there is none', () => {
  it('primaryAudioOutPortId resolves `ring` — one jack of five', () => {
    expect(primaryAudioOutPortId(bugglesDef)).toBe('ring');
    // …and it is the LAST declared output, so the resolver reaches it by port
    // TYPE rather than by position — the fact that makes "one of five" the
    // right description.
    expect(bugglesDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id)).toEqual(['ring']);
    expect(bugglesDef.outputs.at(-1)!.id).toBe('ring');
  });

  it('the declared `none` resolves to NO BINDING — no tap, no rAF, no analyser', () => {
    const b = glyphBinding(bugglesDef);
    expect(b.kind).toBe('none');
    expect('portId' in b).toBe(false);
  });

  it('NEGATIVE CONTROL — any other glyph HERE binds LIVE onto `ring`', () => {
    // The decision, reproduced against this def so `'none'` is a measured choice
    // rather than a preference. Unlike ninelives (every output `cv`, so a glyph
    // fell through to `{ kind: 'static' }` and a gate could see the dead
    // VuMeter), this module HAS an audio output — so a glyph here binds live,
    // attaches a real tap, returns real samples, and paints a creeping line
    // that nothing would flag.
    for (const glyph of ['scope', 'meter', 'waveform'] as const) {
      const asGlyph = { ...bugglesDef, face: { ...bugglesDef.face!, glyph } };
      const b = glyphBinding(asGlyph);
      expect(b.kind, `glyph '${glyph}'`).toBe('live-audio');
      expect(b.kind === 'live-audio' && b.portId, `glyph '${glyph}' taps`).toBe('ring');
    }
    // The counter-control: strip the audio output and the SAME glyph falls to
    // `static` — so the `live-audio` above is a property of this module's ports
    // rather than of a resolver that always binds.
    expect(
      glyphBinding({
        face: { ...bugglesDef.face!, glyph: 'scope' },
        outputs: bugglesDef.outputs.filter((o) => o.type !== 'audio'),
        params: bugglesDef.params,
      }).kind,
    ).toBe('static');
  });

  it('WHY it could not paint RING anyway — the tap window vs the carrier period', () => {
    // GLYPH_TAP_FFT_SIZE is 2048 samples ≈ 42.7 ms at 48 kHz. The units are the
    // whole point, so they are in the message.
    const WINDOW_S = 2048 / 48000;
    const atDefault = 1 / bugglesRingHz(P());
    const atTop = 1 / bugglesRingHz(P({ rate: 1 }));
    expect(atDefault, 'units: seconds, RING carrier period at spawn').toBeCloseTo(3.330, 3);
    expect(
      WINDOW_S / atDefault,
      'units: fraction of ONE carrier cycle inside the glyph tap window, at spawn',
    ).toBeLessThan(0.02);
    // The BEST CASE across the entire travel is still only half a cycle — of a
    // sine whose amplitude is an unrelated random voltage.
    expect(
      WINDOW_S / atTop,
      'units: fraction of one cycle at the TOP of RATE — the best case anywhere',
    ).toBeLessThan(0.6);
  });
});

describe('buggles face model / the ranking’s premises, asserted', () => {
  it('face.order is exactly the declared params, and pages partition it', () => {
    // Derived membership in both directions — never a count.
    const order = [...(bugglesDef.face?.order ?? [])];
    expect(order.slice().sort()).toEqual([...PARAM_IDS].sort());
    const paged = (bugglesDef.face?.pages ?? []).flatMap((p) => [...p.controls]);
    expect(paged.slice().sort(), 'every ranked key appears on exactly one page').toEqual(
      order.slice().sort(),
    );
  });

  it('RANK 5 — LEVEL genuinely does not reach the two GATE jacks', () => {
    // The measured premise behind ranking an unconditionally-applicable trim
    // LAST. If LEVEL ever starts scaling the gates, this argument needs
    // re-making and this is what forces that.
    const gates = bugglesDef.outputs.filter((o) => o.type === 'gate').map((o) => o.id);
    expect(gates, 'the jacks LEVEL bypasses').toEqual(['clock', 'burst']);
    expect(bugglesDef.docs?.controls?.level).toMatch(/CLOCK and BURST gates keep a clean/);
    expect(bugglesDef.face?.order.at(-1)).toBe('level');
  });

  it('RANK 1 — RATE is the only control every readout in the table depends on', () => {
    // The identity claim, as a sweep: RATE moves ALL FIVE rows; no other param
    // moves more than two.
    const movedBy = (paramId: string) => {
      const def = bugglesDef.params.find((p) => p.id === paramId)!;
      return VALUE_IDS.filter((id) => {
        const fn = faceReadoutValueFor(id)!;
        const a = fn(reader({ ...DEFAULTS }));
        return [def.min, def.max].some((v) => fn(reader({ ...DEFAULTS, [paramId]: v })) !== a);
      }).length;
    };
    expect(movedBy('rate'), 'RATE must move every row').toBe(VALUE_IDS.length);
    for (const other of PARAM_IDS.filter((p) => p !== 'rate')) {
      expect(movedBy(other), `${other} must move fewer rows than RATE`).toBeLessThan(
        VALUE_IDS.length,
      );
    }
    expect(bugglesDef.face?.order[0]).toBe('rate');
    expect(bugglesDef.face?.hero?.control).toBe('rate');
  });
});

describe('buggles face model / TOTALITY (a throw takes the faceplate down mid-drag)', () => {
  const HOSTILE: (number | undefined)[] = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    99,
    0,
    undefined,
  ];

  it('a FRESH node, a NaN mid-drag and an out-of-range save all print a finite string', () => {
    for (const id of VALUE_IDS) {
      const fn = faceReadoutValueFor(id)!;
      expect(fn(reader({})), `'${id}' on a fresh node`).toMatch(/\S/);
      for (const hostile of HOSTILE) {
        for (const paramId of PARAM_IDS) {
          const over = hostile === undefined ? {} : { [paramId]: hostile };
          const out = fn(reader(over as Record<string, number>));
          expect(out, `'${id}' with ${paramId}=${hostile}`).toMatch(/\S/);
          expect(out, `'${id}' must never leak a raw non-finite`).not.toMatch(
            /NaN|Infinity|undefined/,
          );
        }
      }
    }
  });

  it('an UNTOUCHED param reads its DEF DEFAULT, and an out-of-range one is CLAMPED', () => {
    // `node.params` is a sparse overlay of what has been touched; reading it
    // bare would print a clock for a module that is not running at that rate.
    for (const p of bugglesDef.params) {
      expect((P() as unknown as Record<string, number>)[p.id], `${p.id} falls back`).toBe(
        p.defaultValue,
      );
    }
    const wild = P({ rate: 99, chaos: -5, smoothness: 99, burst_probability: -1, level: 99 });
    for (const p of bugglesDef.params) {
      const v = (wild as unknown as Record<string, number>)[p.id]!;
      expect(v, `${p.id} must be inside [${p.min}, ${p.max}]`).toBeGreaterThanOrEqual(p.min);
      expect(v, `${p.id} must be inside [${p.min}, ${p.max}]`).toBeLessThanOrEqual(p.max);
    }
  });
});

describe('buggles face model / promotion', () => {
  it('is in STRICT_FACES — an authored face NOT in the set ships as a no-op', () => {
    expect(bugglesDef.face, 'the def declares a face').toBeDefined();
    expect(STRICT_FACES.has('buggles')).toBe(true);
  });
});
