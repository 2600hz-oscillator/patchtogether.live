// packages/web/src/lib/audio/modules/symbiote.ts
//
// SYMBIOTE — Marbles core running the always-on "Symbiote" alt-firmware:
// T-section = Grids drum engine (BD/SD/HH), X-section = TB-3PO acid sequencer.
// Audio-domain module def + pure-math host mirror (symbiote-engine.ts) for
// tests/ART. Worklet DSP at packages/dsp/src/symbiote.ts.
//
// Always-on Symbiote mode — NO hardware-only UX: the Drums/Euclidean sub-mode
// and all TB-3PO controls are exposed as normal module params/knobs (no long-
// press T MODEL, no déjà-vu-button sub-mode toggle).
//
// Source: Grids PatternGenerator + drum-maps Copyright 2011/2012 Émilie Gillet
// (GPLv3, AGPL-compatible); TB-3PO from the O&C / Hemisphere applet. See
// packages/dsp/src/symbiote-core.ts.
//
// Outputs: t1(BD) t2(SD) t3(HH) | x1(clock) x2(pitch CV 1V/oct) x3(gate) y(accent)
//
// Inputs:
//   rate_cv (cv, linear, paramTarget=rate): displaces the master clock rate.
//   submode_cv (cv, discrete, paramTarget=sub_mode): displaces the drum sub-mode (DRUMS/EUCLIDEAN).
//   bd_cv / sd_cv / hh_cv (cv, linear, paramTarget=…_density): per-channel density CV.
//   chaos_cv (cv, linear, paramTarget=chaos): displaces the drum-chaos amount.
//   aciddensity_cv (cv, linear, paramTarget=acid_density): displaces TB-3PO note density.
//   transpose_cv (cv, linear, paramTarget=transpose): displaces TB-3PO transposition.
//   acidlength_cv (cv, linear, paramTarget=acid_length): displaces TB-3PO loop length.
//   scale_cv (cv, discrete, paramTarget=scale): displaces TB-3PO scale.
//
// Outputs:
//   t1 / t2 / t3 (gate): Grids BD / SD / HH triggers.
//   x1 (gate): TB-3PO master clock.
//   x2 (cv): TB-3PO pitch CV (1V/oct).
//   x3 (gate): TB-3PO note gate.
//   y (gate): TB-3PO accent gate.
//
// Params:
//   rate (linear -60..60 st, default 0): master tempo rate macro.
//   sub_mode (discrete 0..1, default 0): drum sub-mode (DRUMS vs EUCLIDEAN).
//   map_x / map_y (linear 0..1, default 0.5): Grids drum-map coordinate.
//   bd_density / sd_density / hh_density (linear 0..1, default 0.5): per-channel fill density.
//   chaos (linear -1..1, default 0): drum chaos amount.
//   euclid_length (discrete 1..16, default 16): Euclidean loop length.
//   acid_density (linear 0..1, default 0.5): TB-3PO note density.
//   transpose (linear -18..18 st, default 0): TB-3PO transposition.
//   acid_length (discrete 1..32, default 16): TB-3PO loop length.
//   scale (discrete 0..SYMBIOTE_SCALE_NAMES.length, default 0): TB-3PO scale.
//   seed_lock (discrete 0..1, default 0): 1 = freeze the pattern seed (no re-randomize on clock).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/symbiote.js?url';

import { RandomStream, TGenerator, PRESET_SCALES } from './marbles-engine';
import {
  GridsRandom,
  PatternGenerator,
  TB3PoSequencer,
  OUTPUT_MODE_DRUMS,
  OUTPUT_MODE_EUCLIDEAN,
} from './symbiote-engine';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const SYMBIOTE_SUB_MODE_NAMES = ['DRUMS', 'EUCLID'] as const;
export const SYMBIOTE_SCALE_NAMES = [
  'C major',
  'C minor',
  'Pentatonic',
  'Pelog',
  'Raag Bhairav',
  'Raag Shri',
] as const;

const K_PULSES_PER_STEP = 3;
const MASTER_WRAPS_PER_X_STEP = K_PULSES_PER_STEP * 2;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface SymbioteParams {
  rate: number;
  sub_mode: number;
  map_x: number;
  map_y: number;
  bd_density: number;
  sd_density: number;
  hh_density: number;
  chaos: number;
  euclid_length: number;
  acid_density: number;
  transpose: number;
  acid_length: number;
  scale: number;
  seed_lock: number;
}

