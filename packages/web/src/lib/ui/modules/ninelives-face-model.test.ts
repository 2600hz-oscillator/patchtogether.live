// packages/web/src/lib/ui/modules/ninelives-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS FOR THE NINE LIVES FACEPLATE.
//
// A derived readout earns its place by being negative-controlled on the input a
// KNOB READBACK would be blind to — permanently, on every run, not once at
// authoring time (`module-faceplates.md`). This module's readouts have two such
// inputs and they are orthogonal, which is what lets the readouts control each
// other:
//
//   · the LADDER readouts (`ladder-span`, `fast-taps`, the nine tap rows) are
//     WAVEFORM-INVARIANT — `shape` chooses what is read off the accumulators
//     and never how fast they advance;
//   · the WAVE readout is RATE-INVARIANT.
//
// So each is the other's control, in the `clap-q` / `clap-bandwidth-hz` shape:
// publishing both makes the instrument its own negative control. On top of that
// sits the load-bearing one — the `noise` control — that ONE `rate` readback
// prints ONE number while the nine tap rows print nine different ones.
//
// ⚠ AND THE GLYPH IS TESTED HERE TOO, because on a nine-output module the glyph
// is a claim about WHICH output, and the wrong answer is a shipped defect twice
// over: `noise`'s lane meter reads the first AUDIO output and paints it as the
// module, and `marbles` shipped `glyph: 'meter'` on a def with no audio output
// at all, which resolved `{ kind: 'static' }` and gave `<VuMeter>` no tap —
// twelve segments that could never light. Both resolutions are asserted below,
// in both directions, so the choice cannot silently become either of them.
//
// PURE — no DOM, no engine. Every number is re-derived from the shipping DSP
// core's own `NINE_LIVES_RATE_MULTIPLIERS` on every run.

import { describe, expect, it } from 'vitest';
import { ninelivesDef } from '$lib/audio/modules/ninelives';
import {
  glyphBinding,
  primaryAudioOutPortId,
} from '$lib/ui/workflow/shell-glyph-live';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import { isUsableReadout, readoutText } from '$lib/ui/workflow/dock-faceplate-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { NINE_LIVES_RATE_MULTIPLIERS } from '../../../../../dsp/src/lib/ninelives-dsp';
import {
  NINELIVES_LIVELY_PERIOD_S,
  NINELIVES_TAP_MULTIPLIERS,
  NINELIVES_TAP_PORT_IDS,
  fmtNinelivesPeriod,
  ninelivesFaceParams,
  ninelivesFastTaps,
  ninelivesFastTapsText,
  ninelivesLadderSpanText,
  ninelivesTapHz,
  ninelivesTapPeriodS,
  ninelivesTapPeriodText,
  ninelivesWaveText,
} from './ninelives-face-model';

/** A reader over an explicit param map — the shape `FaceReadoutValue` gets. */
const reader =
  (params: Record<string, number | undefined>) =>
  (id: string): number | undefined =>
    params[id];

/** The def's own shipped spawn defaults. */
const DEFAULTS = Object.fromEntries(
  ninelivesDef.params.map((p) => [p.id, p.defaultValue]),
) as Record<string, number>;

const P = (over: Record<string, number> = {}) =>
  ninelivesFaceParams(reader({ ...DEFAULTS, ...over }));

const RATE_DEF = ninelivesDef.params.find((p) => p.id === 'rate')!;
const SHAPE_DEF = ninelivesDef.params.find((p) => p.id === 'shape')!;

// ── THE LADDER IS THE DSP'S, NOT A COPY ─────────────────────────────────────

