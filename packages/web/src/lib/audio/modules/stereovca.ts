// packages/web/src/lib/audio/modules/stereovca.ts
//
// STEREOVCA — stereo VCA + ring modulator with independent stereo
// normalling on the audio AND strength halves.
//
// out_l = in_l * (strength_l + offset) * level
// out_r = in_r * (strength_r + offset) * level
//
// The same per-channel multiply behaves as a VCA gain control when the
// strength input is slow (CV / LFO / envelope) and as a ring modulator
// when the strength input is audio-rate. No mode toggle — the perceptual
// difference is purely a function of signal frequency content, matching
// Eurorack hardware convention (CV is just slow audio). The strength
// inputs declare cable type `cv` (raw bipolar carrier consumed directly
// in the per-sample multiply with NO scaling — listed in the
// PASSTHROUGH_BY_DESIGN ledger in cv-scale-registry.test.ts), so any
// cv-typed source (LFO, ADSR, sequencer step CV) lands without a
// cross-type cast. Audio-rate ring mod is achieved by patching
// audio-rate signals into the in_l/in_r audio carriers and any
// modulator into strength_*.
//
// Normalling rules (independent for the two domains):
//   in_r unpatched       → in_r := in_l        (mono → stereo)
//   strength_r unpatched → strength_r := strength_l (one knob both VCAs)
// Either side can be normalled without forcing the other to be.
//
// `level` (0..1, default 1.0) is a master output gain post-multiply.
// `offset` (-1..+1, default 0, BIPOLAR) is a DC term added to the
// strength signal before multiplying. With offset=0, strength=+1 gives
// unity output, strength=0 mutes; offset=+1 lifts the strength's
// effective range so an unpatched (0V) strength still passes audio at
// unity. Useful for "always-on with optional duck" patches.
//
// Inputs:
//   in_l / in_r (audio): stereo audio in.
//   strength_l / strength_r (cv): per-channel multiplier (CV or audio-rate carrier).
//     Slow signals → VCA, audio-rate signals → ring modulator.
//
// Outputs:
//   out_l (audio): in_l * (strength_l + offset) * level.
//   out_r (audio): in_r * (strength_r + offset) * level.
//
// Params:
//   level (linear 0..1, default 1.0): master output gain.
//   offset (linear -1..1, default 0.0): DC offset added to each strength input.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamLandmark } from '$lib/graph/types';
import workletUrl from '@patchtogether.live/dsp/dist/stereovca.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'stereovca';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure helpers extracted so unit tests can pin the math without spinning
 *  up Web Audio. Mirrors the per-sample loop in stereovca.ts (DSP) — any
 *  drift here means the worklet and the unit-test reference disagree. */
export const stereoVcaMath = {
  /** Per-channel multiply: out = in * (strength + offset) * level. */
  sample(inSample: number, strengthSample: number, offset: number, level: number): number {
    return inSample * (strengthSample + offset) * level;
  },

  /** Apply normalling rules and run the per-sample multiply over a pair
   *  of channel buffers. Returns { outL, outR } as fresh Float32Arrays.
   *  Pass `null` (NOT a silent buffer) for any unpatched input — that's
   *  the same convention the worklet uses to detect normalling targets. */
  render(
    inL: Float32Array | null,
    inR: Float32Array | null,
    sL: Float32Array | null,
    sR: Float32Array | null,
    offset: number,
    level: number,
    frames: number,
  ): { outL: Float32Array; outR: Float32Array } {
    const inRNorm = inR ?? inL;
    const sRNorm  = sR  ?? sL;
    const outL = new Float32Array(frames);
    const outR = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const xL  = inL      ? (inL[i]      ?? 0) : 0;
      const xR  = inRNorm  ? (inRNorm[i]  ?? 0) : 0;
      const stL = sL       ? (sL[i]       ?? 0) : 0;
      const stR = sRNorm   ? (sRNorm[i]   ?? 0) : 0;
      outL[i] = stereoVcaMath.sample(xL, stL, offset, level);
      outR[i] = stereoVcaMath.sample(xR, stR, offset, level);
    }
    return { outL, outR };
  },
};

