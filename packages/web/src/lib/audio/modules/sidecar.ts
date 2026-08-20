// packages/web/src/lib/audio/modules/sidecar.ts
//
// SIDECAR — stereo sidechain ducker. The MAIN audio pair is the trigger
// (e.g. a kick); the SIDECHAIN pair is the signal that gets ducked and
// summed into the output (e.g. a pad/bass). The sidechain is ALWAYS
// present at the output except when the main fires and pulls it down.
// CV-modulatable threshold + envMag + inputLevel, and two CV-shaped
// envelope outs (env_out + env_inv_out) for cross-patch ducking too.
//
// Topology in three sentences (full rationale in
// packages/dsp/src/lib/compressor-dsp.ts):
//   1. The MAIN pair goes through a one-pole detector HPF (sc_hpf knob;
//      20–1000 Hz, default 20 = effectively off) → |aL| + |aR| stereo-link
//      peak detector.
//   2. log2 → 3-region soft-knee gain computer (threshold + knee + ratio,
//      GMR 2012 eq 4) → asymmetric one-pole smoother (attack / release).
//   3. The resulting gainDb (≤ 0) becomes a duck gain (2^(gainDb/6.0205));
//      output = MAIN passthrough + ducked(inputLevel · SIDECHAIN).
//
// env_out semantics — IMPORTANT, NOT a typical compressor envelope:
//   env_out = (-gainDb / 24) * envMag, NO HARD CLAMP.
//   - At envMag = 1 + reduction = 24 dB, env_out reaches 1.0.
//   - At envMag = 2 + reduction = 24 dB, env_out reaches 2.0 (overshoot).
//   Downstream modules MUST tolerate env_out > 1.0 when envMag > 1.
//   env_inv_out = 1 - env_out, also un-clamped (can go negative when
//   env_out > 1). The two outs are the standard "duck this when SC fires"
//   pair: patch env_inv_out into a downstream VCA strength to make that
//   VCA close when this compressor is reducing.
//
// Channel normalling:
//   - audio_r_in unpatched → audio_r := audio_l_in (mono main → stereo duck).
//   - sc_r_in    unpatched → sc_r    := sc_l_in    (mono SC → both outputs).
//   - sc pair unpatched entirely → 0 (nothing to duck; main still passes
//     through to the output).
//
// Stereo-link is always on in v1 — the detector signal is |aL| + |aR|
// summed (the MAIN pair), so a transient on either side ducks BOTH output
// channels equally (no stereo image shift under ducking). A toggle is
// deferred to v2 if a single-channel use case appears.
//
// Inputs:
//   audio_l_in, audio_r_in (audio): MAIN / trigger pair (detector + pass-
//                                   through).
//   sc_l_in, sc_r_in       (audio): SIDECHAIN pair — ducked + summed to out.
//   threshold_cv           (cv):    summed into `threshold` AudioParam.
//   env_mag_cv             (cv):    summed into `envMag` AudioParam.
//   input_level_cv         (cv):    summed into `inputLevel` AudioParam.
//
// Outputs:
//   audio_l_out, audio_r_out (audio): main + ducked sidechain stereo pair.
//   env_out                  (audio at CV-rate): 0..∞ (overshoot allowed).
//   env_inv_out              (audio at CV-rate): 1 - env_out (can go < 0).
//
// Params:
//   threshold  (-60..0 dB,   linear, default -18, CV)
//   ratio      (1..20,        log,    default 4)
//   attack     (0.1..200 ms,  log,    default 10)
//   release    (1..2000 ms,   log,    default 100)
//   knee       (0..24 dB,     linear, default 6)
//   envMag     (0..2,         linear, default 1, CV)
//   inputLevel (0..2 [0–200%],linear, default 1, CV)
//   makeup     (0..24 dB,     linear, default 0)
//   sc_hpf     (20..1000 Hz,  log,    default 20)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/sidecar.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'sidecar';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const sidecarDef: AudioModuleDef = {
  type: 'sidecar',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'sidecar',
  category: 'processors',
  stereoPairs: [['audio_l_in', 'audio_r_in'], ['sc_l_in', 'sc_r_in'], ['audio_l_out', 'audio_r_out']],
  ossAttribution: {
    author: 'Algorithm: Giannoulis-Massberg-Reiss 2012 JAES; Faust co.compressor_stereo as reference',
  },

  inputs: [
    { id: 'audio_l_in',   type: 'audio' },
    { id: 'audio_r_in',   type: 'audio' },
    { id: 'sc_l_in',      type: 'audio' },
    { id: 'sc_r_in',      type: 'audio' },
    { id: 'threshold_cv',   type: 'cv', paramTarget: 'threshold',  cvScale: { mode: 'linear' } },
    { id: 'env_mag_cv',     type: 'cv', paramTarget: 'envMag',     cvScale: { mode: 'linear' } },
    { id: 'input_level_cv', type: 'cv', paramTarget: 'inputLevel', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio_l_out', type: 'audio' },
    { id: 'audio_r_out', type: 'audio' },
    // env_out + env_inv_out are typed `cv` so they connect cleanly to
    // CV-family sinks (VCA strength, ADSR-style env consumers, modulation
    // inputs). This matches ADSR's `env` / `env_inv` typing — same
    // "audio-rate CV" pattern. NOTE: env_out has NO HARD CLAMP, so when
    // envMag > 1 the signal can exceed ±1 (overshoot). Downstream
    // consumers in CV_FAMILY tolerate this — Web Audio sums/multiplies
    // them just like any other audio signal.
    { id: 'env_out',     type: 'cv' },
    { id: 'env_inv_out', type: 'cv' },
  ],
  params: [
    { id: 'threshold', label: 'Threshold', defaultValue: -18,  min: -60, max: 0,    curve: 'linear', units: 'dB' },
    { id: 'ratio',     label: 'Ratio',     defaultValue: 4,    min: 1,   max: 20,   curve: 'log' },
    { id: 'attack',    label: 'Attack',    defaultValue: 10,   min: 0.1, max: 200,  curve: 'log',    units: 'ms' },
    { id: 'release',   label: 'Release',   defaultValue: 100,  min: 1,   max: 2000, curve: 'log',    units: 'ms' },
    { id: 'knee',      label: 'Knee',      defaultValue: 6,    min: 0,   max: 24,   curve: 'linear', units: 'dB' },
    { id: 'envMag',     label: 'Env Mag',    defaultValue: 1,    min: 0,   max: 2,    curve: 'linear' },
    // ⚠ `units: '%'` ON A 0..2 RANGE, and it is the only one in the registry —
    // every other `%` param in the fleet is declared 0..100. The value is a
    // GAIN (1.0 = 100 %), so any surface that prints value+units prints
    // `1.00 %` where the module means 100 %. It has been invisible only because
    // SidecarCard passes no `units` to its faders; a FACEPLATE reads the
    // ParamDef and would paint it. Fixed at the source with a `format` rather
    // than by rescaling the range — the worklet's own parameterDescriptor is
    // 0..2 (packages/dsp/src/sidecar.ts) and every saved rack holds a 0..2
    // value, so moving the range is an audio-affecting migration for a display
    // bug. `format` is UI metadata: contract-signature projects id/min/max/
    // curve/default/units and not this, so contract-lock does not move.
    {
      id: 'inputLevel', label: 'Input Lvl',  defaultValue: 1,    min: 0,   max: 2,    curve: 'linear', units: '%',
      format: (v: number) => `${Math.round(v * 100)} %`,
    },
    { id: 'makeup',     label: 'Makeup',     defaultValue: 0,    min: 0,   max: 24,   curve: 'linear', units: 'dB' },
    { id: 'sc_hpf',    label: 'SC HPF',    defaultValue: 20,   min: 20,  max: 1000, curve: 'log',    units: 'Hz' },
  ],

  // THE TRANSFER CURVE — a PF-14 panel cell, and the only non-param control on
  // this module. It is a PICTURE, not a control: it writes nothing, and its one
  // affordance (a read cursor) is private component state. It exists because
  // three of this module's four measured knob/label disagreements are SHAPE
  // facts — where the bend is and what the two terms of the offset are, how
  // steep the slope is, and what happens at every main level that is not the
  // one the readouts are stated at. See `SidecarTransferPanel.svelte`.
  controlFamilies: [
    {
      id: 'sidecar-curve',
      label: 'Transfer curve — main level in, ducking out',
      kind: 'cell',
      testidPrefix: 'sidecar-curve',
    },
  ],

  // ── THE FACEPLATE (PF-20) ─────────────────────────────────────────────────
  //
  // WHAT SIDECAR IS FOR, musically: it is the rack's PUMP — the one module that
  // makes one signal breathe in time with another. It is not an insert
  // compressor, it is a two-input BOX. The MAIN pair is the trigger and passes
  // through untouched; the SC pair is what gets pushed down and summed back in.
  // The verb is *patch a kick into MAIN, a pad into SC, and set how deep and
  // how fast the pad gets out of the kick's way.* Every rank below descends
  // from that sentence.
  //
  // THE RANKING IS AGAINST THE DSP, NOT THE DECLARATION ORDER, and it inverts
  // the def's own list in one place that matters: `makeup` is declared eighth
  // and ranked eighth here for a measured reason rather than a coincidental
  // one — it is the SAME DIMENSION as `inputLevel` (compressor-dsp step 9
  // multiplies the sidechain by both, and `duckLin` comes from the MAIN pair
  // alone, so the ordering is irrelevant), so it is deliberately ranked BELOW
  // its twin. And `envMag` is ranked LAST of nine because it is the one control
  // on this module that provably cannot change what you hear: the output is
  // bit-identical at 0 / 0.5 / 1 / 2.
  //
  //   1 threshold  decides WHETHER anything ducks at all
  //   2 ratio      how deep (0 / -12.0 / -18.0 / -21.0 / -22.8 dB at 1/2/4/8/20)
  //   3 release    the "breath" — in a ducker the release IS the groove
  //   4 inputLevel how loud the ducked signal sits, and the SC path's enabler
  //   5 attack     how snappy the clamp
  //   6 knee       moves the ONSET by knee/2 (measured -18.0 -> -30.0 dB)
  //   7 sc_hpf     detector shaping; ships effectively off (-0.47 dB at 60 Hz)
  //   8 makeup     the redundant half of the sidechain gain
  //   9 envMag     CV-shaping only — audio-invariant
  //
  // Read back as a sentence: mini shows THRESH; compact adds RATIO; the
  // six-cell lane plate is the pump itself; and the dock adds the detector
  // filter, the redundant makeup and the CV-only env scaler.
  //
  // `order` AND `pages` DISAGREE, deliberately. `order` is PRIORITY (the tiers
  // that show a subset); `pages` is SIGNAL ORDER (the tier that shows
  // everything). So `knee` is a rank-6 refinement that sits in the FIRST band,
  // because it is part of the detection decision; and `envMag` is the
  // lowest-ranked control in the module but is last in the chain.
  //
  // NO `title`, NO `hint`, NO band hints, NO sidebar. Owner ruling 2026-08-11:
  // a faceplate states values, and the explanation lives in `docs` for
  // right-click -> annotate. Everything this face learned is in `docs` above.
  //
  // ⚠ THE ONE THING THIS FACE STRUCTURALLY CANNOT SAY. Measured: with the SC
  // pair unpatched all nine controls are BIT-EXACTLY inert, and with the MAIN
  // pair unpatched six of them are. That is the most important fact about
  // operating the module, and a `FaceReadoutValue` is `(read) => string` over
  // PARAMS — it cannot observe a cable. So it is carried by `docs` and by the
  // rear card's jack field, and NOT faked with a readout that would have to
  // guess. The readouts instead state their operating point in their own
  // labels (`@ FS` = a full-scale mono main).
  face: {
    order: [
      'threshold',
      'ratio',
      'release',
      'inputLevel',
      'attack',
      'knee',
      // 7. THE PICTURE, at the first rank a panel can legally hold (the 'full'
      //    lane cap is six, and module-face-lint refuses a panel SELECTED at a
      //    lane tier). Ranks 1-6 are untouched, so no lane tier moves — this is
      //    purely a dock gain, which is what a 340 px transfer curve should be.
      //    It is NOT `hero.cell`: a hero cell MOVES its key into the hero slot
      //    and suppresses the shell glyph at the dock, which would demote the
      //    THRESHOLD dial this picture exists to explain and drop the meter.
      'sidecar-curve-{n}',
      'sc_hpf',
      'makeup',
      'envMag',
    ],

    // By FUNCTION, in signal order: what the MAIN must do to trigger, then the
    // shape of the dip, then everything that scales what LEAVES the box (the
    // ducked audio AND the two CV envelopes — `envMag` is here because ENV /
    // ENV INV are outputs, not because it is a level).
    pages: [
      // The curve belongs HERE and not in a fourth band of its own. It draws
      // the DETECTION decision — the axis is MAIN dBFS and the two ticks are
      // this band's own `threshold` and `knee` — and a page costs an ~81 px
      // header on a dock that folds at 720p, for one cell. It leads the band
      // because `heroFacePlan` MOVES `threshold` into the hero, so what remains
      // beside it is the two refinements the picture is showing the effect of.
      // ⚠ A panel is a WIDE cell (dock-row-plan `cellWidthClass`), so this band
      // now takes a ROW OF ITS OWN and `duck` + `output` pack together — the
      // dock goes from one packed row to two. That is the visible cost of the
      // picture and it is deliberate.
      { id: 'detect', label: 'detect', controls: ['sidecar-curve-{n}', 'threshold', 'knee', 'sc_hpf'] },
      { id: 'duck', label: 'duck', controls: ['ratio', 'attack', 'release'] },
      { id: 'output', label: 'output', controls: ['inputLevel', 'makeup', 'envMag'] },
    ],

    // A live tap on the primary audio out. UNLIT on a silent rack, which is
    // correct and deterministic for an insert with nothing patched — the
    // mixer / reverb / clouds precedent, and measured here: with the SC
    // unpatched the output is exactly the MAIN passthrough, and with nothing
    // patched at all it is bit-zero.
    glyph: 'meter',

    // Every control on this module is a LEVEL or a TIME with a throw, and the
    // card draws all nine as faders. `fader` is not inferable from a ParamDef
    // (nothing separates "a level" from any other continuous scalar), so
    // silently substituting knobs would be a real regression — the `noise`
    // directive, applied to the module that has nine of them.
    paramCells: {
      threshold: 'fader',
      ratio: 'fader',
      release: 'fader',
      inputLevel: 'fader',
      attack: 'fader',
      knee: 'fader',
      sc_hpf: 'fader',
      makeup: 'fader',
      envMag: 'fader',
    },

    hero: {
      // The dial that decides whether the module does anything at all. It MOVES
      // out of the `detect` band (heroFacePlan), leaving knee + sc_hpf there —
      // still two controls, so the band keeps its header.
      control: 'threshold',
    },
  },

  docs: {
    explanation:
      "A stereo sidechain ducker — the classic 'pumping' compressor where one signal pushes another down. The MAIN pair is the trigger (typically a kick drum); the SIDECHAIN pair is the signal that gets ducked and summed into the output (typically a pad or bass). The sidechain is always present at the output EXCEPT when the main fires, at which point the detector pulls it down by a compressor-style gain computer (threshold, ratio, knee, attack, release) and lets it spring back. Detection is stereo-linked so a transient on either main channel ducks both output channels equally (no image shift), and a sidechain high-pass lets you key off the kick's body without the low end choking the detector. Two extra CV outputs (ENV and ENV INV) expose the live ducking envelope for cross-patching the same pump into other VCAs. Real-source chain: feed a rhythmic source into MAIN and the bus you want pumped into SIDECHAIN. ⚠ IT NEEDS BOTH CABLES BEFORE ANY KNOB DOES ANYTHING, which is the one thing about this module no control can show you. With the SIDECHAIN pair unpatched there is nothing to duck, so the box is a wire: measured on the shipping DSP, the output is BIT-IDENTICAL with every one of the nine controls at either extreme. With the MAIN pair unpatched nothing ever triggers, so the reduction is exactly zero and the sidechain simply passes at its own gain. Patch both, then set the controls.",
    inputs: {
      audio_l_in: "Left MAIN / trigger input — the signal whose transients drive the ducking (e.g. a kick). It also passes through to the output untouched. Unpatched: silent.",
      audio_r_in: "Right MAIN / trigger input. If unpatched it is normalled to MAIN L, so a mono trigger drives both detector channels.",
      sc_l_in: "Left SIDECHAIN input — the signal that gets ducked and summed to the output (e.g. a pad). If the whole SC pair is unpatched, nothing is ducked and only the MAIN passes through.",
      sc_r_in: "Right SIDECHAIN input. If unpatched it is normalled to SC L (mono sidechain to both output channels).",
      threshold_cv: "CV that adds to the THRESHOLD knob — modulate how loud the main must get before ducking begins.",
      env_mag_cv: "CV that adds to the ENV MAG knob — scale how far the ENV / ENV INV outputs swing for a given amount of gain reduction.",
      input_level_cv: "CV that adds to the INPUT LVL knob — modulate the sidechain's input gain (how loud the ducked signal sits in the output).",
    },
    outputs: {
      audio_l_out: "Left output: the MAIN left passthrough plus the ducked left sidechain.",
      audio_r_out: "Right output: the MAIN right passthrough plus the ducked right sidechain.",
      env_out: "The ducking envelope as CV (rises as gain reduction increases). It is NOT hard-clamped: with ENV MAG above 1 it can exceed 1.0 — patch it where overshoot is tolerated. Use it to drive another VCA's strength so it ducks in time with this one.",
      env_inv_out: "The inverted ducking envelope (1 − ENV), also un-clamped (can go negative when ENV exceeds 1). Patch it into a downstream VCA's strength to make that VCA CLOSE while this ducker is reducing.",
    },
    controls: {
      threshold: "Where the gain computer's knee is centred (-60 to 0 dB, default -18): lower it to duck on quieter hits, raise it so only loud transients pump the sidechain. ⚠ It is NOT the MAIN level at which ducking starts, for two reasons the dial cannot show. The detector is a stereo-linked sum of rectifiers (|L| + |R|), so a mono trigger normalled to both channels reads 6.02 dB above its own peak; and the soft KNEE opens half its width BELOW this value. At the shipped defaults ducking begins at a main peak of -27.0 dBFS. The faceplate's ONSET readout prints that number; the THR CV input adds to this one. ⚠ AND THE TOP OF THE DIAL DOES NOT MEAN 'ONLY DUCK ON PEAKS'. Because those two offsets are subtracted rather than added, the onset can never be closer to full scale than -6.02 dBFS — at ANY setting of this knob and the KNEE, including 0 dB with a hard knee. Wind THRESHOLD to the top and a mono main is still ducked from -6 dBFS upward; there is no setting that leaves a hot mono trigger alone. The faceplate's transfer curve shows it as a tick that never reaches the right-hand edge of the plot.",
      ratio: "How hard the sidechain is pushed down once over threshold (1:1 to 20:1, default 4): higher ratios duck more aggressively. The dial is very non-linear in its own top half — at a full-scale mono trigger and the default threshold the reduction runs 0 / -12.0 / -18.0 / -21.0 / -22.8 dB at 1 / 2 / 4 / 8 / 20, so the last two thirds of the travel buy under 2 dB. What a given setting is worth also depends on the THRESHOLD, which is why the faceplate prints the reduction rather than the ratio.",
      attack: "How fast the duck clamps down after the main fires (0.1 to 200 ms, log, default 10): short for a snappy pump, longer for a gentler dip.",
      release: "How fast the sidechain springs back up after the main passes (1 to 2000 ms, log, default 100): this sets the 'breath' / pumping speed.",
      knee: "The soft-knee width around the threshold in dB (0 to 24, default 6): a wider knee eases ducking in gradually instead of switching hard at the threshold.",
      envMag: "Scales how far the ENV / ENV INV CV outputs swing for a given gain reduction (0 to 2, default 1). It is CV-shaping ONLY: measured on the shipping DSP, the audio output is bit-identical at 0, 0.5, 1 and 2, so this is the one control on the module that cannot change what you hear. ENV is `(reduction / 24 dB) × MAG` and is NOT clamped, so it passes 1.0 whenever the reduction passes 24 dB — at the DEFAULT setting of 1, not only above it (measured 1.70 at MAG 1 with a deep duck). ENV INV is 1 − ENV and goes negative in the same states. Patch them where overshoot is tolerated. At MAG 0 both outputs are constants (ENV 0, ENV INV 1). The MAG CV input adds to this.",
      inputLevel: "Input gain on the SIDECHAIN signal (0 to 200%, default 100%): boost a quiet pad into the mix or trim a loud one. At 0 the sidechain path is bit-exactly silent and MAKEUP has no authority at all — it and MAKEUP are the SAME dimension in different units (see MAKEUP), so the sidechain's real gain is this knob in dB PLUS makeup. The LVL CV input adds to this.",
      makeup: "Extra gain in dB on the DUCKED SIDECHAIN (0 to 24, default 0). ⚠ It is NOT an output gain: measured with the sidechain unpatched, the output is bit-identical at 0, 12 and 24 dB, because the MAIN passthrough never passes through it. It multiplies the same signal INPUT LVL does — 20·log10(INPUT LVL) + MAKEUP is the sidechain's total gain, and the two knobs are exactly interchangeable (INPUT LVL 2 / MAKEUP 0 renders bit-identically to INPUT LVL 1 / MAKEUP 6.02). Unlike INPUT LVL it takes no CV.",
      sc_hpf: "A high-pass on the DETECTOR signal only (20 to 1000 Hz, log, default 20 = effectively off): raise it so the detector keys on the main's punch rather than its low end, preventing bass from over-triggering the duck. It does not filter the audio you hear.",
      'sidecar-curve-{n}': "THE TRANSFER CURVE — the faceplate's picture of the gain computer, and the thing about this module that no number can say. It plots how much the sidechain is pushed down (down the axis, 0 to -48 dB) against the MAIN peak level that is doing the pushing (across the axis, -60 to 0 dBFS — the number on your meter, not the detector's). Two vertical ticks mark the two halves of this module's central confusion: the dashed one is where the THRESHOLD dial's own number lands once the `|L|+|R|` detector sum is taken off it, and the solid one is where ducking actually begins, another half-knee to the left. The dial reads -18 dB at the shipped defaults and the bend is at -27. The slope to the right of the bend is the RATIO, which is where you can see that its top two thirds buy under 2 dB. Point anywhere on the plot to move the read cursor: the caption under it reports the reduction, the sidechain's resulting output gain and the ENV output AT THAT LEVEL, which is the same set of answers the readout row gives for a full-scale main. It is read-only — nothing on it edits the patch — and the cursor is yours alone: it is not shared with the rackspace and not saved with the patch.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      // 4 audio inputs (audio L/R + SC L/R). CV inputs are routed via
      // AudioParams not separate node inputs — Web Audio sums CV directly
      // into the AudioParam, which is exactly what we want for
      // threshold_cv + env_mag_cv.
      numberOfInputs: 4,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of sidecarDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio_l_in',   { node: worklet, input: 0 }],
        ['audio_r_in',   { node: worklet, input: 1 }],
        ['sc_l_in',      { node: worklet, input: 2 }],
        ['sc_r_in',      { node: worklet, input: 3 }],
        // CV → AudioParam. The `input` index is required by the engine's
        // adapter type but unused for param-targeted edges (the engine
        // connects the CV source directly into the AudioParam).
        ['threshold_cv',   { node: worklet, input: 0, param: params.get('threshold')! }],
        ['env_mag_cv',     { node: worklet, input: 0, param: params.get('envMag')! }],
        ['input_level_cv', { node: worklet, input: 0, param: params.get('inputLevel')! }],
      ]),
      outputs: new Map([
        ['audio_l_out', { node: worklet, output: 0 }],
        ['audio_r_out', { node: worklet, output: 1 }],
        ['env_out',     { node: worklet, output: 2 }],
        ['env_inv_out', { node: worklet, output: 3 }],
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
