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
//   {tone,grain,spread,body,strum,dir,chord}_cv — per-knob CV modulators
//     (Pattern A: paramTarget + cvScale onto the AudioParam; dir/chord are
//     DISCRETE selectors, so their CV quantizes to the index range).
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
    // Per-knob CV modulators (def-only "cofefve/karplus" Pattern A): a `cv`
    // PortDef with paramTarget + cvScale + an inputsMap `param` entry routes
    // onto the existing AudioParam. The engine's generic getCvScaleForTarget/
    // attachCvScale interposes a WaveShaper centred on the LIVE knob so ±1
    // sweeps the param's full natural range; the scaled delta sums into the
    // AudioParam at audio rate (TRANSIENT render state — never the Y.Doc). No
    // DSP/worklet edits (numberOfInputs stays 15), so no ART re-pin.
    { id: 'tone_cv',   type: 'cv', paramTarget: 'pickTone',    cvScale: { mode: 'linear' } },
    { id: 'grain_cv',  type: 'cv', paramTarget: 'pickGrain',   cvScale: { mode: 'log' } },
    { id: 'spread_cv', type: 'cv', paramTarget: 'spread',      cvScale: { mode: 'linear' } },
    { id: 'body_cv',   type: 'cv', paramTarget: 'body',        cvScale: { mode: 'linear' } },
    { id: 'strum_cv',  type: 'cv', paramTarget: 'strumSpread', cvScale: { mode: 'linear' } },
    // DISCRETE selectors: cvScale 'discrete' buckets a −1..+1 CV across the
    // integer index range (round to the exact selector index) — DIR 0..2,
    // CHORD 0..7 — the same quantizer TIDYVCO's oct2 CV uses.
    { id: 'dir_cv',    type: 'cv', paramTarget: 'strumDir',    cvScale: { mode: 'discrete' } },
    { id: 'chord_cv',  type: 'cv', paramTarget: 'quality',     cvScale: { mode: 'discrete' } },
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

  // ── FACE — RACKLINE UI curation (P1 batch-2 TOTAL REWORK; UI metadata, NOT
  // the I/O contract — see ModuleFace in $lib/graph/types). Designed from the
  // instrument's INTENT, not transcribed from the legacy two-band card: SIX
  // STRUM is PLAYED, so the ranking is what a player's hands ride, in order.
  //   mini    (1 cell + glyph) strumSpread — the namesake gesture: 0 = a block
  //             chord, up = a rolled strum / harp gliss across the six strings.
  //   compact (2 cells + glyph) + ring — the string's OWN sustain, the
  //             let-ring ↔ staccato lever you reach for second.
  //   full-in-lane (the 6-cell plate) + material (nylon ↔ steel — the primary
  //             bright↔dark voice), pickTone (soft thumb ↔ hard pick),
  //             muteDepth (how dead the MUTE gates go) and register (the
  //             octave that places the instrument): strum · damp · pluck ·
  //             pitch, the four things a player actually works.
  //   ranks 7–9 the PRESET recall + strumDir + tuning — the controls you SET
  //             rather than ride (they only reach the dock, where a discrete
  //             cell can show its step; a name readout for the two discrete
  //             params is a shell follow-up). PRESET leads them: it is the
  //             "make it a guitar / bass / harp" lever — one pick stamps the
  //             whole calibrated knob state — where `tuning` below it only
  //             swaps the string set. It is deliberately NOT in the hero
  //             ladder: the plate is what a player's HANDS ride, and a preset
  //             is chosen once, then edited.
  // The dock tail then runs page by page in faceplate reading order, so the
  // flat roster still reads as the instrument: hand → string → pick → tuning →
  // envelope → body/out. Pages are the player's sections (lowercase labels),
  // NOT the legacy card's two space-driven bands.
  // glyph 'scope': SIX STRUM is GATE-STRUCK, so the honest live view is the
  // analyser trace on OUT — a plucked attack with the string's exponential
  // decay (the kickdrum precedent), never a static oscillator cycle. It has no
  // assigned-shape morph, so the tidyVco DUAL binding does not apply.
  face: {
    order: [
      // the hero ladder (mini = 1 / compact = 2 / full-in-lane plate = 6)
      'strumSpread',
      'ring',
      'material',
      'pickTone',
      'muteDepth',
      'register',
      // ranks 7–9: the set-it controls (dock-only past the lane's 6-cell plate)
      'sixstrum-preset-{n}',
      'strumDir',
      'tuning',
      // dock tail — page order, so the roster reads as the instrument
      'stiffness',
      'spread',
      'pickGrain',
      'pickPos',
      'quality',
      'attack',
      'envDecay',
      'sustain',
      'release',
      'body',
      'level',
    ],
    pages: [
      // the strumming hand: how the chord is rolled, which way, how hard the
      // MUTE gates damp.
      { id: 'strum', label: 'strum · damp', controls: ['strumSpread', 'strumDir', 'muteDepth'] },
      // the six strings themselves (ring/brightness/inharmonicity + the
      // string-to-string detune that makes a barre chord sound like six).
      { id: 'string', label: 'string', controls: ['ring', 'material', 'stiffness', 'spread'] },
      // the plucking agent: how hard, how long, where along the string.
      { id: 'pick', label: 'pick', controls: ['pickTone', 'pickGrain', 'pickPos'] },
      // what the strings are tuned to and what chord they voice. PRESET leads
      // the page: it is the whole-instrument recall, and TUNING sits right
      // under it as the one value of that preset you can still swap alone.
      { id: 'tuning', label: 'tuning · chord', controls: ['sixstrum-preset-{n}', 'tuning', 'register', 'quality'] },
      { id: 'envelope', label: 'envelope', controls: ['attack', 'envDecay', 'sustain', 'release'] },
      { id: 'output', label: 'body · out', controls: ['body', 'level'] },
    ],
    glyph: 'scope',
    // REAR CARD curation (rear-card-model). Derivation alone would drop all 15
    // non-CV inputs into ONE flat 'voice' band; this instrument's rear IS its
    // per-string field, so the leading band is curated into "how you play it"
    // (the three global note sources) + two function-named sub-header clusters
    // for the twelve PER-STRING jacks — strum triggers (normalled 1→all) and
    // mute gates, the per-string vs global split. The seven per-knob CVs need
    // no curation: each one's paramTarget lands it under its face page (TONE +
    // GRAIN under 'pick', SPREAD under 'string', STRUM + DIR under 'strum',
    // CHORD-quality under 'tuning · chord', BODY under 'body · out') — note the
    // 'play' band's CHORD is the 1 V/oct ROOT, the 'tuning · chord' band's is
    // the chord-QUALITY CV.
    // audioRate: the worklet reads poly, the six strums, the six mutes and
    // accent PER SAMPLE (sample-accurate strike edges + a per-hit accent
    // latch); the CHORD root is read once per block and the seven knob CVs
    // land on k-rate AudioParams, so neither takes the `~` tick.
    rear: {
      groups: [{ id: 'voice', label: 'play', ports: ['poly', 'chord', 'accent'] }],
      clusters: [
        {
          group: 'voice',
          label: 'strum triggers · #1 normals to all',
          ports: ['strum1', 'strum2', 'strum3', 'strum4', 'strum5', 'strum6'],
        },
        {
          group: 'voice',
          label: 'mute gates · one per string',
          ports: ['mute1', 'mute2', 'mute3', 'mute4', 'mute5', 'mute6'],
        },
      ],
      audioRate: [
        'poly',
        'strum1', 'strum2', 'strum3', 'strum4', 'strum5', 'strum6',
        'mute1', 'mute2', 'mute3', 'mute4', 'mute5', 'mute6',
        'accent',
      ],
    },
  },

  docs: {
    explanation:
      "A six-string plucked instrument: SIX of our KARPLUS extended-Karplus-Strong string voices side by side — each with its own amplitude ADSR and its own excitation seed, so a simultaneous barre decorrelates instead of phase-combing — summed to ONE mono output, the sum scaled by 1/√(sounding strings) so a six-string chord doesn't pump against a single note, then LEVEL, then a small resonant BODY across the finished mix. Play it three ways. STRUM it by hand: six TRIGGER inputs, NORMALLED low→high, so patching only #1 barres all six (one clock strums the whole chord, staggered by STRUM and DIR). Play it POLYPHONICALLY: the POLY input's first six lanes drive strings 1–6, each lane's 1 V/oct pitch tuning its string and each note-on plucking it. Or feed one root into CHORD and SIX STRUM voices that chord across the strings as a real fretboard shape — every string takes the LOWEST chord tone at or above its own open pitch. Six MUTE gates are a finger laid loosely on a string: while a gate is high that string's ring collapses to a ~50 ms thud and the MUTE knob chokes its level on top; hold all six to choke the chord. It is deliberately a MONO-out instrument (a guitar-amp out) with one shared panel — no per-voice knobs. GUITAR, BASS and HARP are not hidden DSP branches: TUNING picks which open-string set (and which body resonances) the SAME engine uses — E A D G B E, a low six-string B E A D G C, or a C-major C D E G A C harp run — and everything else is knob state: REGISTER (transpose), RING (how long a string sustains), MATERIAL (nylon↔steel), STIFF (inharmonicity), PICK POS / TONE / GRAIN (where and how it is plucked), STRUM + DIR (how rolled the strum is, and from which end), SPREAD (string-to-string detune), BODY (box resonance), and the per-string A/D/S/R — fast ATTACK, SUSTAIN at 1.0 so the STRING's own ring is the sustain, RELEASE on note-off or mute. ACCENT is latched at each strike for per-hit dynamics: louder and brighter. The PRESET control is how you get the three modes in one move: it stamps the whole calibrated knob state — TUNING included — onto the panel, where TUNING on its own only switches the string set + body. (On the classic card that recall is the MODE knob.)",
    inputs: {
      poly:
        "POLY note source (the 16-lane polyPitchGate cable): its first six lanes drive strings 1–6 — each lane's pitch tunes its string at 1 V/oct (0 V = C4) and each note-on plucks it, note-off releasing that string's amp envelope. Wire MIDI LANE (poly mode) or a poly sequencer here to play SIX STRUM as a 6-voice instrument. While POLY is patched it OWNS pitch and plucking: the STRUM triggers and the CHORD voicer stand down (the MUTE gates still damp their strings).",
      chord:
        "CHORD root — a mono 1 V/oct pitch CV that picks WHICH chord: only the root's PITCH CLASS is used (its octave is ignored — REGISTER + TUNING own the octave), voiced by the CHORD-quality selector into maj / min / 7th / …. SIX STRUM lays that chord out as a real fretboard shape: each string plays the lowest chord tone at or above its open pitch, so a rising CV line RE-VOICES the chord by root rather than sliding the whole instrument upward. It is sampled once per audio block (a knob-rate root, not an audio-rate one). Unpatched, the strings ring their open tuning; patched, strum the result with the STRUM inputs — or hold notes on POLY, which overrides it.",
      strum1:
        "STRUM string 1 — a TRIGGER: one pluck per rising edge, no matter how long the signal stays high. The six STRUM inputs are NORMALLED low→high: an unpatched string follows the nearest PATCHED strum at or below it, so patching ONLY strum 1 barres the whole chord (one trigger strums all six, staggered by the STRUM roll and DIR); a string with no patched strum at or below it is simply never struck. Patch strum 1 and strum 4 to strum two independent groups. (The classic card's ⟋ STRUM button fires exactly this trigger.)",
      strum2: "STRUM string 2 (a trigger — one pluck per rising edge). Unpatched, it follows strum 1 (see strum1: the six are normalled low→high).",
      strum3: "STRUM string 3 (a trigger — one pluck per rising edge). Unpatched, it follows the nearest patched strum below it (see strum1).",
      strum4: "STRUM string 4 (a trigger — one pluck per rising edge). Patch it to lead strings 4–6 as a second strum group; unpatched it follows the nearest patched strum below it (see strum1).",
      strum5: "STRUM string 5 (a trigger — one pluck per rising edge). Unpatched, it follows the nearest patched strum below it (see strum1).",
      strum6: "STRUM string 6, the highest string (a trigger — one pluck per rising edge). Unpatched, it follows the nearest patched strum below it (see strum1).",
      mute1:
        "MUTE string 1 — a GATE (level-sensitive; both edges matter). WHILE it is high a finger lies on string 1: the string's decay collapses to ~50 ms — a dead palm-mute thud instead of a ring — and the MUTE knob chokes its amplitude on top through a ~8 ms smoother, so it damps without a click. In strum/chord mode the rising edge also releases that string's amp envelope; the falling edge frees the string to ring again. Hold all six MUTE inputs to choke the whole chord.",
      mute2: "MUTE string 2 (a gate). Palm-mutes string 2 while it is held high (see mute1).",
      mute3: "MUTE string 3 (a gate). Palm-mutes string 3 while it is held high (see mute1).",
      mute4: "MUTE string 4 (a gate). Palm-mutes string 4 while it is held high (see mute1).",
      mute5: "MUTE string 5 (a gate). Palm-mutes string 5 while it is held high (see mute1).",
      mute6: "MUTE string 6 (a gate). Palm-mutes string 6 while it is held high (see mute1).",
      accent:
        "ACCENT — ONE per-hit velocity CV (0..1) shared by all six strings, LATCHED at each strike and ignored between hits, so an LFO or accent lane here gives every pluck its own dynamics: an accented hit is louder AND brighter (it pushes the pick's own tone up by a quarter of the accent). Unpatched it sits at a musical 0.6, so the strings sound normal without it.",
      tone_cv:
        "CV modulation of PICK TONE (linear, centred on the LIVE knob): ±1 displaces it by half its 0..1 range in each direction (clamped), sweeping the plucking agent from soft thumb toward hard pick — from a centred knob that is the whole range. Wire an envelope or LFO for a pick that brightens over a phrase. (Distinct from ACCENT, which latches a per-hit velocity; this moves the knob itself, continuously.)",
      grain_cv:
        "CV modulation of PICK GRAIN (log, centred on the knob — it MULTIPLIES rather than adds): ±1 is ×/÷ √(4 / 0.1) ≈ 6.3, enough to reach either end of the 0.1–4 period span from the default 1, morphing the attack from a near-impulse nail tick to a scraped/bowed noisy onset. Log-scaled so the sweep is even in perceived grain.",
      spread_cv:
        "CV modulation of SPREAD (linear): ±1 displaces the string-to-string detune by half its 0..1 range around the knob — from tight/unison toward a wide chorused barre. An LFO here animates the chorus width.",
      body_cv:
        "CV modulation of BODY (linear): ±1 displaces the box-resonance mix by half its 0..1 range around the knob, from dry toward a fully resonant body — a wah-like body swell under an envelope.",
      strum_cv:
        "CV modulation of STRUM (the roll amount, linear): ±1 displaces the strum spread by half its 0..1 range around the knob — from a block chord (all six struck together) toward the full ~45 ms rolled strum / harp gliss. Sequence it to alternate tight and rolled strums; DIR still sets the direction.",
      dir_cv:
        "CV modulation of DIR (DISCRETE): a −1..+1 CV is bucketed across the three strum directions — −1 → 0 DOWN, 0 → 1 UP, +1 → 2 ALTERNATE — so a stepped source flips the strum direction. It only reorders the STRUM stagger; it never plucks anything itself.",
      chord_cv:
        "CV modulation of CHORD quality (DISCRETE): a −1..+1 CV is bucketed across the eight chord qualities (−1 → 0 maj … +1 → 7 octaves, the six in between landing on the steps), so a quantizer or sequencer walks the CHORD input's voicing through maj / min / dom7 / maj7 / min7 / sus4 / power5 / octaves. Pure voicing selection — which chord tones the strings take, not the tone.",
    },
    outputs: {
      out:
        "The mono instrument output. Each string runs its own amp ADSR and mute choke first; the six are then summed, scaled by 1/√(sounding strings) so a six-string barre sits at the same level as a single note, put through LEVEL, and only THEN through the BODY resonance — the box is the last stage, a wet/dry blend of two bandpasses across the whole mix rather than a per-string filter. Feed a mixer, amp sim or reverb: it is a whole guitar / bass / harp voice on one cable.",
    },
    controls: {
      register:
        "REGISTER — global transpose in semitones (−24..+24), added to every string at once. The one knob that moves the same tuning and the same chord between bass, guitar and harp octaves.",
      ring:
        "RING — how long an un-muted string sustains: 0.1–10 s to −60 dB (log), frequency-compensated (Jaffe–Smith) so the seconds read true at every pitch instead of low notes ringing ten times longer than high ones. Short = staccato; long = open ringing; 2.5 s (the default) is guitar-ish, and the classic card's MODE presets park it at 2.5 / 6 / 9 s for guitar / bass / harp. (In the extreme corner — darkest MATERIAL × longest RING × a high note — the loop-gain cap makes the string decay faster than the knob asks: a physically muted string.)",
      material:
        "MATERIAL — the string's loop damping (0 = dark felt/nylon, where even the 2nd partial is heavily damped; 1 = ringing steel/glass). The damping filter's cutoff TRACKS the note (f0 · 2^(0.5 + 5.5 · knob)), so the knob voices the same way on every string. The primary bright↔dark control.",
      pickPos:
        "PICK POS — where along the string it is plucked, as a fraction of the period (0.02 = right at the bridge, thin and bright … 0.5 = hollow dead-centre, where the pick-position comb cancels the even harmonics). 0.12–0.25 is the natural guitar/harp zone.",
      stiffness:
        "STIFF — string stiffness / inharmonicity (0 = perfectly harmonic; turning it up runs two dispersion allpasses that stretch the upper partials sharp — thick wound strings, piano wire, then bell and metal). A little thickens a bass string; a lot rings metallic.",
      pickTone:
        "PICK TONE — how hard the plucking agent is: it sweeps the excitation burst's low-pass from 200 Hz (soft thumb or felt, dark onset) up to 10 kHz (hard pick or fingernail, bright). It shapes the ATTACK transient only, never the string itself. ACCENT pushes it up per hit.",
      pickGrain:
        "PICK GRAIN — the pluck's contact length in PERIODS of the note (0.1 = a near-impulse nail tick, 1 = the classic Karplus-Strong pluck, 4 = a scraped/bowed noisy onset). Measured in periods so the attack reads the same at every pitch, and energy-normalized (∝ 1/√length) so a short tick and a long scrape land at comparable loudness.",
      attack:
        "ATTACK — the per-string amplitude envelope's attack: a linear ramp to full, 0.5 ms..5 s (log). Near-zero is an instant pluck; raise it for a bowed or harp-like swell. Retriggers are CLICK-SAFE — strumming a string that is still sounding ramps from its CURRENT level instead of resetting to zero (which shortens that one attack, never its slope).",
      envDecay:
        "DECAY — the amplitude envelope's exponential fall from the peak toward SUSTAIN (1 ms..5 s, log). At the 1.0 SUSTAIN default there is nothing to fall to, so it does nothing until you lower SUSTAIN — then it sets how fast the note ducks under its own ring.",
      sustain:
        "SUSTAIN — the level the amplitude envelope holds once attack and decay finish (0..1, default 1). At 1 the amp stage is effectively flat and the STRING's own physical decay (RING) is the envelope you hear; below 1 the note ducks to that level and rings on quieter — a plucked-then-ducked shape.",
      release:
        "RELEASE — how fast a string's amplitude fades once it is released: 1 ms..5 s (log), exponential from wherever the level currently is. A POLY note-off releases it, and so does a MUTE gate's rising edge in strum/chord mode. Short = a tight choke; long = let it ring past the note-off.",
      muteDepth:
        "MUTE — how much EXTRA amplitude choke the MUTE gates apply on top of the string damping they already cause (0 = the damped string alone, which still drops to a ~50 ms decay; 1 = choked all the way to silence while the gate is held). It sets how dead the 'finger on the string' reads; the choke follows the gate through a ~8 ms smoother.",
      strumSpread:
        "STRUM — how ROLLED a strummed chord is: 0 strikes all six strings together (a block chord); at 1 the strike walks across the strings over ~45 ms (a rolled strum, or a harp gliss). It applies to the STRUM trigger inputs (and to the card's STRUM button); DIR chooses which end it starts from.",
      strumDir:
        "DIR — strum direction: 0 DOWN (low string first), 1 UP (high string first), 2 ALTERNATE (flips on every successive strum, like real up/down picking). It only reorders the STRUM stagger — with STRUM at 0 all three sound identical.",
      spread:
        "SPREAD — string-to-string richness (0..1): a symmetric detune across the six voices, up to ±14 cents at full, so a barre chord sounds full and chorused instead of phase-combed. (The six excitation seeds are ALWAYS distinct — that decorrelation is free; SPREAD only adds the detune.) 0 = tight and unison-ish, up = a wider chorus.",
      body:
        "BODY — the instrument's box resonance, mixed in after the string sum (0 = dry, an exact passthrough; 1 = all resonance). Two band-pass resonances follow the TUNING — guitar box ≈ 100/215 Hz, bass cabinet ≈ 58/120 Hz, harp soundboard ≈ 175/330 Hz — adding the acoustic air a bare string lacks.",
      level:
        "LEVEL — output gain in dB (−24..+12), applied to the active-voice-normalized string sum just before the BODY mix. The instrument is already amplitude-bounded by its own string physics and that normalization; use LEVEL to sit it in the mix.",
      tuning:
        "TUNING — which open-string set (and which body) the engine uses, a 3-way selector: 0 GUITAR (E2 A2 D3 G3 B3 E4), 1 BASS (a low six-string B0 E1 A1 D2 G2 C3), 2 HARP (a C-major run C3 D3 E3 G3 A3 C4). It sets the pitches a bare strum rings, the shape the CHORD voicer walks, and the BODY resonances. On its own it swaps ONLY that string set + body and leaves every other knob untouched — reach for the PRESET recall above it when you want the whole calibrated guitar / bass / harp knob state, and for this when you want (say) harp strings with the guitar's pick and ring.",
      quality:
        "CHORD — which chord quality the CHORD input's root is voiced into, an 8-way selector: 0 maj, 1 min, 2 dom7, 3 maj7, 4 min7, 5 sus4, 6 power(5), 7 octaves. Pure voicing: it decides which chord tones the six strings take (each takes the lowest one at or above its own open pitch), not the tone. It does nothing while CHORD is unpatched — bare strings ring their open tuning.",
      "sixstrum-preset-{n}":
        "PRESET — the guitar / bass / harp recall, and the one control that makes this the instrument you meant. Picking a mode STAMPS its whole calibrated knob state onto the panel — all fourteen values: tuning, register, ring, material, pickPos, stiffness, pickTone, pickGrain, strumSpread, strumDir, muteDepth, quality, body and spread — so GUITAR lands a ~2.5 s ring on standard tuning at concert pitch, BASS a long dark 6 s ring an octave down with a near-block strum and a power-chord voicing, HARP a 9 s bright ring seven semitones up with a wide upward gliss. Nothing is hidden: these are knob STATES of the same engine, not DSP branches, so every stamped knob stays visible and editable the moment the recall lands — a starting point, never a lock — and each write is a normal param change (undoable, shared with everyone in the rackspace). Distinct from TUNING below it, which alone only switches WHICH open strings and body resonances the engine uses and leaves the rest of the panel exactly where you left it. (On the classic card this same recall is the MODE knob.)",
    },
  },

  // The PRESET RECALL, declared as a one-member control family: it is a real
  // control with no backing ParamDef (its state IS the params it stamps), so
  // this is what lets the face rank it, the docs key prose to it, and the
  // RACKLINE shell paint it as a Selector (shell-cells.ts). testidPrefix is
  // grep-verified against SixstrumCard's MODE cell by the docs gate.
  controlFamilies: [
    { id: 'sixstrum-preset', label: 'Preset — guitar / bass / harp', kind: 'other', testidPrefix: 'sixstrum-preset' },
  ],

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

    const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['poly', { node: worklet, input: 0 }],
      ['chord', { node: worklet, input: 1 }],
      ['accent', { node: worklet, input: 14 }],
      // Per-knob CV → AudioParam routing (Pattern A). The `input` index is a
      // placeholder — the engine connects the (cvScale-scaled) source to
      // `param`, not to a worklet audio input, so numberOfInputs stays 15.
      ['tone_cv',   { node: worklet, input: 0, param: params.get('pickTone')! }],
      ['grain_cv',  { node: worklet, input: 0, param: params.get('pickGrain')! }],
      ['spread_cv', { node: worklet, input: 0, param: params.get('spread')! }],
      ['body_cv',   { node: worklet, input: 0, param: params.get('body')! }],
      ['strum_cv',  { node: worklet, input: 0, param: params.get('strumSpread')! }],
      ['dir_cv',    { node: worklet, input: 0, param: params.get('strumDir')! }],
      ['chord_cv',  { node: worklet, input: 0, param: params.get('quality')! }],
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