describe('ninelives face model / the ladder is the DSP core’s own', () => {
  it('re-exports NINE_LIVES_RATE_MULTIPLIERS by identity — a copy would fail this', () => {
    // Identity, not deep equality: a restated array with the same values would
    // pass `toEqual` and then drift the day the DSP's ratio moves. This is what
    // makes "the faceplate cannot insist on a repaired DSP" structural.
    expect(NINELIVES_TAP_MULTIPLIERS).toBe(NINE_LIVES_RATE_MULTIPLIERS);
  });

  it('the tap population IS the def’s declared output roster, both directions', () => {
    expect([...NINELIVES_TAP_PORT_IDS]).toEqual(ninelivesDef.outputs.map((o) => o.id));
    expect(NINELIVES_TAP_PORT_IDS.length).toBe(NINELIVES_TAP_MULTIPLIERS.length);
  });

  it('the multipliers are STRICTLY DECREASING — the property the range form relies on', () => {
    // `ninelivesFastTaps` returns a PREFIX LENGTH and prints `out 1–k`. That is
    // only honest while the periods are strictly increasing down the roster, so
    // the property is asserted rather than assumed.
    for (let n = 1; n < NINELIVES_TAP_MULTIPLIERS.length; n++) {
      expect(
        NINELIVES_TAP_MULTIPLIERS[n]!,
        `rung ${n} multiplier must be smaller than rung ${n - 1}`,
      ).toBeLessThan(NINELIVES_TAP_MULTIPLIERS[n - 1]!);
    }
  });

  it('matches the ART-measured ladder at the shipped Rate, tap by tap (units: seconds)', () => {
    // The numbers the def's comment, the docs and the PR body all quote, pinned
    // where a reader can see them. Measured through the real factory in
    // art/scenarios/ninelives/ladder.test.ts to within 2.5e-7 relative.
    const p = P();
    expect(p.rate).toBe(1);
    const secs = NINELIVES_TAP_MULTIPLIERS.map((_, n) => ninelivesTapPeriodS(n, p));
    expect(secs.map((s) => Number(s.toFixed(4)))).toEqual([
      1, 3, 9, 27, 81, 243, 729, 2187, 6561,
    ]);
  });
});

// ── THE LOAD-BEARING CONTROL: ONE DIAL, NINE ANSWERS ────────────────────────

describe('ninelives face model / the RATE readback is invariant to WHICH tap', () => {
  it('one dial value, nine DIFFERENT printed cycle times', () => {
    const read = reader({ ...DEFAULTS });
    const p = ninelivesFaceParams(read);

    // What a `{ paramId: 'rate' }` readout would print: one number, for all
    // nine outputs.
    expect(read('rate')).toBe(1);

    const printed = NINELIVES_TAP_MULTIPLIERS.map((_, n) => ninelivesTapPeriodText(n, p));
    expect(printed).toEqual([
      '1.00 s', '3.00 s', '9.00 s', '27.00 s',
      '1.4 min', '4.1 min', '12.2 min', '36.5 min', '1.8 h',
    ]);
    // …and they are all DISTINCT, which is the whole claim in one line.
    expect(new Set(printed).size).toBe(printed.length);

    // The spread, stated as the ratio the dial cannot express.
    const span = ninelivesTapPeriodS(NINELIVES_TAP_MULTIPLIERS.length - 1, p) /
      ninelivesTapPeriodS(0, p);
    expect(Math.round(span)).toBe(6561);
  });

  it('EVERY declared readout PAINTS a value through the shell’s own resolver, not `—`', () => {
    // ⚠ THE LEG THAT CATCHES A REGISTRATION THAT IS PRESENT BUT WRONG.
    // `readoutText` (dock-faceplate-model.ts) prints `'—'` for an unresolvable
    // id AND swallows a throw into the same `'—'`, deliberately: a faceplate
    // must keep rendering. So a mis-registered or throwing readout is
    // INVISIBLE at the pixel lane — the e2e sidebar sweep asserts a block
    // "renders a BODY, not just a header", which a column of nine em-dashes
    // satisfies. This walks the def's OWN declarations through the SAME
    // function the shell calls and requires a real value.
    const read = reader({ ...DEFAULTS });
    const declared = [
      ...(ninelivesDef.face?.hero?.readouts ?? []),
      ...(ninelivesDef.face?.sidebar ?? []).flatMap((b) =>
        b.kind === 'readouts' ? [...b.entries] : [],
      ),
    ];
    // Non-vacuity: the walk must actually find the hero row AND every tap row.
    expect(declared.length).toBe(
      (ninelivesDef.face?.hero?.readouts ?? []).length + NINELIVES_TAP_MULTIPLIERS.length,
    );
    for (const r of declared) {
      expect(isUsableReadout(r), `${r.label}: exactly one of paramId/valueId/text`).toBe(true);
      const printed = readoutText(r, ninelivesDef.params, read);
      expect(printed, `${r.label} must paint a value, not the unresolvable placeholder`).not.toBe(
        '—',
      );
      expect(printed.length, `${r.label} must not paint an empty string`).toBeGreaterThan(0);
    }
    // NEGATIVE CONTROL on this very leg: the same resolver DOES return `—` for
    // an id nobody registered, so a green above is a fact about the readouts
    // rather than about a resolver that never says no.
    expect(readoutText({ label: 'x', valueId: 'ninelives-tap-0' }, ninelivesDef.params, read)).toBe(
      '—',
    );
  });

  it('every registered readout id resolves, and the table covers every declared tap', () => {
    // Deny-by-default over the def's OWN sidebar declaration: every `valueId`
    // the face declares must resolve in the registry, and every declared tap
    // must have a row. A typo or a missing rung is red here as well as in
    // module-face-lint.
    const block = ninelivesDef.face?.sidebar?.find((b) => b.kind === 'readouts');
    expect(block, 'the face declares a readouts sidebar block').toBeDefined();
    const ids = (block as { entries: readonly { valueId?: string }[] }).entries.map(
      (e) => e.valueId,
    );
    expect(ids).toEqual(NINELIVES_TAP_PORT_IDS.map((_, n) => `ninelives-tap-${n + 1}`));
    for (const id of ids) {
      expect(faceReadoutValueFor(id!), `${id} must be registered`).not.toBeNull();
    }
    for (const r of ninelivesDef.face?.hero?.readouts ?? []) {
      expect(faceReadoutValueFor(r.valueId!), `${r.valueId} must be registered`).not.toBeNull();
    }
  });
});

