// packages/web/src/lib/ui/modules/illogic-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS FOR THE ILLOGIC FACEPLATE.
//
// A derived readout earns its place by being negative-controlled on the input a
// KNOB READBACK would be blind to — permanently, on every run, not once at
// authoring time (`module-faceplates.md`). ILLOGIC's four dials are four copies
// of the same dial, so the useful controls are not "does it move when I turn
// something" (everything moves) but the SHAPE of what each readout is blind to.
// The four published values are chosen so that each is blind to something the
// next one sees, which makes them each other's controls in the
// `clap-q` / `clap-bandwidth-hz` shape:
//
//   sum   = a1+a2+a3+a4    SIGNED. Blind to which channel carries the sign.
//   diff  = a1+a2−a3−a4    SIGNED, OPPOSITE polarity split. Sees exactly the
//                          thing `sum` cannot: it moves when `sum` does not
//                          (att3 −1 → +1) and in the opposite direction.
//   peak  = Σ|aN|          SIGN-BLIND. Still when both of the above move; the
//                          only one of the four that reads the same at ±1.
//   logic = 1              INVARIANT to all four dials.
//
// ⚠ THE `logic` READOUT'S AUTHORITY IS NOT IN THIS FILE, and that is stated
// rather than left implicit. A readout function that ignores its reader is
// trivially invariant, so asserting "it does not move" here proves something
// about the FUNCTION and nothing about the MODULE. What proves it about the
// module is `art/scenarios/illogic/face-audit.test.ts`, which sweeps every
// param over its full declared travel against the shipping factory and asserts
// that every `gate`-typed output moves by bit-exactly 0.0000e+0 while every
// `cv`-typed output moves for at least one param — both directions, port sets
// derived from the def. The leg below asserts the READOUT agrees with that
// measurement; the measurement is what makes the claim true.
//
// ⚠ THE GLYPH IS ESTABLISHED HERE, NOT ASSUMED. On a ten-output module a glyph
// is a claim about WHICH output, and `marbles` shipped `glyph: 'meter'` on a def
// with no audio output at all — it resolved `{ kind: 'static' }`, gave
// `<VuMeter>` no tap, and painted twelve segments that could never light
// (#1692). ILLOGIC declares six `cv` outputs and four `gate` outputs and no
// `audio` output, so `primaryAudioOutPortId` returns null. Both halves are
// asserted below, in both directions.
//
// PURE — no DOM, no engine, no Web Audio.

import { describe, expect, it } from 'vitest';
import { illogicDef } from '$lib/audio/modules/illogic';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { sidebarPanelFor } from '$lib/ui/workflow/sidebar-panels';
import {
  ILLOGIC_ATT_PARAM_IDS,
  ILLOGIC_DIFF_SIGNS,
  ILLOGIC_LOGIC_TAPPED_INPUTS,
  ILLOGIC_NOT_INPUT,
  LOGIC_OUT_IDS,
  MIX_OUT_IDS,
  fmtBusGain,
  illogicBusCeiling,
  illogicBusCeilingText,
  illogicChannelInputId,
  illogicChannelRows,
  illogicDiffGain,
  illogicDiffGainText,
  illogicFaceParams,
  illogicLogicGainText,
  illogicSumGain,
  illogicSumGainText,
} from './illogic-face-model';

/** A reader over an explicit param map — the shape `FaceReadoutValue` gets. */
const reader =
  (params: Record<string, number | undefined>) =>
  (id: string): number | undefined =>
    params[id];

/** The def's own shipped spawn defaults. */
const DEFAULTS = Object.fromEntries(
  illogicDef.params.map((p) => [p.id, p.defaultValue]),
) as Record<string, number>;

/** A reader at the shipped defaults with `over` applied. */
const R = (over: Record<string, number> = {}) => reader({ ...DEFAULTS, ...over });

/** The attenuverter param id for channel `n` (1-based), off the derived roster
 *  rather than typed — so a renamed param reddens instead of silently missing.
 */
const ch = (n: number): string => {
  const id = ILLOGIC_ATT_PARAM_IDS[n - 1];
  expect(id, `channel ${n} must resolve to a declared attenuverter param`).toBeTruthy();
  return id!;
};

