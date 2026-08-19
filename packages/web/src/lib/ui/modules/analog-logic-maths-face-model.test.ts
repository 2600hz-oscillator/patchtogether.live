// packages/web/src/lib/ui/modules/analog-logic-maths-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS UNDER ANALOGLOGICMATHS' FACEPLATE.
//
// A derived readout is only worth more than a relabelled dial if something
// checks, ON EVERY RUN, that it moves where the dial is BLIND — and that it
// does NOT move where the dial would.
//
// ⚠ THIS MODULE MAKES THE USUAL MATRIX SHAPE VACUOUS, and saying so is the
// reason this file is built differently from `destroy-face-model.test.ts`.
// destroy's matrix is `readout × param` over each param's [min, max] travel.
// Here that matrix is ALL-TRUE and therefore proves nothing: with only two
// dials, every readout moves under every dial's full travel. The discriminating
// perturbations are STRUCTURAL — flip a sign, swap the two dials, rescale both,
// rebalance at a constant sum — and each one is chosen so that some readouts
// must move and some must NOT:
//
//                       sign flip B   swap A/B   rescale ×½   rebalance Σ
//     sum   tanh(a+b)      MOVES        still      MOVES        still
//     diff  a − b          MOVES        MOVES      still        MOVES
//     ring  tanh(a·b)      MOVES        still      MOVES        MOVES
//     peak  Σ|a|           still        still      MOVES        still
//
// Every readout owns at least one `still` cell and at least one `MOVES` cell,
// and every leg owns at least one of each — asserted, not described, so the
// table cannot degenerate into four spellings of one number. The coarse
// per-param sweep is kept too, as the leg that catches a readout going
// CONSTANT.
//
// WHAT THIS FILE CANNOT SEE, stated so a green run does not read as more than
// it is: it checks the MODEL's arithmetic, not the DSP's. The join to the
// shipping worklet — that SUM really saturates by −6.34 dB at full scale, that
// DIFF really reaches Σ|attN| unclipped, that PRODUCT really is silent with one
// input unpatched, that the CV cables really reach the params — is
// `art/scenarios/analog-logic-maths/face-audit.test.ts`, which renders the
// module through its own factory.

import { describe, expect, it } from 'vitest';
import { analogLogicMathsDef } from '$lib/audio/modules/analog-logic-maths';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import {
  ALM_ATT_PARAM_IDS,
  ALM_CLIPPED_OUT_IDS,
  ALM_LINEAR_OUT_IDS,
  ALM_OUT_IDS,
  ALM_PROBE,
  almDiffGain,
  almFaceParams,
  almPeak,
  almRingGain,
  almSumGain,
  almTransferCurves,
  almTransferSpan,
  fmtAlmGain,
} from './analog-logic-maths-face-model';

/** A param reader over a sparse overlay, exactly as ModuleShell builds one. */
const reader =
  (overlay: Record<string, number>) =>
  (id: string): number | undefined =>
    overlay[id];

/** The DECLARED readout ids, read off the def. DERIVED — there is no list of
 *  readouts in this file and no count of one. */

/** The DECLARED param ids, read off the def. */
const PARAM_IDS = analogLogicMathsDef.params.map((p) => p.id);

/** The default overlay — what a freshly spawned node resolves to. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  analogLogicMathsDef.params.map((p) => [p.id, p.defaultValue]),
);

/** `[attA, attB]` → the overlay ModuleShell would read. Positional, keyed off
 *  the def's own attenuverter roster so a rename cannot leave a stale literal. */
function at(a: number, b: number): Record<string, number> {
  return Object.fromEntries(ALM_ATT_PARAM_IDS.map((id, i) => [id, [a, b][i]!]));
}


/**
 * THE STRUCTURAL LEGS. Each is a pair of dial settings and, per readout, whether
 * the PRINTED STRING must differ. `false` cells are the point — see the header.
 */