// ── THE TWO-WAY NEGATIVE CONTROL ───────────────────────────────────────────

describe('ninelives face model / each readout is the other’s negative control', () => {
  it('the LADDER readouts are WAVEFORM-invariant across the whole morph', () => {
    const at = (shape: number) => ninelivesLadderSpanText(P({ shape }));
    const baseline = at(SHAPE_DEF.defaultValue);
    for (const shape of [0, 0.25, 0.5, 1, 1.5, 1.999, SHAPE_DEF.max]) {
      expect(
        at(shape),
        `ladder span at shape ${shape} must equal the shape-${SHAPE_DEF.defaultValue} value`,
      ).toBe(baseline);
      expect(ninelivesFastTapsText(P({ shape }))).toBe(ninelivesFastTapsText(P()));
    }
    // POSITIVE control on the same metric — without it, an always-constant
    // function would pass the invariance leg above.
    expect(at(SHAPE_DEF.defaultValue)).not.toBe(ninelivesLadderSpanText(P({ rate: 10 })));
  });

  it('the WAVE readout is RATE-invariant across the whole dial', () => {
    const at = (rate: number) => ninelivesWaveText(P({ rate }));
    const baseline = at(RATE_DEF.defaultValue);
    for (const rate of [RATE_DEF.min, 0.1, 1, 12.5, RATE_DEF.max]) {
      expect(at(rate), `wave name at rate ${rate} Hz must not depend on the rate`).toBe(baseline);
    }
    // POSITIVE control: the same function DOES move on the input it reads.
    expect(baseline).toBe('sine');
    expect(ninelivesWaveText(P({ shape: 2 }))).toBe('square');
  });
});

// ── THE READOUTS THEMSELVES ────────────────────────────────────────────────

describe('ninelives face model / ladder span', () => {
  it('prints BOTH ENDS, which one dial value cannot be', () => {
    expect(ninelivesLadderSpanText(P())).toBe('1.00 s → 1.8 h');
    // The two extremes of the RATE dial. At the bottom the slowest tap's cycle
    // is longer than a working week; at the top it is barely over a minute.
    // ⚠ `1.7 min`, not `100.00 s`: at the BOTTOM of the dial even the FASTEST
    // tap has left the seconds unit, which is the fact this readout exists to
    // make visible — the dial still says `0.01 Hz`.
    expect(ninelivesLadderSpanText(P({ rate: RATE_DEF.min }))).toBe('1.7 min → 7.6 d');
    expect(ninelivesLadderSpanText(P({ rate: RATE_DEF.max }))).toBe('10 ms → 1.1 min');
  });
});

