// packages/web/src/lib/audio/modules/ringback.ts
//
// RINGBACK — stereo crush effect extracted from the TWOTRACKS record-time
// artifact. Stereo in (L/R) → stereo out (L/R). Wraps the `ringback` worklet
// (packages/dsp/src/ringback.ts), which runs the shared RingChannel crush core
// (ringback-core.ts): an integer-cell varispeed write into a small ring buffer
// + a fractional interpolated read-back at the same cursor + feedback, dry/wet
// at the output — the exact mechanism that made TWOTRACKS' monitor sound
// "bitcrushed" while recording, now a deliberate effect.
//
// Inputs:
//   in_l / in_r (audio) — stereo input (mono in → mirrored to both channels).
// Outputs:
//   out_l / out_r (audio) — stereo crushed output.
// Params — RANGES LIVE IN $lib/audio/ringback-crush-model, which sources SIZE
// and FEEDBACK from the DSP core's own clamp constants and is checked against
// the worklet's `parameterDescriptors` by ringback-crush-model.test.ts. The
// card imports the same consts, so no surface can restate them:
//   rate     (0.05..4,  default 0.5)  — ring cursor advance in CELLS PER SAMPLE.
//                                       Below 1 the wet path is decimated by
//                                       1/rate — that IS the crush.
//   size     (2..4096,  default 64)   — ring length in samples (comb ↔ grainy smear).
//   feedback (0..0.98,  default 0.3)  — read-back re-injected into the ring (regen tail).
//   mix      (0..1,     default 1)    — dry/wet (0 = clean, 1 = full crush).
// All four are a-rate AND read per frame (ringback.ts:83-90), so every CV jack
// is a genuine audio-rate consumer — the face's rear card ticks all four.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  RINGBACK_FEEDBACK,
  RINGBACK_MIX,
  RINGBACK_RATE,
  RINGBACK_SIZE,
  formatRingbackFeedback,
  formatRingbackMix,
  formatRingbackRate,
} from '$lib/audio/ringback-crush-model';
import workletUrl from '@patchtogether.live/dsp/dist/ringback.js?url';

// Pure crush math re-exported from the worklet's shared core so the card + unit
// tests share ONE import surface (relative path, not the package alias —
// svelte-check only resolves the TS source out of node_modules via the dist
// build; cube.ts / twotracks.ts re-export the same way).
export {
  ringRead,
  ringWriteSpan,
  clampSize,
  clampFeedback,
  clampMix,
  mixSample,
  RingChannel,
  RINGBACK_MIN_SIZE,
  RINGBACK_MAX_SIZE,
  RINGBACK_MAX_FEEDBACK,
} from '../../../../../dsp/src/lib/ringback-core';

