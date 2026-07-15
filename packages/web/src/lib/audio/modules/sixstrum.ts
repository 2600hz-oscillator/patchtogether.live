// packages/web/src/lib/audio/modules/sixstrum.ts
//
// SIX STRUM — a 6-string guitar/bass/harp instrument built from SIX of our
// KARPLUS string voices (packages/dsp/src/lib/sixstrum-dsp.ts), each with its
// own amplitude ADSR, summed to MONO through a resonant body. It is a VOICE +
// a strummer + a chord voicer in one: strum the six strings by hand (6
// normalled STRUM triggers), play them from a keyboard/sequencer (POLY in), or
// feed one root and let it voice a guitar chord (mono CHORD in). Six MUTE gates
// palm-mute individual strings ("a finger loosely on the string").
//
// GUITAR / BASS / HARP are NOT presets with hidden DSP — they are three knob
// states of this one control scheme (TUNING + REGISTER + RING + MATERIAL +
// PICK + STRUM SPREAD + …). Presets recall knob positions, nothing else.
//
// Ports (see the worklet header for the input index layout):
//   POLY   — polyPitchGate; lanes 0..5 → strings 1..6 (needs the 16-lane bus).
//   CHORD  — mono pitch CV (V/oct root) → a voiced 6-string chord.
//   STRUM 1..6 — edge:'trigger'; NORMALLED low→high (patch only #1 ⇒ barre all).
//   MUTE 1..6  — edge:'gate'; palm mute that string (all six ⇒ choke the chord).
//   ACCENT — cv 0..1 per-hit velocity (louder + brighter).
//   OUT    — mono.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { fireTrigger } from '$lib/audio/gate-trigger';
import workletUrl from '@patchtogether.live/dsp/dist/sixstrum.js?url';

const PROCESSOR_NAME = 'sixstrum';
const STRINGS = 6;
const loadedContexts = new WeakSet<BaseAudioContext>();

