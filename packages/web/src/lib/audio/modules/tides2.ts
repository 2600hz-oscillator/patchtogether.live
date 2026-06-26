// packages/web/src/lib/audio/modules/tides2.ts
//
// TIDES2 — tidal modulator / poly-slope generator (Mutable Instruments Tides
// 2018 archetype, Émilie Gillet, MIT-licensed). Audio-domain module def +
// pure-math mirror import of the shared engine. Worklet at
// packages/dsp/src/tides2.ts; engine math at ./tides2-engine.ts.
//
// Tides is a versatile ramp / LFO / envelope generator with FOUR related
// outputs whose relationship is set by OUTPUT MODE:
//   GATES  — main slope + variant + EOA pulse + EOR pulse
//   AMP    — four amplitude-stepped copies (SHIFT pans across the four)
//   PHASE  — four progressively phase-shifted copies (SHIFT = spread)
//   FREQ   — four frequency-divided/multiplied copies (SHIFT picks ratios)
// RANGE selects LFO (slow) / AUDIO / TEMPO (external-clock synced) bands.
// RAMP MODE selects AD (one-shot attack-decay) / LOOP (free-running) / AR
// (gated attack-sustain-release / clock-following).
//
// Inputs: V/oct pitch, TRIG (gate), CLOCK (external), plus CV → param
// fast-paths for FREQ / SHAPE / SLOPE / SMOOTH / SHIFT. Four CV outs.
//
// v1 fidelity notes (also in tides2-engine.ts):
//   - SHAPE morph is a procedural sine→tri→ramp→expo bank, not MI's binary
//     `lut_wavetable`. Perceptually faithful; not bit-exact.
//   - The ramp extractor (external-clock PLL) is a moving-average period
//     predictor; the rhythmic-pattern + constant-PW predictors are folded in.
//   - BLEP anti-aliasing in the audio range is omitted (the slope shapes are
//     identical; aliasing nicety deferred).
//
// Inputs:
//   voct (pitch, paramTarget=frequency): V/oct, displaces FREQ.
//   trig (gate): rising edge fires (AD / AR modes).
//   clock (gate): external clock (TEMPO range; PLL'd into the period).
//   freq_cv (cv, linear, paramTarget=frequency): displaces FREQ.
//   shape_cv (cv, linear, paramTarget=shape): displaces SHAPE.
//   slope_cv (cv, linear, paramTarget=slope): displaces SLOPE.
//   smooth_cv (cv, linear, paramTarget=smoothness): displaces SMOOTH.
//   shift_cv (cv, linear, paramTarget=shift): displaces SHIFT.
//
// Outputs:
//   out0..out3 (cv): four related slope outputs whose relationship is set by outputMode
//     (GATES / AMP / PHASE / FREQ).
//
// Params:
//   frequency / shape / slope / smoothness / shift (linear 0..1, default 0.5): the five macros.
//   rampMode (discrete 0..2, default 0): AD / LOOP / AR.
//   outputMode (discrete 0..3, default 2): GATES / AMP / PHASE / FREQ.
//   range (discrete 0..2, default 0): LFO / AUDIO / TEMPO.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/tides2.js?url';

// Re-export the host-side engine mirror so card UI + host tests share the
// same math + constants as the worklet.
export {
  PolySlopeGenerator,
  RampGenerator,
  RampShaper,
  RampWaveshaper,
  RampExtractor,
  shapeMorph,
  fold,
  freqKnobToIncrement,
  clamp,
  TIDES2_NUM_CHANNELS,
  RAMP_MODE_AD,
  RAMP_MODE_LOOPING,
  RAMP_MODE_AR,
  OUTPUT_MODE_GATES,
  OUTPUT_MODE_AMPLITUDE,
  OUTPUT_MODE_SLOPE_PHASE,
  OUTPUT_MODE_FREQUENCY,
  RANGE_CONTROL,
  RANGE_AUDIO,
  TRIG_THRESHOLD,
  TIDES2_RAMP_MODE_NAMES,
  TIDES2_OUTPUT_MODE_NAMES,
  TIDES2_RANGE_NAMES,
} from './tides2-engine';
export type { Tides2Params } from './tides2-engine';

import {
  PolySlopeGenerator as _Engine,
  TIDES2_NUM_CHANNELS as _N,
  RAMP_MODE_AD as _AD,
  OUTPUT_MODE_SLOPE_PHASE as _PHASE,
  RANGE_CONTROL as _CTRL,
  type Tides2Params,
} from './tides2-engine';

const PROCESSOR_NAME = 'tides2';
const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------------------------------------------------------------------------
// Pure-math mirror — render N samples of the four outputs for fixed params.
// Used by host-side tests + ART scenarios; numerically identical to the
// worklet because both call into the same PolySlopeGenerator.
// ---------------------------------------------------------------------------