/** Pure-math render — numerically identical to the worklet. For tests + ART. */
export const symbioteMath = {
  render(n: number, sr: number, params: SymbioteParams) {
    const stream = new RandomStream(0x12345678);
    const t = new TGenerator(stream, sr);
    const rng = new GridsRandom();
    const grids = new PatternGenerator(rng);
    const tb3po = new TB3PoSequencer(rng);
    t.reset();
    t.model = 2;

    const scaleIdx = clamp(Math.round(params.scale), 0, PRESET_SCALES.length - 1);
    tb3po.setScale(PRESET_SCALES[scaleIdx]!);

    const euclidean = params.sub_mode >= 0.5;
    grids.setOutputMode(euclidean ? OUTPUT_MODE_EUCLIDEAN : OUTPUT_MODE_DRUMS);
    const s = grids.settings;
    s.density[0] = clamp(Math.round(clamp(params.bd_density, 0, 1) * 255), 0, 255);
    s.density[1] = clamp(Math.round(clamp(params.sd_density, 0, 1) * 255), 0, 255);
    s.density[2] = clamp(Math.round(clamp(params.hh_density, 0, 1) * 255), 0, 255);
    const chaos = clamp(params.chaos, -1, 1);
    if (euclidean) {
      const len = clamp(Math.round(params.euclid_length), 1, 16);
      const enc = (len - 1) * 8;
      s.euclideanLength[0] = enc;
      s.euclideanLength[1] = enc;
      s.euclideanLength[2] = enc;
      s.euclideanFillT2 = chaos < 0 ? clamp(Math.round(-chaos * 255), 0, 255) : 0;
      s.euclideanRotation = chaos > 0 ? clamp(Math.round(chaos * 255), 0, 255) : 0;
    } else {
      s.drums.x = clamp(Math.round(clamp(params.map_x, 0, 1) * 255), 0, 255);
      s.drums.y = clamp(Math.round(clamp(params.map_y, 0, 1) * 255), 0, 255);
      s.drums.randomness = clamp(Math.round(Math.abs(chaos) * 255), 0, 255);
    }

    t.setRate(params.rate);
    tb3po.setDensity(Math.round(clamp(params.acid_density, 0, 1) * 14), 0);
    tb3po.setTranspose(clamp(params.transpose, -18, 18));
    tb3po.setLength(clamp(Math.round(params.acid_length), 1, 32));
    tb3po.setLockSeed(params.seed_lock >= 0.5);

    const t1 = new Float32Array(n);
    const t2 = new Float32Array(n);
    const t3 = new Float32Array(n);
    const x1 = new Float32Array(n);
    const x2 = new Float32Array(n);
    const x3 = new Float32Array(n);
    const y = new Float32Array(n);
    const gateBuf = [false, false];
    const slaveBuf = [0, 0];

    let prevMasterPhase = 0;
    let gridsPulse = 0;
    let bd = false;
    let sd = false;
    let hh = false;

    for (let i = 0; i < n; i++) {
      const masterPhase = t.processSample(2.0, gateBuf, slaveBuf);
      const wrapped = masterPhase < prevMasterPhase;
      prevMasterPhase = masterPhase;
      if (wrapped) {
        grids.tickClock(1);
        const state = grids.getState();
        bd = (state & 0x01) !== 0;
        sd = (state & 0x02) !== 0;
        hh = (state & 0x04) !== 0;
        gridsPulse = (gridsPulse + 1) % MASTER_WRAPS_PER_X_STEP;
      }
      const stepRamp = (gridsPulse + masterPhase) / MASTER_WRAPS_PER_X_STEP;
      if (wrapped && gridsPulse === 0) {
        tb3po.tick(false);
      } else if (wrapped && gridsPulse === Math.floor(MASTER_WRAPS_PER_X_STEP / 2)) {
        tb3po.tickHalfCycle();
      }
      tb3po.stepSlide();
      t1[i] = bd ? 1 : 0;
      t2[i] = sd ? 1 : 0;
      t3[i] = hh ? 1 : 0;
      x1[i] = stepRamp < 0.5 ? 1 : 0;
      x2[i] = clamp(tb3po.getPitchVolts() / 5, -1, 1);
      x3[i] = tb3po.gate() ? 1 : 0;
      y[i] = tb3po.accent() ? 1 : 0;
    }
    return { t1, t2, t3, x1, x2, x3, y };
  },
};