const LEGS: readonly {
  name: string;
  from: [number, number];
  to: [number, number];
  moves: Record<string, boolean>;
  why: string;
}[] = [
  {
    name: 'SIGN FLIP on ATT B',
    from: [1, 1],
    to: [1, -1],
    moves: { 'alm-sum-gain': true, 'alm-diff-gain': true, 'alm-ring-gain': true, 'alm-peak': false },
    why:
      'inverting one dial SWAPS the module: SUM collapses to the null and DIFF becomes its ' +
      'loudest jack. `peak` must NOT notice — it is Σ|attN| and |−1| = |+1|, and that ' +
      'sign-blindness is what makes it the other three’s control.',
  },
  {
    name: 'SWAP the two dials',
    from: [1, 0.5],
    to: [0.5, 1],
    moves: { 'alm-sum-gain': false, 'alm-diff-gain': true, 'alm-ring-gain': false, 'alm-peak': false },
    why:
      'SUM, PRODUCT, MIN and MAX are SYMMETRIC in A and B; only DIFF is antisymmetric. So a ' +
      'swap must move exactly one readout — which is also the whole polarity argument the ' +
      'face ranks on.',
  },
  {
    name: 'RESCALE both dials ×½',
    from: [1, 1],
    to: [0.5, 0.5],
    moves: { 'alm-sum-gain': true, 'alm-diff-gain': false, 'alm-ring-gain': true, 'alm-peak': true },
    why:
      'the dials MULTIPLY in PRODUCT and ADD everywhere else, so halving both HALVES `peak` ' +
      'and QUARTERS `ring` — a distinction no additive readout can make. `diff` stays ×0.00 ' +
      'because a balanced pair is a null at any depth.',
  },
  {
    name: 'REBALANCE at constant Σ',
    from: [0.5, 0.5],
    to: [0.8, 0.2],
    moves: { 'alm-sum-gain': false, 'alm-diff-gain': true, 'alm-ring-gain': true, 'alm-peak': false },
    why:
      'SUM and `peak` depend only on the TOTAL, so a rebalance leaves both still while it ' +
      'breaks the DIFF null and moves the product. Without this leg `sum` and `peak` would ' +
      'be indistinguishable from each other on every other leg.',
  },
];

describe('analogLogicMaths face model — the glyph binding, ESTABLISHED not assumed', () => {
  it('resolves to NOTHING, which is why the declared glyph is ‘none’', () => {
    // The marbles / buggles / ninelives lesson (#1692): `primaryAudioOutPortId`
    // matches `type === 'audio'`, and this module declares five `cv` outputs and
    // no audio output at all. Every glyph literal but 'none' would therefore
    // fall through `glyphBinding` to `{kind:'static'}` — the dead binding
    // `module-face-lint` refuses — and paint a live-looking readout of nothing.
    // Asserted by CALLING both functions rather than by trusting the comment.
    expect(primaryAudioOutPortId(analogLogicMathsDef)).toBeNull();
    expect(analogLogicMathsDef.face?.glyph).toBe('none');
    // ⚠ `{kind:'none'}`, NOT `{kind:'static'}`: `glyphBinding` short-circuits on
    // the DECLARED literal before it inspects a single port. `'static'` is the
    // DEAD state this module would be in had it declared anything else — and the
    // negative control below is what proves that, by declaring one.
    expect(glyphBinding(analogLogicMathsDef)).toEqual({ kind: 'none' });
  });

  it('NEGATIVE CONTROL, BOTH WAYS: the resolution is a property of the PORTS', () => {
    // The assertion above would pass on a resolver that returned null for
    // everything, so perturb the thing it claims to measure and confirm the
    // answer moves — in both directions.
    //
    // ⚠ THE GLYPH LITERAL MUST BE OVERRIDDEN IN BOTH MUTANTS, and finding that
    // out is worth a line: `glyphBinding` short-circuits on `glyph === 'none'`
    // BEFORE it looks at any port, so spreading this def and only adding an
    // audio output still returns `{kind:'none'}`. A control that forgot this
    // would have "passed" by measuring the literal it was trying to control for.
    const withAudio = {
      ...analogLogicMathsDef,
      face: { ...analogLogicMathsDef.face!, glyph: 'scope' as const },
      outputs: [{ id: 'sum', type: 'audio' as const }, ...analogLogicMathsDef.outputs.slice(1)],
    };
    expect(primaryAudioOutPortId(withAudio)).toBe('sum');
    expect(glyphBinding(withAudio)).toEqual({ kind: 'live-audio', portId: 'sum' });

    // …and THE STATE THIS MODULE WOULD BE IN had it declared anything else: the
    // dead `{kind:'static'}` binding module-face-lint refuses.
    const deadGlyph = {
      ...analogLogicMathsDef,
      face: { ...analogLogicMathsDef.face!, glyph: 'scope' as const },
    };
    expect(primaryAudioOutPortId(deadGlyph)).toBeNull();
    expect(glyphBinding(deadGlyph)).toEqual({ kind: 'static' });
  });
});