export interface Tides2RenderOpts {
  params: Tides2Params;
  /** Sample indices at which the TRIG gate is high (held for 1 sample, or a
   *  [start,end) range if you pass a tuple per entry). */
  trigHigh?: number[];
  /** Held-gate ranges [start,end) for AR mode (gate stays high). */
  gateRanges?: Array<[number, number]>;
  /** External-clock rising-edge sample indices (when useClock). */
  clockEdges?: number[];
  useClock?: boolean;
}

export const tides2Math = {
  /** Render `n` samples at sample rate `sr`. Returns
   *  Float32Array[TIDES2_NUM_CHANNELS] of the four outputs. */
  render(n: number, sr: number, opts: Tides2RenderOpts): Float32Array[] {
    const engine = new _Engine(sr);
    const outs: Float32Array[] = [];
    for (let c = 0; c < _N; c++) outs.push(new Float32Array(n));

    const trigSet = new Set(opts.trigHigh ?? []);
    const clockSet = new Set(opts.clockEdges ?? []);
    const gateRanges = opts.gateRanges ?? [];
    const useClock = opts.useClock ?? false;

    for (let i = 0; i < n; i++) {
      let gate = trigSet.has(i) ? 1 : 0;
      for (const [s, e] of gateRanges) {
        if (i >= s && i < e) gate = 1;
      }
      const clock = clockSet.has(i) ? 1 : 0;
      const vals = engine.render(opts.params, gate, clock, useClock);
      for (let c = 0; c < _N; c++) outs[c]![i] = vals[c] ?? 0;
    }
    return outs;
  },
};

// ---------------------------------------------------------------------------
// Module def.
// ---------------------------------------------------------------------------