/**
 * OFFSET's three named waypoints — the QUIESCENT FLOOR this dial sets.
 *
 * ⚠ THE OWNER RULED THIS MECHANISM BY NAME (#1962, 2026-08-19, verbatim
 * *"2 - b"*): stereovca KEEPS its behaviour — mute at centre, unity at both
 * rails, no default change and no audible change — and the mute-at-centre fact
 * is made LEGIBLE **on the control**, as a landmark NAME at the centre
 * position. Not a readout row: the 2026-08-17 resting-text ruling permits an
 * option/landmark NAME under a control and forbids every other derived-state
 * shape, and a `MUTE` tick at 12 o'clock is the permitted class.
 *
 * WHAT EACH NAME IS TRUE OF, and it is the FLOOR, not the module's audibility.
 * `offset` is the DC term added to `strength` before the multiply, so with
 * nothing patched the multiplier IS `offset` — but with a cable in `strength_*`
 * the gain is `(strength + offset) × level` and no label on this dial could
 * track it. Naming the FLOOR is therefore true unconditionally, where naming
 * the module's output level would become a lie the moment a modulator arrives:
 *
 *   −1 `INV`   the floor is unity with the polarity flipped (|gain| = level)
 *    0 `MUTE`  the floor is closed — the shipped default, and the whole point
 *   +1 `UNITY` the floor is open at unity with no modulator patched
 *
 * ⚠ NEAREST-MATCH SPREAD, MEASURED AND ACCEPTED. `knobNameReadout` resolves by
 * NEAREST value by design (`knob-vocabulary-model.ts` says so, and ties go to
 * the earlier entry), so `MUTE` prints across |offset| ≤ 0.5 — where the
 * quiescent gain reaches ×0.5, i.e. −6.02 dB, which is quiet but not muted.
 * The alternative measured against it was a five-tick roster adding `HALF` at
 * ±0.5, which halves the band to |offset| ≤ 0.25 (−12.04 dB) and doubles the
 * text on a 46 px lane knob. Three ticks is what every existing landmark
 * roster in the repo declares (kickdrum `body_shape`, lfo `shape`,
 * warrensspectrum) and compact-by-default is the standing ruling, so the band
 * is PINNED by `stereovca-face-model.test.ts` rather than narrowed here.
 *
 * ⚠ AND `format` IS DELIBERATELY NOT DECLARED. `paintsReadout` is
 * `!format && (options || landmarks)`, so declaring a formatter — the shape
 * `vca` uses for its own attenuverter — would paint NOTHING at rest and delete
 * the exact legibility the ruling asks for. The distinction is real rather
 * than stylistic: vca's `cvAmount` means its SIGN (a BOUNDARY, where a nearest
 * lookup genuinely lies — see vca-gain-model's header), while this dial means
 * its MAGNITUDE, which is a proximity question and is what landmarks answer.
 *
 * UI VOCABULARY, so contract-transparent: `contract-signature` projects only
 * id/min/max/curve/defaultValue/units, and this def is audio, so the attest is
 * NIL on both counts.
 */
export const STEREOVCA_OFFSET_LANDMARKS: readonly ParamLandmark[] = [
  { value: -1, label: 'INV' },
  { value: 0, label: 'MUTE' },
  { value: 1, label: 'UNITY' },
];

