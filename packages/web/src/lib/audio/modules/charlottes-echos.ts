// packages/web/src/lib/audio/modules/charlottes-echos.ts
//
// CHARLOTTE'S ECHOS — destructive multi-head stereo delay.
//
// A stereo delay with a thicker, more abused character than the basic
// DELAY: per-tap pitch-up grain, gradual feedback-loop decay, and high
// feedback ratios that smear into endless tails. The "destructive" name
// captures the intent — this is the delay you reach for when you want
// the wet path to colour and degrade the source, not stay clean. DSP is
// a TS AudioWorklet (packages/dsp/src/charlottes-echos.ts) built from four
// clean-room AnalogDelayCore stages (the GPL-free own-code core that also
// powers COFEFVE) plus an own-code varispeed shifter for the pitch-up.
// Internally this is the audio sibling of VDELAY in the video domain and is
// the effect 4× COFEFVE analog delays would approximate if stacked in serial.
//
// Inputs:
//   L (audio): left-channel signal.
//   R (audio): right-channel signal.
//   delay (cv, log, paramTarget=delay): scales the delay-time knob (log).
//
// Outputs:
//   L (audio): left-channel wet+dry mix.
//   R (audio): right-channel wet+dry mix.
//
// Params:
//   delay (log 0.001..1.5 s, default 0.4): tap time.
//   feedback (linear 0..1, default 0.5): feedback ratio (high ≈ infinite tails).
//   decay (linear 0..1, default 0.2): per-tap colour-decay (HF loss in the loop).
//   pitchUp (linear 0..0.2, default 0): per-tap pitch-shift on the feedback path.
//   mix (linear 0..1, default 0.5): dry/wet balance.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamDef } from '$lib/graph/types';
import workletUrl from '@patchtogether.live/dsp/dist/charlottes-echos.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * The five params, declared ONCE.
 *
 * ⚠ THE CARD MUST NOT RE-TYPE THESE NUMBERS. `CharlottesEchosCard.svelte` used
 * to pass ten literal `min=`/`max=` props plus five `defaultValue=`, five
 * `curve=` and two labels that DISAGREED with the def (`Feedback` vs `Fbk`,
 * `Pitch` vs `Ptch` — both were ledgered in `card-def-debt.ts`). Every gate we
 * own reads the DEF, so a card that restates a number can disagree with it and
 * nothing goes red (the analogVco `min={0}`-against-`-1` defect). Promotion
 * makes that split visible in a second way: the dock face renders straight off
 * these ParamDefs, so the same knob would have carried two labels depending on
 * which surface you reached it through. The card now binds every prop through
 * `CHARLOTTES_ECHOS_RANGES` and re-types nothing.
 */
const PARAMS: readonly ParamDef[] = [
  { id: 'delay',    label: 'Delay',    defaultValue: 0.4, min: 0.001, max: 1.5, curve: 'log',    units: 's' },
  { id: 'feedback', label: 'Feedback', defaultValue: 0.5, min: 0,     max: 1,   curve: 'linear' },
  { id: 'decay',    label: 'Decay',    defaultValue: 0.2, min: 0,     max: 1,   curve: 'linear' },
  { id: 'pitchUp',  label: 'Pitch',    defaultValue: 0,   min: 0,     max: 0.2, curve: 'linear' },
  { id: 'mix',      label: 'Mix',      defaultValue: 0.5, min: 0,     max: 1,   curve: 'linear' },
];

/**
 * Param ranges live HERE and nowhere else — the card imports this rather than
 * re-typing the numbers (CLAUDE.md: "a control's range must come from ONE
 * place"). The values are the def's OWN `ParamDef` objects, by identity, not a
 * parallel copy that could drift; `art/scenarios/charlottes-echos/cv-path.test.ts`
 * asserts that identity in both directions.
 */
export const CHARLOTTES_ECHOS_RANGES: Readonly<Record<string, ParamDef>> = Object.fromEntries(
  PARAMS.map((p) => [p.id, p]),
);

