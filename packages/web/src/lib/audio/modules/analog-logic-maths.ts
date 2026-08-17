// packages/web/src/lib/audio/modules/analog-logic-maths.ts
//
// ANALOGLOGICMATHS (ALM) — analog-logic mixer.
//
// Inspired by Mystic Instruments ANA (hardware, no firmware source — this is
// a from-spec implementation, NOT a port). The intent is the "logic" of
// analog electronics: continuous-signal min/max/diff/sum/product, not the
// digital boolean logic that ILLOGIC ships.
//
// Two continuous inputs A and B feed bipolar attenuverters (-1..+1) and the
// post-attenuverter signals fan out into five simultaneous outputs:
//
//   MIN     = min(A', B')          — sample-wise minimum
//   MAX     = max(A', B')          — sample-wise maximum
//   DIFF    = A' - B'              — sign-aware difference
//   SUM     = tanh(A' + B')        — pure sum with tanh soft-clip
//   PRODUCT = tanh(A' * B')        — sample-wise multiply with tanh soft-clip
//
// Musical use:
//   • MIN/MAX of two waveforms gives jagged-saw / smoothed-crest mashing.
//   • MAX of two envelopes = "either-trigger" fires.
//   • DIFF of two LFOs creates anti-correlated motion.
//   • PRODUCT of two audios is ring-mod; of two CVs is smooth blending.
//
// ILLOGIC contrast: ILLOGIC thresholds inputs at 0.5 and produces AND/NAND/
// OR/NOT booleans (0 or 1). ALM never thresholds — its outputs are
// continuous functions of the inputs.
//
// ⚠ WHICH JACKS CAN LEAVE THE ±1 RAIL — MEASURED, and it is not the pair the
// soft-clip protects. For in-range inputs (|a|,|b| ≤ 1) at any attenuverter
// setting, |a′| ≤ 1 and |b′| ≤ 1, so:
//
//   SUM      a′+b′ ∈ [−2,+2]   CAN exceed the rail   → tanh, bounded under 1
//   PRODUCT  a′·b′ ∈ [−1,+1]   CANNOT exceed it      → tanh anyway: −2.37 dB
//                                                      of distortion at the
//                                                      corner, protecting
//                                                      nothing
//   DIFF     a′−b′ ∈ [−2,+2]   CAN exceed the rail   → ⚠ NOT CLIPPED. It is
//                                                      the ONLY jack on this
//                                                      module that leaves ±1,
//                                                      and it reaches ±2.00 at
//                                                      the shipped defaults
//   MIN/MAX  select one of a′,b′ — genuinely bounded
//
// Measured through this def's own factory in
// `art/scenarios/analog-logic-maths/face-audit.test.ts`. The DSP source used to
// say the opposite ("soft-clip is applied only to SUM + PRODUCT, the operations
// that can leave the [-1,+1] range … MIN / MAX / DIFF stay bounded"); that
// sentence was wrong in both halves and is corrected in
// `packages/dsp/src/analog-logic-maths.ts`. The behaviour is UNCHANGED — an
// unclipped difference is the correct instrument, and the faceplate prints its
// live ceiling as `peak` instead.
//
// Trimmed output set rationale: the canonical analog-logic catalog also
// lists MEAN ((a+b)/2) and ABS_DIFF (|a-b|). MEAN is SUM÷2 — patch a follow-
// up attenuator if needed; redundant on the panel. ABS_DIFF is niche enough
// that we omitted it to keep the 5-out card readable; can ship as a follow-
// up if user feedback asks for it.
//
// Inputs:
//   a (cv): bipolar input A.
//   b (cv): bipolar input B.
//   attA_cv (cv, linear, paramTarget=attA): displaces the A attenuvert.
//   attB_cv (cv, linear, paramTarget=attB): displaces the B attenuvert.
//
// Outputs:
//   min (cv): min(A', B').
//   max (cv): max(A', B').
//   diff (cv): A' - B'.
//   sum (cv): tanh(A' + B').
//   product (cv): tanh(A' * B').
//
// Params:
//   attA (linear -1..1, default 1): A attenuvert.
//   attB (linear -1..1, default 1): B attenuvert.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/analog-logic-maths.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'analog-logic-maths';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure helpers extracted so unit tests can pin the math without spinning
 *  up a Web Audio context. The worklet's per-sample loop is the same five
 *  expressions. */
