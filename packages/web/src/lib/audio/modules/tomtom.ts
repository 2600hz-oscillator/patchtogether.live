// packages/web/src/lib/audio/modules/tomtom.ts
//
// TOM DRUM — analog-modeled tom-tom voice, the third member of the drum
// family (KICK DRUM / SNARE DRUM), at deliberately CURATED complexity: one
// synthesis engine, seven voice knobs + level, spanning the classic analog
// tom lineage in one continuous space:
//
//   808-woody    — bridged-T-style near-sine ring + filtered noise breath:
//                  low TUNE, small BEND, some NOISE, low TONE.
//   909-punchy   — swept oscillator + tuned overtone + heat: mid TUNE,
//                  medium BEND, TONE up, DRIVE up.
//   Simmons-zap  — the SDS-V "piuuu": BEND depth + time maxed.
//   floor-deep   — TUNE at the bottom, DECAY long (frequency-compensated,
//                  so deep tunings ring exactly as set).
//
// The control set mirrors the Vermona DRM1's tom channel (tune, bend,
// decay, noise/attack, drive) — the modern analog reference for "curated,
// not exhaustive". DSP: packages/dsp/src/lib/tomtom-dsp.ts (MEMBRANE
// fundamental + 1.593× Bessel second mode on one exponential bend law,
// band-passed BREATH noise, 2×-oversampled warm-tanh DRIVE, DC block,
// true-peak bound). Mono voice, mono output.
//
// Trigger semantics (declared, per CLAUDE.md): trigger_in edge:'trigger' —
// ONE strike per rising edge (phases reset, envelopes fire, accent
// latched); per-sample edge-detect in the worklet. The card's STRIKE pad
// writes the `strike` param (the bluebox press-param pattern) which the
// worklet ORs with trigger_in.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/tomtom.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'tomtom';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const tomtomDef: AudioModuleDef = {
  type: 'tomtom',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'tom drum',
  category: 'sources',
  // Measured card box ≈ 200×460 px → 2u tall × 3 tiles wide (rack-sizes rule:
  // new modules declare size/hp on the def).
  size: '2u',
  hp: 3,

  inputs: [
    // The STRIKE: one tom hit per rising edge. Accent is read from
    // accent_in at that exact edge (per-hit latch).
    { id: 'trigger_in', type: 'gate', edge: 'trigger' },
    { id: 'accent_in',  type: 'cv' },
    // 1V/oct — transposes the whole voice (fundamental + overtone + the
    // breath band together) as a frequency multiplier.
    { id: 'pitch_cv',   type: 'cv' },
    // Per-knob CV for EVERY continuous control (Pattern B: a plain cv port
    // per knob; the scaling law lives in the shared core, NOT a cvScale hint).
    // tune_cv modulates the TUNE knob (distinct from the whole-voice pitch_cv).
    { id: 'bend_cv',      type: 'cv' },
    { id: 'decay_cv',     type: 'cv' },
    { id: 'tone_cv',      type: 'cv' },
    { id: 'noise_cv',     type: 'cv' },
    { id: 'tune_cv',      type: 'cv' },
    { id: 'bend_time_cv', type: 'cv' },
    { id: 'drive_cv',     type: 'cv' },
    { id: 'level_cv',     type: 'cv' },
  ],
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    { id: 'tune',      label: 'Tune',  defaultValue: 110,  min: 60,  max: 400,  curve: 'log',      units: 'Hz' },
    { id: 'bend_amt',  label: 'Bend',  defaultValue: 7,    min: 0,   max: 24,   curve: 'linear',   units: 'st' },
    { id: 'bend_time', label: 'B Time', defaultValue: 60,  min: 10,  max: 300,  curve: 'log',      units: 'ms' },
    { id: 'decay',     label: 'Decay', defaultValue: 350,  min: 40,  max: 1500, curve: 'log',      units: 'ms' },
    { id: 'tone',      label: 'Tone',  defaultValue: 0.35, min: 0,   max: 1,    curve: 'linear' },
    { id: 'noise',     label: 'Noise', defaultValue: 0.25, min: 0,   max: 1,    curve: 'linear' },
    { id: 'drive',     label: 'Drive', defaultValue: 0.25, min: 0,   max: 1,    curve: 'linear' },
    { id: 'level',     label: 'Level', defaultValue: 0,    min: -24, max: 12,   curve: 'linear',   units: 'dB' },
    // The card's manual STRIKE pad (held 0/1; the worklet ORs it with
    // trigger_in — its rising edge fires exactly one hit).
    { id: 'strike',    label: 'Strike', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
  ],

  // ── RACKLINE face (P1 batch-2 TOTAL REWORK — UI curation only, NOT the
  // I/O contract; see ModuleFace in $lib/graph/types). Designed from the
  // voice's INTENT and kept inside the drum-face family grammar (KICK DRUM's
  // `section · intent` bands + the 'scope' glyph). A synth tom IS a tuned
  // membrane that starts sharp and falls, so the RANKING leads with the two
  // controls that decide WHICH drum and HOW FAR it dives, and the glyph shows
  // the hit itself: 'scope' binds live-audio on audio_out (shell-glyph-live),
  // so the trace draws the DECAY envelope with the pitch SWEEP compressing the
  // cycles under its front edge — the module's identity, drawn from the real
  // output rather than a legend.
  //   mini    (1)            tune  — which drum: floor / mid / rack / timbale.
  //   compact (2 + glyph)    + bend_amt — the synth-tom identity (808-flat →
  //                          Simmons dive-bomb), read against the live trace.
  //   full-in-lane (6 whole plate cells — laneBodyPlan's no-clip cap)
  //                          + decay, tone, noise, drive — which is EXACTLY
  //                          the analog tom channel (the DRM1 knob family:
  //                          tune / bend / decay / noise / drive, plus the
  //                          modal TONE tilt) complete in the lane.
  //   ranks 7–8              bend_time (the sculptor's half of the sweep pair —
  //                          inaudible while BEND sits at 0, so it never
  //                          outranks a knob that always does something) and
  //                          level.
  //   rank 9                 strike — the manual audition pad. A momentary pad
  //                          belongs on the faceplate, not among lane knobs
  //                          (the tile already carries the real TRIG jack), so
  //                          it ranks last and surfaces in the dock only —
  //                          the kickdrum `hard` / tidyVco `hold` precedent.
  // Pages mirror the DSP's own layer stack (MEMBRANE → BREATH → DRIVE → BUS),
  // lowercase labels, every band ≥ 2 controls (a 9-param voice does not want
  // six one-knob headers).
  face: {
    order: [
      // hero ladder: mini = 1 / compact = 2 + glyph / full-in-lane plate = 6
      'tune', 'bend_amt',
      'decay', 'tone', 'noise', 'drive',
      // ranks 7–8 complete the curated 'full' eight
      'bend_time', 'level',
      // dock-only tail — the momentary pad
      'strike',
    ],
    // STRIKE is a PAD, not a value: the worklet ORs this param with trigger_in
    // and fires on the RISING EDGE, so the control must press-and-release.
    // Its ParamDef shape (0..1 discrete, default 0) is IDENTICAL to a latching
    // switch's (kickdrum/snaredrum `hard`), so the intent is declared here —
    // the shell renders a momentary Button instead of a rotary that would
    // otherwise hold the pad down, mask the TRIG jack and persist a stuck 1.
    momentary: ['strike'],
    pages: [
      { id: 'sweep', label: 'membrane · sweep', controls: ['tune', 'bend_amt', 'bend_time'] },
      { id: 'ring',  label: 'membrane · ring',  controls: ['decay', 'tone'] },
      { id: 'color', label: 'breath · heat',    controls: ['noise', 'drive'] },
      { id: 'out',   label: 'output · play',    controls: ['level', 'strike'] },
    ],
    glyph: 'scope',
    // REAR CARD curation (rear-card-model). Three curations, each a real
    // exception the derivation cannot see:
    //   * the leading voice band is renamed to what it actually DOES — the
    //     three holes that PLAY the voice (strike it, weight the hit, transpose
    //     it), not a generic "voice";
    //   * `bend_cv`'s stem ('bend') does not match its param id ('bend_amt'),
    //     so it would fall out of the sweep band into the orphan 'cv' tail (the
    //     tidyVco pwm_cv/pw class) — the sweep band is therefore pinned whole,
    //     which also fixes its reading order to knob order;
    //   * audioRate = every CONTINUOUS-modulation CV. The worklet reads all of
    //     them per sample with no smoothing (packages/dsp/src/tomtom.ts), so
    //     every knob on this voice is genuinely FM-able. trigger_in and
    //     accent_in are deliberately NOT ticked: the trigger's meaning is its
    //     EDGE (already carried by the ▲ glyph) and accent is LATCHED at that
    //     edge, so "audio-rate" says nothing true about either.
    rear: {
      groups: [
        { id: 'voice', label: 'strike · voice', ports: ['trigger_in', 'accent_in', 'pitch_cv'] },
        { id: 'sweep', label: 'membrane · sweep', ports: ['tune_cv', 'bend_cv', 'bend_time_cv'] },
      ],
      audioRate: [
        'pitch_cv', 'tune_cv', 'bend_cv', 'bend_time_cv',
        'decay_cv', 'tone_cv', 'noise_cv', 'drive_cv', 'level_cv',
      ],
    },
  },

  docs: {
    explanation:
      "An analog-modeled TOM DRUM voice that spans the whole classic synth-tom SPECTRUM with seven curated knobs — 808-woody, 909-punchy, Simmons-zap, floor-tom-deep are all corners of one continuous space, not presets. The model is the circuit-sized caricature every analog tom since the TR-808 has used, informed by real membrane physics: a struck drumhead's tension momentarily rises, so pitch starts sharp and relaxes down (the BEND envelope — depth in semitones, settle time in ms), the fundamental is joined by an inharmonic second mode at 1.593× (the same Bessel-zero ratio SNARE DRUM's modal bank uses — TONE tilts the membrane between fundamental and that mode, and the mode decays faster, as a real head's upper modes do), and the stick impact splashes broadband energy through the skin — the BREATH layer, seeded noise through a band-pass centred 2.5× above the settled pitch (floored at 300 Hz, so at the lower tunings it sits just above the drum instead of tracking it). NOISE balances membrane against breath the way the SDS-V's tone/noise mix does — 0 is a pure-tone hit, full up the breath dominates and the membrane drops back to about a third of its level, so it never stops being a drum. DECAY is FREQUENCY-COMPENSATED: it sets the −60 dB ring time in milliseconds regardless of TUNE, so a 60 Hz floor tom and a 400 Hz timbale ring exactly as long as the knob says (a raw analog resonator's high tunings die faster — this is the one place the model deliberately improves on the circuit). DRIVE is a 2×-oversampled warm tanh saturator (the analog heat, a true bypass at 0), and the chain ends in a 20 Hz DC block → LEVEL → a true-peak tanh bound, so the voice never clips downstream. Every hit is bit-identical to the last: phases reset and the noise reseeds on each strike, with no free-running randomness anywhere. Recipes: 808 woody = Tune low-mid, Bend ~3 st / 40 ms, Tone low, Noise ~0.3; 909 punchy = Tune mid, Bend ~7 st / 60 ms, Tone ~0.5, Drive up; Simmons zap = Bend 24 st / 200+ ms (a two-octave dive); deep floor tom = Tune 60–80, Decay 1+ s. Strike it from any trigger/gate/sequencer source or the faceplate\'s STRIKE pad; ACCENT makes a hit louder, bend-deeper and brighter at once, exactly like a harder stick.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge fires one tom hit — oscillator phases reset (click-free and deterministic), every envelope retriggers, and the accent input is sampled at that instant. How long the signal stays high doesn't matter; it's a trigger, not a hold. Patch a sequencer gate, drum-seq lane, or clock here.",
      accent_in:
        "Per-hit intensity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO here gives every hit its own velocity. An accented hit lands hotter (up to +80 % velocity ≈ +5 dB, applied BEFORE the drive stage, so a harder hit also saturates and leans into the output bound a little harder — it compresses musically instead of just getting loud), bends deeper (up to +50 % sweep depth), AND starts brighter (up to 2× overtone and breath excitation — impact nonlinearity) — the three things a harder stick does to a real head.",
      pitch_cv:
        "1V/oct pitch input: transposes the whole voice — fundamental, 1.593× overtone, and the breath band together — as a true frequency multiplier (tune × 2^volts) applied ON TOP of the TUNE knob and NOT clamped back into the knob's 60–400 Hz window, so melodic tom lines track across octaves (the oscillators stop short of Nyquist and the breath centre still stops at its 300 Hz / 6 kHz limits). Patch a sequencer pitch output here for tuned toms.",
      bend_cv:
        "Bend-depth CV: ±1 V adds ±24 semitones to the BEND knob (summed, clamped 0–36 st — a full ±1 V swing covers the knob's whole range, per the house CV full-swing rule). Sequence it to alternate woody flat hits with Simmons-style dive-bombs from the same voice.",
      decay_cv:
        "Decay-time CV: 2 octaves of TIME per volt — +1 V = ×4 decay, −1 V = ×¼ (clamped 20 ms – 3 s), so ±1 V spans close to the knob's full 40–1500 ms range. Ride it with an envelope or sequencer step to open the tom up on fills.",
      tone_cv:
        "Overtone-mix CV: sums into TONE (clamped 0–1). More voltage = more of the 1.593× second membrane mode — brighter, more 'struck', more 909.",
      noise_cv:
        "Breath-mix CV: sums into NOISE (clamped 0–1). More voltage = more of the band-passed skin noise over the attack — more stick, more air.",
      tune_cv:
        "CV on the TUNE KNOB at 2 octaves/volt (+1 V = ×4, −1 V = ×¼), CLAMPED straight back into the knob's own 60–400 Hz window — that clamp, and the steeper 2 oct/V law, are what make it different from pitch_cv: this input can never take the drum out of its natural register, while pitch_cv is an unclamped 1 V/oct transpose laid on top. Both move the whole voice (the 1.593× overtone and the breath band follow the fundamental either way). cv = 0 is a perfect no-op; sequence it for melodic tom lines that stay inside the tom's range.",
      bend_time_cv:
        "Bend-TIME CV: 2 octaves of sweep-settle time per volt (+1 V = ×4, −1 V = ×¼, clamped 5–600 ms), riding the B Time knob independently of DECAY. Ride it to turn a tick-of-attack pitch into an audible 'piuuu' without touching the ring length.",
      drive_cv:
        "Drive CV: sums into DRIVE (clamped 0–1) — a ±1 V swing covers the whole 0–1 warmth range on top of the knob, so an envelope here fattens the hit as it lands (2×-oversampled warm-tanh saturation).",
      level_cv:
        "Output-level CV (dB): ±1 V sweeps ±18 dB — the FULL 36 dB level range centered on the knob (clamped −24..+12 dB into the true-peak bound), so a ±1 V LFO or envelope covers the whole level travel. cv = 0 is a no-op.",
    },
    outputs: {
      audio_out:
        "The mono tom voice: membrane (fundamental + 1.593× overtone) plus breath noise, through DRIVE, a 20 Hz DC block, LEVEL and the final true-peak bound (|out| < 1 always, so it patches hot safely). One tom = one mono source — spread multiple TOM DRUMs across a mixer's pan field for the classic multi-tom fill.",
    },
    controls: {
      tune: "The settled fundamental (60–400 Hz, log). 60–90 Hz = floor tom, ~110 = the classic mid tom default, 200+ = high rack tom into timbale territory. The 1.593× overtone and the breath band track it; tune_cv rides this knob (2 oct/V, clamped back into 60–400 Hz) and pitch_cv transposes the result at 1 V/oct.",
      bend_amt: "Strike pitch-sweep depth in semitones (0–24) — the synth-tom identity. 0 = a perfectly stable pitch (pure resonator ring); 2–4 st = the 808's subtle relaxation; 6–10 st = 909 punch; 24 st = a two-octave Simmons dive-bomb. Accent deepens it up to +50 %; bend_cv adds ±24 st per volt on top (the sum clamps at 36 st).",
      bend_time: "How fast the sweep settles, as a −60 dB time (10–300 ms, log). Short = a tick of attack pitch; long + deep = the audible 'piuuu'. Independent of DECAY, so a short zap can ride a long ring or vice versa.",
      decay: "The −60 dB ring time (40–1500 ms, log), FREQUENCY-COMPENSATED: the knob means milliseconds at every TUNE, so retuning never shortens the tail. 90 ms = tight and dry, 350 = the shipped default, 1+ s = a singing floor tom. It also sets the two derived envelopes — the overtone rings 0.6× as long, the breath 0.5× (held between 25 and 500 ms) — and decay_cv scales it ×4 / ÷4 per volt.",
      tone: "Membrane tilt: fundamental ↔ the inharmonic 1.593× second mode (0–1). The overtone has its own faster decay (higher modes damp harder) and coming up it ducks the fundamental to as little as 40 %, so the knob sweeps woody-pure → bright/metallic 'struck' — a tilt, not just more level. tone_cv sums in.",
      noise: "Membrane ↔ breath balance (0–1): seeded noise through a band-pass centred 2.5× above the settled pitch (floored at 300 Hz, so below roughly 120 Hz TUNE it stops tracking the drum), riding a decay of half the effective DECAY held between 25 and 500 ms — shorter than the drum's own tail at every knob position (the 40 ms DECAY floor still gives a 25 ms breath), though a strongly negative decay_cv can drive the membrane under 25 ms and leave the breath the longer of the two. The SDS-V tone/noise mix law: 0 = pure membrane; full up the breath dominates and the membrane sits back at 30 %, never silent. noise_cv sums in.",
      drive: "Analog warmth (0–1): a 2×-oversampled warm tanh soft-clip on the summed voice, its pre-gain rising from 1× to 4×. At 0 the stage is bypassed outright; up, it fattens harmonics and perceived loudness at the same peak — the tom leans into the output bound instead of clipping.",
      level: "Output level in dB (−24..+12), applied after the DC block and before the final true-peak tanh bound, so a hot Level saturates musically rather than clipping the rack.",
      strike: "The manual STRIKE pad: press to fire exactly one hit — the pad's rising edge IS the strike, so holding it does not retrigger. Handy for auditioning the voice with nothing patched. It is OR-ed with trigger_in, which means that while you hold it the combined trigger stays high and incoming trigger edges are masked until you let go; released, it sits at 0 and is a no-op. The pad is sampled once per audio block, so a press lands on the next block boundary rather than the exact sample.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 11 audio-rate node inputs: trigger (0), accent (1), pitch (2),
    // bend (3), decay (4), tone (5), noise (6), tune (7), bend_time (8),
    // drive (9), level (10) — a per-knob CV for EVERY continuous control.
    // ONE mono output.
    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 11,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the worklet alive with a single 0-offset silence source on EVERY
    // input, so it processes blocks (and can be struck immediately) even
    // when nothing is patched yet. The 0-offset fan is ALSO what makes an
    // unpatched CV a no-op (cv = 0 → the core's scaling laws are identities),
    // keeping the ART render byte-identical. One ConstantSource, 11 connections.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 11; i++) silence.connect(worklet, 0, i);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of tomtomDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    inputsMap.set('trigger_in',   { node: worklet, input: 0 });
    inputsMap.set('accent_in',    { node: worklet, input: 1 });
    inputsMap.set('pitch_cv',     { node: worklet, input: 2 });
    inputsMap.set('bend_cv',      { node: worklet, input: 3 });
    inputsMap.set('decay_cv',     { node: worklet, input: 4 });
    inputsMap.set('tone_cv',      { node: worklet, input: 5 });
    inputsMap.set('noise_cv',     { node: worklet, input: 6 });
    inputsMap.set('tune_cv',      { node: worklet, input: 7 });
    inputsMap.set('bend_time_cv', { node: worklet, input: 8 });
    inputsMap.set('drive_cv',     { node: worklet, input: 9 });
    inputsMap.set('level_cv',     { node: worklet, input: 10 });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['audio_out', { node: worklet, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
