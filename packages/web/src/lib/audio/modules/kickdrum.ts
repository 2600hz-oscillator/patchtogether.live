// packages/web/src/lib/audio/modules/kickdrum.ts
//
// KICK DRUM — layered stereo kick VOICE (build plan:
// .myrobots/plans/kick-drum-voice-2026-07-01.md). A super-deep, pulsing
// bass kick built from three DECOUPLED generator layers on a serial
// processing bus, so "deep pulse" (sub) and "punch" (body + click) live on
// orthogonal knobs and can be maxed together without fighting:
//
//   SUB   — pure sine at Tune (20–120 Hz), gentle slow settle, LONG decay.
//           Always mono. The air-moving fundamental.
//   BODY  — band-limited morphable wave one octave up, FAST downward pitch
//           sweep (the 909 "dooo"), short decay, optional TENSION
//           amplitude→pitch glide. The chest-thump punch.
//   CLICK — short filtered noise burst, the leading transient.
//
// Downstream (per the plan; phases land inside the worklet without changing
// this contract): oversampled DRIVE with the single HARD character switch,
// own-code 3-band EQ + tilt, the TRANSLATE harmonic exciter (small-speaker
// sub reconstruction), DYNAMICS (transient shaper / glue compressor /
// ceiling soft-clip), and the stereo crossover (mono <120 Hz, M/S WIDTH
// above). Phase 1 today renders SUB + BODY with L = R.
//
// Trigger/gate semantics (declared, per CLAUDE.md):
//   trigger_in edge:'trigger' — ONE strike per rising edge (phases reset,
//     envelopes fire, accent latched). Per-sample edge-detect in the worklet.
//   choke_in edge:'gate' — level-sensitive: damps WHILE high through a short
//     ramp and releases on the falling edge (both-edge behavior).
//
// Outputs are SEPARATE audio_l / audio_r ports (the cube.ts idiom: one
// stereo worklet output fanned through a ChannelSplitter) so the stereo
// width survives downstream patching; stereoPairs lets the engine auto-pair
// them. Level spans −24..+12 dB (the deliberate headroom fix vs chowkick's
// −60..0), guarded by the voice's own ceiling stage when Phase 4 lands.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/kickdrum.js?url';