export const sixstrumDef: AudioModuleDef = {
  type: 'sixstrum',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'six strum',
  category: 'sources',

  inputs: [
    // Poly note source: lanes 0..5 → strings 1..6 (pitch + gate-as-pluck).
    { id: 'poly', type: 'polyPitchGate' },
    // Mono chord root (V/oct) → voiced across the 6 strings.
    { id: 'chord', type: 'pitch' },
    // Six STRUM triggers (one pluck per rising edge), normalled #1→all.
    { id: 'strum1', type: 'gate', edge: 'trigger' },
    { id: 'strum2', type: 'gate', edge: 'trigger' },
    { id: 'strum3', type: 'gate', edge: 'trigger' },
    { id: 'strum4', type: 'gate', edge: 'trigger' },
    { id: 'strum5', type: 'gate', edge: 'trigger' },
    { id: 'strum6', type: 'gate', edge: 'trigger' },
    // Six MUTE gates (palm-mute while held).
    { id: 'mute1', type: 'gate', edge: 'gate' },
    { id: 'mute2', type: 'gate', edge: 'gate' },
    { id: 'mute3', type: 'gate', edge: 'gate' },
    { id: 'mute4', type: 'gate', edge: 'gate' },
    { id: 'mute5', type: 'gate', edge: 'gate' },
    { id: 'mute6', type: 'gate', edge: 'gate' },
    // Shared per-hit velocity (Pattern B: scaled in the core — see
    // cv-scale-registry PASSTHROUGH_BY_DESIGN).
    { id: 'accent', type: 'cv' },
  ],
  outputs: [{ id: 'out', type: 'audio' }],

  params: [
    { id: 'register', label: 'Register', defaultValue: 0, min: -24, max: 24, curve: 'linear', units: 'st' },
    { id: 'ring', label: 'Ring', defaultValue: 2.5, min: 0.1, max: 10, curve: 'log', units: 's' },
    { id: 'material', label: 'Material', defaultValue: 0.55, min: 0, max: 1, curve: 'linear' },
    { id: 'pickPos', label: 'Pick Pos', defaultValue: 0.17, min: 0.02, max: 0.5, curve: 'linear' },
    { id: 'stiffness', label: 'Stiff', defaultValue: 0.06, min: 0, max: 1, curve: 'linear' },
    { id: 'pickTone', label: 'Pick Tone', defaultValue: 0.6, min: 0, max: 1, curve: 'linear' },
    { id: 'pickGrain', label: 'Pick Grain', defaultValue: 1, min: 0.1, max: 4, curve: 'log' },
    { id: 'attack', label: 'Attack', defaultValue: 0.003, min: 0.0005, max: 5, curve: 'log', units: 's' },
    { id: 'envDecay', label: 'Decay', defaultValue: 0.12, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sustain', label: 'Sustain', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'release', label: 'Release', defaultValue: 0.35, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'muteDepth', label: 'Mute', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'strumSpread', label: 'Strum', defaultValue: 0.28, min: 0, max: 1, curve: 'linear' },
    { id: 'strumDir', label: 'Dir', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    { id: 'spread', label: 'Spread', defaultValue: 0.25, min: 0, max: 1, curve: 'linear' },
    { id: 'body', label: 'Body', defaultValue: 0.35, min: 0, max: 1, curve: 'linear' },
    { id: 'level', label: 'Level', defaultValue: 0, min: -24, max: 12, curve: 'linear', units: 'dB' },
    { id: 'tuning', label: 'Tuning', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    { id: 'quality', label: 'Chord', defaultValue: 0, min: 0, max: 7, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A six-string plucked instrument — six of our KARPLUS extended-Karplus-Strong string voices side by side, each behind its own amplitude envelope, summed to one mono output through a small resonant BODY. Play it three ways: STRUM it by hand (six trigger inputs, normalled so patching only #1 barres all six — a single clock or gate strums the whole chord), play it polyphonically from a keyboard or sequencer (the POLY input maps up to six held notes to the six strings), or feed a single root pitch to the CHORD input and SIX STRUM voices the corresponding guitar chord across the strings (root → nearest chord-tone at or above each open string, a real fretboard shape). Six MUTE gates model a finger laid loosely on a string: while a mute gate is high that string goes dead and unpitched, like a palm mute — mute one string, or gate all six to choke the whole chord. It is deliberately a MONO-out device (a guitar amp out), with no per-voice controls beyond the shared panel. GUITAR, BASS and HARP are not magic presets — they are three knob states of the SAME engine: switch TUNING (the open-string set), set REGISTER (octave), RING (string sustain, calibrated to real plucked-string decay research — guitar ~2.5 s, bass long and dark, harp very long), MATERIAL (nylon↔steel), PICK POS / PICK TONE / PICK GRAIN (where and how hard it's plucked), and STRUM (roll speed) + DIR (down/up/alternate). SPREAD detunes and decorrelates the six strings for a fuller chorus; BODY adds the instrument's box resonance; the per-string ADSR (fast ATTACK, SUSTAIN held so the string's own ring is the sustain, RELEASE on note-off/mute) shapes the pluck. ACCENT gives per-hit dynamics.",
    inputs: {
      poly:
        "POLY note source (the 16-lane polyPitchGate cable): lanes 1–6 drive strings 1–6 — each lane's pitch tunes its string and each note-on plucks it, note-off releases the amp envelope. Wire MIDI LANE (poly mode) or a poly sequencer here to play SIX STRUM from a keyboard as a 6-voice instrument. When POLY is patched it takes over pitch + plucking; the STRUM/CHORD paths stand down.",
      chord:
        "CHORD root — a mono 1 V/oct pitch CV that picks WHICH chord (the root's pitch-class); SIX STRUM voices it across the six strings as a real guitar shape (each string plays the lowest chord-tone at or above its open pitch), using the CHORD-quality selector for major/minor/7th/etc. The octave comes from REGISTER + TUNING, so a rising CV line transposes the chord by root. Unpatched, the strings ring their open tuning. Strum the result with the STRUM inputs.",
      strum1:
        "STRUM string 1 (a TRIGGER — one pluck per rising edge). The six STRUM inputs are NORMALLED low→high: an unpatched string follows the nearest patched strum at or below it, so patching ONLY strum 1 barres the whole chord (one trigger strums all six, staggered by STRUM SPREAD / DIR). Patch strum 1 and strum 4 to strum two independent groups. Also fired by the on-card STRUM button.",
      strum2: "STRUM string 2 (trigger). Unpatched, it follows strum 1 (see strum1 — normalled low→high).",
      strum3: "STRUM string 3 (trigger). Unpatched, it follows the nearest patched strum below it (see strum1).",
      strum4: "STRUM string 4 (trigger). Patch it to lead strings 4–6 as a separate strum group; unpatched it follows strum 1–3 (see strum1).",
      strum5: "STRUM string 5 (trigger). Unpatched, it follows the nearest patched strum below it (see strum1).",
      strum6: "STRUM string 6 (trigger — the highest string). Unpatched, it follows the nearest patched strum below it (see strum1).",
      mute1:
        "MUTE string 1 (a GATE — level-sensitive). While high it lays a finger loosely on string 1: the ring collapses to a dead, dark, almost-unpitched palm-mute thunk (MUTE depth sets how dead), and the falling edge frees the string to ring again. Gate all six MUTE inputs to choke the whole chord.",
      mute2: "MUTE string 2 (gate). Palm-mutes string 2 while held (see mute1).",
      mute3: "MUTE string 3 (gate). Palm-mutes string 3 while held (see mute1).",
      mute4: "MUTE string 4 (gate). Palm-mutes string 4 while held (see mute1).",
      mute5: "MUTE string 5 (gate). Palm-mutes string 5 while held (see mute1).",
      mute6: "MUTE string 6 (gate). Palm-mutes string 6 while held (see mute1).",
      accent:
        "ACCENT — per-hit velocity CV (0..1) shared by all strings, sampled at each pluck: accented strikes are louder AND brighter (harder pick). Unpatched it sits at a musical default, so strings sound normal without it; wire an accent lane or an envelope for dynamics.",
    },
    outputs: {
      out:
        "The mono instrument output — all six strings summed, active-voice normalized (no chord pumping), through the BODY resonance and LEVEL. Feed a mixer, amp sim, or reverb; it's a full guitar/bass/harp voice on one cable.",
    },
    controls: {
      register:
        "REGISTER — global transpose in semitones (−24..+24). Shifts every string together; the single knob that moves the same chord between bass, guitar and harp octaves on top of the TUNING set.",
      ring:
        "RING — how long an open, un-muted string sustains (0.1–10 s to −60 dB, log), frequency-compensated so the seconds read true at every pitch. Short = staccato/muted; long = open ringing. Calibrated to real plucked-string decay: ~2.5 s guitar, ~6 s dark bass, ~9 s blooming harp.",
      material:
        "MATERIAL — the string material / loop damping (0 = felt-muted nylon, dark, upper partials die fast; 1 = ringing steel/glass). Pitch-tracking, so it means the same on every string. The primary bright↔dark voice.",
      pickPos:
        "PICK POS — where along the string it's plucked (0.02 bridge-thin/bright … 0.5 hollow dead-centre, even harmonics cancelled). 0.12–0.25 is the natural guitar/harp zone.",
      stiffness:
        "STIFF — string stiffness / inharmonicity (0 = perfectly harmonic; up stretches the upper partials sharp toward thick wound strings, piano wire and bell/metal). A little adds body to a bass string; a lot rings metallic.",
      pickTone:
        "PICK TONE — how hard the plucking agent is (0 = soft thumb/felt, dark onset; 1 = hard pick/fingernail, bright). Shapes the attack transient, not the string itself. ACCENT pushes it up per-hit.",
      pickGrain:
        "PICK GRAIN — the pluck's contact length in string periods (0.1 = near-impulse nail tick; 1 = a classic pluck; 4 = a scraped/bowed noisy onset). Energy-normalized, so loudness stays even; measured in periods so the attack is consistent across the range.",
      attack:
        "ATTACK — the per-string amplitude envelope attack (0.5 ms..5 s, log). Near-zero = an instant pluck; raise it for a bowed/harp swell in. Overlapping strums retrigger click-free.",
      envDecay:
        "DECAY — the amplitude-envelope decay toward SUSTAIN (1 ms..5 s, log). With SUSTAIN at 1 the string's own ring is the real envelope, so this mostly softens the attack shoulder; lower SUSTAIN to make it bite.",
      sustain:
        "SUSTAIN — the held amplitude level after the attack (0..1, default 1). At 1 the string rings on its own physical decay (the RING knob); below 1 the note sits quieter under the ring, toward a plucked-then-ducked shape.",
      release:
        "RELEASE — how fast a string's amplitude fades on note-off or MUTE (1 ms..5 s, log). Short = tight étouffé/choke; long = let-ring past the note-off.",
      muteDepth:
        "MUTE — how DEAD the MUTE gates make a string (0 = a light étouffé over the string's own damp; 1 = a fully choked, unpitched thunk). Sets the character of the 'finger loosely on the string' sound.",
      strumSpread:
        "STRUM — how rolled a strummed chord is: 0 = all six strings hit together (a block chord); up to a slow rolled strum / harp gliss (~45 ms across the strings). Applies to the STRUM trigger inputs; DIR sets the direction.",
      strumDir:
        "DIR — strum direction: 0 DOWN (low string first), 1 UP (high string first), 2 ALTERNATE (flips each successive strum, like real up/down picking). Only reorders the STRUM stagger.",
      spread:
        "SPREAD — string-to-string richness (0..1): a small symmetric detune across the six voices plus their (always-distinct) excitation seeds, so a barre chord sounds full and chorused instead of phase-combed. 0 = tight/unison-ish, up = wider chorus.",
      body:
        "BODY — the instrument's box resonance (0 = dry/off, an identity passthrough; 1 = full resonant body). Two body-tuned resonances follow the TUNING (guitar box / bass cabinet / harp soundboard), adding the acoustic 'air' the bare string lacks.",
      level:
        "LEVEL — output gain in dB (−24..+12). The instrument is amplitude-bounded by its own string physics and active-voice normalization; use LEVEL to sit it in the mix.",
      tuning:
        "TUNING — the open-string set, a discrete selector: 0 GUITAR (EADGBE), 1 BASS (a low six-string set), 2 HARP (a diatonic run). This is the main lever that turns the SAME engine into a guitar, a bass or a harp; it also picks the BODY character and the pitches a bare strum rings.",
      quality:
        "CHORD — the chord quality the CHORD input's root is voiced into, a discrete selector: 0 maj, 1 min, 2 dom7, 3 maj7, 4 min7, 5 sus4, 6 power(5), 7 octaves. Pure voicing — it sets which chord tones the six strings take, not the tone.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 15 audio-rate node inputs (poly, chord, 6 strum, 6 mute, accent), one mono
    // output. NO silence keep-alives on the inputs — SIX STRUM detects an
    // unpatched input by its zero-length channel array (that's how strum
    // normalling and poly/chord presence work). channelCountMode defaults to
    // 'max' so the poly input accepts the 32-channel cable.
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 15,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Manual STRUM (the on-card audition button): a ConstantSource summed into
    // STRUM #1 (input 2). It also (a) keeps the worklet processing when nothing
    // else is patched, and (b) is the barre default — an unpatched string
    // normals to strum #1. Fired through the SHARED gate-trigger waveform.
    const strumCs = ctx.createConstantSource();
    strumCs.offset.value = 0;
    strumCs.start();
    strumCs.connect(worklet, 0, 2);

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of sixstrumDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputs = new Map<string, { node: AudioNode; input: number }>([
      ['poly', { node: worklet, input: 0 }],
      ['chord', { node: worklet, input: 1 }],
      ['accent', { node: worklet, input: 14 }],
    ]);
    for (let i = 0; i < STRINGS; i++) {
      inputs.set(`strum${i + 1}`, { node: worklet, input: 2 + i });
      inputs.set(`mute${i + 1}`, { node: worklet, input: 8 + i });
    }

    return {
      domain: 'audio',
      inputs,
      outputs: new Map([['out', { node: worklet, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      // On-card STRUM audition — fires one canonical trigger pulse at strum #1,
      // which barres all six strings (same effect as a strum1 rising edge).
      read(key: string): unknown {
        if (key === 'manualTrigger') {
          return () => {
            try { fireTrigger(strumCs, ctx.currentTime); } catch { /* */ }
          };
        }
        return undefined;
      },
      dispose() {
        try { strumCs.stop(); } catch { /* already stopped */ }
        try { strumCs.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
