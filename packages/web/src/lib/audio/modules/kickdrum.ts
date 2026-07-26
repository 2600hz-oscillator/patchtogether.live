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
// above). All phases are now implemented in the worklet: the three SUB /
// BODY / CLICK generators plus the full downstream chain (DRIVE, EQ + tilt,
// TRANSLATE, DYNAMICS, and the stereo crossover / WIDTH).
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
// them. Level spans −24..+12 dB (deliberate headroom), guarded by the
// voice's own true-peak ceiling stage.

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
  // A WIDE banded voice card (~26 controls over three SUB·BODY·CLICK /
  // DRIVE·EQ·TRANSLATE / DYNAMICS·STEREO·OUT bands). MEASURED natural
  // content height at hp:2 (360px) is ~576px (offsetHeight probe), so the
  // 3u tier (540px) clipped the bottom DYNAMICS/STEREO/OUT band; 4u (720px)
  // contains every control + label with comfortable margin. ~576×360px.
  size: '4u',
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
    // Per-control CV for EVERY voice knob (the cofefve/karplus convention): a
    // -1..+1 CV sweeps the target AudioParam's FULL range centred on the live
    // knob. cvScale mode matches each param's curve (log / linear / discrete);
    // at cv=0 the delta is 0, so an unpatched input is a no-op.
    { id: 'tune_cv',        type: 'cv', paramTarget: 'tune',        cvScale: { mode: 'log' } },
    { id: 'sub_decay_cv',   type: 'cv', paramTarget: 'sub_decay',   cvScale: { mode: 'log' } },
    { id: 'sub_level_cv',   type: 'cv', paramTarget: 'sub_level',   cvScale: { mode: 'linear' } },
    { id: 'pitch_amt_cv',   type: 'cv', paramTarget: 'pitch_amt',   cvScale: { mode: 'linear' } },
    { id: 'pitch_time_cv',  type: 'cv', paramTarget: 'pitch_time',  cvScale: { mode: 'log' } },
    { id: 'tension_cv',     type: 'cv', paramTarget: 'tension',     cvScale: { mode: 'linear' } },
    { id: 'body_decay_cv',  type: 'cv', paramTarget: 'body_decay',  cvScale: { mode: 'log' } },
    { id: 'body_level_cv',  type: 'cv', paramTarget: 'body_level',  cvScale: { mode: 'linear' } },
    { id: 'body_shape_cv',  type: 'cv', paramTarget: 'body_shape',  cvScale: { mode: 'linear' } },
    { id: 'click_len_cv',   type: 'cv', paramTarget: 'click_len',   cvScale: { mode: 'log' } },
    { id: 'click_tone_cv',  type: 'cv', paramTarget: 'click_tone',  cvScale: { mode: 'log' } },
    { id: 'click_level_cv', type: 'cv', paramTarget: 'click_level', cvScale: { mode: 'linear' } },
    { id: 'drive_cv',       type: 'cv', paramTarget: 'drive',       cvScale: { mode: 'linear' } },
    { id: 'hard_cv',        type: 'cv', paramTarget: 'hard',        cvScale: { mode: 'discrete' } },
    { id: 'translate_cv',   type: 'cv', paramTarget: 'translate',   cvScale: { mode: 'linear' } },
    { id: 'sub_eq_cv',      type: 'cv', paramTarget: 'sub_eq',      cvScale: { mode: 'linear' } },
    { id: 'body_eq_cv',     type: 'cv', paramTarget: 'body_eq',     cvScale: { mode: 'linear' } },
    { id: 'attack_eq_cv',   type: 'cv', paramTarget: 'attack_eq',   cvScale: { mode: 'linear' } },
    { id: 'tilt_cv',        type: 'cv', paramTarget: 'tilt',        cvScale: { mode: 'linear' } },
    { id: 'attack_cv',      type: 'cv', paramTarget: 'attack',      cvScale: { mode: 'linear' } },
    { id: 'sustain_cv',     type: 'cv', paramTarget: 'sustain',     cvScale: { mode: 'linear' } },
    { id: 'glue_cv',        type: 'cv', paramTarget: 'glue',        cvScale: { mode: 'linear' } },
    { id: 'ceiling_cv',     type: 'cv', paramTarget: 'ceiling',     cvScale: { mode: 'linear' } },
    { id: 'width_cv',       type: 'cv', paramTarget: 'width',       cvScale: { mode: 'linear' } },
    { id: 'level_cv',       type: 'cv', paramTarget: 'level',       cvScale: { mode: 'linear' } },
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

  // ── RACKLINE face (P1 total-rework — UI curation only, NOT the I/O
  // contract; see ModuleFace in $lib/graph/types). Designed from the voice's
  // INTENT + the approved mock (fullcard-mocks/kickdrum.html): the lane leads
  // with the PLAYER knobs — TUNE (the kick's identity), SUB DEC (pulse
  // length), DRIVE (aggression) — then the punch cluster (P AMT / BODY LVL /
  // CLK LVL / P TIME) + LEVEL complete the full-in-lane eight. The dock
  // groups by producer intent: the three GENERATOR LAYERS over the serial
  // BUS, with each band-EQ folded into the layer it shapes (sub also owns
  // TRANSLATE, its small-speaker reconstructor; TILT rides with DRIVE).
  // glyph 'scope' = the mock's amp+pitch envelope hero.
  face: {
    order: [
      // top-3 → the compact lane tile: tune it, size the pulse, drive it.
      'tune', 'sub_decay', 'drive',
      // ranks 4–8 → the full-in-lane face: the punch cluster + output gain.
      'pitch_amt', 'body_level', 'click_level', 'pitch_time', 'level',
      // dock roster, mock reading order — the layers, then the bus.
      'sub_level', 'sub_eq', 'translate',
      'tension', 'body_decay', 'body_shape', 'body_eq',
      'click_len', 'click_tone', 'attack_eq',
      'hard', 'tilt',
      'attack', 'sustain', 'glue', 'ceiling',
      'width',
    ],
    pages: [
      { id: 'sub',      label: 'sub · depth',       controls: ['tune', 'sub_decay', 'sub_level', 'sub_eq', 'translate'] },
      { id: 'body',     label: 'body · punch',      controls: ['pitch_amt', 'pitch_time', 'tension', 'body_decay', 'body_level', 'body_shape', 'body_eq'] },
      { id: 'click',    label: 'click · transient', controls: ['click_len', 'click_tone', 'click_level', 'attack_eq'] },
      { id: 'drive',    label: 'drive · character', controls: ['drive', 'hard', 'tilt'] },
      { id: 'dynamics', label: 'dynamics · glue',   controls: ['attack', 'sustain', 'glue', 'ceiling'] },
      { id: 'output',   label: 'output · stereo',   controls: ['width', 'level'] },
    ],
    glyph: 'scope',
    // REAR CARD curation (rear-card-model) — the flip-side jack field.
    //  * The four performance inputs are PINNED into the leading band and it
    //    is headed 'strike': that is their function (hit it, accent the hit,
    //    transpose the voice, choke the tail) — 'voice' would suggest a pitch/
    //    gate note pair this drum does not have. Pinning also nails `pitch_cv`
    //    down: its `_cv` stem is 'pitch', so the day a param named `pitch` is
    //    added, derivation would silently file it into that param's page band.
    //  * The 'body · punch' page carries SEVEN CV holes — the widest band on
    //    the card — so it splits into the two things the body layer really is:
    //    the PITCH ENVELOPE that makes the punch (amount / time / tension) and
    //    the TONE that follows it (decay / level / shape / EQ). Every other
    //    band mirrors its dock page 1:1.
    //  * `~` on PITCH only. The worklet's four node inputs are read RAW
    //    per-sample, but only pitch is a continuous audio-rate destination
    //    (per-sample 1 V/oct → real FM of the whole voice); TRIGGER and CHOKE
    //    are edge/level jacks already glyphed ▲/▬, and ACCENT is LATCHED at
    //    the strike edge (per-hit, not per-sample). Every per-param CV lands on
    //    an 80 Hz-smoothed AudioParam — control-rate by construction.
    rear: {
      groups: [
        { id: 'voice', label: 'strike', ports: ['trigger_in', 'accent_in', 'pitch_cv', 'choke_in'] },
      ],
      clusters: [
        { group: 'body', label: 'pitch envelope', ports: ['pitch_amt_cv', 'pitch_time_cv', 'tension_cv'] },
        { group: 'body', label: 'tone', ports: ['body_decay_cv', 'body_level_cv', 'body_shape_cv', 'body_eq_cv'] },
      ],
      audioRate: ['pitch_cv'],
    },
  },

  docs: {
    explanation:
      "A super-deep, pulsing stereo kick VOICE — built to shake the room, not just tick. Instead of one oscillator + envelope, KICK DRUM layers three decoupled GENERATOR LAYERS so depth and punch live on separate knobs: a pure-sine SUB (the air-moving fundamental at Tune, with a long decay — the 'pulse'), a BODY one octave above with a fast downward pitch sweep (the 909-style 'dooo' that reads as punch on mid-size speakers), and a short band-passed noise CLICK (the leading-edge transient the ear locks onto — seeded-deterministic, so every hit is bit-identical). The summed layers then hit the BUS: first a DRIVE saturator with a single HARD character switch (clean-warm tanh vs an aggressive wavefolder whose bite rides the body envelope); then the TRANSLATE harmonic exciter joins as a PARALLEL branch — it taps a copy of the raw sub layer (pre-drive), synthesizes the sub's 2nd/3rd/4th harmonics, and sums them into the bus just ahead of the EQ, so the kick still reads deep on laptop and phone speakers that can't reproduce a 40–50 Hz fundamental; finally the combined signal runs the internal 3-band kick EQ (sub shelf ~50 Hz / body bell ~150 Hz / attack bell ~2.8 kHz, plus a spectral TILT). A DYNAMICS section (threshold-free ATTACK/SUSTAIN transient shaper, a GLUE compressor whose detector ignores everything under ~100 Hz so the sub never pumps, and a CEILING lean-in stage that keeps the voice true-peak-bounded however hot it runs) lets it sit hot safely, and the stereo stage is mono-safe by construction: the sub AND body are identical on both channels — WIDTH spreads only the click's decorrelated noise above ~120 Hz. Phase-safe low end, wide top. Strike it from any trigger/gate source; ACCENT is latched per hit and deepens the pitch sweep, drive, and level together; PITCH CV tracks 1V/oct; CHOKE damps the tail while held (drum-machine choke groups). The default patch is a clean, deep club kick; push Drive/Hard/Translate for aggression.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge fires one kick — oscillator phases reset (click-free and deterministic), every envelope retriggers, and the accent input is sampled at that instant. How long the signal stays high doesn't matter; it's a trigger, not a hold. Patch a sequencer gate, drum-seq lane, or clock here.",
      accent_in:
        "Per-hit intensity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO here gives each kick its own velocity. One accent macro moves three things together: the body's pitch sweep dives up to 50 % deeper, DRIVE pushes up to 30 % harder, and the hit lands up to +4 dB louder — the boost leans into the CEILING stage, so accents stay true-peak-safe.",
      pitch_cv:
        "1V/oct pitch input: transposes the whole voice — sub fundamental and body together — as a true frequency multiplier (tune × 2^volts), so melodic kick lines track across octaves. Patch a sequencer pitch output here for tuned kicks.",
      choke_in:
        "Choke group input (level-sensitive gate): WHILE the level is high the voice is damped through a fast ~30 ms ramp toward silence, and on the falling edge it recovers through a short ~10 ms lag so the release is click-free — both edges matter, like an open-hat choke. Hold it high to duck the kick's tail; it does not fire hits.",
      tune_cv:
        "CV modulation of TUNE (log): ±1 sweeps the sub fundamental across its full 20–120 Hz range centred on the knob — tuned kicks or per-step pitch. (Distinct from pitch_cv, which transposes the whole voice at 1V/oct; this sets the SUB's own base.)",
      sub_decay_cv:
        "CV modulation of SUB DEC (log): ±1 sweeps the sub layer's decay across its full 50–800 ms range around the knob — shorten for fast patterns, lengthen to make the room breathe.",
      sub_level_cv:
        "CV modulation of SUB level (linear): ±1 sweeps the sine-sub layer across its full 0–1 range around the knob — duck or lift the low end per hit.",
      pitch_amt_cv:
        "CV modulation of P AMT (linear): ±1 sweeps the body pitch-sweep depth across its full 0–48 st range around the knob — modulate the punch/chirp amount.",
      pitch_time_cv:
        "CV modulation of P TIME (log): ±1 sweeps the sweep-settle time across its full 5–120 ms range around the knob — sharp tick to falling 'dooo'.",
      tension_cv:
        "CV modulation of TENSION (linear): ±1 sweeps the amplitude→pitch glide across its full 0–0.6 range around the knob — animate the drum-skin bend.",
      body_decay_cv:
        "CV modulation of BODY DEC (log): ±1 sweeps the body layer's decay across its full 20–400 ms range around the knob.",
      body_level_cv:
        "CV modulation of BODY level (linear): ±1 sweeps the body layer across its full 0–1 range around the knob — the punch-vs-depth balance.",
      body_shape_cv:
        "CV modulation of SHAPE (linear): ±1 sweeps the body waveform morph across its full 0–1 range (sine→tri→rect) around the knob — add or remove grit.",
      click_len_cv:
        "CV modulation of CLICK len (log): ±1 sweeps the noise transient length across its full 2–60 ms range around the knob.",
      click_tone_cv:
        "CV modulation of CLK TONE (log): ±1 sweeps the click band-pass across its full 500–6000 Hz range around the knob — dark knock to bright snap.",
      click_level_cv:
        "CV modulation of CLK LVL (linear): ±1 sweeps the click layer across its full 0–1 range around the knob.",
      drive_cv:
        "CV modulation of DRIVE (linear): ±1 sweeps the saturation amount across its full 0–1 range around the knob — pump the perceived loudness live.",
      hard_cv:
        "CV modulation of HARD (discrete): the CV is bucketed straight to the switch by round-half-up, so the flip point sits exactly at CV = 0 — CV ≥ 0 (the midpoint itself included) selects the aggressive mode, and only CV < 0 selects clean-warm — the character switch under CV.",
      translate_cv:
        "CV modulation of TRANSLATE (linear): ±1 sweeps the harmonic exciter across its full 0–1 range around the knob — reconstruct the sub for small speakers dynamically.",
      sub_eq_cv:
        "CV modulation of SUB EQ (linear): ±1 sweeps the sub shelf across its full ±12 dB range around the knob.",
      body_eq_cv:
        "CV modulation of BODY EQ (linear): ±1 sweeps the body bell across its full ±12 dB range around the knob.",
      attack_eq_cv:
        "CV modulation of ATK EQ (linear): ±1 sweeps the attack bell across its full ±12 dB range around the knob.",
      tilt_cv:
        "CV modulation of TILT (linear): ±1 sweeps the spectral tilt across its full −1..+1 range around the knob — darker to brighter.",
      attack_cv:
        "CV modulation of ATTACK (linear): ±1 sweeps the transient-shaper attack across its full −1..+1 range around the knob — round or sharpen the onset.",
      sustain_cv:
        "CV modulation of SUSTAIN (linear): ±1 sweeps the transient-shaper sustain across its full −1..+1 range around the knob — tuck or fatten the tail.",
      glue_cv:
        "CV modulation of GLUE (linear): ±1 sweeps the compressor amount across its full 0–1 range around the knob.",
      ceiling_cv:
        "CV modulation of CEILING (linear): ±1 sweeps the clip lean across its full 0–1 range around the knob — from near-transparent to slammed into the soft-clip.",
      width_cv:
        "CV modulation of WIDTH (linear): ±1 sweeps the click band's stereo width across its full 0–1 range around the knob (the sub and body stay mono).",
      level_cv:
        "CV modulation of LEVEL (linear): ±1 sweeps the output gain across its full −24..+12 dB range around the knob — tremolo or dynamic swells.",
    },
    outputs: {
      audio_l:
        "Left output of the stereo voice. The sub AND body are identical on both sides — the only stereo content is the click's decorrelated noise, high-passed at ~120 Hz and scaled by WIDTH — so a mono fold-down never thins the low end (the side term cancels to first order). Patch L alone for a mono kick — the stereo pair auto-pairs when the target accepts it.",
      audio_r:
        "Right output — the other half of the stereo pair. Carries the same mono sub and body as the left; only the click's >120 Hz side content differs when WIDTH is up (at WIDTH 0 the channels are identical).",
    },
    controls: {
      tune: "SUB: the kick's fundamental (20–120 Hz, log). 50 Hz default = deep club kick; below ~40 Hz you're into feel-more-than-hear territory (raise TRANSLATE so small speakers keep up); 80–120 Hz reads as a tight punchy thump. Tracks pitch_cv at 1V/oct.",
      pitch_amt: "BODY: depth of the per-hit downward pitch sweep in semitones (0–48). This is the 'punch' knob — the body starts up to 4 octaves above its settled pitch and dives; more depth = harder chirp. Accented hits sweep up to 50 % deeper.",
      pitch_time: "BODY: how fast the pitch sweep settles (5–120 ms, log). Short = a sharp tick; long = an audible falling 'dooo'. The sub's own settle rides this too, ~3× slower and much gentler.",
      tension: "BODY: amplitude→pitch glide (0–0.6). Above zero, the body's pitch rides its own loudness envelope — loud onset bends sharp then relaxes as it decays, the drum-skin tension effect borrowed from modal drums. Subtle values (0.1–0.2) add organic movement.",
      sub_decay: "SUB: the sub layer's decay to −60 dB (50–800 ms, log). This is the 'pulse length' — long settings make the room breathe between hits; short settings tighten the low end for fast patterns.",
      body_decay: "BODY: the body layer's decay to −60 dB (20–400 ms, log). Keep it shorter than Sub Dec so the punch snaps and the sub carries the tail.",
      click_len: "CLICK: length of the noise transient (2–60 ms, log; time to −60 dB). A few ms is a subtle tick; tens of ms becomes an audible slap. The burst is seeded-deterministic — every strike reseeds the noise, so hit N clicks bit-identically to hit 1.",
      sub_level: "SUB: level of the sine sub layer (0–1). The mix is headroom-normalized, so maxing sub + body together won't clip the pre-drive bus.",
      body_level: "BODY: level of the swept body layer (0–1) — the punch-vs-depth balance against Sub.",
      click_level: "CLICK: level of the noise transient layer (0–1). More = a harder leading edge that cuts through a dense mix.",
      body_shape: "BODY: waveform morph (0–1): 0 = pure sine, 0.5 = triangle, 1 = rectangle — band-limited throughout. Higher shapes add harmonics and grit to the punch before the drive stage even engages.",
      click_tone: "CLICK: band-pass center of the noise burst (500–6000 Hz, log) — dark knock at the bottom of the range, bright snap at the top.",
      drive: "DRIVE: saturation amount on the summed voice (0–1). Adds harmonics and perceived loudness at the same peak level — the 'louder without clipping' stage. Its character is set by HARD.",
      hard: "DRIVE character switch: OFF = clean-warm tanh saturation, oversampled 2× (smooth, odd harmonics — the shipping default's deep clean kick); ON = an aggressive wavefolder + asymmetric shaper, oversampled 4× and run hotter, its fold depth riding the body envelope so the bite follows the punch — distorted, techno-leaning kicks. One switch instead of a mode menu — owner-decided.",
      translate: "SUB: the TRANSLATE harmonic exciter (0–1) — the sub layer's small-speaker reconstructor, a parallel branch summed into the bus just ahead of the EQ. It saturates a copy of the sub (an asymmetric shaper, so even harmonics appear) and then low-passes the result at 300 Hz — keeping the synthesized 2nd/3rd/4th harmonics (e.g. 80/120/160 Hz for a 40 Hz fundamental) while discarding the fizz above — so speakers that can't reproduce the fundamental still read the kick as deep. Raise it when Tune is very low.",
      sub_eq: "SUB: sub shelf gain (±12 dB shelf at ~50 Hz) — weight control for the very bottom without touching the punch band.",
      body_eq: "BODY: body bell gain (±12 dB bell at ~150 Hz) — the chest-thump band. Default +3 dB leans the voice punchy.",
      attack_eq: "CLICK: attack bell gain (±12 dB bell at ~2.8 kHz) — presence of the click/beater band; boost to cut through, cut to soften.",
      tilt: "DRIVE: spectral tilt (−1..+1) — opposing ±4 dB shelves at 250 Hz / 2.5 kHz. Negative tips energy toward the lows (darker, deeper); positive toward the highs (brighter, clickier).",
      attack: "DYNAMICS: transient-shaper attack (−1..+1). Positive sharpens the onset slope (more crack at the same peak), negative rounds it off. Threshold-free — level-independent.",
      sustain: "DYNAMICS: transient-shaper sustain (−1..+1). Positive brings the tail up (longer, fuller body), negative tucks it away for a tighter, drier kick.",
      glue: "DYNAMICS: the in-voice compressor amount (0–1). Its detector high-passes at ~100 Hz, so the sub NEVER pumps the compression — glue tightens the body/click while the low end stays untouched.",
      ceiling: "DYNAMICS: how hard the voice leans into its true-peak soft-clip (0–1). The output stage is ALWAYS tanh-bounded below digital full-scale; CEILING sets the gain into that curve — low keeps the stage nearly transparent (clean headroom), high slams the voice into the clip for a denser, louder, more saturated hit. A lean-in control, not a threshold.",
      width: "OUTPUT: stereo width of the click band ONLY (0–1, mid/side). The sub AND body are identical on both channels, and the side signal is high-passed at ~120 Hz — phase-safe, mono-fold-proof by construction. What spreads is the click's decorrelated noise; 0 = a fully mono voice (L and R identical).",
      level: "OUTPUT: output level in dB (−24..+12), applied BEFORE the ceiling so hot settings lean into the clip instead of escaping it. The +12 dB makeup headroom is deliberate (vs older voices capped at 0 dB) — the ceiling keeps it true-peak-safe.",
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

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputsMap.set('trigger_in', { node: worklet, input: 0 });
    inputsMap.set('accent_in',  { node: worklet, input: 1 });
    inputsMap.set('pitch_cv',   { node: worklet, input: 2 });
    inputsMap.set('choke_in',   { node: worklet, input: 3 });
    // Per-control CV → AudioParam routing (cofefve/karplus convention). The
    // `input: 0` is an unused placeholder; the engine routes onto the
    // AudioParam named by `param` (with the def's cvScale hint applied).
    inputsMap.set('tune_cv',        { node: worklet, input: 0, param: params.get('tune')! });
    inputsMap.set('sub_decay_cv',   { node: worklet, input: 0, param: params.get('sub_decay')! });
    inputsMap.set('sub_level_cv',   { node: worklet, input: 0, param: params.get('sub_level')! });
    inputsMap.set('pitch_amt_cv',   { node: worklet, input: 0, param: params.get('pitch_amt')! });
    inputsMap.set('pitch_time_cv',  { node: worklet, input: 0, param: params.get('pitch_time')! });
    inputsMap.set('tension_cv',     { node: worklet, input: 0, param: params.get('tension')! });
    inputsMap.set('body_decay_cv',  { node: worklet, input: 0, param: params.get('body_decay')! });
    inputsMap.set('body_level_cv',  { node: worklet, input: 0, param: params.get('body_level')! });
    inputsMap.set('body_shape_cv',  { node: worklet, input: 0, param: params.get('body_shape')! });
    inputsMap.set('click_len_cv',   { node: worklet, input: 0, param: params.get('click_len')! });
    inputsMap.set('click_tone_cv',  { node: worklet, input: 0, param: params.get('click_tone')! });
    inputsMap.set('click_level_cv', { node: worklet, input: 0, param: params.get('click_level')! });
    inputsMap.set('drive_cv',       { node: worklet, input: 0, param: params.get('drive')! });
    inputsMap.set('hard_cv',        { node: worklet, input: 0, param: params.get('hard')! });
    inputsMap.set('translate_cv',   { node: worklet, input: 0, param: params.get('translate')! });
    inputsMap.set('sub_eq_cv',      { node: worklet, input: 0, param: params.get('sub_eq')! });
    inputsMap.set('body_eq_cv',     { node: worklet, input: 0, param: params.get('body_eq')! });
    inputsMap.set('attack_eq_cv',   { node: worklet, input: 0, param: params.get('attack_eq')! });
    inputsMap.set('tilt_cv',        { node: worklet, input: 0, param: params.get('tilt')! });
    inputsMap.set('attack_cv',      { node: worklet, input: 0, param: params.get('attack')! });
    inputsMap.set('sustain_cv',     { node: worklet, input: 0, param: params.get('sustain')! });
    inputsMap.set('glue_cv',        { node: worklet, input: 0, param: params.get('glue')! });
    inputsMap.set('ceiling_cv',     { node: worklet, input: 0, param: params.get('ceiling')! });
    inputsMap.set('width_cv',       { node: worklet, input: 0, param: params.get('width')! });
    inputsMap.set('level_cv',       { node: worklet, input: 0, param: params.get('level')! });

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
