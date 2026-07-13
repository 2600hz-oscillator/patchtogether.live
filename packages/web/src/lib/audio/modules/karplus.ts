// packages/web/src/lib/audio/modules/karplus.ts
//
// KARPLUS — an extended Karplus-Strong string / percussive-harp VOICE, built
// on the COFEFVE DELAY fundamentals (owner directive): the string loop is
// cofefve's own DelayChannel (packages/dsp/src/lib/analog-delay-core.ts —
// fractional ring buffer + Catmull-Rom cubic read + eased read pointer),
// imported by the pure core (packages/dsp/src/lib/karplus-dsp.ts) rather
// than re-implemented.
//
// The control set is CURATED from the literature and hardware lineage
// (Karplus & Strong 1983; Jaffe–Smith 1983 CMJ extensions; CCRMA EKS;
// Mutable Instruments Rings/Elements vocabulary): a strike excites a
// recirculating delay-line "string"; six voice knobs pick the string and
// how it's struck —
//   DECAY  — t60 in SECONDS, frequency-compensated (ρ = 0.001^(1/(f0·t60)))
//            so low notes don't ring 10× longer than high ones.
//   BRIGHT — loop damping low-pass whose cutoff TRACKS the note (the Rings
//            damping vocabulary): nylon/felt ↔ steel/glass at any pitch.
//   POS    — pick-position feedforward comb (β of the period): bridge-thin
//            ↔ hollow mid-pluck (β = 0.5 cancels even harmonics).
//   STIFF  — dispersion allpasses stretch upper partials sharp: piano-ish
//            stiffness into detuned bell/metallic.
//   COLOR  — exciter burst low-pass, 200 Hz felt mallet → 10 kHz hard pick.
//   BURST  — exciter length in PERIODS of the note: 0.1 = percussive tick /
//            mallet, 1 = classic K-S pluck, 4 = scraped/bowed attack.
//
// Trigger/gate semantics (declared, per CLAUDE.md):
//   trigger_in edge:'trigger' — ONE pluck per rising edge (burst reseeded,
//     accent latched). Per-sample edge-detect in the worklet.
//   damp_in edge:'gate' — level-sensitive palm mute: chokes the ring WHILE
//     high, releases on the falling edge (both-edge behavior).
//
// 1 V/oct: f0 = TUNE × 2^V. Fractional-delay tuning is compensated for every
// loop stage's exact phase delay at f0 — unit-gated at < 3 cents across
// C2–C7 (measured ≤ 0.1 cents) — so melodic sequences track for real.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { fireTrigger } from '$lib/audio/gate-trigger';
import workletUrl from '@patchtogether.live/dsp/dist/karplus.js?url';