const PROCESSOR_NAME = 'ringback';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const ringbackDef: AudioModuleDef = {
  type: 'ringback',
  label: 'ringback', // MUST be lowercase (card CSS uppercases for display)
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  category: 'effects',

  // PF-4 JACK LABELS, authored here so the rear rail, the front PatchPanel and
  // the lane drill-down all read one string. Derivation gives `IN L` / `OUT L`
  // (expandStem splits the underscore), which says the direction a second time
  // next to the rear card's own `←`/`→` glyph and its in/out rails — the exact
  // redundancy PF-5 strips from `_in`/`_out` ids. `L` / `R` is what is left
  // when the surface has already said the rest, and it is unambiguous WITHIN a
  // rail, which is all a jack label has to be (patch-panel-labels' stated
  // collision policy). Cosmetic: `portLine` has no label branch, so this is a
  // 0-line move in contract-lock.txt.
  inputs: [
    { id: 'in_l', type: 'audio', label: 'L' },
    { id: 'in_r', type: 'audio', label: 'R' },
    // CV inputs — the four params are a-rate worklet AudioParams, so a -1..+1
    // CV sweeps each param's natural range via the shared cvScale routing
    // (engine.addEdge → attachCvScale). cvScale.mode mirrors each knob's curve.
    { id: 'rate',     type: 'cv', paramTarget: 'rate',     cvScale: { mode: 'linear' } },
    { id: 'size',     type: 'cv', paramTarget: 'size',     cvScale: { mode: 'log' } },
    { id: 'feedback', type: 'cv', paramTarget: 'feedback', cvScale: { mode: 'linear' } },
    { id: 'mix',      type: 'cv', paramTarget: 'mix',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio', label: 'L' },
    { id: 'out_r', type: 'audio', label: 'R' },
  ],
  // RANGES COME FROM ONE PLACE ($lib/audio/ringback-crush-model), and SIZE +
  // FEEDBACK reach back further still — to `RINGBACK_MIN_SIZE` /
  // `RINGBACK_MAX_SIZE` / `RINGBACK_MAX_FEEDBACK` in the DSP core the worklet
  // runs. `format` is UI VOCABULARY and contract-transparent (contract-signature
  // reads only id/min/max/curve/defaultValue/units), so nothing below moves
  // contract-lock.txt.
  //
  // SIZE deliberately has NO `format`, and that is a decision rather than an
  // omission: `units: 'smp'` already puts the number in the unit that means
  // something, and the quantity a player actually hears — the ring LAP, hence
  // the comb pitch — is `size / rate`, a TWO-param product that a per-param
  // formatter is structurally unable to express. A band label ('COMB' /
  // 'GRAIN') would be decoration, and `knobReadout` returns null by default
  // precisely so a persistent readout has to be earned.
  params: [
    {
      id: 'rate',
      label: 'Rate',
      defaultValue: RINGBACK_RATE.default,
      min: RINGBACK_RATE.min,
      max: RINGBACK_RATE.max,
      curve: 'linear',
      // `0.50` is not half of anything audible; `SR/2.0` is the crush stated.
      format: formatRingbackRate,
    },
    {
      id: 'size',
      label: 'Size',
      defaultValue: RINGBACK_SIZE.default,
      min: RINGBACK_SIZE.min,
      max: RINGBACK_SIZE.max,
      curve: 'log',
      units: 'smp',
    },
    {
      id: 'feedback',
      label: 'Feedback',
      defaultValue: RINGBACK_FEEDBACK.default,
      min: RINGBACK_FEEDBACK.min,
      max: RINGBACK_FEEDBACK.max,
      curve: 'linear',
      // The number says how much comes back; the readout says how LONG.
      format: formatRingbackFeedback,
    },
    {
      id: 'mix',
      label: 'Mix',
      defaultValue: RINGBACK_MIX.default,
      min: RINGBACK_MIX.min,
      max: RINGBACK_MIX.max,
      curve: 'linear',
      // A bare 0.35 does not say which end is wet — and this module spawns
      // FULLY WET, which is the first thing about it a player has to know.
      format: formatRingbackMix,
    },
  ],

  // ── RACKLINE face (batch B of the face program; UI CURATION ONLY, outside
  // the I/O contract — see ModuleFace in $lib/graph/types).
  //
  // WHAT IT IS FOR. Every other short-delay effect in the rack is trying to be
  // clean: COFEFVE and CHARLOTTE'S ECHOS colour their repeats, SHIMMERSHINE
  // diffuses them, DELAY is deliberately transparent. RINGBACK is the only one
  // whose entire mechanism is a MISMATCH — the ring is written into integer
  // cells at a varispeed cursor and read back interpolated at that same
  // cursor, and everything you hear is the difference between those two. So
  // the verb is not "set a time and a feedback"; it is "detune the write
  // against the read until the signal breaks the way you want".
  //
  // `order` is a PRIORITY ranking for the tiers that show a SUBSET; `pages` is
  // FUNCTION order for the tier that shows everything. They are allowed to
  // disagree — do not "fix" one to match the other.
  //
  // THE TIER LADDER, read back as a sentence. Four params and a glyph give
  // mini 1 / compact 2 / full 4 / dock 4. The `full` tile is FOUR cells, which
  // needs two plate rows, and ranked controls outrank the glyph — so the full
  // lane tier paints NO glyph (laneBodyPlan: `glyph = hasGlyph && rows <= 1`).
  // The glyph therefore exists for mini and compact only, and it costs the
  // compact tier its third cell (2 beside a glyph, 3 without). That trade is
  // the ranking's central decision and it is bought below.
  //
  //   mini (1):     RATE — the mismatch itself.
  //   compact (2):  + SIZE. RATE and SIZE are not two knobs, they are one
  //                 sound: the ring's lap is `size / rate` samples, so the
  //                 pitch you hear is their ratio and neither is readable
  //                 without the other. Putting them on the same tile is what
  //                 makes the tile playable.
  //   full (4):     + FEEDBACK, + MIX on the plate's second row.
  //   dock:         two bands — the ring, then the blend.
  //
  // WHY RATE LEADS, and the argument does not transfer to another module.
  // RINGBACK's timbral sensitivity is measurable, and it was measured: sweeping
  // each param alone across its declared range over a C4 saw through the real
  // per-sample core, the output waveform's normalised roughness moves
  // rate 5.05x · size 4.76x · mix 3.28x · feedback 2.18x. The two controls the
  // compact tile shows are the two the sound is most sensitive to, by a 45 %
  // margin over the third. `ringback-crush-model.test.ts` DERIVES that ranking
  // from the DSP and checks this face against it, so a re-rank has to re-argue
  // the property rather than edit a literal.
  //
  // THE COUNTER-ARGUMENT, stated because it is real: this module spawns at
  // `mix = 1` — FULLY WET, the most intrusive state it has — so one could rank
  // MIX first on the grounds that the first thing a player needs is the way
  // back out. That is the VCA face's REACHABILITY argument, and it does NOT
  // transfer: the VCA spawns at `base = 0`, silent, with every other cell inert,
  // whereas nothing on RINGBACK is inert at spawn (pinned in the model test —
  // moving any one of the four defaults changes the output). A mini tile whose
  // one control is the bypass is a tile that can only make the module quieter.
  // If you disagree: move 'mix' to the front of `order` and change nothing else
  // — `pages` and the rear card are untouched by the ranking.
  //
  // MIX RANKS LAST for the plate's sake: ranks 3 and 4 are tier-identical (the
  // plate holds 6), so the only thing they decide is the 3x2 layout. FEEDBACK
  // third puts the three controls that SHAPE the crush on row one and leaves
  // the one that decides how much of it you hear alone on row two.
  //
  // GLYPH 'scope', not the FX-family default 'meter', and this is an empirical
  // claim rather than a taste call. Across RATE's whole range — the hero
  // control, the one cell the mini tile has — the output RMS moves 3.96 dB
  // while the waveform's roughness moves 5.05x. An RMS meter is very nearly
  // BLIND to the control the tile is about, which is the "metric invariant to
  // the dimension under test" trap from CLAUDE.md applied to a picture. The
  // trace shows both the crush and the ring's comb periodicity, and it goes
  // through the ordinary `live-audio` binding on out_l (glyphBinding: any glyph
  // + a primary audio output). Measured and pinned in the model test, so if the
  // DSP ever changes the gate re-opens the question.
  face: {
    order: ['rate', 'size', 'feedback', 'mix'],
    // FUNCTION order, and it happens to equal `order` here — for the
    // independent reason that the signal flows ring-then-blend, which is also
    // how a player reads the band. Two pages, not three: splitting FEEDBACK
    // off as its own 'regeneration' band would buy a ~81 px band for one knob
    // that is part of the ring by construction (it is summed INTO the write).
    // 'output blend' with a single control follows delay + shimmershine.
    pages: [
      { id: 'ring',   label: 'crush ring',   controls: ['rate', 'size', 'feedback'] },
      { id: 'output', label: 'output blend', controls: ['mix'] },
    ],
    glyph: 'scope',
    // REAR CARD. Derivation files the audio pair under a generic 'signal'
    // band; name it by FUNCTION instead, exactly as shimmershine (the other
    // stereo insert) does — 'stereo in' is what a patcher coming from the
    // mono-jacked DELAY needs to see. The four CV holes are derived into their
    // target's page band and need no curation. No page id collides with this
    // group id ('signal' vs 'ring'/'output'), so the leading band is claimed
    // once — the dx7 double-render shape does not apply.
    //
    // audioRate: ALL FOUR, and the citation is the worklet, not a habit.
    // `ringback.ts:55-58` declares every descriptor `a-rate`, `:83-90` reads
    // each one through `av(arr, i)` — a per-FRAME index, not a once-per-block
    // `arr[0]` — and the CV reaches them through `attachCvScale`'s plain
    // WaveShaper with `oversample: 'none'` and no smoothing anywhere
    // (cv-scale.ts:169-170). So these jacks genuinely are sampled per sample:
    // patch audio into RATE and you are frequency-modulating the crush, not
    // nudging it at envelope rate. That is the OPPOSITE of shimmershine and
    // qbrt, whose k-rate / si.smoo params deliberately tick nothing — and
    // `ringback-crush-model.test.ts` checks the claim against the worklet
    // source so it cannot rot into a lie.
    rear: {
      groups: [{ id: 'signal', label: 'stereo in', ports: ['in_l', 'in_r'] }],
      audioRate: ['rate', 'size', 'feedback', 'mix'],
    },
  },

  docs: {
    explanation:
      "A stereo crush effect built from the exact glitch that used to make TWOTRACKS' monitor sound bitcrushed while recording, turned into a deliberate instrument. Each channel writes the input into a short ring buffer at an integer-cell varispeed (set by RATE) and reads it back with fractional interpolation at the same moving cursor, with FEEDBACK re-injecting the read-back into the ring. The mismatch between the stair-stepped write and the smooth read produces a crushed, comb-filtered, grainy texture whose character ranges from subtle aliasing to harsh digital smear. RATE sets the crush hardness, SIZE the ring length, FEEDBACK the regenerating tail, and MIX the dry/wet — but RATE and SIZE are really one control in two halves, because the ring laps every SIZE / RATE input samples and it is that RATIO, not either knob alone, that sets the comb pitch you hear. It ships FULLY WET (MIX 1), so it is at its most extreme the instant you patch it in. All four params are a-rate AND read once per sample, and the CV path has no smoothing in it, so these are true audio-rate jacks: an oscillator into RATE frequency-modulates the crush rather than automating it.",
    inputs: {
      in_l: 'Left-channel audio into the crush ring buffer. (A mono source is mirrored to both channels.)',
      in_r: 'Right-channel audio into the crush ring buffer.',
      rate: 'CV that displaces the RATE knob (linear), modulating the varispeed write rate — sweep it for shifting crush intensity and pitched-comb artifacts. Genuinely AUDIO-RATE: the worklet declares this param a-rate and reads it once per SAMPLE, and the CV reaches it through an unsmoothed shaper, so an oscillator patched here frequency-modulates the crush itself rather than nudging it at envelope rate.',
      size: 'CV that displaces the SIZE knob (log-scaled), modulating the ring length live (comb-filter pitch ↔ grain size). Audio-rate like the other three, and the most violent of them: the ring length is re-clamped every sample, so a fast modulation re-points the read head mid-lap and shreds the tail.',
      feedback: 'CV that displaces the FEEDBACK knob, modulating how much read-back re-injects (the regenerating tail amount). Audio-rate, so it doubles as a ring modulator on the regeneration path.',
      mix: 'CV that displaces the MIX knob, modulating the dry/wet crush balance. Audio-rate: at audio frequencies this crossfade between the clean and crushed copies becomes its own timbre rather than an automation.',
    },
    outputs: {
      out_l: 'Left channel of the crushed stereo output (dry blended with the crushed ring read-back per MIX).',
      out_r: 'Right channel of the crushed stereo output.',
    },
    controls: {
      rate:
        "The ring cursor's advance in CELLS PER INPUT SAMPLE (0.05..4) — the mismatch that IS this module. Below 1 the cursor moves less than a cell per sample, so 1/RATE consecutive input samples land in the same integer cell and only the last one survives: the wet path is decimated to RATE × the sample rate with no anti-alias filter anywhere, which is why the knob reads SR/2.0 at its default and SR/20 at the bottom. At and above 1 nothing is discarded and the knob reads FULL SR — but that is a claim about decimation, not about cleanliness. Measured on the real per-sample core over a C4 saw, the output is at its SMOOTHEST at the INTEGER rates (normalised roughness 0.29 / 0.26 / 0.24 / 0.22 at 1 / 2 / 3 / 4, against the dry saw's own 0.26) and rough again in between (0.81 at 1.25, 0.73 at 1.5), because a fractional cursor smears the write across a fractional cell span and reads back interpolated. So the harsh region is roughly 0.1–0.9 plus every non-integer setting above 1, and the four integer detents are the closest this module gets to a clean short comb.",
      size: 'Ring buffer length in samples, log-scaled 2..4096. Tiny sizes give a high-pitched comb-filter tone; larger sizes spread into a grainy, smeared echo-like texture. Two things worth knowing: the DSP ROUNDS this to a whole number of cells (a knob at 63.7 runs as 64), and the pitch you actually hear is not SIZE alone — the ring laps every SIZE / RATE input samples, so the comb frequency is set by the RATIO of the two knobs and halving RATE drops the ring an octave without touching SIZE. That is also why this control carries no persistent readout: the number that matters is a product of two params, and a per-knob readout cannot show it.',
      feedback:
        'How much of the read-back is re-injected into the ring (0..0.98). Each LAP of the cursor around the ring multiplies the stored signal by this amount, so the tail is a geometric decay and the knob reads it in laps: 1 PASS at 0 (the crushed copy is heard once and overwritten), 6 LAPS at the 0.3 default, 66 LAPS at 0.9, and RINGING once the tail outlasts 100 laps (about 0.933 up) — the regime where the ring stops decaying audibly and settles into the metallic drone. It is hard-clamped strictly below 1, so it can never self-amplify without bound.',
      mix: 'Dry / wet balance (0..1): 0 is the clean input, 1 is full crush, between blends the two. It defaults to 1 — a freshly spawned RINGBACK is FULLY WET, which is unusual for an insert effect and is why the knob names its ends (DRY / 99% WET / WET) rather than printing a bare fraction. Turning it down is the only control that makes the module quieter rather than different.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2, // [0]=L, [1]=R
      numberOfOutputs: 1,
      outputChannelCount: [2], // stereo
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of ringbackDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in_l', { node: worklet, input: 0 }],
        ['in_r', { node: worklet, input: 1 }],
        // CV → AudioParam (a-rate). node/input are placeholders required by the
        // handle type; the engine connects to `param` (cvScale interposed).
        ['rate',     { node: worklet, input: 0, param: params.get('rate')! }],
        ['size',     { node: worklet, input: 0, param: params.get('size')! }],
        ['feedback', { node: worklet, input: 0, param: params.get('feedback')! }],
        ['mix',      { node: worklet, input: 0, param: params.get('mix')! }],
      ]),
      outputs: new Map([
        ['out_l', { node: worklet, output: 0 }],
        ['out_r', { node: worklet, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