describe('illogic face model — the roster is DERIVED from the def', () => {
  it('the attenuverter params, the logic jacks and the mix jacks all come off the def', () => {
    // No count anywhere: the three sets PARTITION the def's declarations, and
    // that is what is asserted. A port added to either half joins the right set
    // with nothing edited here.
    expect([...LOGIC_OUT_IDS, ...MIX_OUT_IDS].sort()).toEqual(
      illogicDef.outputs.map((o) => o.id).sort(),
    );
    expect(LOGIC_OUT_IDS.filter((id) => MIX_OUT_IDS.includes(id))).toEqual([]);
    expect(LOGIC_OUT_IDS.length, 'the logic half must not be empty').toBeGreaterThan(0);
    expect(MIX_OUT_IDS.length, 'the mix half must not be empty').toBeGreaterThan(0);

    // Every attenuverter param is a real declared param, and every declared
    // param is an attenuverter — this module has no other kind.
    expect([...ILLOGIC_ATT_PARAM_IDS].sort()).toEqual(illogicDef.params.map((p) => p.id).sort());
  });

  it('every channel resolves to a declared INPUT port, and the tap set names real ports', () => {
    const declared = new Set(illogicDef.inputs.map((i) => i.id));
    // Channel N ↔ `inN` is a convention; assert it TOTAL rather than trusting it.
    ILLOGIC_ATT_PARAM_IDS.forEach((_, i) => {
      expect(declared.has(illogicChannelInputId(i)), `channel ${i} → ${illogicChannelInputId(i)}`).toBe(true);
    });
    expect(ILLOGIC_ATT_PARAM_IDS.length).toBe(illogicDef.inputs.length);

    // ANCHOR: a declared tap naming a port that no longer exists is RED, so a
    // renamed input cannot leave the routing picture drawing a line to nothing.
    for (const id of ILLOGIC_LOGIC_TAPPED_INPUTS) {
      expect(declared.has(id), `logic tap names a declared input: ${id}`).toBe(true);
    }
    expect(declared.has(ILLOGIC_NOT_INPUT), 'the NOT input is a declared input').toBe(true);
    expect(ILLOGIC_LOGIC_TAPPED_INPUTS.has(ILLOGIC_NOT_INPUT)).toBe(true);
  });

  it('the DIFF polarity splits the channels and sums to zero — the null, structurally', () => {
    expect(ILLOGIC_DIFF_SIGNS.length).toBe(ILLOGIC_ATT_PARAM_IDS.length);
    expect(new Set(ILLOGIC_DIFF_SIGNS)).toEqual(new Set([1, -1]));
    // The reason DIFF is a common-mode null at UNITY gains: the polarity vector
    // itself sums to zero. Derived, not typed.
    expect(ILLOGIC_DIFF_SIGNS.reduce((s, v) => s + v, 0)).toBe(0);
  });
});