describe('ninelives face model / which taps still read as movement', () => {
  it('names a PREFIX of the roster, and `none` below the knee', () => {
    expect(ninelivesFastTapsText(P())).toBe('out 1–4');
    expect(ninelivesFastTapsText(P({ rate: RATE_DEF.max }))).toBe('out 1–8');
  });

  it('THE DIAL STEP NOBODY WOULD LOOK TWICE AT — 0.02 → 0.016 Hz empties it', () => {
    // The knee is `rate = 1 / NINELIVELY`, i.e. the point where even the
    // FASTEST tap takes longer than the threshold to come round. A `rate`
    // readback prints `0.02 Hz` and `0.02 Hz` (two decimals) on both sides of
    // it; this readout goes from a tap to none at all.
    const knee = 1 / NINELIVES_LIVELY_PERIOD_S;
    expect(ninelivesFastTapsText(P({ rate: knee * 1.2 }))).toBe('out 1');
    expect(ninelivesFastTapsText(P({ rate: knee * 0.96 }))).toBe('none');
    expect(ninelivesFastTaps(P({ rate: knee * 0.96 }))).toBe(0);
  });

  it('the prefix length is DERIVED from the periods, not from a stored roster', () => {
    // Recompute the answer independently, from the periods themselves, and
    // require agreement at every rate on a log sweep. A `fastTaps` that had
    // frozen a per-rate table would pass one row and fail the rest.
    for (const rate of [RATE_DEF.min, 0.02, 0.05, 0.2, 1, 3, 20, RATE_DEF.max]) {
      const p = P({ rate });
      const expected = NINELIVES_TAP_MULTIPLIERS.filter(
        (_, n) => ninelivesTapPeriodS(n, p) <= NINELIVES_LIVELY_PERIOD_S,
      ).length;
      expect(ninelivesFastTaps(p), `at rate ${rate} Hz (units: Hz)`).toBe(expected);
    }
  });
});

describe('ninelives face model / the waveform name', () => {
  it('names the three vertices and the position between them', () => {
    expect(ninelivesWaveText(P({ shape: 0 }))).toBe('sine');
    expect(ninelivesWaveText(P({ shape: 1 }))).toBe('saw');
    expect(ninelivesWaveText(P({ shape: 2 }))).toBe('square');
    expect(ninelivesWaveText(P({ shape: 0.4 }))).toBe('sine→saw 40%');
    expect(ninelivesWaveText(P({ shape: 1.5 }))).toBe('saw→square 50%');
  });

  it('the dial prints the SAME NUMBER SHAPE for three different waveforms', () => {
    // The blindness this readout exists for, stated as an assertion: `shape`
    // reads `0.00` / `1.00` / `2.00` — a position, never a name — and the two
    // segments of the morph are different laws (sine↔saw, then saw↔square),
    // so the number cannot even be read as a single continuous "brightness".
    const printedByDial = [0, 1, 2].map((v) => v.toFixed(2));
    expect(new Set(printedByDial).size).toBe(3);
    expect(new Set([0, 1, 2].map((s) => ninelivesWaveText(P({ shape: s })))).size).toBe(3);
    // …and the names are words the dial has no way to emit.
    expect(ninelivesWaveText(P({ shape: 0 }))).not.toMatch(/\d/);
  });
});

// ── THE GLYPH: WHICH OUTPUT DOES IT TAP? (the `noise` / `marbles` hazard) ────