const PROCESSOR_NAME = 'karplus';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const karplusDef: AudioModuleDef = {
  type: 'karplus',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'karplus',
  category: 'sources',

  inputs: [
    // The STRIKE: one pluck per rising edge; accent is read from accent_in
    // at that exact edge (per-hit latch), so the two ports work as a pair.
    { id: 'trigger_in', type: 'gate', edge: 'trigger' },
    // 1 V/oct — transposes the whole voice as a frequency multiplier.
    { id: 'pitch',      type: 'pitch' },
    { id: 'accent_in',  type: 'cv' },
    // Level-sensitive palm mute (string damp / harp étouffé).
    { id: 'damp_in',    type: 'gate', edge: 'gate' },
    // Per-param CV for the curated voice controls (cofefve convention).
    { id: 'decay_cv',    type: 'cv', paramTarget: 'decay',      cvScale: { mode: 'log' } },
    { id: 'bright_cv',   type: 'cv', paramTarget: 'brightness', cvScale: { mode: 'linear' } },
    { id: 'position_cv', type: 'cv', paramTarget: 'position',   cvScale: { mode: 'linear' } },
    { id: 'stiff_cv',    type: 'cv', paramTarget: 'stiffness',  cvScale: { mode: 'linear' } },
    { id: 'color_cv',    type: 'cv', paramTarget: 'color',      cvScale: { mode: 'linear' } },
    { id: 'tune_cv',     type: 'cv', paramTarget: 'tune',       cvScale: { mode: 'log' } },
    { id: 'burst_cv',    type: 'cv', paramTarget: 'burst',      cvScale: { mode: 'log' } },
    { id: 'level_cv',    type: 'cv', paramTarget: 'level',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],
  params: [
    { id: 'tune',       label: 'Tune',   defaultValue: 220, min: 55,   max: 1760, curve: 'log',    units: 'Hz' },
    { id: 'decay',      label: 'Decay',  defaultValue: 2,   min: 0.1,  max: 10,   curve: 'log',    units: 's' },
    { id: 'brightness', label: 'Bright', defaultValue: 0.7, min: 0,    max: 1,    curve: 'linear' },
    { id: 'position',   label: 'Pos',    defaultValue: 0.2, min: 0.02, max: 0.5,  curve: 'linear' },
    { id: 'stiffness',  label: 'Stiff',  defaultValue: 0,   min: 0,    max: 1,    curve: 'linear' },
    { id: 'color',      label: 'Color',  defaultValue: 0.6, min: 0,    max: 1,    curve: 'linear' },
    { id: 'burst',      label: 'Burst',  defaultValue: 1,   min: 0.1,  max: 4,    curve: 'log' },
    { id: 'level',      label: 'Level',  defaultValue: 0,   min: -24,  max: 12,   curve: 'linear', units: 'dB' },
  ],

  docs: {
    explanation:
      "A plucked/struck STRING voice — the extended Karplus-Strong algorithm, physical-modeling's original trick: instead of an oscillator plus filter, a short burst of noise is fired into a recirculating delay-line 'string' and everything you hear is that burst ringing around the loop, decaying naturally like a real vibrating string. KARPLUS builds the loop on the COFEFVE DELAY's own fractional delay-line core and extends it the Jaffe–Smith/CCRMA way: the loop delay is tuned with sub-sample precision (1 V/oct tracks under 3 cents across five-plus octaves, so melodies are actually in tune — a rounded delay would be audibly sour above C5), the per-period loop loss is frequency-COMPENSATED so the DECAY knob reads in real seconds at every pitch (classic K-S low notes drone for tens of seconds while high notes choke in milliseconds — fixed here), and a set of in-loop filters give the string its character. Six voice knobs span 'wide variety of string and impact sounds': BRIGHT is the string material (felt-damped nylon to ringing steel — a damping low-pass whose cutoff tracks the note), POS is where you pluck it (a comb filter: mid-string hollow to bridge-bright), STIFF bends the partials sharp toward piano wire, bells and gongs (dispersion allpasses), and COLOR + BURST shape the EXCITER itself — from a soft dark mallet thump (short, low-passed) through a classic pluck (one period of noise) to a scraped/bowed attack (several periods of bright noise). Strike it from any trigger source; ACCENT gives per-hit velocity (louder + brighter), DAMP is a palm mute while held, and five voice knobs have CV inputs for full modulation. Runs as a single mono voice — patch several for chords, or clock it fast for harp arpeggios.",
    inputs: {
      trigger_in:
        "The STRIKE/pluck: each rising edge fires one excitation burst into the string — the burst noise is re-seeded (every hit is deterministic) and the accent input is sampled at that instant. How long the signal stays high doesn't matter; it's a trigger, not a hold. A still-ringing string is re-plucked on top of its ring-over, like a real string. Patch a sequencer gate, clock or drum-seq lane here.",
      pitch:
        "1 V/oct pitch input: transposes the whole voice as a true frequency multiplier (f0 = Tune × 2^volts). Tuning is compensated to sub-cent accuracy across the range, so melodic sequences from a quantizer/sequencer play in tune. The new pitch glides in over ~10 ms (the cofefve read-pointer ease) — retunes slide instead of clicking.",
      accent_in:
        "Per-hit velocity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO or sequencer accent lane gives each pluck its own dynamics. Accented hits are louder AND brighter (the exciter color is pushed up ~25%), like plucking harder.",
      damp_in:
        "Palm-mute gate (level-sensitive): WHILE the level is high the string's decay collapses to ~50 ms — the ring chokes like a muted harp string — and on the falling edge the mute releases so the next strike rings freely again. Both edges matter; hold it to keep the string dead, pulse it to clip tails.",
      decay_cv:
        "CV modulation of DECAY (log-scaled): sweeps the ring-out time around the knob. Sequence it to alternate staccato plinks and long ringing notes.",
      bright_cv:
        "CV modulation of BRIGHT (linear): moves the string material live between felt-damped-dark and steel-bright. An envelope here mimics a string that darkens as it fades.",
      position_cv:
        "CV modulation of POS (linear): moves the virtual pluck point along the string per-hit or continuously — comb-filter animation like a guitarist drifting from bridge to neck.",
      stiff_cv:
        "CV modulation of STIFF (linear): morphs the harmonic series from a true string toward inharmonic bell/metal live. Great per-step for alternating string and chime timbres.",
      color_cv:
        "CV modulation of COLOR (linear): changes the exciter's tone for hits that follow — soft mallet strikes to hard bright picks under sequencer control. (It shapes the burst, so it's heard on the NEXT strike.)",
      tune_cv:
        "CV modulation of TUNE (log-scaled): ±1 sweeps the string's base pitch across its full 55–1760 Hz range, centred on the knob — an LFO gives vibrato, a sequencer plays melodic runs. Distinct from the 1 V/oct pitch input; the loop retunes with the ~10 ms cofefve glide.",
      burst_cv:
        "CV modulation of BURST (log-scaled): ±1 moves the exciter length across its full 0.1–4 period span around the knob, morphing the attack from percussive tick to scraped/bowed. It shapes the burst, so it's heard on the NEXT strike.",
      level_cv:
        "CV modulation of LEVEL (linear): ±1 sweeps the output gain across its full −24..+12 dB range around the knob — an envelope or LFO here gives the voice tremolo or dynamic swells.",
    },
    outputs: {
      out:
        "The string itself — the mono voice output (the delay-line tap, the brightest point of the loop), scaled by LEVEL. DC-free and stability-bounded by construction; feed it to a VCA/mixer, or straight to an output — the voice's own envelope IS the string decay, no ADSR needed.",
    },
    controls: {
      tune:
        "TUNE — the string's base pitch (55–1760 Hz, log; default 220 = A3). The pitch input transposes around it at 1 V/oct. Together they cover the full musical range 30 Hz–4.2 kHz (clamped).",
      decay:
        "DECAY — ring-out time to −60 dB in SECONDS (0.1–10, log), frequency-compensated (the Jaffe–Smith ρ law): 2 s means 2 s at C2 AND at C6. Short = plucked staccato/koto; long = open piano strings. (At the extreme dark-plus-high-pitch corner the string physically can't ring that long — it decays early, like a muted string.) The DAMP gate temporarily overrides this to ~50 ms.",
      brightness:
        "BRIGHT — the string material: an in-loop damping low-pass whose cutoff TRACKS the note (≈1.4×f0 dark … ≈90×f0 open), so the knob means the same thing at every pitch. 0 = felt-muted nylon (upper partials die almost immediately), 1 = ringing steel/glass (near-lossless top). The fundamental's decay stays on the DECAY knob — brightness shapes how the TONE fades, compensated so it never detunes or shortens the note itself.",
      position:
        "POS — pick position β along the string (0.02–0.5): a feedforward comb on the exciter. 0.5 = plucked dead-center: even harmonics cancel for a hollow, clarinet-ish pluck; small values = plucked at the bridge: thin, bright, all harmonics. 0.12–0.25 is the natural guitar/harp zone.",
      stiffness:
        "STIFF — string stiffness/inharmonicity (0–1): dispersion allpasses in the loop make upper partials run ahead of the fundamental, stretching them SHARP like real piano wire — and past it. 0 = perfectly harmonic string; small amounts = piano realism; high values = detuned metallic clang/bell (most audible on higher notes, where dispersion is physically strongest). The fundamental stays in tune — the tuning compensation accounts for the allpasses exactly.",
      color:
        "COLOR — the exciter's tone: a low-pass on the noise burst sweeping 200 Hz → 10 kHz (0 = soft felt mallet / thumb, 1 = hard pick / metal tine). Dark bursts also excite the string's lower modes more — the whole note sounds rounder, not just the attack. Accent pushes color up per-hit.",
      burst:
        "BURST — exciter length in PERIODS of the note (0.1–4, log). 0.1 = a near-impulse tick (percussive harp/marimba attack), 1 = the classic Karplus-Strong pluck (fills the string exactly once), 4 = a noisy scraped/bowed onset. Energy-normalized so short ticks and long scrapes land at comparable loudness. Because it's measured in periods, the attack character is consistent across the keyboard.",
      level:
        "LEVEL — output gain in dB (−24..+12, default 0). The voice is amplitude-bounded by its own string physics; use LEVEL to sit it in the mix or drive a downstream stage.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 4 audio-rate node inputs: trigger (0), pitch (1), accent (2), damp (3).
    // One mono output.
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

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

    // Manual STRIKE (the on-card audition button): a dedicated
    // ConstantSource summed into the trigger input, fired through the
    // SHARED $lib/audio/gate-trigger waveform (never re-derived). Works
    // whether or not a cable is patched into trigger_in — Web Audio sums
    // the connections, and the worklet edge-detects the crossing.
    const strikeCs = ctx.createConstantSource();
    strikeCs.offset.value = 0;
    strikeCs.start();
    strikeCs.connect(worklet, 0, 0);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of karplusDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['trigger_in',  { node: worklet, input: 0 }],
        ['pitch',       { node: worklet, input: 1 }],
        ['accent_in',   { node: worklet, input: 2 }],
        ['damp_in',     { node: worklet, input: 3 }],
        // Per-param CV → AudioParam routing (the cofefve convention).
        ['decay_cv',    { node: worklet, input: 0, param: params.get('decay')! }],
        ['bright_cv',   { node: worklet, input: 0, param: params.get('brightness')! }],
        ['position_cv', { node: worklet, input: 0, param: params.get('position')! }],
        ['stiff_cv',    { node: worklet, input: 0, param: params.get('stiffness')! }],
        ['color_cv',    { node: worklet, input: 0, param: params.get('color')! }],
        ['tune_cv',     { node: worklet, input: 0, param: params.get('tune')! }],
        ['burst_cv',    { node: worklet, input: 0, param: params.get('burst')! }],
        ['level_cv',    { node: worklet, input: 0, param: params.get('level')! }],
      ]),
      outputs: new Map([
        ['out', { node: worklet, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      // Manual STRIKE (the on-card audition button): the samsloop
      // manualTrigger read-key seam — returns a function that fires one
      // canonical trigger pulse at the worklet, the same effect as a
      // trigger_in rising edge.
      read(key: string): unknown {
        if (key === 'manualTrigger') {
          return () => {
            try { fireTrigger(strikeCs, ctx.currentTime); } catch { /* */ }
          };
        }
        return undefined;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { strikeCs.stop(); } catch { /* */ }
        try { strikeCs.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
