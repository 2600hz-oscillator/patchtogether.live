// packages/web/src/lib/audio/modules/clap.ts
//
// CLAP — analog-modeled handclap voice, the fourth member of the drum
// family (KICK DRUM / SNARE DRUM / TOM DRUM), at deliberately CURATED
// complexity: one synthesis engine, eight voice knobs + level, spanning
// the classic analog clap lineage in one continuous space:
//
//   808-canonical — band-passed noise through the twin-VCA topology: a
//                   3-pulse ~10 ms comparator retrigger burst (the final
//                   discharge rings 2× longer) + the smooth "reverb"
//                   envelope summed in. The shipping default.
//   909-dense     — 4-5 fast bright pulses, white digital-register noise,
//                   burst-forward: PULSES up, SPREAD down, TONE up,
//                   COLOR 0, SNAP up.
//   ClapTrap      — the Simmons 1980 clap box's adjustable spread:
//                   SPREAD long (each pulse its own micro-clap), WIDTH
//                   narrow for the tuned disco slap.
//   LinnDrum-era  — dark roomy sampled-clap read: COLOR up, TAIL long,
//                   SNAP low (room-dominant).
//
// DSP: packages/dsp/src/lib/clap-dsp.ts (seeded noise → COLOR pole →
// Chamberlin band-pass at TONE/WIDTH with 1/√q loudness compensation →
// PULSES×SPREAD retrigger burst VCA + reverb-TAIL VCA fired at the last
// pulse, SNAP equal-power balance, 2×-oversampled warm-tanh DRIVE, DC
// block, true-peak bound). Mono voice, mono output.
//
// Trigger semantics (declared, per CLAUDE.md): trigger_in edge:'trigger' —
// ONE clap per rising edge (burst geometry + accent latched at that
// instant); per-sample edge-detect in the worklet. The card's CLAP pad
// writes the `strike` param (the bluebox press-param pattern) which the
// worklet ORs with trigger_in.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/clap.js?url';