export const symbioteDef: AudioModuleDef = {
  type: 'symbiote',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'symbiote',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'rate_cv', type: 'cv', paramTarget: 'rate', cvScale: { mode: 'linear' } },
    { id: 'submode_cv', type: 'cv', paramTarget: 'sub_mode', cvScale: { mode: 'discrete' } },
    { id: 'bd_cv', type: 'cv', paramTarget: 'bd_density', cvScale: { mode: 'linear' } },
    { id: 'sd_cv', type: 'cv', paramTarget: 'sd_density', cvScale: { mode: 'linear' } },
    { id: 'hh_cv', type: 'cv', paramTarget: 'hh_density', cvScale: { mode: 'linear' } },
    { id: 'chaos_cv', type: 'cv', paramTarget: 'chaos', cvScale: { mode: 'linear' } },
    { id: 'aciddensity_cv', type: 'cv', paramTarget: 'acid_density', cvScale: { mode: 'linear' } },
    // transpose is 1V/oct on hardware — pitch-typed CV passthrough handled by the worklet param.
    { id: 'transpose_cv', type: 'cv', paramTarget: 'transpose', cvScale: { mode: 'linear' } },
    { id: 'acidlength_cv', type: 'cv', paramTarget: 'acid_length', cvScale: { mode: 'linear' } },
    { id: 'scale_cv', type: 'cv', paramTarget: 'scale', cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 't1', type: 'gate' }, // BD
    { id: 't2', type: 'gate' }, // SD
    { id: 't3', type: 'gate' }, // HH
    { id: 'x1', type: 'gate' }, // clock
    { id: 'x2', type: 'cv' }, // pitch (1V/oct)
    { id: 'x3', type: 'gate' }, // acid gate
    { id: 'y', type: 'gate' }, // accent
  ],
  params: [
    { id: 'rate', label: 'Rate', defaultValue: 0, min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 'sub_mode', label: 'Mode', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'map_x', label: 'Map X', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'map_y', label: 'Map Y', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'bd_density', label: 'BD', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'sd_density', label: 'SD', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'hh_density', label: 'HH', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'chaos', label: 'Chaos', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'euclid_length', label: 'E.Len', defaultValue: 16, min: 1, max: 16, curve: 'discrete' },
    { id: 'acid_density', label: 'Acid Dens', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'transpose', label: 'Transpose', defaultValue: 0, min: -18, max: 18, curve: 'linear', units: 'st' },
    { id: 'acid_length', label: 'Acid Len', defaultValue: 16, min: 1, max: 32, curve: 'discrete' },
    { id: 'scale', label: 'Scale', defaultValue: 0, min: 0, max: SYMBIOTE_SCALE_NAMES.length - 1, curve: 'discrete' },
    { id: 'seed_lock', label: 'Seed Lock', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A self-running generative rhythm + melody brain — a Mutable Instruments Marbles core running the 'Symbiote' alt-firmware, which fuses two classic Eurorack patterns into one module. There is NO audio input and no clock input: an internal master clock (set by RATE) drives everything. The T-SECTION is a Grids drum engine that emits three correlated drum triggers — BD (t1), SD (t2), HH (t3) — whose busy-ness you steer with the MAP X / MAP Y drum-map coordinate and the per-channel densities, or switch to a Euclidean pattern generator. The X-SECTION is a TB-3PO acid sequencer that emits a master clock (x1), a 1V/oct pitch CV (x2), a note gate (x3) and an accent gate (y), with controls for note density, transposition, loop length and a musical scale. CHAOS adds randomness/variation to the drums; SEED LOCK freezes the current generated pattern so it stops re-rolling on each cycle. Patch the trigger/gate outs into drum voices and the pitch+gate into a synth voice to get a complete evolving pattern from one box.",
    inputs: {
      rate_cv: 'CV that offsets the RATE macro — speeds up or slows down the internal master clock that drives both the drum and acid sections.',
      submode_cv: 'CV that offsets the MODE selector (discrete), switching the T-section between the DRUMS map and the EUCLID pattern generator.',
      bd_cv: 'CV that offsets the BD density — raises or lowers how often the bass-drum trigger (t1) fires.',
      sd_cv: 'CV that offsets the SD density — how often the snare trigger (t2) fires.',
      hh_cv: 'CV that offsets the HH density — how often the hi-hat trigger (t3) fires.',
      chaos_cv: 'CV that offsets the CHAOS amount — adds or removes randomness/variation in the generated drum pattern (and, in Euclid mode, fill/rotation).',
      aciddensity_cv: 'CV that offsets the ACID DENSITY — how many of the TB-3PO steps play a note vs. rest.',
      transpose_cv: 'CV that offsets the TRANSPOSE — shifts the acid sequence up or down (1V/oct-style pitch passthrough on the worklet param).',
      acidlength_cv: 'CV that offsets the ACID LENGTH — the number of steps in the TB-3PO loop before it repeats.',
      scale_cv: 'CV that offsets the SCALE selector (discrete) — picks the musical scale the acid pitch CV is quantized to.',
    },
    outputs: {
      t1: 'Grids BD trigger — a rising-edge pulse on each bass-drum hit of the generated drum pattern. Patch into a kick voice.',
      t2: 'Grids SD trigger — a rising-edge pulse on each snare hit. Patch into a snare voice.',
      t3: 'Grids HH trigger — a rising-edge pulse on each hi-hat hit. Patch into a hat/percussion voice.',
      x1: 'TB-3PO master clock — a rising-edge pulse on each acid step. Use it to clock other sequencers/envelopes in sync with the acid line.',
      x2: 'TB-3PO pitch CV (1V/oct) — the current acid note, quantized to the selected SCALE and shifted by TRANSPOSE. Patch into an oscillator\'s pitch input.',
      x3: 'TB-3PO note gate — goes high while the current acid step plays a note (and low on rests). Patch into an envelope/VCA to articulate each note.',
      y: 'TB-3PO accent gate — a pulse on accented acid steps. Patch into a second envelope, a VCA boost, or a filter ping to emphasise accented notes (classic 303 accent).',
    },
    controls: {
      rate: 'Master clock RATE macro (−60..+60 semitones of tempo, i.e. a wide ±5-octave speed range) — the single tempo control for the whole module; everything (drums + acid) runs off this internal clock.',
      sub_mode: 'T-section MODE — DRUMS (the Grids drum-map engine, steered by MAP X/Y) vs EUCLID (a Euclidean pattern generator, where CHAOS becomes fill/rotation and E.LEN sets the length). Toggle on the card.',
      map_x: 'Grids drum-map X coordinate (DRUMS mode): scans across the 2-D map of pre-baked drum patterns, morphing the FEEL/style of the three drum channels together.',
      map_y: 'Grids drum-map Y coordinate (DRUMS mode): the other axis of the drum-pattern map; MAP X and MAP Y together pick a point in the pattern space.',
      bd_density: 'Bass-drum fill density (0..1) — how busy the BD (t1) trigger pattern is. CV via the BD input.',
      sd_density: 'Snare fill density (0..1) — how busy the SD (t2) trigger pattern is. CV via the SD input.',
      hh_density: 'Hi-hat fill density (0..1) — how busy the HH (t3) trigger pattern is. CV via the HH input.',
      chaos: 'CHAOS (−1..+1) — injects randomness/variation into the drum pattern (its magnitude is the randomness amount). In EUCLID mode negative values add T2 fill and positive values add rotation. CV via the CHAOS input.',
      euclid_length: 'Euclidean loop LENGTH (1..16 steps) — used only in EUCLID mode; sets the period of the Euclidean drum pattern.',
      acid_density: 'TB-3PO note DENSITY (0..1) — what fraction of the acid steps play a note rather than rest. CV via the ACID DENS input.',
      transpose: 'TB-3PO TRANSPOSE (−18..+18 semitones) — shifts the whole acid melody up or down. CV via the TRANSPOSE input.',
      acid_length: 'TB-3PO loop LENGTH (1..32 steps) — the number of steps in the acid sequence before it repeats. CV via the ACID LEN input.',
      scale: 'TB-3PO SCALE — the musical scale the acid pitch CV is quantized to (C major / C minor / Pentatonic / Pelog / Raag Bhairav / Raag Shri). Cycle on the card; CV via the SCALE input.',
      seed_lock: 'SEED LOCK — when on, freezes the current generated pattern seed so the drums + acid stop re-randomizing on each cycle (a repeatable loop); off lets the pattern keep evolving.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const workletNode = new AudioWorkletNode(ctx, 'symbiote', {
      numberOfInputs: 0,
      numberOfOutputs: 7,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1],
    });
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of symbioteDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['rate_cv', { node: workletNode, input: 0, param: params.get('rate')! }],
        ['submode_cv', { node: workletNode, input: 0, param: params.get('sub_mode')! }],
        ['bd_cv', { node: workletNode, input: 0, param: params.get('bd_density')! }],
        ['sd_cv', { node: workletNode, input: 0, param: params.get('sd_density')! }],
        ['hh_cv', { node: workletNode, input: 0, param: params.get('hh_density')! }],
        ['chaos_cv', { node: workletNode, input: 0, param: params.get('chaos')! }],
        ['aciddensity_cv', { node: workletNode, input: 0, param: params.get('acid_density')! }],
        ['transpose_cv', { node: workletNode, input: 0, param: params.get('transpose')! }],
        ['acidlength_cv', { node: workletNode, input: 0, param: params.get('acid_length')! }],
        ['scale_cv', { node: workletNode, input: 0, param: params.get('scale')! }],
      ]),
      outputs: new Map([
        ['t1', { node: workletNode, output: 0 }],
        ['t2', { node: workletNode, output: 1 }],
        ['t3', { node: workletNode, output: 2 }],
        ['x1', { node: workletNode, output: 3 }],
        ['x2', { node: workletNode, output: 4 }],
        ['x3', { node: workletNode, output: 5 }],
        ['y', { node: workletNode, output: 6 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          workletNode.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