describe('illogic face model — the four readouts, and what each is BLIND to', () => {
  it('at the shipped defaults: sum ×4.00, diff ×0.00, peak ×4.00, logic ×1.00', () => {
    // ⚠ THE ONE THAT MATTERS. The module leaves the factory with one of its two
    // mix buses configured as a COMMON-MODE NULL, underneath four faders all
    // sitting at maximum. Verified against the rendered graph too — the ART
    // sweep renders DC into all four inputs at these defaults and reads
    // diff = 0.000000 at the jack.
    expect(illogicSumGainText(R())).toBe('×4.00');
    expect(illogicDiffGainText(R())).toBe('×0.00');
    expect(illogicBusCeilingText(R())).toBe('×4.00');
    expect(illogicLogicGainText(R())).toBe('×1.00');
  });

  it('CONTROL 1 — the SIGN: `peak` is blind to it, `sum` and `diff` are not', () => {
    // The attenuverter's DEFINING behaviour is a sign flip, and it is exactly
    // what a level statistic cannot see (measured at the jack: att1 at −1 and
    // +1 give an IDENTICAL rms of 0.636396 and an identical peak of 0.900000,
    // while the signed difference is 1.8000e+0). A readout built on magnitude
    // alone would report the dial's whole point as doing nothing — so ONE of
    // the four is deliberately magnitude-only, and the other two are not.
    const flipped = R({ [ch(2)]: -1 });
    expect(illogicBusCeilingText(flipped), 'peak is SIGN-BLIND by construction').toBe('×4.00');
    expect(illogicSumGainText(flipped), 'sum sees the sign').toBe('×2.00');
    expect(illogicDiffGainText(flipped), 'diff sees it too, on the added half').toBe('×−2.00');
  });

  it('CONTROL 2 — the POLARITY SPLIT: `sum` and `diff` move in OPPOSITE directions', () => {
    // Flip a SUBTRACTED channel. `sum` falls by 2 (its coefficient went +1→−1)
    // and `diff` RISES by 2 (its coefficient went −1→+1). Two readouts that
    // always agreed would be one readout spelled twice.
    const base = { sum: illogicSumGain(illogicFaceParams(R())), diff: illogicDiffGain(illogicFaceParams(R())) };
    const flipped = R({ [ch(3)]: -1 });
    const after = {
      sum: illogicSumGain(illogicFaceParams(flipped)),
      diff: illogicDiffGain(illogicFaceParams(flipped)),
    };
    expect(after.sum - base.sum).toBe(-2);
    expect(after.diff - base.diff).toBe(+2);
    expect(illogicBusCeilingText(flipped), 'and `peak` sees neither').toBe('×4.00');
  });

  it('CONTROL 3 — MUTING a channel drops `peak` by exactly one unit', () => {
    // Proves the ceiling COUNTS CHANNELS rather than echoing a constant: the
    // failure mode a `×4.00` that never moves would be indistinguishable from.
    expect(illogicBusCeilingText(R({ [ch(1)]: 0 }))).toBe('×3.00');
    expect(illogicBusCeilingText(R({ [ch(1)]: 0, [ch(2)]: 0 }))).toBe('×2.00');
    expect(illogicBusCeilingText(R({ [ch(1)]: 0, [ch(2)]: 0, [ch(3)]: 0, [ch(4)]: 0 }))).toBe('×0.00');
    // …and a HALF-open channel contributes its magnitude, not its presence.
    expect(illogicBusCeilingText(R({ [ch(1)]: 0.5 }))).toBe('×3.50');
    expect(illogicBusCeilingText(R({ [ch(1)]: -0.5 }))).toBe('×3.50');
  });

  it('CONTROL 4 — `logic` is invariant to every knob, at every extreme', () => {
    // The face's headline, in readout form. See the ⚠ in this file's header:
    // the MODULE-side proof is the ART influence sweep; this asserts the
    // readout agrees with it rather than standing on its own.
    for (const v of [-1, -0.5, 0, 0.5, 1]) {
      for (const id of ILLOGIC_ATT_PARAM_IDS) {
        expect(illogicLogicGainText(R({ [id]: v })), `${id} = ${v}`).toBe('×1.00');
      }
    }
    // All four at once, both rails.
    const all = (v: number) => Object.fromEntries(ILLOGIC_ATT_PARAM_IDS.map((id) => [id, v]));
    expect(illogicLogicGainText(R(all(-1)))).toBe('×1.00');
    expect(illogicLogicGainText(R(all(0)))).toBe('×1.00');
    // POSITIVE CONTROL on the same reader, so "invariant" cannot be "the reader
    // is broken and everything reads the same".
    expect(illogicSumGainText(R(all(-1)))).toBe('×−4.00');
    expect(illogicSumGainText(R(all(0)))).toBe('×0.00');
  });

  it('the worst case is a CEILING on both buses — |sum| and |diff| can never exceed it', () => {
    // Asserted as a RELATION over a swept fixture rather than as a table of
    // numbers: whatever the four coefficients are, neither signed bus gain can
    // exceed the sign-blind ceiling.
    const grid = [-1, -0.75, -0.25, 0, 0.25, 0.75, 1];
    for (const a of grid) for (const b of grid) for (const c of grid) for (const d of grid) {
      const p = illogicFaceParams(R({ [ch(1)]: a, [ch(2)]: b, [ch(3)]: c, [ch(4)]: d }));
      const ceil = illogicBusCeiling(p);
      expect(Math.abs(illogicSumGain(p))).toBeLessThanOrEqual(ceil + 1e-12);
      expect(Math.abs(illogicDiffGain(p))).toBeLessThanOrEqual(ceil + 1e-12);
    }
    // And the ceiling is REACHABLE on both — it is a worst case, not a bound
    // nothing attains.
    const allPos = illogicFaceParams(R());
    expect(illogicSumGain(allPos)).toBe(illogicBusCeiling(allPos));
    const split = illogicFaceParams(R({ [ch(3)]: -1, [ch(4)]: -1 }));
    expect(illogicDiffGain(split)).toBe(illogicBusCeiling(split));
  });
});

describe('illogic face model — TOTALITY (a readout runs on every render)', () => {
  it('a fresh node with NO params resolves the def defaults', () => {
    // `node.params` is a SPARSE overlay of what has been TOUCHED — reading it
    // bare is the StereoCrossoverPanel scar.
    const empty = reader({});
    expect(illogicSumGainText(empty)).toBe('×4.00');
    expect(illogicDiffGainText(empty)).toBe('×0.00');
    expect(illogicBusCeilingText(empty)).toBe('×4.00');
    expect(illogicChannelRows(empty).map((r) => r.amount)).toEqual(
      ILLOGIC_ATT_PARAM_IDS.map((id) => DEFAULTS[id]),
    );
  });

  it('NaN / ±Infinity / undefined never throw and never print a broken number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined]) {
      const rd = reader({ ...DEFAULTS, [ch(1)]: bad });
      // A non-finite live value falls back to the def default rather than
      // poisoning the sum, so the row still prints a real number.
      expect(() => illogicSumGainText(rd)).not.toThrow();
      expect(illogicSumGainText(rd)).toBe('×4.00');
      expect(illogicBusCeilingText(rd)).toBe('×4.00');
    }
    // The formatter itself is total on a non-finite it is handed directly.
    expect(fmtBusGain(Number.NaN)).toBe('—');
    expect(fmtBusGain(Number.POSITIVE_INFINITY)).toBe('—');
    // …and −0 must not print as `×−0.00`.
    expect(fmtBusGain(-0)).toBe('×0.00');
  });

  it('every declared readout id RESOLVES and prints through the registry', () => {
    const declared = (illogicDef.face?.hero?.readouts ?? []).map((r) => r.valueId).filter(Boolean);
    expect(declared.length, 'the hero declares readouts').toBeGreaterThan(0);
    for (const id of declared) {
      const fn = faceReadoutValueFor(id!);
      expect(fn, `readout ${id} is registered`).toBeTruthy();
      const out = fn!(R());
      expect(typeof out).toBe('string');
      expect(out.length, `readout ${id} prints something`).toBeGreaterThan(0);
    }
  });
});