const PROCESSOR_NAME = 'clap';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const clapDef: AudioModuleDef = {
  type: 'clap',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'clap',
  category: 'sources',
  // Measured card box ≈ 200×460 px → 2u tall × 3 tiles wide (rack-sizes
  // rule: new modules declare size/hp on the def).
  size: '2u',
  hp: 3,

  inputs: [
    // The STRIKE: one clap per rising edge. Accent is read from accent_in
    // at that exact edge (per-hit latch), and the burst geometry (pulse
    // count + spacing incl. spread_cv) latches at the same instant.
    { id: 'trigger_in', type: 'gate', edge: 'trigger' },
    { id: 'accent_in',  type: 'cv' },
    // Per-knob CV for the voice's musical core.
    { id: 'tone_cv',    type: 'cv' },
    { id: 'tail_cv',    type: 'cv' },
    { id: 'spread_cv',  type: 'cv' },
  ],
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    { id: 'pulses', label: 'Pulses', defaultValue: 3,    min: 2,   max: 5,    curve: 'discrete' },
    { id: 'spread', label: 'Spread', defaultValue: 10,   min: 4,   max: 25,   curve: 'log',    units: 'ms' },
    { id: 'tone',   label: 'Tone',   defaultValue: 1000, min: 400, max: 3000, curve: 'log',    units: 'Hz' },
    { id: 'width',  label: 'Width',  defaultValue: 0.5,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'tail',   label: 'Tail',   defaultValue: 150,  min: 30,  max: 800,  curve: 'log',    units: 'ms' },
    { id: 'color',  label: 'Color',  defaultValue: 0.15, min: 0,   max: 1,    curve: 'linear' },
    { id: 'snap',   label: 'Snap',   defaultValue: 0.5,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'drive',  label: 'Drive',  defaultValue: 0.2,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'level',  label: 'Level',  defaultValue: 0,    min: -24, max: 12,   curve: 'linear', units: 'dB' },
    // The card's manual CLAP pad (held 0/1; the worklet ORs it with
    // trigger_in — its rising edge fires exactly one clap).
    { id: 'strike', label: 'Clap',   defaultValue: 0,    min: 0,   max: 1,    curve: 'discrete' },
  ],

  docs: {
    explanation:
      "An analog-modeled HANDCLAP voice that spans the classic clap circuits with eight curated knobs — TR-808 canonical, TR-909 dense, Simmons-ClapTrap spread, LinnDrum-dark are all corners of one continuous space, not presets. The model is the circuit every analog clap since the 808 has used, because a real clap is two palms' broadband impulse plus the ROOM: (1) a BURST of band-passed noise pulses — several hands landing milliseconds apart — retriggered PULSES times, SPREAD ms apart, each pulse decaying to −60 dB in exactly the spacing (the 808's quad-comparator sawtooth cycles) with the FINAL pulse ringing 2× longer (its uninterrupted last discharge), and (2) a separate smooth 'reverb' TAIL envelope summed in parallel — the fake room ring-out, fired at the last pulse and fed through one extra low-pass pole so the room sits darker than the crack. TONE places the band-pass center (the 808 sits near 1 kHz; the 909 near 1.14 kHz and brighter), WIDTH morphs the filter from ringy tuned slap (Q≈5.5) to broad splash with loudness compensation, COLOR darkens the noise source itself (white 909 registers → dark LinnDrum-era heft), and SNAP is the equal-power burst↔room balance (1 = bone-dry machine clap, 0 = room only). DRIVE is a 2×-oversampled warm tanh saturator, and the output stage ends in a true-peak bound so the voice never clips downstream. Recipes: 808 = the shipping defaults; 909 = Pulses 5, Spread ~5 ms, Tone 2.2k, Color 0, Snap up, Drive up; disco slap = Width near 0, Spread 15+; big dark room = Color 0.8+, Tail 500+, Snap 0.25. Strike it from any trigger/gate/sequencer source or the card's CLAP pad; ACCENT makes a hit both louder and roomier, exactly like a harder clap.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge fires one clap — the burst geometry (pulse count + spacing, including spread_cv) and the accent are latched at that instant, the noise source reseeds (every hit is bit-identical), and the pulse scheduler arms. How long the signal stays high doesn't matter; it's a trigger, not a hold. Patch a sequencer gate, drum-seq lane, or clock here.",
      accent_in:
        "Per-hit intensity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO here gives every hit its own velocity. An accented clap lands hotter (up to +80 % velocity ≈ +5 dB into the output bound, which compresses it musically) AND pumps the room disproportionately (up to +60 % tail excitation) — a harder clap is bigger, not just louder.",
      tone_cv:
        "Band-center CV: ±1.5 octaves per volt on TONE (multiplied, clamped 200 Hz–4.2 kHz) — a full ±1 V swing covers the knob's whole 400–3000 Hz range from the 1 kHz default (the house CV full-swing rule). Sequence it to alternate dark thuds and bright snaps from the same voice.",
      tail_cv:
        "Room-size CV: 2 octaves of TAIL time per volt — +1 V = ×4 tail, −1 V = ×¼ (clamped 15 ms–1.6 s), so ±1 V spans close to the knob's full 30–800 ms range. Ride it with an envelope or sequencer step to open the room up on the backbeat.",
      spread_cv:
        "Burst-geometry CV: ±1.3 octaves per volt on SPREAD (clamped 2–50 ms), LATCHED per hit at the strike edge — ±1 V covers the knob's whole 4–25 ms range, so a slow LFO here makes each clap's hand-timing subtly different (the Simmons ClapTrap's 'random spread' trick, deterministic).",
    },
    outputs: {
      audio_out:
        "The mono clap voice: burst + room tail through the drive and the true-peak output bound (|out| < 1 always, so it patches hot safely). Layer it a few ms behind a snare for the classic 909 backbeat, or run SNAP low for a pure room layer under a dry snare.",
    },
    controls: {
      pulses: "How many hands land (2–5 burst onsets, latched per hit). 3 = the 808's comparator cycles, 4–5 = the 909's denser 'T-T-T' machine burst, 2 = a tight flam. The last pulse always rings 2× longer (the final discharge) and hands off to the room tail.",
      spread: "Milliseconds between burst onsets (4–25, log, latched per hit). Short = one thick crack; the 808 sits at 10 ms; long reads as distinct micro-claps — the ClapTrap's spread into small-crowd 'applause' territory. Each pulse's decay time equals the spacing, so the sawtooth troughs stay deep at every setting. spread_cv adds ±1.3 oct/V.",
      tone: "Band-pass center (400–3000 Hz, log). ~1 kHz = the 808's palm-cavity resonance; up = the 909's brighter snap; down = a soft dark pat. The room tail tracks it one pole darker. tone_cv sweeps ±1.5 oct/V.",
      width: "Filter shape (0–1): 0 = ringy tuned slap (Q≈5.5 — the narrow disco clap that almost pitches), 1 = a broad noise splash. Loudness-compensated (1/√q), so it changes the shape of the noise, not the volume.",
      tail: "The room's −60 dB ring time (30–800 ms, log). The 808's fake-reverb envelope sits near 100–150 ms; short = a dry stage, long = a hall bloom. Fired at the LAST burst pulse so the crack stays articulated. tail_cv doubles/halves per volt.",
      color: "Noise color (0–1): a log-swept low-pass on the noise source from ~white (9 kHz pole — 909 shift-register bright) down to dark 700 Hz heft (the LinnDrum-era read), gain-compensated so dark stays loud. Upstream of the band-pass, so it tilts the whole voice including the room.",
      snap: "Burst ↔ room balance (0–1, equal-power): 1 = bone-dry machine-gun burst only, 0 = the room envelope only (a ghost clap / reverb layer), 0.5 = the classic 808 sum. This is the 'how close is the mic' knob.",
      drive: "Analog warmth (0–1): a 2×-oversampled warm tanh soft-clip on the summed voice. Low = clean; up = the crack fattens and the burst leans into the output bound instead of clipping — the 909-on-a-hot-mixer move.",
      level: "Output level in dB (−24..+12). The chain ends in a true-peak tanh bound, so a hot Level saturates musically rather than clipping the rack.",
      strike: "The manual CLAP pad: press to fire exactly one clap (the pad's press edge is the strike — holding it does not retrigger). Handy for dialing the voice in without patching a trigger source; external triggers keep working while it's held.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 5 audio-rate node inputs: trigger (0), accent (1), tone (2),
    // tail (3), spread (4). ONE mono output.
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 5,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the worklet alive with a single 0-offset silence source on every
    // input, so it processes blocks (and can be struck immediately) even
    // when nothing is patched yet. One ConstantSource, five connections.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 5; i++) silence.connect(worklet, 0, i);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of clapDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    inputsMap.set('trigger_in', { node: worklet, input: 0 });
    inputsMap.set('accent_in',  { node: worklet, input: 1 });
    inputsMap.set('tone_cv',    { node: worklet, input: 2 });
    inputsMap.set('tail_cv',    { node: worklet, input: 3 });
    inputsMap.set('spread_cv',  { node: worklet, input: 4 });

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