export const stereovcaDef: AudioModuleDef = {
  type: 'stereovca',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'stereovca',
  category: 'utilities',
  // Rack: the canonical 1u reference (1 square tile). Phase-1 rack sizing.
  size: '1u',
  hp: 1,

  inputs: [
    { id: 'in_l',       type: 'audio' },
    { id: 'in_r',       type: 'audio' },
    { id: 'strength_l', type: 'cv' },
    { id: 'strength_r', type: 'cv' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    { id: 'level',  label: 'Level',  defaultValue: 1.0, min:  0, max: 1, curve: 'linear' },
    // The landmark roster is the #1962 ruling's whole implementation — see
    // STEREOVCA_OFFSET_LANDMARKS above for what each name is true OF and why
    // no `format` may join it.
    { id: 'offset', label: 'Offset', defaultValue: 0.0, min: -1, max: 1, curve: 'linear',
      landmarks: STEREOVCA_OFFSET_LANDMARKS },
  ],

  docs: {
    explanation:
      "A dual (stereo) voltage-controlled amplifier that doubles as a ring modulator — no mode switch, the behavior is purely a function of how fast the control signal is. Each channel computes out = in × (strength + offset) × level: when the STRENGTH input is slow (an LFO, an envelope, a sequencer step) it acts as a VCA, gating and shaping the audio's volume; when STRENGTH is audio-rate it acts as a ring modulator, multiplying two audio signals into clangorous sum-and-difference tones (this matches the hardware truth that 'CV is just slow audio'). The two channels share the LEVEL and OFFSET knobs but have independent audio and strength inputs, with smart normalling so you can drive both sides from one cable: leave IN R unpatched and it mirrors IN L (mono in, stereo out), leave STRENGTH R unpatched and it mirrors STRENGTH L (one modulator drives both VCAs). The STRENGTH inputs take raw bipolar CV directly with no scaling.",
    inputs: {
      in_l: "Left audio carrier — the signal the left channel multiplies by its strength. For ring modulation patch an audio oscillator here.",
      in_r: "Right audio carrier. If you leave this unpatched it is normalled to IN L, so a single mono source fans out to both output channels (mono-to-stereo).",
      strength_l: "Left multiplier / modulator (raw bipolar CV, consumed with no scaling). A slow signal makes the channel behave as a VCA (volume control); an audio-rate signal makes it a ring modulator. At strength +1 (and offset 0) the channel passes at unity; at 0 it mutes; negative values invert.",
      strength_r: "Right multiplier / modulator. If unpatched it is normalled to STRENGTH L, so one CV or LFO controls both VCAs at once; patch it for independent left/right modulation.",
    },
    outputs: {
      out_l: "Left result: in_l × (strength_l + offset) × level. Audio (or ring-mod) out for the left channel.",
      out_r: "Right result: in_r × (strength_r + offset) × level, honoring the IN R and STRENGTH R normalling above.",
    },
    controls: {
      level: "Master output gain applied after the per-channel multiply (0 to 1, default unity) — a final trim on both channels at once without touching the modulation depth.",
      offset: "A bipolar DC term added to each strength signal before multiplying (-1 to +1, default 0). It sets the QUIESCENT FLOOR — the gain the channel has with nothing patched into STRENGTH — and the dial is marked with that floor's three named waypoints: MUTE at the centre, UNITY at +1, and INV at -1 (also unity, with the polarity flipped, so the two ends differ in phase and not in level). The shipped default is the centre, so a freshly patched stereovca with no modulator is SILENT until you move this control or send it some strength; turn it up toward +1 to lift the floor so the channel stays open at unity even with no modulator, and a strength signal then only ducks it — handy for 'always on with optional duck' patches. With a cable in STRENGTH the gain is (strength + offset) x level, so the marks name where this dial sits rather than how loud the module is.",
    },
  },

  // RACKLINE curation (face queue Q42). Two controls, so almost nothing about
  // this face is a layout decision — the whole of it is WHICH CONTROL IS RANK 1
  // and WHAT THE DIAL SAYS AT REST, and both descend from one measurement.
  //
  // WHAT IT IS FOR, musically: the rack's stereo VCA *and* its ring modulator,
  // with no mode switch — `out = in × (strength + offset) × level` per channel,
  // and the perceptual difference is purely how fast the control signal is.
  //
  // THE RANKING ARGUMENT, AND IT INVERTS DECLARATION ORDER. Read straight off
  // the shipping worklet (`packages/dsp/src/stereovca.ts:62-71`): with nothing
  // patched into `strength_*` the multiplier is `0 + offset`, so
  //
  //     stL = 0 + offset   ⇒   outL[i] = xL * offset * level
  //
  // and at the shipped defaults (`offset = 0`) that is `xL * 0 * level` — zero
  // for EVERY sample and for EVERY value of `level`. So at spawn:
  //
  //   * `offset` is the ONLY control that can un-mute the module, and
  //   * `level` is bit-exactly INERT — it multiplies a term already exactly 0.
  //
  // The inertness is structural rather than statistical: it is a multiply by a
  // literal zero, not a small number. That is why `offset` takes rank 1 even
  // though `level` is declared first, and it is the same shape as vca's `base`
  // ranking (REACHABILITY FROM THE SPAWN STATE) arrived at independently.
  //
  // WHAT IS GIVEN UP, stated because it is real: at `mini` (cap 1) the tile
  // shows OFFSET alone, so the master trim is one zoom step away. That is the
  // right trade — a tile whose one control cannot make the module audible is a
  // tile with nothing to do.
  //
  // THE TIER LADDER AS A SENTENCE: a glyph BINDS (`meter` resolves
  // `{kind:'live-audio', portId:'out_l'}` — `primaryAudioOutPortId` returns
  // `out_l`), so the compact cap is `LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`, and
  // the module has exactly two controls. Everything fits from compact upward
  // and only `mini` truncates. ⚠ The meter reads EXACTLY ZERO at spawn, for
  // the reason above — so it is also the fastest surface on which a player
  // sees the silent-at-spawn state, and any live-glyph assertion has to drive
  // `offset` or patch `strength_l` first or it is asserting on silence.
  //
  // `glyph: 'meter'` rather than `'waveform'`: both resolve to the same live
  // tap, and this module's entire job is LEVEL — its sharpest property is a
  // level of zero, which is exactly what a meter shows.
  face: {
    order: ['offset', 'level'],
    glyph: 'meter',
    // ⚠ `level` IS DECLARED A FADER AND `offset` IS DELIBERATELY NOT, AND THAT
    // ASYMMETRY IS THE ONE NON-OBVIOUS LINE IN THIS FILE.
    //
    // The legacy card mounts `<NeonFader>` for BOTH (StereovcaCard.svelte), so
    // declaring the kind for both is what "preserve today's look" would ask
    // for. Measured against the shell instead of assumed: the `fader` branch of
    // ModuleShell (`:990-1005`) passes NO `landmarks` and no `ticks`, and
    // `NeonFader` has no resting readout element at all — its own source says
    // why, verbatim: *"A fader's readout is a number by construction — there is
    // no option/landmark NAME a level could print — so the whole element went"*.
    // Only the KNOB branch (`:1044-1046`) forwards `landmarks`, and only
    // `KnobConic` paints `knobNameReadout` plus the labeled `knobMarks` ticks.
    //
    // So declaring `offset: 'fader'` would silently delete the `MUTE` name the
    // owner ruled for on #1962 — a face that looks complete and satisfies the
    // ruling nowhere. `offset` therefore takes the swap from throw to dial
    // DELIBERATELY, buying three labeled ticks and a resting state name; and
    // `level`, which has no vocabulary to print and would gain nothing, keeps
    // its throw. ⚠ Price the lane consequence: `LANE_CELL_H.fader` is 96 px
    // against a 42 px plate row, so one cell of this plate is a throw.
    paramCells: { level: 'fader' },
    // ONE PAGE, and this face says so rather than inventing a second idea: a
    // level and the bias that decides what it multiplies are one thought.
    // Membership is in FUNCTION order — the band reads the same way the law
    // printed at the top of this file does.
    //
    // ⚠ NO `hero.readouts`, AND THAT IS THE RULING RATHER THAN AN OMISSION.
    // The Q42 spec proposed a derived `quiescent gain` line; the owner ruled
    // the legibility onto the CONTROL instead (#1962). A landmark name is
    // strictly narrower than that readout would have been — it cannot see
    // `level`, so it says "OFFSET is at its MUTE position", not "the module is
    // muted" — and that narrowness is the right half to keep: a level fader at
    // zero is self-evidently silent, while an OFFSET at centre is not, and the
    // non-obvious half is the one worth naming.
    //
    // ⚠ NO `face.sidebar`: it is the one contract-projected `face` field, and
    // `sweepBudgetMs(adopterCount)` scales with the roster.
    pages: [
      {
        id: 'level',
        label: 'out = in × (strength + offset) × level',
        controls: ['offset', 'level'],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of stereovcaDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const pLevel  = params.get('level')!;
    const pOffset = params.get('offset')!;

    return {
      domain: 'audio',
      inputs: new Map([
        ['in_l',       { node: worklet, input: 0 }],
        ['in_r',       { node: worklet, input: 1 }],
        ['strength_l', { node: worklet, input: 2 }],
        ['strength_r', { node: worklet, input: 3 }],
      ]),
      outputs: new Map([
        ['out_l', { node: worklet, output: 0 }],
        ['out_r', { node: worklet, output: 1 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'level':  pLevel.setValueAtTime(value, ctx.currentTime); return;
          case 'offset': pOffset.setValueAtTime(value, ctx.currentTime); return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'level':  return pLevel.value;
          case 'offset': return pOffset.value;
        }
        return undefined;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