export const tides2Def: AudioModuleDef = {
  type: 'tides2',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'tides2',
  category: 'modulation',
  schemaVersion: 1,
  ossAttribution: { author: 'Émilie Gillet' },
  inputs: [
    // V/oct pitch — audio-rate node input; the worklet maps ±1 → ±5 octaves
    // (matches the BLADES voct convention), so it's PASSTHROUGH_BY_DESIGN
    // for the cv-scale check.
    { id: 'voct', type: 'pitch', paramTarget: 'frequency' },
    { id: 'trig', type: 'gate' },
    { id: 'clock', type: 'gate' },
    // CV → AudioParam fast paths (linear cvScale → full-range sweep).
    { id: 'freq_cv', type: 'cv', paramTarget: 'frequency', cvScale: { mode: 'linear' } },
    { id: 'shape_cv', type: 'cv', paramTarget: 'shape', cvScale: { mode: 'linear' } },
    { id: 'slope_cv', type: 'cv', paramTarget: 'slope', cvScale: { mode: 'linear' } },
    { id: 'smooth_cv', type: 'cv', paramTarget: 'smoothness', cvScale: { mode: 'linear' } },
    { id: 'shift_cv', type: 'cv', paramTarget: 'shift', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out0', type: 'cv' },
    { id: 'out1', type: 'cv' },
    { id: 'out2', type: 'cv' },
    { id: 'out3', type: 'cv' },
  ],
  params: [
    { id: 'frequency', label: 'FREQ', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'shape', label: 'SHAPE', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'slope', label: 'SLOPE', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'smoothness', label: 'SMOOTH', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'shift', label: 'SHIFT', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    // RAMP MODE (discrete: 0=AD, 1=LOOP, 2=AR).
    { id: 'rampMode', label: 'MODE', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
    // OUTPUT MODE (discrete: 0=GATES, 1=AMP, 2=PHASE, 3=FREQ).
    { id: 'outputMode', label: 'OUT', defaultValue: 2, min: 0, max: 3, curve: 'discrete' },
    // RANGE (discrete: 0=LFO, 1=AUDIO, 2=TEMPO/clock-synced).
    { id: 'range', label: 'RANGE', defaultValue: 0, min: 0, max: 2, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A tidal modulator / poly-slope generator after Mutable Instruments' Tides — at heart a single rising-then-falling ramp whose speed, contour and symmetry you sculpt with five macro knobs, exposed not once but as FOUR related copies on outputs 1–4. It works as an LFO, an envelope, an oscillator, or a clockable ramp depending on three mode switches. RANGE picks the speed band (slow LFO, audio-rate, or external-clock-synced TEMPO). MODE picks how the ramp behaves: AD fires a one-shot rising-then-falling shape on each trigger, LOOP free-runs as an oscillating LFO/oscillator, and AR follows a held gate (rises while held, releases when let go). OUTPUT mode sets the relationship between the four outputs — GATES gives the main slope plus a variant and two end-of-rise/end-of-fall pulses; AMP, PHASE and FREQ give four copies staggered in amplitude, phase or frequency, with SHIFT spreading them apart. Every macro also has a CV input so the whole shape can be modulated. (Note: the SHAPE morph is a faithful sine→triangle→ramp→expo bank, not a bit-exact wavetable copy of the original.)",
    inputs: {
      voct:
        "1V/oct pitch input that displaces the FREQ macro — most useful in the AUDIO range, where TIDES2 tracks a keyboard/sequencer like an oscillator (±1 maps to ±5 octaves). In the LFO/TEMPO ranges it still shifts the rate up and down by octaves.",
      trig:
        "Trigger input: a rising edge fires the ramp once in AD mode (one full rise-then-fall) and re-starts/syncs the cycle in LOOP mode. Patch a clock or gate sequencer here to make TIDES2 an envelope per note.",
      clock:
        "External clock input used by the TEMPO range: TIDES2 measures the time between rising edges and phase-locks the ramp period to it, so the LFO/cycle stays in tempo with the rack. Has no effect in the LFO/AUDIO ranges.",
      freq_cv:
        "CV that displaces the FREQ macro around its knob setting (full-range bipolar sweep), so an LFO or envelope can speed up and slow down the ramp continuously.",
      shape_cv:
        "CV that displaces the SHAPE macro, morphing the waveform contour (sine→triangle→ramp→expo) under modulation.",
      slope_cv:
        "CV that displaces the SLOPE macro, sweeping the rise/fall symmetry from fast-attack/slow-decay through to the reverse.",
      smooth_cv:
        "CV that displaces the SMOOTH macro, modulating how rounded vs. sharp the slope's corners are (from smoothed curves to crisp folded edges).",
      shift_cv:
        "CV that displaces the SHIFT macro, sweeping the relationship between the four outputs (the amplitude/phase/frequency spread, or the GATES variant) under modulation.",
    },
    outputs: {
      out0:
        "Output 1 — the main slope. In GATES output mode this is the primary rising-then-falling ramp; in AMP/PHASE/FREQ mode it is the first of four related copies (the reference, with no amplitude/phase/frequency offset).",
      out1:
        "Output 2 — a variant of the main slope. In GATES mode this is an alternate contour of the same ramp; in AMP/PHASE/FREQ mode it is the second copy, offset from output 1 by the amount SHIFT sets.",
      out2:
        "Output 3 — in GATES mode an end-of-attack pulse (a short trigger when the rise completes); in AMP/PHASE/FREQ mode the third staggered copy.",
      out3:
        "Output 4 — in GATES mode an end-of-release pulse (a short trigger when the fall completes); in AMP/PHASE/FREQ mode the fourth staggered copy.",
    },
    controls: {
      frequency:
        "FREQ — the base rate of the ramp, scaled by the RANGE band: slow LFO cycles, audio-rate pitch, or the clock-synced period in TEMPO. Pitch/freq CV and the V/oct input add to this.",
      shape:
        "SHAPE — morphs the waveform contour continuously from sine through triangle and ramp to a near-exponential curve, cross-fading between adjacent shapes at in-between settings.",
      slope:
        "SLOPE — the rise/fall symmetry of the ramp: centred is a symmetric triangle, one way is fast-attack/slow-decay (a plucky envelope), the other is slow-attack/fast-decay.",
      smoothness:
        "SMOOTH — how rounded vs. sharp the slope's corners are; low values give crisp, even folded edges, high values smooth the curve into gentle bends.",
      shift:
        "SHIFT — spreads the four outputs apart: in AMP it pans amplitude across the four, in PHASE it spreads their phase, in FREQ it picks the frequency-division ratios, and in GATES it morphs the variant/pulse relationship.",
      rampMode:
        "MODE — how the ramp is driven: AD fires a one-shot rise-then-fall on each trigger (an envelope), LOOP free-runs as a repeating LFO/oscillator, and AR follows a held gate (rises while high, releases on the falling edge). The card's MODE button cycles these.",
      outputMode:
        "OUT — the relationship between outputs 1–4: GATES (main slope + variant + end-of-rise + end-of-fall pulses), AMP (four amplitude-staggered copies), PHASE (four phase-staggered copies), or FREQ (four frequency-divided/multiplied copies). The card's OUT button cycles these.",
      range:
        "RANGE — the speed band: LFO (slow, sub-audio cycles), AUDIO (audio-rate, so TIDES2 acts as an oscillator and tracks V/oct), or TEMPO (the cycle locks to the external CLOCK input). The card's RNG button cycles these.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      // voct + trig + clock = 3 audio-rate node inputs.
      numberOfInputs: 3,
      numberOfOutputs: _N,
      outputChannelCount: new Array(_N).fill(1),
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    for (const def of tides2Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['voct', { node: worklet, input: 0 }],
      ['trig', { node: worklet, input: 1 }],
      ['clock', { node: worklet, input: 2 }],
      ['freq_cv', { node: worklet, input: 0, param: params.get('frequency')! }],
      ['shape_cv', { node: worklet, input: 0, param: params.get('shape')! }],
      ['slope_cv', { node: worklet, input: 0, param: params.get('slope')! }],
      ['smooth_cv', { node: worklet, input: 0, param: params.get('smoothness')! }],
      ['shift_cv', { node: worklet, input: 0, param: params.get('shift')! }],
    ]);

    const outputsMap = new Map<string, { node: AudioNode; output: number }>();
    for (let c = 0; c < _N; c++) {
      outputsMap.set(`out${c}`, { node: worklet, output: c });
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: outputsMap,
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};

// Silence unused-import lint for re-export-only names.
void _AD; void _PHASE; void _CTRL;
