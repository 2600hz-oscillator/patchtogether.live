// packages/web/src/lib/audio/modules/snaredrum.ts
//
// SNARE DRUM — deep, flexible stereo snare VOICE with a POLYPHONIC two-hand
// DRUMROLL (design + build spec: .myrobots/snare-drum-module-design.md). Mate to
// KICK DRUM; it clones that template (state-object DSP, sr-calibrated decay,
// seeded xorshift, per-channel tanh ceiling, mono-safe M/S, stereo audio_l /
// audio_r fanned through a ChannelSplitter) and adds one new thing: a true
// mechanistic drumroll driven by a GATE.
//
// Four decoupled acoustic layers (design §1): a HEAD modal bank at Bessel-zero
// ratios (the pitchless membrane thunk), BODY noise around the head (the noisy
// tone; `tone` crossfades HEAD↔BODY), a SHARED re-excitable snare-WIRE buzz bed
// (the defining sizzle + the roll's continuity), and a CRACK stick transient.
//
// Two strike sources feed the one synth:
//   trigger_in (edge:'trigger') — one rising edge fires ONE snare hit.
//   gate_in    (edge:'gate')    — WHILE high, an internal two-hand roll engine
//     generates a continuous roll at `roll_speed` (+ roll_speed_cv). Two
//     alternating hands (180° interleaved) whose overlapping decaying tails +
//     the re-excited wire bed keep the snare ringing — a real superposition, NOT
//     a fast one-shot retrigger. `bounce` morphs single → double/open → buzz.
//
// Outputs are SEPARATE audio_l / audio_r ports (cube.ts idiom) so the stereo
// image survives downstream patching; stereoPairs auto-pairs them. width=0 AND
// spread=0 → L == R exactly (mono-safe fold-down).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/snaredrum.js?url';