export const charlottesEchosDef: AudioModuleDef = {
  type: 'charlottesEchos',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: "charlotte's echos",
  category: 'effects',
  stereoPairs: [['L', 'R']],

  inputs: [
    { id: 'L',     type: 'audio' },
    { id: 'R',     type: 'audio' },
    // CV scaling per docs/adr/004-cv-range-convention.md.
    // delay: log (0.001..1.5s).
    { id: 'delay', type: 'cv', paramTarget: 'delay', cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: PARAMS,

  docs: {
    explanation:
      "A destructive multi-head stereo delay — a four-stage cascade of echoes that colour and degrade the source rather than repeating it cleanly. Each of the four stages tap the delayed signal in turn; FEEDBACK is fed to every stage so repeats compound across the chain into smeared, endless tails, DECAY progressively tapers each later stage's level and adds in-loop drive and high-frequency loss for a darkening, dub-like decay, and PITCHUP shifts each stage up by a compounding ratio so the cascaded echoes climb in pitch — the classic ascending-shimmer effect. It is the audio sibling of the video-domain VDELAY, and roughly the sound of four COFEFVE analog delays stacked in serial. Reach for it when you want the wet path to abuse the signal.",
    inputs: {
      L: 'Left-channel input feeding the multi-head delay cascade.',
      R: 'Right-channel input feeding the cascade. If unpatched it is normalled from L, so a mono source into L alone drives both channels of the cascade and the echoes come back centred rather than hard-left.',
      delay: 'CV that scales the DELAY-time knob (log-scaled), shifting all tap times together — sweep it for tape-warble and pitch-bend smears on the echoes.',
    },
    outputs: {
      L: 'Left-channel output: the dry signal blended with the four-stage wet cascade per MIX. ⚠ The two channels are INDEPENDENT CASCADES sharing one control set — there is no width, no ping-pong and no stereo offset here (the DSP pins all three to 0), so silence into L with signal into R measures a bit-exact 0.0000 on this output. "Stereo" means two mono paths, not an image.',
      R: 'Right-channel output: the dry signal blended with the wet cascade per MIX. Independent of L in both directions — measured max|L−R| = 0.000e+0 for a mono source and zero cross-talk for two different sources.',
    },
    controls: {
      delay: 'Base tap time in seconds, log-scaled 1 ms..1.5 s — the spacing of the first echo (the cascade stages derive from it, each running at a quarter of it). Measured first-echo time / knob = 1.000 from 3 ms up. Summed with the DELAY CV input. ⚠ THE BOTTOM OF THE DIAL IS A FLOOR: each stage clamps at 0.5 ms, so the cascade cannot go below 2 ms and every setting from the 1 ms minimum up to 2 ms renders BIT-IDENTICALLY — about 9 % of the log travel. It also sets how FAST a tail fades rather than whether it does: at a fixed FEEDBACK and DECAY the same loop gain loses 47 dB/s at 0.15 s and 7 dB/s at 1.0 s, because the round trip is DELAY/4.',
      feedback: 'Feedback amount fed to EVERY stage (0..1) — the largest authority on the module (25.6 dB of RMS span across its travel). ⚠ IT IS HALF OF A STABILITY BOUNDARY, not an amount control. Each stage multiplies it by 0.995 and by its own in-loop drive (see DECAY), so the loop gain is FEEDBACK × 0.995 × (1 + DECAY × 4 × 0.8); when that reaches 1 the echoes NEVER DECAY. At the shipped DECAY of 0.2 the boundary is FEEDBACK 0.59 — inside the normal working range of the dial. It never self-oscillates from nothing (feedback 1 with no input renders bit-exact silence): it needs a seed, and once seeded it keeps it.',
      decay: "Per-tap colour-decay (0..1): progressively tapers each later stage's wet level and adds in-loop tanh drive plus high-frequency loss, so the repeats darken and degrade as they fade — the 'destructive', dub-delay character. ⚠ IT IS THREE CONTROLS AT ONCE AND ITS NAME SAYS ONE. Measured wet-only: a LEVEL control (peak 2.0000 at 0 down to 0.0381 at 1, ~22 dB), a TONE control (spectral centroid 1040 Hz → 125 Hz), and — because the drive it adds sits INSIDE each feedback loop with small-signal gain 1 + DECAY × (1+stage) × 0.8, up to 4.2 at the last stage — the other half of the stability boundary. At the shipped FEEDBACK of 0.5 the boundary is DECAY 0.29: turning a 'darkening' dial from 0.2 to 0.35 is what makes the module a drone.",
      pitchUp: 'Per-stage upward pitch shift (0..0.2). At 0 the internal varispeed grain shifter is bypassed entirely and the echoes repeat at pitch; above 0 each successive stage is transposed up by a compounding ratio, so content that traverses stages 1-3 climbs by (1+PITCH)^6 — at 0.1 that is +990 cents, most of an octave, which no 0..0.2 linear dial hints at. ⚠ IT IS ALSO A TIME CONTROL, AND IT IS DISCONTINUOUS AT ZERO: each engaged shifter seeds its read lag at half of a 30 ms grain window, so the instant PITCH leaves 0 the three engaged stages insert 45.000 ms between the hit and the first echo (measured to the sample at PITCH = 1e-9), after which the offset wanders anywhere in 16.6-25.2 ms with the grain phase. ⚠ AND IT COSTS 15-28 dB of wet level: the two grain taps sum with unity GAIN but read content 15 ms apart, so their POWER sum is at best 3 dB down per engaged stage. Set it, do not ride it.',
      mix: 'Dry / wet balance (0..1): 0 is the clean input, 1 is the cascade only, between crossfades the two. It is the only control provably OUTSIDE every feedback loop — measured, it moves the level 9.8 dB and the tail length 0.00 s. ⚠ It is also what turns the wet path\'s internal ±2 clamp into an output clip: at DECAY 0 / FEEDBACK 0.9 / MIX 1 a sustained source measures peak 2.0000 with 84 % of samples past full scale, where the same patch at the shipped MIX 0.5 measures 1.30.',
    },
  },

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // WHAT THIS MODULE IS, IN ONE SENTENCE: four analog delays in SERIES, each
  // with its own feedback loop and its own in-loop tanh drive, with a grain
  // shifter between them — so the repeats are not copies. Each pass through the
  // chain comes back quieter, darker, more saturated and (optionally) higher
  // than the last. That is what separates it from DELAY and COFEFVE, and the
  // verb a player performs is FEED: you give it a hit and decide whether the
  // rack ever gets quiet again.
  //
  // THE PROBLEM THIS FACE EXISTS FOR: two of the five dials are a STABILITY
  // BOUNDARY wearing the labels of taste controls. The in-loop drive's
  // small-signal gain is 1 + DECAY×(1+stage)×0.8 and it multiplies the feedback
  // INSIDE each stage's own loop, so FEEDBACK_MAX = 0.995 does not bound it:
  // the module stops decaying at FEEDBACK × 0.995 × (1 + DECAY×3.2) = 1, which
  // at the shipped defaults is 0.82 — a margin of 0.11 on either dial. Nothing
  // on the card, in the old docs, or in any gate said so.
  //
  // The measurements are NOT repeated here. Every claim in this comment is
  // re-derived from the SHIPPING worklet on every run by
  // art/scenarios/charlottes-echos/face-law.test.ts, and every readout's
  // negative control is permanent in charlottes-echos-face-model.test.ts — a
  // number copied into a comment could go stale while the gate stayed green,
  // which is the drift this repo keeps re-learning.
  //
  // ⚠ ONE SPEC CLAIM WAS MEASURED AND REFUTED. The batch-6 spec asserted the
  // stability boundary is a function of DELAY as well (a table sliding from
  // DECAY 0.318 at 20 ms to 0.208 at 600 ms). It was bisected with a LEVEL
  // threshold over a fixed-length render, which cannot tell "does not decay"
  // from "decays slowly" — and a longer tape decays slower in wall-clock time by
  // construction. Re-measured with a RATE instrument (dB/s between two late
  // windows) the boundary is loop gain 1.000 at 0.02 s, 0.15 s, 0.6 s AND 1.5 s.
  // DELAY moves the RATE, not the boundary. The `margin` readout is a closed
  // form because of that correction.
  //
  // THE RANKING, and it would be wrong for a different module. Ranks 1-6 are the
  // whole lane budget (faceTierCap) and this module has five params, so the
  // ranking is what MINI and COMPACT show, not what the dock hides:
  //   1 FEEDBACK — the largest measured authority of the five (max|Δ| 1.0126
  //     linear, 25.61 dB of RMS span, both the widest) and the numerator of the
  //     loop gain. It is also the one loop control with NO CV jack, so the dial
  //     is the only way to reach it.
  //   2 DECAY — the other half of the boundary, and three controls in one:
  //     ~22 dB of level, an 8.3× centroid drop, and the drive that raises the
  //     loop gain while lowering the level. Turning it DOWN is what makes the
  //     module clip; turning it UP is what makes it never stop.
  //   3 DELAY — the module's unit and the spacing everything else is measured
  //     in, ranked BELOW the loop pair because it is the one control with a CV
  //     input (a patcher can reach it without the dial) and because it decides
  //     how fast a tail fades rather than whether there is one.
  //   4 MIX — the only control provably outside every loop, and the one that
  //     turns the internal ±2 clamp into an output clip.
  //   5 PITCH — the signature, and SET-ONCE: it is discontinuous at zero
  //     (+45.000 ms of grain lag the instant it leaves 0) and costs 15-28 dB, so
  //     it is not a control you ride. Last is the honest rank for a control you
  //     touch once per patch.
  // Read back as a sentence: MINI gives you FEEDBACK; COMPACT gives you the pair
  // that decides whether the module stops; the PLATE gives you all five; the
  // dock adds the hero, the three readouts and the sidebar.
  //
  // ⚠ `order` AND `pages` DISAGREE, DELIBERATELY. `order` is priority (which
  // control survives to a 192 px tile); `pages` is SIGNAL ORDER for the tier
  // that shows everything — the tape first (DELAY sets the spacing, PITCH bends
  // it), then the loop the tape feeds. MIX sits in the loop band as a ONE-CELL
  // CLUSTER labelled "outside the loop", because that is the cheapest way to
  // state the fact (~14 px of sub-header) without buying an ~81 px band for a
  // single knob.
  //
  // ⚠ NO `hero.cell`. A picture of the echo train would be a good sidebar
  // `custom` panel and is deliberately NOT in this PR: nothing on this module is
  // `node.data`, so promotion strands no input path (STOP 2 is clean — the card
  // is five Knobs and a PatchPanel and the affordance grep returns nothing), and
  // a picture is a want, not a rescue. Leaving `cell` unset also keeps the
  // `scope` glyph painting at the dock.
  // ⚠ NO `title`, NO `hint`, NO band hints. Owner ruling 2026-08-11
  // (marbles / resofilter): a face carries PLAIN LABELS AND VALUES, and the
  // explanation lives in `docs` for right-click → annotate. `sidecar`,
  // `warrensspectrum` and `wavetableVco` — the three faces merged since — all
  // declare none of the three, and the docs above carry every sentence a draft
  // of this face had put in them.
  face: {
    order: ['feedback', 'decay', 'delay', 'mix', 'pitchUp'],

    pages: [
      { id: 'tape', label: 'the tape', controls: ['delay', 'pitchUp'] },
      {
        id: 'loop',
        label: 'the loop',
        controls: ['feedback', 'decay', 'mix'],
        clusters: [{ label: 'outside the loop', controls: ['mix'] }],
      },
    ],

    // An INSERT: bit-exactly silent with nothing patched (asserted in
    // cv-path.test.ts), so the tile's trace is a flat centreline and the VRT
    // scene pins deterministically — this is not the analogVco case.
    glyph: 'scope',

    hero: {
      // FEEDBACK is promoted because it is the control two of the three readouts
      // are about and the one with the largest measured authority.
      control: 'feedback',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'charlottes-echos', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Silence keeps the node active even when nothing is patched in — pinned to
    // input 0 ONLY. A ConstantSource on input 1 makes Chrome hand the processor
    // a (silent) channel for input 1 forever, which defeats the DSP's
    // `inputs[1]?.[0] ?? inputs[0]?.[0]` mono normal and renders an unpatched R
    // as digital silence. Enforced by mono-normal-not-defeated.test.ts.
    const silenceL = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceL.start();
    silenceL.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of charlottesEchosDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDelay = params.get('delay');
    const pFb = params.get('feedback');
    const pDecay = params.get('decay');
    const pPitch = params.get('pitchUp');
    const pMix = params.get('mix');

    return {
      domain: 'audio',
      inputs: new Map([
        ['L',     { node: workletNode, input: 0 }],
        ['R',     { node: workletNode, input: 1 }],
        ['delay', { node: workletNode, input: 0, param: pDelay! }],
      ]),
      outputs: new Map([
        ['L', { node: workletNode, output: 0 }],
        ['R', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        silenceL.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
