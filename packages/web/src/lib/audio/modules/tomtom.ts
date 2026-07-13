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

  docs: {
    explanation:
      "An analog-modeled TOM DRUM voice that spans the whole classic synth-tom SPECTRUM with seven curated knobs — 808-woody, 909-punchy, Simmons-zap, floor-tom-deep are all corners of one continuous space, not presets. The model is the circuit-sized caricature every analog tom since the TR-808 has used, informed by real membrane physics: a struck drumhead's tension momentarily rises, so pitch starts sharp and relaxes down (the BEND envelope — depth in semitones, time in ms), the fundamental is joined by an inharmonic second mode at ~1.59× (the same Bessel-zero ratio SNARE DRUM's modal bank uses — TONE tilts the membrane between fundamental and that mode), and the stick impact splashes broadband energy through the skin (the band-passed NOISE 'breath', tracking the pitch a couple of octaves up — NOISE balances membrane against breath the way the SDS-V's tone/noise mix does, from pure-tone hit to Simmons noise hit). DECAY is FREQUENCY-COMPENSATED: it sets the −60 dB ring time in milliseconds regardless of TUNE, so a 60 Hz floor tom and a 400 Hz timbale ring exactly as long as the knob says (a raw analog resonator's high tunings die faster — this is the one place the model deliberately improves on the circuit). DRIVE is a 2×-oversampled warm tanh saturator (the analog heat), and the output stage ends in a true-peak bound so the voice never clips downstream. Recipes: 808 woody = Tune low-mid, Bend ~3 st / 40 ms, Tone low, Noise ~0.3; 909 punchy = Tune mid, Bend ~7 st / 60 ms, Tone ~0.5, Drive up; Simmons zap = Bend 24 st / 200+ ms (a two-octave dive); deep floor tom = Tune 60–80, Decay 1+ s. Strike it from any trigger/gate/sequencer source or the card's STRIKE pad; ACCENT makes a hit both louder and bend-deeper, exactly like a harder stick.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge fires one tom hit — oscillator phases reset (click-free and deterministic), every envelope retriggers, and the accent input is sampled at that instant. How long the signal stays high doesn't matter; it's a trigger, not a hold. Patch a sequencer gate, drum-seq lane, or clock here.",
      accent_in:
        "Per-hit intensity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO here gives every hit its own velocity. An accented hit lands hotter (up to +80 % velocity ≈ +5 dB into the output bound, which compresses it musically), bends deeper (up to +50 % sweep depth), AND starts brighter (up to 2× overtone/breath excitation — impact nonlinearity) — the three things a harder stick does to a real head.",
      pitch_cv:
        "1V/oct pitch input: transposes the whole voice — fundamental, 1.59× overtone, and the breath noise band together — as a true frequency multiplier (tune × 2^volts), so melodic tom lines track across octaves. Patch a sequencer pitch output here for tuned toms.",
      bend_cv:
        "Bend-depth CV: ±1 V adds ±24 semitones to the BEND knob (summed, clamped 0–36 st — a full ±1 V swing covers the knob's whole range, per the house CV full-swing rule). Sequence it to alternate woody flat hits with Simmons-style dive-bombs from the same voice.",
      decay_cv:
        "Decay-time CV: 2 octaves of TIME per volt — +1 V = ×4 decay, −1 V = ×¼ (clamped 20 ms – 3 s), so ±1 V spans close to the knob's full 40–1500 ms range. Ride it with an envelope or sequencer step to open the tom up on fills.",
      tone_cv:
        "Overtone-mix CV: sums into TONE (clamped 0–1). More voltage = more of the 1.59× second membrane mode — brighter, more 'struck', more 909.",
      noise_cv:
        "Breath-mix CV: sums into NOISE (clamped 0–1). More voltage = more of the band-passed skin noise over the attack — more stick, more air.",
      tune_cv:
        "TUNE-knob CV at 2 octaves/volt (+1 V = ×4, −1 V = ×¼, clamped back into 60–400 Hz). This modulates ONLY the settled fundamental — the TUNE knob — which is what makes it distinct from pitch_cv (that transposes the WHOLE voice, breath band included). cv = 0 is a perfect no-op; sequence it for melodic tom lines that stay inside the tom's natural range.",
      bend_time_cv:
        "Bend-TIME CV: 2 octaves of sweep-settle time per volt (+1 V = ×4, −1 V = ×¼, clamped 5–600 ms), riding the B Time knob independently of DECAY. Ride it to turn a tick-of-attack pitch into an audible 'piuuu' without touching the ring length.",
      drive_cv:
        "Drive CV: sums into DRIVE (clamped 0–1) — a ±1 V swing covers the whole 0–1 warmth range on top of the knob, so an envelope here fattens the hit as it lands (2×-oversampled warm-tanh saturation).",
      level_cv:
        "Output-level CV (dB): ±1 V sweeps ±18 dB — the FULL 36 dB level range centered on the knob (clamped −24..+12 dB into the true-peak bound), so a ±1 V LFO or envelope covers the whole level travel. cv = 0 is a no-op.",
    },
    outputs: {
      audio_out:
        "The mono tom voice: membrane (fundamental + overtone) + breath noise through the drive and the true-peak output bound (|out| < 1 always, so it patches hot safely). One tom = one mono source — spread multiple TOM DRUMs across a mixer's pan field for the classic multi-tom fill.",
    },
    controls: {
      tune: "The settled fundamental (60–400 Hz, log). 60–90 Hz = floor tom, ~110 = the classic mid tom default, 200+ = high rack tom into timbale territory. The 1.59× overtone and the breath band track it, and pitch_cv transposes it at 1V/oct.",
      bend_amt: "Strike pitch-sweep depth in semitones (0–24). 0 = a perfectly stable pitch (pure resonator ring); 2–4 st = the 808's subtle relaxation; 6–10 st = 909 punch; 24 st = a two-octave Simmons dive-bomb. Accent deepens it up to +50 %; bend_cv adds ±12 st/V.",
      bend_time: "How fast the sweep settles to −60 dB (10–300 ms, log). Short = a tick of attack pitch; long + deep = the audible 'piuuu'. Independent of DECAY, so a short zap can ride a long ring or vice versa.",
      decay: "The −60 dB ring time (40–1500 ms, log), FREQUENCY-COMPENSATED: the knob means milliseconds at every TUNE, so retuning never shortens the tail. 90 ms = tight and dry, 350 = the shipped default, 1+ s = a singing floor tom. decay_cv doubles/halves per volt.",
      tone: "Membrane tilt: fundamental ↔ the inharmonic 1.59× second mode (0–1). The overtone has its own faster decay (higher modes damp harder) and coming up it ducks the fundamental, so the knob sweeps woody-pure → bright/metallic 'struck' — not just louder. tone_cv sums in.",
      noise: "Membrane ↔ breath balance (0–1): band-passed noise ~2.5× above the settled pitch, riding (but undercutting) the main DECAY. The SDS-V tone/noise mix law — 0 = pure membrane, up = the noise half takes over (808 breath → full Simmons noise hit). noise_cv sums in.",
      drive: "Analog warmth (0–1): a 2×-oversampled warm tanh soft-clip on the summed voice. Low = clean; up = fattened harmonics and perceived loudness at the same peak — the tom leans into the output bound instead of clipping.",
      level: "Output level in dB (−24..+12). The chain ends in a true-peak tanh bound, so a hot Level saturates musically rather than clipping the rack.",
      strike: "The manual STRIKE pad: press to fire exactly one hit (the pad's press edge is the strike — holding it does not retrigger). Handy for dialing the voice in without patching a trigger source; external triggers keep working while it's held.",
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
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
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