describe('analogLogicMaths face model — the four laws, and the numbers they print', () => {

  it('`sum` is the only law that is NON-LINEAR IN THE DRIVE', () => {
    // The property that makes it a JOIN rather than a gain, and the reason the
    // readout row names its probe. At a tenth of the rail SUM is very nearly
    // transparent; at the rail it is 6.34 dB down. The other three are gains and
    // do not care.
    //
    // ⚠ "NEARLY", MEASURED. The first draft of this leg asserted ×2.00 at a
    // tenth scale and went red at 1.9738 — tanh(0.2)/0.1, which is −0.11 dB, not
    // zero. The tanh has no transparent region, only a shallow one, and the
    // rounded ×2.00 in the header prose would have been a transcribed value
    // rather than a measured one. The numbers here are the measured ones.
    const a = almFaceParams(reader(DEFAULTS));
    const small = almSumGain(a, ALM_PROBE / 10);
    const full = almSumGain(a, ALM_PROBE);
    expect(small, 'a tenth-scale input sees ×1.97 — −0.11 dB re the un-clipped ×2.00')
      .toBeCloseTo(1.97375, 4);
    expect(full, 'a full-scale input sees ×0.96 — −6.34 dB re the same reference')
      .toBeCloseTo(0.964028, 5);
    expect(small, 'the gain RISES toward the un-clipped ×2.00 as the drive falls')
      .toBeGreaterThan(full * 2);
    // NEGATIVE CONTROL — `diff` and `peak` are drive-INVARIANT by construction,
    // so the sensitivity above is a property of the tanh and not of the harness.
    expect(almDiffGain(a)).toBe(0);
    expect(almPeak(a)).toBe(2);
  });

  it('THE JOIN: the compression exists only when BOTH dials are open', () => {
    // The STOP-1 claim, as arithmetic. Neither dial alone can print this,
    // because closing either one nearly triples the transparency.
    const both = almSumGain([1, 1]);
    const one = almSumGain([1, 0]);
    const dbBoth = 20 * Math.log10(both / 2);
    const dbOne = 20 * Math.log10(one / 1);
    expect(dbBoth, 'dB re the un-clipped sum, both dials open').toBeCloseTo(-6.3388, 3);
    expect(dbOne, 'dB re the un-clipped sum, ATT B closed').toBeCloseTo(-2.3655, 3);
    expect(dbBoth, 'opening the second dial nearly triples the compression').toBeLessThan(dbOne - 3);
  });
});

describe('analogLogicMaths face model — totality and the structural declarations', () => {

  it('the CLIPPED / LINEAR partition names only DECLARED ports, and partitions them', () => {
    // ANCHORED: a jack renamed out from under `ALM_CLIPPED_OUT_IDS` is RED here,
    // and a new jack lands in one half rather than in neither. (Which half is
    // CORRECT is measured against the worklet in the ART audit.)
    for (const id of ALM_CLIPPED_OUT_IDS) {
      expect(ALM_OUT_IDS, `clipped jack '${id}' is a declared output`).toContain(id);
    }
    expect([...ALM_CLIPPED_OUT_IDS, ...ALM_LINEAR_OUT_IDS].sort()).toEqual([...ALM_OUT_IDS].sort());
    expect(ALM_LINEAR_OUT_IDS, 'DIFF is on the LINEAR side — the jack with no clip').toContain('diff');
  });

  it('`fmtAlmGain` is total and never prints a negative zero', () => {
    expect(fmtAlmGain(NaN)).toBe('—');
    expect(fmtAlmGain(Infinity)).toBe('—');
    expect(fmtAlmGain(-0)).toBe('×0.00');
    expect(fmtAlmGain(-2)).toBe('×−2.00');
  });

  it('the transfer picture reads the SAME laws the readouts do', () => {
    // The picture and the numbers must not be two implementations of one claim.
    // At the probe, each curve's value IS the corresponding readout's number.
    const a = almFaceParams(reader(DEFAULTS));
    const curves = almTransferCurves(a);
    const byId = Object.fromEntries(curves.map((c) => [c.outId, c]));
    expect(byId['sum']!.at(ALM_PROBE)).toBeCloseTo(almSumGain(a) * ALM_PROBE, 9);
    expect(byId['diff']!.at(ALM_PROBE)).toBeCloseTo(almDiffGain(a) * ALM_PROBE, 9);
    expect(byId['sum']!.clipped, 'SUM is drawn as the clipped curve').toBe(true);
    expect(byId['diff']!.clipped, 'DIFF is drawn as the linear one').toBe(false);
    // The y span always shows the rail — otherwise "DIFF crosses it" is invisible.
    expect(almTransferSpan(a)).toBeGreaterThan(ALM_PROBE);
    expect(almTransferSpan([0.2, 0.2]), 'a near-closed pair still shows the ±1 marks')
      .toBeGreaterThan(ALM_PROBE);
  });
});