describe('illogic face — the GLYPH resolution, in both directions', () => {
  it('this def has NO audio output, so `primaryAudioOutPortId` is null', () => {
    expect(primaryAudioOutPortId(illogicDef)).toBeNull();
    expect(illogicDef.outputs.some((o) => o.type === 'audio')).toBe(false);
  });

  it("`glyph: 'none'` resolves to the NONE binding", () => {
    expect(illogicDef.face?.glyph).toBe('none');
    expect(glyphBinding(illogicDef).kind).toBe('none');
  });

  it('NEGATIVE CONTROL: any other glyph on THIS def resolves to the DEAD static binding', () => {
    // The marbles defect (#1692) manufactured on the real def: with no audio
    // output to tap, `meter` / `scope` / `waveform` all fall through to
    // `{ kind: 'static' }`, which is what `module-face-lint`'s dead-glyph clause
    // refuses. This is why `'none'` is a decision rather than a default.
    for (const g of ['meter', 'scope', 'waveform', 'envelope', 'algorithm'] as const) {
      const probe = { ...illogicDef, face: { ...illogicDef.face!, glyph: g } };
      expect(glyphBinding(probe).kind, `glyph '${g}' on a def with no audio out`).toBe('static');
    }
  });

  it('POSITIVE CONTROL: the same predicate DOES bind when an audio output exists', () => {
    // So "static" above is a property of THIS def's port types, not of a
    // resolver that returns `static` for everything.
    const withAudio = {
      ...illogicDef,
      outputs: [...illogicDef.outputs, { id: 'probe_out', type: 'audio' as const }],
      face: { ...illogicDef.face!, glyph: 'meter' as const },
    };
    expect(primaryAudioOutPortId(withAudio)).toBe('probe_out');
    expect(glyphBinding(withAudio).kind).not.toBe('static');
  });
});

describe('illogic face — promotion + the picture', () => {
  it('is PROMOTED, and the promotion is what changes the UI', () => {
    expect(STRICT_FACES.has('illogic')).toBe(true);
    expect(illogicDef.face, 'authoring a face IS the promotion').toBeTruthy();
  });

  it('the sidebar names a REGISTERED panel', () => {
    const custom = (illogicDef.face?.sidebar ?? []).filter((b) => b.kind === 'custom');
    expect(custom.length, 'the routing picture is a sidebar block').toBeGreaterThan(0);
    for (const b of custom) {
      expect(sidebarPanelFor(b.panelId!), `panel ${b.panelId} is registered`).toBeTruthy();
    }
  });

  it('the picture marks exactly the tapped channels, and marks the sign', () => {
    const rows = illogicChannelRows(R({ [ch(1)]: -0.5 }));
    expect(rows.filter((r) => r.logic).map((r) => illogicChannelInputId(r.index)).sort()).toEqual(
      [...ILLOGIC_LOGIC_TAPPED_INPUTS].sort(),
    );
    // The SIGN survives into the drawing — it is the one thing a level meter
    // cannot see, so the triangle hatches on it.
    expect(rows[0]!.amount).toBe(-0.5);
    expect(rows.filter((r) => r.amount < 0).length).toBe(1);
    // And the polarity split reaches the picture too.
    expect(rows.map((r) => r.diffSign)).toEqual([...ILLOGIC_DIFF_SIGNS]);
  });

  it('the RANK is channel order, and every ranked key is a declared param', () => {
    // The DEFENCE of this order (channel reach: 7 / 6 / 3 / 3 outputs) is
    // MEASURED against the shipping factory in
    // art/scenarios/illogic/face-audit.test.ts, which asserts the reach
    // ordering is non-increasing along this list. Here we only pin that the
    // list IS channel order and resolves.
    expect(illogicDef.face?.order).toEqual([...ILLOGIC_ATT_PARAM_IDS]);
    const declared = new Set(illogicDef.params.map((p) => p.id));
    for (const k of illogicDef.face?.order ?? []) expect(declared.has(k)).toBe(true);
  });
});