const PROCESSOR_NAME = 'snaredrum';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const snaredrumDef: AudioModuleDef = {
  type: 'snaredrum',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'snare drum',
  category: 'sources',
  // A WIDE 3u card (banded layout, ~22 controls), mate to KICK DRUM.
  size: '3u',
  hp: 2,

  inputs: [
    // The STRIKE: one snare hit per rising edge. Accent is read at the edge.
    { id: 'trigger_in',   type: 'gate', edge: 'trigger' },
    // The DRUMROLL: while high, the two-hand engine rolls (level-sensitive).
    { id: 'gate_in',      type: 'gate', edge: 'gate' },
    // Roll rate CV — a 1V/oct multiply on roll_speed.
    { id: 'roll_speed_cv', type: 'cv' },
    // Per-hit velocity, sampled at each strike.
    { id: 'accent_in',    type: 'cv' },
    // 1V/oct — transposes the whole voice (head + body) as a multiplier.
    { id: 'pitch_cv',     type: 'cv' },
    // Level-sensitive hand-on-head mute (a choke group input).
    { id: 'choke_in',     type: 'gate', edge: 'gate' },
  ],
  outputs: [
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  stereoPairs: [['audio_l', 'audio_r']],
  params: [
    // ── HEAD · BODY ──
    { id: 'tune',        label: 'Tune',    defaultValue: 180,  min: 90,   max: 400,  curve: 'log',      units: 'Hz' },
    { id: 'tone',        label: 'Tone',    defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'damping',     label: 'Damp',    defaultValue: 0.4,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'head_decay',  label: 'Head',    defaultValue: 180,  min: 30,   max: 600,  curve: 'log',      units: 'ms' },
    { id: 'body_decay',  label: 'Body',    defaultValue: 110,  min: 20,   max: 300,  curve: 'log',      units: 'ms' },
    { id: 'pitch_amt',   label: 'P Amt',   defaultValue: 3,    min: 0,    max: 12,   curve: 'linear',   units: 'st' },
    { id: 'pitch_time',  label: 'P Time',  defaultValue: 18,   min: 3,    max: 80,   curve: 'log',      units: 'ms' },
    // ── WIRE · CRACK ──
    { id: 'wire',        label: 'Wires',   defaultValue: 0.7,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'wire_tone',   label: 'W Tone',  defaultValue: 4500, min: 1500, max: 9000, curve: 'log',      units: 'Hz' },
    { id: 'wire_decay',  label: 'W Dec',   defaultValue: 260,  min: 40,   max: 700,  curve: 'log',      units: 'ms' },
    { id: 'crack',       label: 'Crack',   defaultValue: 0.4,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'crack_tone',  label: 'Ck Tone', defaultValue: 3200, min: 800,  max: 7000, curve: 'log',      units: 'Hz' },
    { id: 'damp',        label: 'G Damp',  defaultValue: 0.2,  min: 0,    max: 1,    curve: 'linear' },
    // ── ROLL ──
    { id: 'roll_speed',  label: 'Roll',    defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'bounce',      label: 'Bounce',  defaultValue: 0.35, min: 0,    max: 1,    curve: 'linear' },
    { id: 'humanize',    label: 'Human',   defaultValue: 0.2,  min: 0,    max: 1,    curve: 'linear' },
    // ── DRIVE · STEREO · OUT ──
    { id: 'spread',      label: 'Spread',  defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'drive',       label: 'Drive',   defaultValue: 0.2,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'hard',        label: 'Hard',    defaultValue: 0,    min: 0,    max: 1,    curve: 'discrete' },
    { id: 'ceiling',     label: 'Ceiling', defaultValue: 0.5,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'width',       label: 'Width',   defaultValue: 0.4,  min: 0,    max: 1,    curve: 'linear' },
    { id: 'level',       label: 'Level',   defaultValue: 0,    min: -24,  max: 12,   curve: 'linear',   units: 'dB' },
  ],

  docs: {
    explanation:
      "A deep, flexible stereo SNARE VOICE — the mate to KICK DRUM — with a true polyphonic two-hand DRUMROLL. Instead of a single oscillator, it layers four decoupled acoustic generators the way a real snare works: a HEAD modal bank tuned to inharmonic Bessel-zero ratios (the pitchless membrane 'thunk', with a short downward pitch-drop at the strike — the snare 'pit'), a band-passed noise BODY around the head (the drum's noisy tone; the TONE knob tilts the whole drum bright/sizzle-forward ↔ fat/head-forward, scaling the tonal voice against the wire bed and crossfading head↔body), the SNARE-WIRE buzz — the defining timbre — modeled as bright HP-tunable noise on a shared re-excitable bed that breathes with the head and rings out between strokes, and a short CRACK stick-contact transient. It has TWO strike inputs into the one synth: TRIGGER fires a single hit per rising edge, and GATE runs the drumroll. The roll is genuinely polyphonic — two alternating hands 180° out of phase, each stroke allocating its own voice from a pool while the shared wire bed sustains the sizzle, so overlapping decaying tails superpose into a continuous roll (NOT a pulsed one-shot retrigger). ROLL SPEED sets the rate (4–24 strokes/hand, plus roll_speed_cv at 1V/oct), BOUNCE morphs the roll type from a machine-gun single-stroke roll through the classic double/open roll to a dense multi-bounce buzz/press roll (a coefficient-of-restitution bounce train), and HUMANIZE adds seeded timing/velocity/detune jitter for a live feel. The summed pool + bed run one shared bus: a DRIVE saturator with a single HARD character switch (clean-warm vs aggressive), a per-channel true-peak CEILING soft-clip so it can sit hot, and a stereo stage where SPREAD pans the two hands and WIDTH decorrelates only the bright wire sizzle — head and body stay centered so a mono fold-down never thins (width=0 AND spread=0 → dead-centre mono). ACCENT sets per-hit intensity, PITCH CV tracks 1V/oct, and CHOKE mutes the tail while held. Strike it from any trigger/gate/clock/sequencer source.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge fires exactly ONE snare hit — the voice is allocated from the pool, its envelopes retrigger, and accent is sampled at that instant. How long the signal stays high doesn't matter; it's a trigger, not a hold. Patch a sequencer gate, drum-seq lane, or clock here for individual hits.",
      gate_in:
        "The DRUMROLL: WHILE this level is high, the internal two-hand roll engine generates a continuous roll at ROLL SPEED — two alternating hands whose overlapping strokes (and, in buzz mode, multi-bounce trains) keep the snare re-excited faster than it decays. The rising edge resets the roll to a repeatable phase; on the falling edge scheduling stops and the in-flight voices + wire bed ring out naturally. Hold a long gate here (a sequencer gate with a long gate length, a held clock, an LFO pulse) for a snare roll.",
      roll_speed_cv:
        "Roll-rate CV — a 1V/oct multiply on ROLL SPEED (+1 V doubles the strokes/second, −1 V halves it), so you can crescendo a roll from a control source or sequence its density.",
      accent_in:
        "Per-hit intensity CV (0..1), sampled at each strike (trigger and every roll stroke). Higher accent lands a hotter hit — it scales the strike velocity and, like KICK's accent macro, lifts drive and level so the accented stroke leans into the ceiling. Patch an LFO or velocity lane for dynamics.",
      pitch_cv:
        "1V/oct pitch input: transposes the whole voice — head modes and body together — as a true frequency multiplier (tune × 2^volts), so a snare line can track a melody or be tuned per step.",
      choke_in:
        "Choke group input (level-sensitive gate): WHILE the level is high the output is damped toward silence through a short ~30 ms ramp (a hand on the head), and on the falling edge it releases and recovers — both edges matter. Hold it high to duck the snare's ring/roll; it does not fire hits.",
    },
    outputs: {
      audio_l:
        "Left output of the stereo voice. The head and body of a single (centered) hit are identical on both sides — only SPREAD (the two-hand pan) and WIDTH (the decorrelated wire sizzle) put content on the sides — so a mono fold-down never phase-cancels. Patch L alone for a mono snare; the pair auto-pairs when the target accepts it.",
      audio_r:
        "Right output — the other half of the stereo pair. Carries the same centered head/body as the left; the two-hand roll and the bright wire band differ from L when SPREAD / WIDTH are up.",
    },
    controls: {
      tune: "HEAD: the snare's fundamental pitch (90–400 Hz, log). The inharmonic modes track it at their Bessel ratios, and the body noise centers on it. Low = deep/fat snare, high = tight/piccolo. Tracks pitch_cv at 1V/oct.",
      tone: "Overall tonal TILT of the drum (0 = bright, wire/noise-forward sizzle; 1 = fat, head/body-forward). It scales the tonal VOICE against the bright wire BED — the dominant part of the sound — and crossfades the head modes with the body noise, so low leans snappy/sizzly and high leans deep/tonal. 0.5 is centered — the everyday balance and the shipped default.",
      damping: "HEAD: mode Q / ring character (0 = open and ringy, 1 = tight and muted). Independent of Head Dec: this shapes how resonant the membrane rings, that shapes how long the amplitude lasts.",
      head_decay: "HEAD: the modal ring's decay to −60 dB (30–600 ms, log). Short = a dry tick; long = a ringing, resonant head. Scaled shorter by Global Damp.",
      body_decay: "BODY: the noise-body decay to −60 dB (20–300 ms, log) — the length of the drum's noisy tone. Scaled shorter by Global Damp.",
      pitch_amt: "HEAD: depth of the downward pitch-drop at the strike, in semitones (0–12) — the snare 'pit'. 0 = static pitch; higher = a more pronounced pitched-down attack.",
      pitch_time: "HEAD: how fast the pitch-drop settles (3–80 ms, log). Short = a quick chirp; long = an audible falling attack.",
      wire: "WIRE: snare-wire buzz amount (0–1) — the defining sizzle. It sets both the wire level AND how hard every strike re-excites the shared wire bed, so it's the master of the roll's continuous sustain. 0 = a wireless tom-like drum.",
      wire_tone: "WIRE: the high-pass corner of the wire noise (1500–9000 Hz, log). Lower = a darker, fuller rattle; higher = a bright, papery sizzle that sits on top of the mix.",
      wire_decay: "WIRE: the wire bed's decay to −60 dB (40–700 ms, log) — the sustain of the buzz between strokes. This is what makes a roll continuous: set longer than the stroke interval and the bed never returns to silence mid-roll. Scaled shorter by Global Damp.",
      crack: "CRACK: level of the short stick-contact transient (0–1) — the leading-edge tick the ear locks onto. More = a harder, snappier attack.",
      crack_tone: "CRACK: band-pass center of the stick transient (800–7000 Hz, log) — dark knock at the bottom, bright snap at the top.",
      damp: "GLOBAL DAMP: scales the head, body, and wire decays DOWN together (0 = full length, 1 = heavily muted) — a single 'towel on the drum' choke without touching the tuning.",
      roll_speed: "ROLL: strokes per hand while GATE is held (0 → 4 Hz, 1 → 24 Hz, exponential; composite two-hand rate ≈ 2×). Below ~15–20 Hz composite the individual strokes are audible (a machine-gun/open roll); above it they fuse into a roar. Modulated by roll_speed_cv (1V/oct).",
      bounce: "ROLL type: 0 = a single-stroke roll (one stroke per hand-beat, granular), ~0.2–0.4 = the classic double/open roll (a primary stroke + a softer rebound), → 1 = a dense multi-bounce buzz / press roll (a bouncing-ball train of up to 6 sub-strokes with geometric decay). Slower hands automatically add more bounces to fill the gap.",
      humanize: "ROLL: seeded (deterministic) timing, velocity, and per-hand detune jitter (0 = machine-perfect, 1 = loose and human). Adds the constantly-shifting sizzle of a real roll without ever using wall-clock randomness.",
      spread: "STEREO: two-hand pan + per-hand detune (0 = mono/centered, 1 = hard L/R hands). The left hand pans left, the right pans right, each striking a slightly different spot (small membrane detune) — a genuine stereo roll image, not a decorrelation trick. At 0 the voice is dead-centre.",
      drive: "DRIVE: saturation on the summed bus (0–1) — adds harmonics and perceived loudness at the same peak level. Character set by HARD; oversampled so it stays clean.",
      hard: "DRIVE character switch: OFF = clean-warm tanh saturation (smooth, the shipping default); ON = an aggressive wavefold + asymmetric shaper (harder, gated/distorted snares). It only engages when DRIVE > 0 — at Drive = 0 the shaper is bypassed, so the switch has no effect until you add drive. One switch instead of a mode menu.",
      ceiling: "OUTPUT: how hard the summed bus is pushed into the per-channel true-peak soft-clip (0–1). HIGHER = hotter — more gain into the clip tanh, so louder and more aggressively clipped/compressed; LOWER = cleaner and quieter with more headroom before the clip. The tanh always bounds each channel true-peak-safe, so you can run Level hot regardless.",
      width: "STEREO: M/S width of the decorrelated wire SIZZLE only (0–1). Head and body stay centered/mono-safe; width spreads just the bright wire band. 0 = a mono wire (combine with Spread=0 for a fully mono voice).",
      level: "OUTPUT: output level in dB (−24..+12). The +12 dB makeup headroom is deliberate — the ceiling stage keeps a hot setting true-peak-safe.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 6 audio-rate node inputs (trigger, gate, roll-cv, accent, pitch, choke);
    // ONE stereo output, fanned into separate L / R ports below.
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 6,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    // Fan the worklet's 2-channel output into SEPARATE L / R node ports so the
    // stereo image survives downstream (the cube.ts / kickdrum idiom).
    const splitter = ctx.createChannelSplitter(2);
    worklet.connect(splitter, 0);

    // Keep the worklet alive with a single 0-offset silence source on every
    // input, so it processes blocks (and can be struck immediately) even when
    // nothing is patched yet. One ConstantSource, six connections.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 6; i++) silence.connect(worklet, 0, i);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of snaredrumDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    inputsMap.set('trigger_in',   { node: worklet, input: 0 });
    inputsMap.set('gate_in',      { node: worklet, input: 1 });
    inputsMap.set('roll_speed_cv', { node: worklet, input: 2 });
    inputsMap.set('accent_in',    { node: worklet, input: 3 });
    inputsMap.set('pitch_cv',     { node: worklet, input: 4 });
    inputsMap.set('choke_in',     { node: worklet, input: 5 });

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