export const analogLogicMath = {
  /** Bipolar attenuvert: y = x * att with att ∈ [-1, +1]. */
  atten(x: number, att: number): number {
    return x * att;
  },
  min(a: number, b: number): number {
    return a < b ? a : b;
  },
  max(a: number, b: number): number {
    return a > b ? a : b;
  },
  diff(a: number, b: number): number {
    return a - b;
  },
  /** Sum with tanh soft-clip. a+b can exceed unity; tanh keeps the bus
   *  in (-1, +1). At small amplitudes tanh(x) ≈ x so quiet sums pass
   *  through nearly transparent. */
  sum(a: number, b: number): number {
    return Math.tanh(a + b);
  },
  /** Product with tanh soft-clip. ⚠ NOT the same reasoning as sum: for in-range
   *  inputs |a′·b′| ≤ 1 already, so this tanh cannot be protecting anything —
   *  it is a fixed −2.37 dB of soft distortion at the corner. Kept because it
   *  is the module's shipped voice and because two full-scale OVER-range
   *  sources (±2) do reach it. */
  product(a: number, b: number): number {
    return Math.tanh(a * b);
  },
};

export const analogLogicMathsDef: AudioModuleDef = {
  type: 'analogLogicMaths',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'analoglogicmaths',
  category: 'utilities',

  inputs: [
    { id: 'a',       type: 'cv' },
    { id: 'b',       type: 'cv' },
    // CV-on-knob inputs for both attenuverters — gives a 4-input module
    // where someone can sweep the attenuvert via LFO/envelope. Linear
    // cv-scale per the project's CV range standard.
    { id: 'attA_cv', type: 'cv', paramTarget: 'attA', cvScale: { mode: 'linear' } },
    { id: 'attB_cv', type: 'cv', paramTarget: 'attB', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'min',     type: 'cv' },
    { id: 'max',     type: 'cv' },
    { id: 'diff',    type: 'cv' },
    { id: 'sum',     type: 'cv' },
    { id: 'product', type: 'cv' },
  ],
  params: [
    { id: 'attA', label: 'Att A', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
    { id: 'attB', label: 'Att B', defaultValue: 1, min: -1, max: 1, curve: 'linear' },
  ],

  // ── THE FACEPLATE (PF-20) ────────────────────────────────────────────────
  //
  // WHAT THIS MODULE IS, IN ONE SENTENCE: two attenuverters in front of FIVE
  // simultaneous algebra jacks, of which one saturates, one is a common-mode
  // null at the factory settings, one multiplies where the rest add, and one is
  // the only jack on the module that can leave the ±1 rail. The verb a player
  // performs is TRIM AND INVERT — exactly ILLOGIC's verb — and the thing they
  // cannot see while doing it is which of those five behaviours they just
  // changed.
  //
  // WHY THIS HAS A FACE AT ALL, since the queue rejected it once (§9:
  // *"the module IS its five outputs, and the rear card renders those without a
  // face"*). That sentence is the `ninelives` argument with the sign flipped: a
  // module's face value lives in what it PUBLISHES as much as in what it
  // exposes, and the rear card renders the five JACKS, not the five LAWS. The
  // laws are what no dial prints, and they are measured, not asserted —
  // `art/scenarios/analog-logic-maths/face-audit.test.ts` renders the shipping
  // worklet for every number below.
  //
  // THE MERIT CLAIM IS THE `tanh`, AND ITS KNEE IS REACHABLE. Against the
  // UN-CLIPPED sum (the only reference that makes the rows comparable), SUM's
  // compression on a common-mode input measures:
  //
  //     drive   ±0.05   ±0.10   ±0.25   ±0.30   ±0.40   ±0.50   ±1.00   ±2.00
  //     dB      −0.03   −0.11   −0.68   −0.96   −1.62   −2.37   −6.34  −12.05
  //
  // So it passes 1 dB between ±0.3 and ±0.4 — LESS THAN HALF the rail, an
  // amplitude any LFO or envelope reaches — and it is −6.34 dB at full scale: a
  // routine patch, not a corner case. (⚠ An earlier draft of this paragraph
  // said "about a THIRD of the rail" off the ±0.3 row, which reads −0.96 dB and
  // has therefore NOT crossed. The gate asserts ±0.4.) And it is a JOIN: with ATT
  // B at 0 the same full-scale input compresses by only −2.37 dB, so opening
  // the second dial nearly triples the compression. Neither dial can print a
  // number that only exists when both are open. (§11.1 derived −6.34 / −12.05
  // from the declared law; both REPRODUCE on the shipped worklet to 4 dp.)
  //
  // THE RANK, and the axis this module REFUSES. ILLOGIC ranked its four
  // identical dials by REACH — how many jacks each one moves. That axis does
  // not work here and the audit proves it rather than assuming it: with a > b
  // the sweep reports attA moving 5 jacks and attB moving 4, and SWAPPING THE
  // TWO INPUT AMPLITUDES FLIPS THE ANSWER, because MIN/MAX are selectors and
  // whichever channel is louder owns them. Reach is a property of the STIMULUS
  // here, not of the module (`face-audit.test.ts` M7 asserts both readings).
  //
  // The axis that IS intrinsic is POLARITY: `diff = a′ − b′` is the module's
  // one antisymmetric law, so ATT A enters all five jacks with the sign the
  // panel implies and ATT B inverts one of them. attA first, on that and
  // nothing else. It is a thin axis and saying so is the point — the
  // INFORMATION on this face is in the readouts.
  //
  // NO `pages`. Two keys, one promoted to the hero; a page would buy an ~81 px
  // band over a single fader. The page-less `__all` band renders unlabelled,
  // which is the honest shape (the illogic / destroy / ninelives shape).
  //
  // NO `title`, no `hint`, no band hints — owner ruling 2026-08-11: plain labels
  // and values on the face; the explanation lives in `docs`, one right-click
  // away.
  //
  // ⚠ `faceTierCap('full')` is 6 and this module has TWO params, so every tier
  // from `compact` up renders the identical cells — the `resofilter` collapse,
  // harder than illogic's. This face's value is ENTIRELY in the readouts and
  // the picture, and that is stated here rather than dressed up as a ladder.
  face: {
    order: ['attA', 'attB'],

    // ⚠ ESTABLISHED, NOT ASSUMED. `primaryAudioOutPortId` matches
    // `type === 'audio'` and this module declares FIVE `cv` outputs and no
    // audio output at all, so it returns NULL — every other glyph value falls
    // through `glyphBinding` to `{kind:'static'}`, the DEAD binding
    // `module-face-lint` refuses. `analog-logic-maths-face-model.test.ts` pins
    // that by CALLING both functions, with a has-audio leg proving the
    // resolution is a property of the ports rather than of the literal.
    glyph: 'none',

    hero: {
      control: 'attA',
      readouts: [
        // FOUR LAWS OVER TWO DIALS, chosen so each is BLIND to something the
        // next one sees — the property that makes them each other's negative
        // control on every render rather than four spellings of one number.
        //
        // ⚠ `sum` IS THE ONLY NON-LINEAR ROW, and the whole merit claim. It
        // reads ×0.96 beside a `peak` of ×2.00, and that GAP is the tanh.
        { label: 'sum', valueId: 'alm-sum-gain' },
        // ⚠ READS ×0.00 AT THE SHIPPED DEFAULTS. The module leaves the factory
        // with one of its five jacks configured as a common-mode null, beneath
        // two faders both at maximum — patch one LFO into both inputs and DIFF
        // is silent until you unbalance a dial. Inverting ATT B swaps this row
        // with `sum`, which is the single most useful gesture on the module.
        { label: 'diff', valueId: 'alm-diff-gain' },
        // THE MULTIPLICATIVE ROW. Halve both dials and this QUARTERS while
        // `peak` merely halves — a distinction no additive readout can make.
        { label: 'ring', valueId: 'alm-ring-gain' },
        // THE CEILING, SIGN-BLIND: Σ|attN| = ×2.00 at the defaults on a bus
        // whose convention is ±1. It is DIFF's alone (SUM and PRODUCT are
        // tanh-bounded under 1; MIN/MAX cannot exceed their own inputs), and it
        // is the row that stays still when the sign flip moves the other three.
        { label: 'peak', valueId: 'alm-peak' },
      ],
    },

    // THE PICTURE. `glyph: 'none'` means the shell paints no tile here, so this
    // is the module's only drawing — and it is the one representation in which
    // the readout row is obvious instead of surprising: under ONE common-mode
    // drive, SUM bends over and DIFF does not, and it is the STRAIGHT line that
    // crosses the ±1 rail.
    //
    // A `custom` sidebar block rather than a `hero.cell`, for the structural
    // reason meowbox / noise / illogic all hit: `module-face-lint` refuses a
    // PANEL cell selected at a lane tier and the `full` cap is 6, so a panel's
    // first legal rank is 7 — unreachable on a module with two keys. A sidebar
    // block carries no `face.order` key and therefore no rank at all.
    sidebar: [{ kind: 'custom', label: 'transfer', panelId: 'alm-transfer' }],
  },

  docs: {
    explanation:
      "An analog-logic processor that runs five continuous algebraic operations on two inputs at once — the 'analog' counterpart to ILLOGIC's digital 0/1 booleans. Two inputs A and B each pass through a bipolar attenuverter, then the module simultaneously outputs their sample-wise MINIMUM, MAXIMUM, DIFFERENCE (A-B), SUM (soft-clipped with tanh), and PRODUCT (AxB, soft-clipped). Unlike ILLOGIC nothing is ever thresholded — every output is a smooth function of the inputs, so it works equally on CV and on audio. Musically: MIN/MAX of two waveforms gives jagged or smoothed wave-mashing; MAX of two envelopes is an 'either fires' combiner; DIFF of two LFOs makes anti-correlated motion; PRODUCT of two audio signals is ring modulation, of two CVs a smooth crossfade-blend. The two attenuverters can themselves be swept by CV. FIVE THINGS TO KNOW BEFORE YOU PATCH IT, all measured on the shipping worklet through this module's own factory (art/scenarios/analog-logic-maths/face-audit.test.ts). First, SUM IS A SATURATOR, NOT A MIXER. Two dials at +1 have a nameplate gain of x2.00 and a full-scale signal in both inputs leaves SUM at x0.96 — a compression of -6.34 dB against the un-clipped sum, rising to -12.05 dB for two +/-2 sources. It reads -0.96 dB at +/-0.3 in each input and passes 1 dB by +/-0.4, so this is the normal case rather than a corner one, and it is a JOIN over BOTH dials: with ATT B at 0 the same input compresses by only -2.37 dB. The faceplate prints the live figure as `sum`. Second, DIFF IS THE ONLY JACK THAT CAN LEAVE THE +/-1 RAIL, and it is NOT soft-clipped. Its worst case is |ATT A| + |ATT B| = x2.00 at the shipped defaults, reached whenever the two inputs are anti-phase; even a modest 0.9 / -0.9 pair puts it at 1.80. SUM and PRODUCT are held under 1 by the tanh and MIN/MAX cannot exceed their own inputs, so DIFF is the one to attenuate downstream. The faceplate prints its live ceiling as `peak`. Third, DIFF IS A COMMON-MODE NULL AT THE SHIPPED DEFAULTS. Its gain on a signal present at both inputs is ATT A - ATT B, which is exactly 0.00 with both dials at +1 — so patching one LFO into both jacks gives SUM at x0.96 and DIFF at silence until you unbalance a dial. Inverting ATT B swaps the two. Fourth, WITH ONLY ONE INPUT PATCHED THE MODULE IS A RECTIFIER PAIR: the unpatched input reads 0, so MIN emits only the NEGATIVE half of what you fed it, MAX only the POSITIVE half, and PRODUCT is bit-exactly silent. That is useful (a free full-wave pair from MIN and MAX) but it is not what a jack labelled MIN suggests. Fifth, THE TWO CV INPUTS ARE HALF-DEAD AT THE FACTORY SETTINGS. ATT A and ATT B ship at +1, which is the top of their declared -1..+1 range, and a CV cable ADDS to the knob, so a positive CV of any size is bit-exactly ignored while the knob is at maximum. Turn the dial down to give the CV room; at +1 a bipolar LFO patched to ATT A CV is half-wave rectified.",
    inputs: {
      a: "Input A (bipolar CV or audio). Scaled by the ATT A attenuverter before feeding all five math operations.",
      b: "Input B (bipolar CV or audio). Scaled by the ATT B attenuverter before the math.",
      attA_cv: "CV control over the ATT A attenuverter knob — patch an LFO or envelope here to sweep how much of input A reaches the outputs. It ADDS to the knob's position and the sum is clamped to the knob's own -1..+1 range. ⚠ AT THE SHIPPED DEFAULT THIS INPUT IS HALF-DEAD: ATT A ships at +1, which IS the top of that range, so a positive CV of any size — +1, +5, anything — changes the output by bit-exactly zero, and a bipolar LFO patched here is half-wave rectified (measured). Turn ATT A down to give the cable room: from a knob at 0, a +0.5 CV lands exactly where the knob at +0.5 does.",
      attB_cv: "CV control over the ATT B attenuverter knob — sweep how much of input B reaches the outputs. Adds to the knob and clamps to -1..+1, with the same half-dead-at-the-default behaviour as ATT A CV: at the shipped +1 only the downward half of a bipolar CV does anything.",
    },
    outputs: {
      min: "The sample-wise minimum of the two attenuverted inputs, min(A', B') — follows whichever signal is lower at each moment. ⚠ WITH INPUT B UNPATCHED THIS IS A HALF-WAVE RECTIFIER: the missing input reads 0, so min(A', 0) passes only the NEGATIVE half of A and holds 0 for the rest (measured — a 0.8 sine on A alone leaves MIN swinging -0.80 to 0.00). Useful, and not what the label suggests.",
      max: "The sample-wise maximum, max(A', B') — follows whichever signal is higher; MAX of two envelopes acts as an OR-style 'either triggers'. ⚠ WITH INPUT B UNPATCHED IT IS THE OPPOSITE HALF-WAVE RECTIFIER to MIN: max(A', 0) passes only the POSITIVE half of A. MIN and MAX together therefore give a free full-wave pair off one input.",
      diff: "The signed difference A' - B' — zero when the two match, swinging positive or negative as they diverge. ⚠ THE ONLY JACK ON THIS MODULE THAT CAN LEAVE THE ±1 RAIL, and the only one with NO soft-clip. Its worst case is |ATT A| + |ATT B| — ×2.00 at the shipped defaults on a bus whose convention is ±1, reached whenever the two inputs are anti-phase, and a modest 0.9 / -0.9 pair already reads 1.80 (measured). SUM and PRODUCT are held under 1 by their tanh and MIN/MAX cannot exceed their own inputs, so this is the jack to attenuate downstream; the faceplate prints its live ceiling as `peak`. ⚠ AND AT THE SHIPPED DEFAULTS IT IS A COMMON-MODE NULL: its gain on a signal present at BOTH inputs is ATT A - ATT B = 0.00 with both dials at +1, so patching one CV into both jacks leaves DIFF silent until you unbalance a dial — which is what makes it a difference-taker rather than a second mixer. The faceplate prints that gain live as `diff`.",
      sum: "The sum A' + B' run through a tanh soft-clipper, so it stays within ±1 and saturates instead of hard-clipping when both inputs are loud. ⚠ IT IS A SATURATOR, NOT A MIXER, AND THE KNEE IS LOW. Against the un-clipped sum: -0.11 dB at ±0.1 in each input, -0.68 dB at ±0.25, -0.96 dB at ±0.3, -1.62 dB at ±0.4 (the 1 dB crossing is between those two), -2.37 dB at ±0.5, -6.34 dB at full scale and -12.05 dB for two ±2 sources (measured on the shipping worklet). So two dials reading +1 have a nameplate gain of ×2.00 and deliver ×0.96, and the compression is a JOIN over BOTH dials — with ATT B at 0 the same full-scale input compresses by only -2.37 dB. The faceplate prints the live figure as `sum`, beside a `peak` of ×2.00; the gap between them IS the tanh.",
      product: "The product A' × B' through a tanh soft-clip: ring modulation for two audio inputs, or a smooth multiplicative blend for two CVs. ⚠ THE SOFT-CLIP HERE PROTECTS NOTHING FOR IN-RANGE MATERIAL — |A' × B'| can never exceed 1 when both inputs are inside ±1, so the tanh is a fixed -2.37 dB of soft distortion at the corner rather than a limiter (it only starts limiting for over-range sources; two ±2 inputs compress by -12.05 dB). It is the module's shipped voice and is left alone. ⚠ IT IS ALSO THE ONE JACK THAT NEEDS BOTH INPUTS: with either input unpatched it is bit-exactly silent, and it is the only place the two dials MULTIPLY rather than add — halve both and this quarters. The faceplate prints its gain as `ring`.",
    },
    controls: {
      attA: "Bipolar attenuverter for input A (-1 to +1, default +1): +1 passes A through, 0 removes it from the math, negative values invert its sign. The ATT A CV input adds to this position and is clamped with it. ⚠ IT REACHES ALL FIVE JACKS, AND ITS SIGN IS THE ONE ASYMMETRY BETWEEN THE TWO DIALS: DIFF is A' - B', so ATT A enters every jack with the polarity the panel implies while ATT B inverts that one. ⚠ IT IS ALSO NOT A LEVEL CONTROL ON SUM: because SUM saturates, turning this dial from +0.5 to +1 with a full-scale input moves SUM by 0.20, not by 0.48. ⚠ AND A LEVEL METER CANNOT SEE HALF OF WHAT IT DOES — -1 and +1 differ only in SIGN, so ATT A's rms and peak on MIN/MAX are identical at both ends of the dial while DIFF and PRODUCT invert.",
      attB: "Bipolar attenuverter for input B (-1 to +1, default +1): +1 passes B, 0 removes it, negative inverts. The ATT B CV input adds to this position and is clamped with it. ⚠ THE TWO DIALS ARE NOT INTERCHANGEABLE, in exactly one respect: SUM, PRODUCT, MIN and MAX are symmetric in A and B, but DIFF subtracts this channel, so swapping the two dial positions moves DIFF and nothing else. That is also why inverting this dial turns the DIFF null into the module's loudest jack and SUM into silence.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 5,
      outputChannelCount: [1, 1, 1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of analogLogicMathsDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const pAttA = params.get('attA')!;
    const pAttB = params.get('attB')!;

    return {
      domain: 'audio',
      inputs: new Map([
        ['a',       { node: worklet, input: 0 }],
        ['b',       { node: worklet, input: 1 }],
        // CV-on-param inputs reuse input slot 0 (the engine writes only to
        // the AudioParam in this case; the audio slot is ignored).
        ['attA_cv', { node: worklet, input: 0, param: pAttA }],
        ['attB_cv', { node: worklet, input: 0, param: pAttB }],
      ]),
      outputs: new Map([
        ['min',     { node: worklet, output: 0 }],
        ['max',     { node: worklet, output: 1 }],
        ['diff',    { node: worklet, output: 2 }],
        ['sum',     { node: worklet, output: 3 }],
        ['product', { node: worklet, output: 4 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'attA': pAttA.setValueAtTime(value, ctx.currentTime); return;
          case 'attB': pAttB.setValueAtTime(value, ctx.currentTime); return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'attA': return pAttA.value;
          case 'attB': return pAttB.value;
        }
        return undefined;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