const PROCESSOR_NAME = 'kickdrum';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const kickdrumDef: AudioModuleDef = {
  type: 'kickdrum',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'kick drum',
  category: 'sources',
  // Owner decision: a WIDE 3u card (banded layout, ~26 controls).
  size: '3u',
  hp: 2,

  inputs: [
    // The STRIKE: one kick per rising edge. Accent is read from accent_in
    // at that exact edge (per-hit latch), so the two ports work as a pair.
    { id: 'trigger_in', type: 'gate', edge: 'trigger' },
    { id: 'accent_in',  type: 'cv' },
    // 1V/oct — transposes the whole voice (sub + body together) as a
    // frequency multiplier, not a Hz offset.
    { id: 'pitch_cv',   type: 'cv' },
    // Level-sensitive damp — a drum-machine choke group input.
    { id: 'choke_in',   type: 'gate', edge: 'gate' },
  ],
  outputs: [
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  stereoPairs: [['audio_l', 'audio_r']],
  params: [
    // ── SUB · BODY · CLICK ──
    { id: 'tune',        label: 'Tune',      defaultValue: 50,   min: 20,  max: 120,  curve: 'log',      units: 'Hz' },
    { id: 'pitch_amt',   label: 'P Amt',     defaultValue: 24,   min: 0,   max: 48,   curve: 'linear',   units: 'st' },
    { id: 'pitch_time',  label: 'P Time',    defaultValue: 30,   min: 5,   max: 120,  curve: 'log',      units: 'ms' },
    { id: 'tension',     label: 'Tension',   defaultValue: 0,    min: 0,   max: 0.6,  curve: 'linear' },
    { id: 'sub_decay',   label: 'Sub Dec',   defaultValue: 450,  min: 50,  max: 800,  curve: 'log',      units: 'ms' },
    { id: 'body_decay',  label: 'Body Dec',  defaultValue: 120,  min: 20,  max: 400,  curve: 'log',      units: 'ms' },
    { id: 'click_len',   label: 'Click',     defaultValue: 12,   min: 2,   max: 60,   curve: 'log',      units: 'ms' },
    { id: 'sub_level',   label: 'Sub',       defaultValue: 0.9,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'body_level',  label: 'Body',      defaultValue: 0.7,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'click_level', label: 'Clk Lvl',   defaultValue: 0.4,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'body_shape',  label: 'Shape',     defaultValue: 0.3,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'click_tone',  label: 'Clk Tone',  defaultValue: 2800, min: 500, max: 6000, curve: 'log',      units: 'Hz' },
    // ── DRIVE · EQ · TRANSLATE ──
    { id: 'drive',       label: 'Drive',     defaultValue: 0.4,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'hard',        label: 'Hard',      defaultValue: 0,    min: 0,   max: 1,    curve: 'discrete' },
    { id: 'translate',   label: 'Translate', defaultValue: 0.3,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'sub_eq',      label: 'Sub EQ',    defaultValue: 0,    min: -12, max: 12,   curve: 'linear',   units: 'dB' },
    { id: 'body_eq',     label: 'Body EQ',   defaultValue: 3,    min: -12, max: 12,   curve: 'linear',   units: 'dB' },
    { id: 'attack_eq',   label: 'Atk EQ',    defaultValue: 2,    min: -12, max: 12,   curve: 'linear',   units: 'dB' },
    { id: 'tilt',        label: 'Tilt',      defaultValue: 0,    min: -1,  max: 1,    curve: 'linear' },
    // ── DYNAMICS · STEREO · OUT ──
    { id: 'attack',      label: 'Attack',    defaultValue: 0.2,  min: -1,  max: 1,    curve: 'linear' },
    { id: 'sustain',     label: 'Sustain',   defaultValue: 0,    min: -1,  max: 1,    curve: 'linear' },
    { id: 'glue',        label: 'Glue',      defaultValue: 0.3,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'ceiling',     label: 'Ceiling',   defaultValue: 0.5,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'width',       label: 'Width',     defaultValue: 0.2,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'level',       label: 'Level',     defaultValue: 0,    min: -24, max: 12,   curve: 'linear',   units: 'dB' },
  ],

  docs: {
    explanation:
      "A super-deep, pulsing stereo kick VOICE — built to shake the room, not just tick. Instead of one oscillator + envelope, KICK DRUM layers three decoupled generators so depth and punch live on separate knobs: a pure-sine SUB (the air-moving fundamental at Tune, with a long decay — the 'pulse'), a BODY an octave above with a fast downward pitch sweep (the 909-style 'dooo' that reads as punch on mid-size speakers), and a short filtered-noise CLICK (the leading-edge transient the ear locks onto). The summed layers then run a serial bus: a DRIVE saturator with a single HARD character switch (clean-warm vs aggressive), an internal 3-band kick EQ (sub shelf / body bell / attack bell, plus a spectral TILT), and the TRANSLATE harmonic exciter — it synthesizes the sub's 2nd/3rd/4th harmonics so the kick still reads deep on laptop and phone speakers that can't reproduce a 40–50 Hz fundamental. A DYNAMICS section (transient ATTACK/SUSTAIN shaper, a GLUE compressor whose detector ignores the sub so the low end never pumps, and a CEILING soft-clip that true-peak-bounds the voice) lets it sit hot safely, and the stereo stage keeps everything below ~120 Hz strictly MONO while WIDTH spreads only the upper body/click band — phase-safe sub, wide top. Strike it from any trigger/gate source; ACCENT sets per-hit intensity, PITCH CV tracks 1V/oct, and CHOKE damps the tail while held (hi-hat-style choke groups). The default patch is a clean, deep club kick; push Drive/Hard/Translate for aggression.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge fires one kick — oscillator phases reset (click-free and deterministic), every envelope retriggers, and the accent input is sampled at that instant. How long the signal stays high doesn't matter; it's a trigger, not a hold. Patch a sequencer gate, drum-seq lane, or clock here.",
      accent_in:
        "Per-hit intensity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO here gives each kick its own velocity. Accented hits sweep the pitch envelope deeper and land louder (the plan's accent macro: pitch-depth + level move together).",
      pitch_cv:
        "1V/oct pitch input: transposes the whole voice — sub fundamental and body together — as a true frequency multiplier (tune × 2^volts), so melodic kick lines track across octaves. Patch a sequencer pitch output here for tuned kicks.",
      choke_in:
        "Choke group input (level-sensitive gate): WHILE the level is high the voice is damped through a short ~30 ms ramp toward silence, and on the falling edge it releases and recovers — both edges matter, like an open-hat choke. Hold it high to duck the kick's tail; it does not fire hits.",
    },
    outputs: {
      audio_l:
        "Left output of the stereo voice. Everything below ~120 Hz is identical on both sides (mono-safe sub — full speaker excursion, no phase cancellation on a mono fold-down); WIDTH only decorrelates the upper body/click band. Patch L alone for a mono kick — the stereo pair auto-pairs when the target accepts it.",
      audio_r:
        "Right output — the other half of the stereo pair. Carries the same mono sub as the left; only the >120 Hz band differs when WIDTH is up.",
    },
    controls: {
      tune: "SUB: the kick's fundamental (20–120 Hz, log). 50 Hz default = deep club kick; below ~40 Hz you're into feel-more-than-hear territory (raise TRANSLATE so small speakers keep up); 80–120 Hz reads as a tight punchy thump. Tracks pitch_cv at 1V/oct.",
      pitch_amt: "BODY: depth of the per-hit downward pitch sweep in semitones (0–48). This is the 'punch' knob — the body starts up to 4 octaves above its settled pitch and dives; more depth = harder chirp. Accented hits sweep up to 50 % deeper.",
      pitch_time: "BODY: how fast the pitch sweep settles (5–120 ms, log). Short = a sharp tick; long = an audible falling 'dooo'. The sub's own settle rides this too, ~3× slower and much gentler.",
      tension: "BODY: amplitude→pitch glide (0–0.6). Above zero, the body's pitch rides its own loudness envelope — loud onset bends sharp then relaxes as it decays, the drum-skin tension effect borrowed from modal drums. Subtle values (0.1–0.2) add organic movement.",
      sub_decay: "SUB: the sub layer's decay to −60 dB (50–800 ms, log). This is the 'pulse length' — long settings make the room breathe between hits; short settings tighten the low end for fast patterns.",
      body_decay: "BODY: the body layer's decay to −60 dB (20–400 ms, log). Keep it shorter than Sub Dec so the punch snaps and the sub carries the tail.",
      click_len: "CLICK: length of the noise transient (2–60 ms, log). A few ms is a subtle tick; tens of ms becomes an audible slap. (Click layer lands in the next DSP phase — the knob is live and wired through.)",
      sub_level: "SUB: level of the sine sub layer (0–1). The mix is headroom-normalized, so maxing sub + body together won't clip the pre-drive bus.",
      body_level: "BODY: level of the swept body layer (0–1) — the punch-vs-depth balance against Sub.",
      click_level: "CLICK: level of the noise transient layer (0–1). More = a harder leading edge that cuts through a dense mix.",
      body_shape: "BODY: waveform morph (0–1): 0 = pure sine, 0.5 = triangle, 1 = rectangle — band-limited throughout. Higher shapes add harmonics and grit to the punch before the drive stage even engages.",
      click_tone: "CLICK: band-pass center of the noise burst (500–6000 Hz, log) — dark knock at the bottom of the range, bright snap at the top.",
      drive: "DRIVE: saturation amount on the summed voice (0–1). Adds harmonics and perceived loudness at the same peak level — the 'louder without clipping' stage. Its character is set by HARD.",
      hard: "DRIVE character switch: OFF = clean-warm saturation (smooth, odd harmonics — the shipping default's deep clean kick); ON = the aggressive mode (harder folding/edge for distorted, techno-leaning kicks). One switch instead of a mode menu — owner-decided.",
      translate: "TRANSLATE: the harmonic exciter (0–1). Synthesizes the sub's 2nd/3rd/4th harmonics (e.g. 80/120/160 Hz for a 40 Hz fundamental) so small speakers reconstruct the missing fundamental — the kick stays 'deep' on a phone. Raise it when Tune is very low.",
      sub_eq: "EQ: sub shelf gain (±12 dB, ~50 Hz) — weight control for the very bottom without touching the punch band.",
      body_eq: "EQ: body bell gain (±12 dB, ~150 Hz) — the chest-thump band. Default +3 dB leans the voice punchy.",
      attack_eq: "EQ: attack bell gain (±12 dB, ~2.8 kHz) — presence of the click/beater band; boost to cut through, cut to soften.",
      tilt: "EQ: spectral tilt (−1..+1): negative tips energy toward the lows (darker, deeper), positive toward the highs (brighter, clickier), pivoting around the body band.",
      attack: "DYNAMICS: transient-shaper attack (−1..+1). Positive sharpens the onset slope (more crack at the same peak), negative rounds it off. Threshold-free — level-independent.",
      sustain: "DYNAMICS: transient-shaper sustain (−1..+1). Positive brings the tail up (longer, fuller body), negative tucks it away for a tighter, drier kick.",
      glue: "DYNAMICS: the in-voice compressor amount (0–1). Its detector high-passes at ~100 Hz, so the sub NEVER pumps the compression — glue tightens the body/click while the low end stays untouched.",
      ceiling: "DYNAMICS: soft-knee output clip (0–1) that true-peak-bounds the voice — lets you run Level hot into the rack safely. Lower = earlier, more audible clipping; higher = cleaner headroom.",
      width: "STEREO: width of the upper band ONLY (0–1, M/S). Everything under ~120 Hz stays strictly mono (phase-safe, mono-fold-proof); width spreads the body/click above it. 0 = fully mono voice.",
      level: "OUT: output level in dB (−24..+12). The +12 dB makeup headroom is deliberate (vs older voices capped at 0 dB) — the ceiling stage keeps a hot setting true-peak-safe.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 4 audio-rate node inputs: trigger (0), accent (1), pitch (2), choke (3).
    // ONE stereo output, fanned into separate L/R ports below.
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    // Fan the worklet's 2-channel output into SEPARATE L / R node ports so
    // the (future) stereo width survives downstream — the cube.ts /
    // meowbox idiom: splitter output 0 = L, output 1 = R.
    const splitter = ctx.createChannelSplitter(2);
    worklet.connect(splitter, 0);

    // Keep the worklet alive with a single 0-offset silence source on every
    // input, so it processes blocks (and can be struck immediately) even
    // when nothing is patched yet. One ConstantSource, four connections.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(worklet, 0, 0);
    silence.connect(worklet, 0, 1);
    silence.connect(worklet, 0, 2);
    silence.connect(worklet, 0, 3);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of kickdrumDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    inputsMap.set('trigger_in', { node: worklet, input: 0 });
    inputsMap.set('accent_in',  { node: worklet, input: 1 });
    inputsMap.set('pitch_cv',   { node: worklet, input: 2 });
    inputsMap.set('choke_in',   { node: worklet, input: 3 });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['audio_l', { node: splitter, output: 0 }],
        ['audio_r', { node: splitter, output: 1 }],
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
        try { splitter.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