describe('ninelives face model / the glyph taps NOTHING, and that is derived', () => {
  it('primaryAudioOutPortId is NULL — every declared output is `cv`', () => {
    expect(ninelivesDef.outputs.every((o) => o.type === 'cv')).toBe(true);
    expect(primaryAudioOutPortId(ninelivesDef)).toBeNull();
    // POSITIVE control on the resolver: it DOES pick a port when there is one,
    // and it picks the FIRST — which is the `noise` defect's mechanism. Without
    // this leg a resolver that always returned null would pass above.
    expect(
      primaryAudioOutPortId({
        outputs: [{ id: 'cv1', type: 'cv' }, { id: 'a', type: 'audio' }, { id: 'b', type: 'audio' }],
      }),
    ).toBe('a');
  });

  it('the declared `waveform` glyph resolves PARAM-DERIVED (wave-morph), not a tap', () => {
    const b = glyphBinding(ninelivesDef);
    expect(b.kind).toBe('wave-morph');
    // No port id anywhere on the binding — that is what "taps nothing" means
    // mechanically, and it is why the picture is of ALL NINE taps rather than
    // of whichever one a resolver happened to reach.
    expect('portId' in b).toBe(false);
    if (b.kind === 'wave-morph') {
      expect(b.shapeParamId).toBe('shape');
      // No depth param on this module, so the glyph draws at amplitude 1 —
      // which is exactly what the taps are.
      expect(b.depthParamId).toBeUndefined();
      expect(b.depthGain).toBe(1);
    }
  });

  it('NEGATIVE CONTROL — `glyph: meter` here would paint a DEAD VuMeter', () => {
    // The marbles defect, reproduced against this def so the glyph choice is a
    // measured decision rather than a preference. With no audio output to
    // resolve, a `meter` glyph falls all the way through to `static`: no tap,
    // so `<VuMeter>` gets `getLevel: undefined` and its `level = 0` default —
    // twelve segments that can never light, on a module with nine jacks.
    const asMeter = { ...ninelivesDef, face: { ...ninelivesDef.face!, glyph: 'meter' as const } };
    expect(glyphBinding(asMeter).kind).toBe('static');
    // …and `scope` is no better, for the same reason.
    const asScope = { ...ninelivesDef, face: { ...ninelivesDef.face!, glyph: 'scope' as const } };
    expect(glyphBinding(asScope).kind).toBe('static');
    // The counter-control: give the SAME def an audio output and `meter` binds
    // live — so the `static` above is a property of this module's ports, not of
    // a resolver that never returns anything else.
    expect(
      glyphBinding({
        face: { ...ninelivesDef.face!, glyph: 'meter' },
        outputs: [...ninelivesDef.outputs, { id: 'audio', type: 'audio' }],
        params: ninelivesDef.params,
      }).kind,
    ).toBe('live-audio');
  });
});

// ── TOTALITY ───────────────────────────────────────────────────────────────

describe('ninelives face model / totality (a throw takes the faceplate down mid-drag)', () => {
  const VALUE_IDS = [
    'ninelives-ladder-span',
    'ninelives-fast-taps',
    'ninelives-wave',
    ...NINELIVES_TAP_MULTIPLIERS.map((_, n) => `ninelives-tap-${n + 1}`),
  ];

  it('every registered id survives a FRESH node, NaN, ±Infinity and out-of-range', () => {
    const hostile: Record<string, number | undefined>[] = [
      {}, // fresh spawn: node.params is a SPARSE overlay
      { rate: Number.NaN, shape: Number.NaN },
      { rate: Number.POSITIVE_INFINITY, shape: Number.POSITIVE_INFINITY },
      { rate: Number.NEGATIVE_INFINITY, shape: Number.NEGATIVE_INFINITY },
      { rate: 0, shape: -5 },
      { rate: -1, shape: 99 },
    ];
    for (const params of hostile) {
      for (const id of VALUE_IDS) {
        const fn = faceReadoutValueFor(id)!;
        const out = fn(reader(params));
        expect(typeof out, `${id} on ${JSON.stringify(params)}`).toBe('string');
        expect(out.length, `${id} must never print an empty string`).toBeGreaterThan(0);
        expect(out, `${id} must never leak a raw non-finite`).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  it('a rate of 0 prints `still`, not a divide-by-zero artefact', () => {
    expect(fmtNinelivesPeriod(ninelivesTapPeriodS(0, P({ rate: 0 })))).toBe('still');
    expect(ninelivesTapHz(0, P({ rate: 0 }))).toBe(0);
  });

  it('an out-of-range tap index returns NaN rather than reading past the ladder', () => {
    expect(Number.isNaN(ninelivesTapHz(NINELIVES_TAP_MULTIPLIERS.length, P()))).toBe(true);
    expect(Number.isNaN(ninelivesTapHz(-1, P()))).toBe(true);
  });
});

// ── THE PROMOTION ──────────────────────────────────────────────────────────

describe('ninelives face model / promotion', () => {
  it('is in STRICT_FACES — an authored face NOT in the set ships as a no-op', () => {
    expect(ninelivesDef.face, 'the def declares a face').toBeDefined();
    expect(STRICT_FACES.has('ninelives')).toBe(true);
  });
});
