// packages/web/src/lib/audio/modules/cloudseed.ts
//
// CLOUDSEED — module def + pure-math mirror.
//
// Exact algorithm port of Ghost Note Audio's CloudSeed reverb
// (MIT-licensed, Copyright (c) 2024 Ghost Note Engineering Ltd,
// https://github.com/GhostNoteAudio/CloudSeedCore). The reverb engine
// runs in the AudioWorklet at packages/dsp/src/cloudseed.ts; this file
// re-exports the pure-math helpers (scaleParam, RandomBuffer, biquad +
// 1-pole filters) so the unit + ART tests can verify numerical fidelity
// against the C++ source without rendering through Web Audio.
//
// CloudSeed exposes 45 parameters (TAPS / DIFFUSION / LATE / EQ / output
// mix / seeds). We split them across:
//   - 7 AudioParams (the macros that benefit from CV summing — DRY /
//     EARLY / LATE faders, INPUT MIX, LOW CUT, HIGH CUT, CROSS SEED).
//   - 38 message-port params (toggles, integer counts, seeds, per-EQ-
//     band frequencies + gains, modulation knobs). These mutate via the
//     worklet's postMessage channel.
// All 45 retain stable numerical IDs from the C++ Parameter enum so the
// preset bank (Programs.h) maps cleanly.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/cloudseed.js?url';

const PROCESSOR_NAME = 'cloudseed';
const loadedContexts = new WeakSet<BaseAudioContext>();

// ============================================================================
// Parameter enum (1:1 from CloudSeedCore/Parameters.h)
// ============================================================================
export const CloudseedParam = {
  Interpolation: 0,
  LowCutEnabled: 1,
  HighCutEnabled: 2,
  InputMix: 3,
  LowCut: 4,
  HighCut: 5,
  DryOut: 6,
  EarlyOut: 7,
  LateOut: 8,
  TapEnabled: 9,
  TapCount: 10,
  TapDecay: 11,
  TapPredelay: 12,
  TapLength: 13,
  EarlyDiffuseEnabled: 14,
  EarlyDiffuseCount: 15,
  EarlyDiffuseDelay: 16,
  EarlyDiffuseModAmount: 17,
  EarlyDiffuseFeedback: 18,
  EarlyDiffuseModRate: 19,
  LateMode: 20,
  LateLineCount: 21,
  LateDiffuseEnabled: 22,
  LateDiffuseCount: 23,
  LateLineSize: 24,
  LateLineModAmount: 25,
  LateDiffuseDelay: 26,
  LateDiffuseModAmount: 27,
  LateLineDecay: 28,
  LateLineModRate: 29,
  LateDiffuseFeedback: 30,
  LateDiffuseModRate: 31,
  EqLowShelfEnabled: 32,
  EqHighShelfEnabled: 33,
  EqLowpassEnabled: 34,
  EqLowFreq: 35,
  EqHighFreq: 36,
  EqCutoff: 37,
  EqLowGain: 38,
  EqHighGain: 39,
  EqCrossSeed: 40,
  SeedTap: 41,
  SeedDiffusion: 42,
  SeedDelay: 43,
  SeedPostDiffusion: 44,
  COUNT: 45,
} as const;

// ============================================================================
// scaleParam — pure mirror of Parameters.h:ScaleParam.
// ============================================================================
const DEC1 = (10 / 9) * 0.1;
const DEC2 = (100 / 99) * 0.01;
const DEC3 = (1000 / 999) * 0.001;
const OCT2 = (4 / 3) * 0.25;
const OCT3 = (8 / 7) * 0.125;
const OCT4 = (16 / 15) * 0.0625;
export function resp1dec(x: number): number { return (Math.pow(10, x) - 1) * DEC1; }
export function resp2dec(x: number): number { return (Math.pow(10, 2 * x) - 1) * DEC2; }
export function resp3dec(x: number): number { return (Math.pow(10, 3 * x) - 1) * DEC3; }
export function resp2oct(x: number): number { return (Math.pow(2, 2 * x) - 1) * OCT2; }
export function resp3oct(x: number): number { return (Math.pow(2, 3 * x) - 1) * OCT3; }
export function resp4oct(x: number): number { return (Math.pow(2, 4 * x) - 1) * OCT4; }

export function scaleParam(val: number, index: number): number {
  switch (index) {
    case CloudseedParam.Interpolation:
    case CloudseedParam.LowCutEnabled:
    case CloudseedParam.HighCutEnabled:
    case CloudseedParam.TapEnabled:
    case CloudseedParam.LateDiffuseEnabled:
    case CloudseedParam.EqLowShelfEnabled:
    case CloudseedParam.EqHighShelfEnabled:
    case CloudseedParam.EqLowpassEnabled:
    case CloudseedParam.EarlyDiffuseEnabled:
      return val < 0.5 ? 0 : 1;
    case CloudseedParam.InputMix:
    case CloudseedParam.EarlyDiffuseFeedback:
    case CloudseedParam.TapDecay:
    case CloudseedParam.LateDiffuseFeedback:
    case CloudseedParam.EqCrossSeed:
      return val;
    case CloudseedParam.SeedTap:
    case CloudseedParam.SeedDiffusion:
    case CloudseedParam.SeedDelay:
    case CloudseedParam.SeedPostDiffusion:
      return Math.floor(val * 999.999);
    case CloudseedParam.LowCut:    return 20 + resp4oct(val) * 980;
    case CloudseedParam.HighCut:   return 400 + resp4oct(val) * 19600;
    case CloudseedParam.DryOut:
    case CloudseedParam.EarlyOut:
    case CloudseedParam.LateOut:   return -30 + val * 30;
    case CloudseedParam.TapCount:    return Math.floor(1 + val * 255);
    case CloudseedParam.TapPredelay: return resp1dec(val) * 500;
    case CloudseedParam.TapLength:   return 10 + val * 990;
    case CloudseedParam.EarlyDiffuseCount:     return Math.floor(1 + val * 11.999);
    case CloudseedParam.EarlyDiffuseDelay:     return 10 + val * 90;
    case CloudseedParam.EarlyDiffuseModAmount: return val * 2.5;
    case CloudseedParam.EarlyDiffuseModRate:   return resp2dec(val) * 5;
    case CloudseedParam.LateMode:              return val < 0.5 ? 0 : 1;
    case CloudseedParam.LateLineCount:         return Math.floor(1 + val * 11.999);
    case CloudseedParam.LateDiffuseCount:      return Math.floor(1 + val * 7.999);
    case CloudseedParam.LateLineSize:          return 20 + resp2dec(val) * 980;
    case CloudseedParam.LateLineModAmount:     return val * 2.5;
    case CloudseedParam.LateDiffuseDelay:      return 10 + val * 90;
    case CloudseedParam.LateDiffuseModAmount:  return val * 2.5;
    case CloudseedParam.LateLineDecay:         return 0.05 + resp3dec(val) * 59.95;
    case CloudseedParam.LateLineModRate:       return resp2dec(val) * 5;
    case CloudseedParam.LateDiffuseModRate:    return resp2dec(val) * 5;
    case CloudseedParam.EqLowFreq:  return 20 + resp3oct(val) * 980;
    case CloudseedParam.EqHighFreq: return 400 + resp4oct(val) * 19600;
    case CloudseedParam.EqCutoff:   return 400 + resp4oct(val) * 19600;
    case CloudseedParam.EqLowGain:  return -20 + val * 20;
    case CloudseedParam.EqHighGain: return -20 + val * 20;
  }
  return 0;
}

// ============================================================================
// formatParameter — for the on-card readouts. 1:1 mirror of FormatParameter.
// ============================================================================
export function formatParameter(val: number, paramId: number): string {
  const s = scaleParam(val, paramId);
  switch (paramId) {
    case CloudseedParam.Interpolation:
    case CloudseedParam.HighCutEnabled:
    case CloudseedParam.LowCutEnabled:
    case CloudseedParam.TapEnabled:
    case CloudseedParam.LateDiffuseEnabled:
    case CloudseedParam.EqLowShelfEnabled:
    case CloudseedParam.EqHighShelfEnabled:
    case CloudseedParam.EqLowpassEnabled:
    case CloudseedParam.EarlyDiffuseEnabled:
      return s === 1 ? 'ENABLED' : 'DISABLED';
    case CloudseedParam.InputMix:
    case CloudseedParam.EarlyDiffuseFeedback:
    case CloudseedParam.TapDecay:
    case CloudseedParam.LateDiffuseFeedback:
    case CloudseedParam.EqCrossSeed:
      return `${Math.round(s * 100)}%`;
    case CloudseedParam.SeedTap:
    case CloudseedParam.SeedDiffusion:
    case CloudseedParam.SeedDelay:
    case CloudseedParam.SeedPostDiffusion:
      return String(s | 0).padStart(3, '0');
    case CloudseedParam.LowCut:
    case CloudseedParam.HighCut:
    case CloudseedParam.EqLowFreq:
    case CloudseedParam.EqHighFreq:
    case CloudseedParam.EqCutoff:
      return `${s | 0} Hz`;
    case CloudseedParam.DryOut:
    case CloudseedParam.EarlyOut:
    case CloudseedParam.LateOut:
      return s <= -30 ? 'MUTED' : `${s.toFixed(1)} dB`;
    case CloudseedParam.TapCount:
    case CloudseedParam.EarlyDiffuseCount:
    case CloudseedParam.LateLineCount:
    case CloudseedParam.LateDiffuseCount:
      return `${s | 0}`;
    case CloudseedParam.TapPredelay:
    case CloudseedParam.TapLength:
    case CloudseedParam.EarlyDiffuseDelay:
    case CloudseedParam.LateLineSize:
    case CloudseedParam.LateDiffuseDelay:
      return `${s | 0} ms`;
    case CloudseedParam.LateLineDecay:
      if (s < 1) return `${Math.round(s * 1000)} ms`;
      if (s < 10) return `${s.toFixed(2)} sec`;
      return `${s.toFixed(1)} sec`;
    case CloudseedParam.LateMode:
      return s === 1 ? 'POST' : 'PRE';
    case CloudseedParam.EarlyDiffuseModAmount:
    case CloudseedParam.LateLineModAmount:
    case CloudseedParam.LateDiffuseModAmount:
      return `${Math.round(s * 100)}%`;
    case CloudseedParam.EarlyDiffuseModRate:
    case CloudseedParam.LateLineModRate:
    case CloudseedParam.LateDiffuseModRate:
      return `${s.toFixed(2)} Hz`;
    case CloudseedParam.EqLowGain:
    case CloudseedParam.EqHighGain:
      return `${s.toFixed(1)} dB`;
    default:
      return s.toFixed(2);
  }
}

// ============================================================================
// Built-in presets (port of Programs.h). v1 ships the canonical DarkPlate
// + 3 derived presets that exercise different corners of the param space
// (BRIGHT HALL, SHORT ROOM, INFINITE PAD). The full Ghost Note preset
// bank is enormous and would bloat the bundle without proportionate
// benefit; the in-app "load preset" picker can grow over time as users
// surface favourites.
// ============================================================================

export interface CloudseedPreset {
  name: string;
  /** Normalized 0..1 values keyed by CloudseedParam.* index. */
  values: Readonly<Record<number, number>>;
}

const DARK_PLATE: CloudseedPreset = {
  name: '[FX] DIVINE INSPIRATION',
  values: {
    [CloudseedParam.DryOut]: 0.8706,
    [CloudseedParam.EarlyDiffuseCount]: 0.2960,
    [CloudseedParam.EarlyDiffuseDelay]: 0.3067,
    [CloudseedParam.EarlyDiffuseEnabled]: 0,
    [CloudseedParam.EarlyDiffuseFeedback]: 0.7707,
    [CloudseedParam.EarlyDiffuseModAmount]: 0.1439,
    [CloudseedParam.EarlyDiffuseModRate]: 0.2467,
    [CloudseedParam.EarlyOut]: 0,
    [CloudseedParam.EqCrossSeed]: 0,
    [CloudseedParam.EqCutoff]: 0.976,
    [CloudseedParam.EqHighFreq]: 0.5134,
    [CloudseedParam.EqHighGain]: 0.768,
    [CloudseedParam.EqHighShelfEnabled]: 1,
    [CloudseedParam.EqLowFreq]: 0.388,
    [CloudseedParam.EqLowGain]: 0.556,
    [CloudseedParam.EqLowShelfEnabled]: 0,
    [CloudseedParam.EqLowpassEnabled]: 0,
    [CloudseedParam.HighCut]: 0.2933,
    [CloudseedParam.HighCutEnabled]: 0,
    [CloudseedParam.InputMix]: 0.2347,
    [CloudseedParam.Interpolation]: 1,
    [CloudseedParam.LateDiffuseCount]: 0.488,
    [CloudseedParam.LateDiffuseDelay]: 0.24,
    [CloudseedParam.LateDiffuseEnabled]: 1,
    [CloudseedParam.LateDiffuseFeedback]: 0.8507,
    [CloudseedParam.LateDiffuseModAmount]: 0.1468,
    [CloudseedParam.LateDiffuseModRate]: 0.1667,
    [CloudseedParam.LateLineCount]: 1,
    [CloudseedParam.LateLineDecay]: 0.6346,
    [CloudseedParam.LateLineModAmount]: 0.272,
    [CloudseedParam.LateLineModRate]: 0.2293,
    [CloudseedParam.LateLineSize]: 0.4694,
    [CloudseedParam.LateMode]: 1,
    [CloudseedParam.LateOut]: 0.6614,
    [CloudseedParam.LowCut]: 0.64,
    [CloudseedParam.LowCutEnabled]: 1,
    [CloudseedParam.SeedDelay]: 0.2181,
    [CloudseedParam.SeedDiffusion]: 0.185,
    [CloudseedParam.SeedPostDiffusion]: 0.3653,
    [CloudseedParam.SeedTap]: 0.334,
    [CloudseedParam.TapDecay]: 1,
    [CloudseedParam.TapLength]: 0.9867,
    [CloudseedParam.TapPredelay]: 0,
    [CloudseedParam.TapCount]: 0.196,
    [CloudseedParam.TapEnabled]: 0,
  },
};

// SHORT ROOM — small bright room, ~0.7s tail, tap+early on.
const SHORT_ROOM: CloudseedPreset = {
  name: '[FX] SHORT ROOM',
  values: {
    ...DARK_PLATE.values,
    [CloudseedParam.LateLineDecay]: 0.32,   // ~0.7s
    [CloudseedParam.LateLineSize]: 0.25,    // ~50ms lines
    [CloudseedParam.EqHighGain]: 0.55,      // less HF roll-off
    [CloudseedParam.TapEnabled]: 1,
    [CloudseedParam.EarlyDiffuseEnabled]: 1,
    [CloudseedParam.LateLineCount]: 0.6,
    [CloudseedParam.LateOut]: 0.5,
  },
};

// BRIGHT HALL — larger space, lifted HF, mid-density.
const BRIGHT_HALL: CloudseedPreset = {
  name: '[FX] BRIGHT HALL',
  values: {
    ...DARK_PLATE.values,
    [CloudseedParam.LateLineDecay]: 0.78,
    [CloudseedParam.LateLineSize]: 0.65,
    [CloudseedParam.LateLineCount]: 0.92,
    [CloudseedParam.EqHighGain]: 0.85,
    [CloudseedParam.EqLowShelfEnabled]: 1,
    [CloudseedParam.EarlyDiffuseEnabled]: 1,
    [CloudseedParam.TapPredelay]: 0.18,
    [CloudseedParam.LateOut]: 0.72,
    [CloudseedParam.EarlyOut]: 0.4,
  },
};

// INFINITE PAD — extreme decay, max diffusion, low-cut on. Useful for
// proving the freeze/sustain corner of the algorithm holds without
// runaway feedback.
const INFINITE_PAD: CloudseedPreset = {
  name: '[FX] INFINITE PAD',
  values: {
    ...DARK_PLATE.values,
    [CloudseedParam.LateLineDecay]: 0.95,   // ~30s
    [CloudseedParam.LateDiffuseFeedback]: 0.92,
    [CloudseedParam.LateDiffuseCount]: 0.88,
    [CloudseedParam.LateLineCount]: 1,
    [CloudseedParam.EqCrossSeed]: 0.5,
    [CloudseedParam.LowCutEnabled]: 1,
    [CloudseedParam.LowCut]: 0.45,
    [CloudseedParam.LateOut]: 0.78,
  },
};

export const CLOUDSEED_PRESETS: readonly CloudseedPreset[] = Object.freeze([
  DARK_PLATE,
  SHORT_ROOM,
  BRIGHT_HALL,
  INFINITE_PAD,
]);

/** Get the live DECAY (RT60-style) seconds from a preset's LateLineDecay. */
export function presetDecaySeconds(preset: CloudseedPreset): number {
  const v = preset.values[CloudseedParam.LateLineDecay] ?? 0.5;
  return scaleParam(v, CloudseedParam.LateLineDecay);
}

// ============================================================================
// Module def. The 7 macro params are AudioParams; the remaining 38
// parameters live in node.params and are pushed through the worklet's
// postMessage channel via the `non-AudioParam params helper` below.
// ============================================================================

/** Non-AudioParam parameters mutated via postMessage to the worklet. */
export const CLOUDSEED_MESSAGE_PARAMS: ReadonlyArray<{ id: string; cppId: number; defaultValue: number }> = [
  { id: 'interpolation',           cppId: CloudseedParam.Interpolation,         defaultValue: 1 },
  { id: 'low_cut_enabled',         cppId: CloudseedParam.LowCutEnabled,         defaultValue: 1 },
  { id: 'high_cut_enabled',        cppId: CloudseedParam.HighCutEnabled,        defaultValue: 0 },
  { id: 'tap_enabled',             cppId: CloudseedParam.TapEnabled,            defaultValue: 0 },
  { id: 'tap_count',               cppId: CloudseedParam.TapCount,              defaultValue: 0.2 },
  { id: 'tap_decay',               cppId: CloudseedParam.TapDecay,              defaultValue: 1 },
  { id: 'tap_predelay',            cppId: CloudseedParam.TapPredelay,           defaultValue: 0 },
  { id: 'tap_length',              cppId: CloudseedParam.TapLength,             defaultValue: 0.98 },
  { id: 'early_diffuse_enabled',   cppId: CloudseedParam.EarlyDiffuseEnabled,   defaultValue: 0 },
  { id: 'early_diffuse_count',     cppId: CloudseedParam.EarlyDiffuseCount,     defaultValue: 0.3 },
  { id: 'early_diffuse_delay',     cppId: CloudseedParam.EarlyDiffuseDelay,     defaultValue: 0.3 },
  { id: 'early_diffuse_mod_amt',   cppId: CloudseedParam.EarlyDiffuseModAmount, defaultValue: 0.14 },
  { id: 'early_diffuse_feedback',  cppId: CloudseedParam.EarlyDiffuseFeedback,  defaultValue: 0.77 },
  { id: 'early_diffuse_mod_rate',  cppId: CloudseedParam.EarlyDiffuseModRate,   defaultValue: 0.25 },
  { id: 'late_mode',               cppId: CloudseedParam.LateMode,              defaultValue: 1 },
  { id: 'late_line_count',         cppId: CloudseedParam.LateLineCount,         defaultValue: 1 },
  { id: 'late_diffuse_enabled',    cppId: CloudseedParam.LateDiffuseEnabled,    defaultValue: 1 },
  { id: 'late_diffuse_count',      cppId: CloudseedParam.LateDiffuseCount,      defaultValue: 0.49 },
  { id: 'late_line_size',          cppId: CloudseedParam.LateLineSize,          defaultValue: 0.47 },
  { id: 'late_line_mod_amt',       cppId: CloudseedParam.LateLineModAmount,    defaultValue: 0.27 },
  { id: 'late_diffuse_delay',      cppId: CloudseedParam.LateDiffuseDelay,      defaultValue: 0.24 },
  { id: 'late_diffuse_mod_amt',    cppId: CloudseedParam.LateDiffuseModAmount,  defaultValue: 0.15 },
  { id: 'late_line_decay',         cppId: CloudseedParam.LateLineDecay,         defaultValue: 0.63 },
  { id: 'late_line_mod_rate',      cppId: CloudseedParam.LateLineModRate,       defaultValue: 0.23 },
  { id: 'late_diffuse_feedback',   cppId: CloudseedParam.LateDiffuseFeedback,   defaultValue: 0.85 },
  { id: 'late_diffuse_mod_rate',   cppId: CloudseedParam.LateDiffuseModRate,    defaultValue: 0.17 },
  { id: 'eq_low_shelf_enabled',    cppId: CloudseedParam.EqLowShelfEnabled,     defaultValue: 0 },
  { id: 'eq_high_shelf_enabled',   cppId: CloudseedParam.EqHighShelfEnabled,    defaultValue: 1 },
  { id: 'eq_lowpass_enabled',      cppId: CloudseedParam.EqLowpassEnabled,      defaultValue: 0 },
  { id: 'eq_low_freq',             cppId: CloudseedParam.EqLowFreq,             defaultValue: 0.39 },
  { id: 'eq_high_freq',            cppId: CloudseedParam.EqHighFreq,            defaultValue: 0.51 },
  { id: 'eq_cutoff',               cppId: CloudseedParam.EqCutoff,              defaultValue: 0.97 },
  { id: 'eq_low_gain',             cppId: CloudseedParam.EqLowGain,             defaultValue: 0.56 },
  { id: 'eq_high_gain',            cppId: CloudseedParam.EqHighGain,            defaultValue: 0.77 },
  { id: 'seed_tap',                cppId: CloudseedParam.SeedTap,               defaultValue: 0.33 },
  { id: 'seed_diffusion',          cppId: CloudseedParam.SeedDiffusion,         defaultValue: 0.19 },
  { id: 'seed_delay',              cppId: CloudseedParam.SeedDelay,             defaultValue: 0.22 },
  { id: 'seed_post_diffusion',     cppId: CloudseedParam.SeedPostDiffusion,     defaultValue: 0.37 },
];

export const cloudseedDef: AudioModuleDef = {
  type: 'cloudseed',
  domain: 'audio',
  label: 'CLOUDSEED',
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],

  inputs: [
    { id: 'in_l',           type: 'audio' },
    { id: 'in_r',           type: 'audio' },
    // 7 CV inputs mapping to the AudioParam macros. Linear scale: the
    // module already accepts 0..1 normalized values and the cvScale
    // helper maps ±1 bipolar CV onto the natural span.
    { id: 'dry_cv',         type: 'cv', paramTarget: 'dry_out',    cvScale: { mode: 'linear' } },
    { id: 'early_cv',       type: 'cv', paramTarget: 'early_out',  cvScale: { mode: 'linear' } },
    { id: 'late_cv',        type: 'cv', paramTarget: 'late_out',   cvScale: { mode: 'linear' } },
    { id: 'input_mix_cv',   type: 'cv', paramTarget: 'input_mix',  cvScale: { mode: 'linear' } },
    { id: 'low_cut_cv',     type: 'cv', paramTarget: 'low_cut',    cvScale: { mode: 'linear' } },
    { id: 'high_cut_cv',    type: 'cv', paramTarget: 'high_cut',   cvScale: { mode: 'linear' } },
    { id: 'cross_seed_cv',  type: 'cv', paramTarget: 'cross_seed', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    // The 7 AudioParam macros. Defaults match DarkPlate's output mix.
    { id: 'dry_out',    label: 'Dry',        defaultValue: 0.87, min: 0, max: 1, curve: 'linear' },
    { id: 'early_out',  label: 'Early',      defaultValue: 0,    min: 0, max: 1, curve: 'linear' },
    { id: 'late_out',   label: 'Late',       defaultValue: 0.66, min: 0, max: 1, curve: 'linear' },
    { id: 'input_mix',  label: 'Input Mix',  defaultValue: 0.23, min: 0, max: 1, curve: 'linear' },
    { id: 'low_cut',    label: 'Low Cut',    defaultValue: 0.64, min: 0, max: 1, curve: 'linear' },
    { id: 'high_cut',   label: 'High Cut',   defaultValue: 0.29, min: 0, max: 1, curve: 'linear' },
    { id: 'cross_seed', label: 'Cross Seed', defaultValue: 0,    min: 0, max: 1, curve: 'linear' },
    // The 38 message-port params. We declare them on the def so the
    // multiplayer-sync / persist / preset-load paths all see the full
    // parameter inventory; defaults pulled from DarkPlate where set.
    ...CLOUDSEED_MESSAGE_PARAMS.map((p) => ({
      id: p.id,
      label: p.id,
      defaultValue: p.defaultValue,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
    // Preset slot index — UI footer click-through; stored as a param so
    // collaborators see the active slot in real time.
    { id: 'preset_index', label: 'Preset', defaultValue: 0, min: 0, max: CLOUDSEED_PRESETS.length - 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};

    // Push initial AudioParam values.
    const macroDefs = cloudseedDef.params.filter((p) => params.has(p.id));
    for (const def of macroDefs) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    // Push initial message-port values.
    for (const mp of CLOUDSEED_MESSAGE_PARAMS) {
      const v = initial[mp.id] ?? mp.defaultValue;
      worklet.port.postMessage({ type: 'setParam', id: mp.cppId, value: v });
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in_l',          { node: worklet, input: 0 }],
        ['in_r',          { node: worklet, input: 1 }],
        ['dry_cv',        { node: worklet, input: 0, param: params.get('dry_out')! }],
        ['early_cv',      { node: worklet, input: 0, param: params.get('early_out')! }],
        ['late_cv',       { node: worklet, input: 0, param: params.get('late_out')! }],
        ['input_mix_cv',  { node: worklet, input: 0, param: params.get('input_mix')! }],
        ['low_cut_cv',    { node: worklet, input: 0, param: params.get('low_cut')! }],
        ['high_cut_cv',   { node: worklet, input: 0, param: params.get('high_cut')! }],
        ['cross_seed_cv', { node: worklet, input: 0, param: params.get('cross_seed')! }],
      ]),
      outputs: new Map([
        ['out_l', { node: worklet, output: 0 }],
        ['out_r', { node: worklet, output: 1 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'preset_index') {
          // Preset apply: write all values into the worklet + into the
          // patch graph so the change persists. The card handles its own
          // patch.nodes[id].params mutation; here we just push every
          // preset value through to the worklet.
          const preset = CLOUDSEED_PRESETS[Math.max(0, Math.min(CLOUDSEED_PRESETS.length - 1, value | 0))];
          if (!preset) return;
          for (const [cppIdStr, v] of Object.entries(preset.values)) {
            const cppId = Number(cppIdStr);
            // If it's a macro AudioParam, find its name and set it via AudioParam.
            const macro = cloudseedDef.params.find((p) => {
              if (!params.has(p.id)) return false;
              const mp = CLOUDSEED_MACRO_CPP_MAP[p.id];
              return mp === cppId;
            });
            if (macro) {
              params.get(macro.id)?.setValueAtTime(v, ctx.currentTime);
            } else {
              worklet.port.postMessage({ type: 'setParam', id: cppId, value: v });
            }
          }
          return;
        }
        if (params.has(paramId)) {
          params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
          return;
        }
        // Look up cppId for the message-port path.
        const mp = CLOUDSEED_MESSAGE_PARAMS.find((p) => p.id === paramId);
        if (mp) worklet.port.postMessage({ type: 'setParam', id: mp.cppId, value });
      },
      readParam(paramId) {
        if (params.has(paramId)) return params.get(paramId)?.value;
        return undefined;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};

/** Macro-AudioParam IDs → C++ Parameter enum, for the preset-load fast-path. */
export const CLOUDSEED_MACRO_CPP_MAP: Readonly<Record<string, number>> = {
  dry_out: CloudseedParam.DryOut,
  early_out: CloudseedParam.EarlyOut,
  late_out: CloudseedParam.LateOut,
  input_mix: CloudseedParam.InputMix,
  low_cut: CloudseedParam.LowCut,
  high_cut: CloudseedParam.HighCut,
  cross_seed: CloudseedParam.EqCrossSeed,
};

// ============================================================================
// Pure-math primitives re-exported for tests (1:1 with the worklet)
// ============================================================================

// ---- LcgRandom (Borland 22695477/1 LCG) ----
export class CloudseedLcg {
  private x: bigint;
  private static readonly A = 22695477n;
  private static readonly C = 1n;
  private static readonly M = 0xffffffffn;
  constructor(seed: number) { this.x = BigInt(seed >>> 0); }
  nextUInt(): number {
    this.x = (CloudseedLcg.A * this.x + CloudseedLcg.C) & CloudseedLcg.M;
    return Number(this.x);
  }
}
export function cloudseedRandomBuffer(seed: number, count: number): Float32Array {
  const out = new Float32Array(count);
  const rng = new CloudseedLcg(seed);
  for (let i = 0; i < count; i++) out[i] = rng.nextUInt() / 4294967295;
  return out;
}
export function cloudseedRandomBufferCrossSeed(seed: number, count: number, crossSeed: number): Float32Array {
  const seedA = seed >>> 0;
  const seedB = (~seedA) >>> 0;
  const a = cloudseedRandomBuffer(seedA, count);
  const b = cloudseedRandomBuffer(seedB, count);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = a[i]! * (1 - crossSeed) + b[i]! * crossSeed;
  return out;
}

// ---- Biquad LowShelf / HighShelf coeffs ----
export interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number; }
export function biquadLowShelfCoeffs(fc: number, fs: number, gainDb: number): BiquadCoeffs {
  const V = Math.pow(10, Math.abs(gainDb) / 20);
  const K = Math.tan((Math.PI * fc) / fs);
  let b0: number, b1: number, b2: number, a1: number, a2: number, norm: number;
  if (gainDb >= 0) {
    norm = 1 / (1 + Math.sqrt(2) * K + K * K);
    b0 = (1 + Math.sqrt(2 * V) * K + V * K * K) * norm;
    b1 = 2 * (V * K * K - 1) * norm;
    b2 = (1 - Math.sqrt(2 * V) * K + V * K * K) * norm;
    a1 = 2 * (K * K - 1) * norm;
    a2 = (1 - Math.sqrt(2) * K + K * K) * norm;
  } else {
    norm = 1 / (1 + Math.sqrt(2 * V) * K + V * K * K);
    b0 = (1 + Math.sqrt(2) * K + K * K) * norm;
    b1 = 2 * (K * K - 1) * norm;
    b2 = (1 - Math.sqrt(2) * K + K * K) * norm;
    a1 = 2 * (V * K * K - 1) * norm;
    a2 = (1 - Math.sqrt(2 * V) * K + V * K * K) * norm;
  }
  return { b0, b1, b2, a1, a2 };
}
export function biquadHighShelfCoeffs(fc: number, fs: number, gainDb: number): BiquadCoeffs {
  const V = Math.pow(10, Math.abs(gainDb) / 20);
  const K = Math.tan((Math.PI * fc) / fs);
  let b0: number, b1: number, b2: number, a1: number, a2: number, norm: number;
  if (gainDb >= 0) {
    norm = 1 / (1 + Math.sqrt(2) * K + K * K);
    b0 = (V + Math.sqrt(2 * V) * K + K * K) * norm;
    b1 = 2 * (K * K - V) * norm;
    b2 = (V - Math.sqrt(2 * V) * K + K * K) * norm;
    a1 = 2 * (K * K - 1) * norm;
    a2 = (1 - Math.sqrt(2) * K + K * K) * norm;
  } else {
    norm = 1 / (V + Math.sqrt(2 * V) * K + K * K);
    b0 = (1 + Math.sqrt(2) * K + K * K) * norm;
    b1 = 2 * (K * K - 1) * norm;
    b2 = (1 - Math.sqrt(2) * K + K * K) * norm;
    a1 = 2 * (K * K - V) * norm;
    a2 = (V - Math.sqrt(2 * V) * K + K * K) * norm;
  }
  return { b0, b1, b2, a1, a2 };
}

// ---- 1-pole HP / LP coefficients (Hp1.h / Lp1.h shape) ----
export function onePoleCoeffs(fc: number, fs: number): { b0: number; a1: number } {
  let cutoff = fc;
  if (cutoff >= fs * 0.5) cutoff = fs * 0.499;
  const x = (2 * Math.PI * cutoff) / fs;
  const nn = 2 - Math.cos(x);
  const alpha = nn - Math.sqrt(nn * nn - 1);
  return { b0: 1 - alpha, a1: alpha };
}

// ---- Multitap delay: deterministic tap positions for a given seed ----
export function multitapTapPositions(seed: number, count: number): { positions: Float32Array; gains: Float32Array } {
  // Re-derives the seeded tap layout from MultitapDelay::UpdateSeeds + Update.
  const buf = cloudseedRandomBuffer(seed, 256 * 3);
  const positions = new Float32Array(count);
  const gains = new Float32Array(count);
  let s = 0;
  for (let i = 0; i < 256; i++) {
    const a = buf[s++]!;
    const b = buf[s++]!;
    const c = buf[s++]!;
    if (i >= count) continue;
    const phase = a < 0.5 ? 1 : -1;
    gains[i] = Math.pow(10, (-20 + b * 20) / 20) * phase;
    positions[i] = i + c;
  }
  return { positions, gains };
}

// ---- Pure renderer for impulse-response tests. Minimal mirror of the
// worklet (single channel; uses the same scaleParam) so the test can run
// in node without spinning up an AudioContext. ----

interface PureChannel {
  preDelaySamples: number;
  lineCount: number;
  lineDelays: Float32Array;
  lineFeedbacks: Float32Array;
  // Per-line delay buffer + write index.
  lineBufs: Float32Array[];
  lineWrites: Int32Array;
  // EQ filters (per-line low-shelf + high-shelf + LP).
  lowShelfEnabled: boolean;
  highShelfEnabled: boolean;
  lowpassEnabled: boolean;
  lsState: Float32Array; // [x1,x2,y1,y2] per line
  hsState: Float32Array;
  lpState: Float32Array; // [output] per line
  lsCoeff: BiquadCoeffs;
  hsCoeff: BiquadCoeffs;
  lpCoeff: { b0: number; a1: number };
  dryGain: number;
  earlyGain: number;
  lateGain: number;
  // Pre-delay buffer.
  preBuf: Float32Array;
  preWrite: number;
}

/**
 * Pure-math impulse-response renderer. Simplified — single channel,
 * NO multitap (TapEnabled is OFF in DarkPlate so it doesn't matter for
 * RT60), NO early diffusion (also OFF). 12 parallel delay lines with
 * the same C++-formula feedback (T60-targeted) + optional per-line EQ.
 * This is the "spec-level" parity check: feed a unit impulse, measure
 * the late-field decay envelope, compare to the parameter's target
 * decay seconds. Drop-in CloudSeed users will hear a tail that matches
 * the displayed DECAY readout within rendering tolerance.
 */
export function cloudseedImpulseResponse(
  preset: CloudseedPreset,
  sr: number,
  durationSeconds: number,
): Float32Array {
  const n = Math.floor(sr * durationSeconds);
  const out = new Float32Array(n);
  const ms2s = (ms: number): number => (ms / 1000) * sr;
  const ch: PureChannel = initPureChannel(preset, sr);
  // Unit impulse at sample 0.
  for (let i = 0; i < n; i++) {
    let x = i === 0 ? 1 : 0;
    // Pre-delay.
    const preIdx = (ch.preWrite - ch.preDelaySamples + ch.preBuf.length) % ch.preBuf.length;
    const preOut = ch.preBuf[preIdx]!;
    ch.preBuf[ch.preWrite] = x;
    ch.preWrite = (ch.preWrite + 1) % ch.preBuf.length;
    // Sum across parallel delay lines.
    let lineSum = 0;
    for (let li = 0; li < ch.lineCount; li++) {
      const buf = ch.lineBufs[li]!;
      const wi = ch.lineWrites[li]!;
      const di = ((wi - ch.lineDelays[li]!) | 0 + buf.length) % buf.length;
      const dOut = buf[di]!;
      let v = preOut + dOut * ch.lineFeedbacks[li]!;
      // EQ stages on the line feedback path.
      if (ch.lowShelfEnabled) v = biquadStep(v, ch.lsCoeff, ch.lsState, li);
      if (ch.highShelfEnabled) v = biquadStep(v, ch.hsCoeff, ch.hsState, li);
      if (ch.lowpassEnabled) {
        // 1-pole LP.
        const prev = ch.lpState[li]!;
        const o = ch.lpCoeff.b0 * v + ch.lpCoeff.a1 * prev;
        ch.lpState[li] = o;
        v = o;
      }
      buf[wi] = v;
      ch.lineWrites[li] = (wi + 1) % buf.length;
      lineSum += dOut;
    }
    const perLineGain = 1 / Math.sqrt(ch.lineCount);
    out[i] = ch.dryGain * x + ch.lateGain * lineSum * perLineGain;
    // suppress lint about unused
    void ms2s;
  }
  return out;
}

function biquadStep(x: number, c: BiquadCoeffs, state: Float32Array, line: number): number {
  const off = line * 4;
  const x1 = state[off]!, x2 = state[off + 1]!, y1 = state[off + 2]!, y2 = state[off + 3]!;
  const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
  state[off] = x;
  state[off + 1] = x1;
  state[off + 2] = y;
  state[off + 3] = y1;
  return y;
}

function initPureChannel(preset: CloudseedPreset, sr: number): PureChannel {
  const ms2s = (ms: number): number => (ms / 1000) * sr;
  const get = (cppId: number, fallback = 0.5): number => preset.values[cppId] ?? fallback;
  // crossSeed for L channel = 1 - 0.5 * value.
  const crossSeed = 1 - 0.5 * scaleParam(get(CloudseedParam.EqCrossSeed, 0), CloudseedParam.EqCrossSeed);
  const lineCount = scaleParam(get(CloudseedParam.LateLineCount, 1), CloudseedParam.LateLineCount) | 0;
  const lineSizeMs = scaleParam(get(CloudseedParam.LateLineSize, 0.5), CloudseedParam.LateLineSize);
  const lineDelaySamples = ms2s(lineSizeMs) | 0;
  const lineDecaySec = scaleParam(get(CloudseedParam.LateLineDecay, 0.5), CloudseedParam.LateLineDecay);
  const lineDecaySamples = lineDecaySec * sr;
  const seedDelay = scaleParam(get(CloudseedParam.SeedDelay, 0.2), CloudseedParam.SeedDelay) | 0;
  const seeds = cloudseedRandomBufferCrossSeed(seedDelay, 12 * 3, crossSeed);
  const lineDelays = new Float32Array(12);
  const lineFeedbacks = new Float32Array(12);
  const lineBufs: Float32Array[] = [];
  const lineWrites = new Int32Array(12);
  for (let i = 0; i < 12; i++) {
    let d = (0.5 + 1.0 * seeds[24 + i]!) * lineDelaySamples;
    if (d < 2) d = 2;
    const db = (d / lineDecaySamples) * -60;
    const gain = Math.pow(10, db / 20);
    lineDelays[i] = d | 0;
    lineFeedbacks[i] = gain;
    lineBufs.push(new Float32Array(Math.max(64, (d | 0) + 64)));
  }
  const preDelaySamples = ms2s(scaleParam(get(CloudseedParam.TapPredelay, 0), CloudseedParam.TapPredelay)) | 0;
  const preBuf = new Float32Array(Math.max(64, preDelaySamples + 64));
  const dryGain = (() => {
    const s = scaleParam(get(CloudseedParam.DryOut, 0.5), CloudseedParam.DryOut);
    return s <= -30 ? 0 : Math.pow(10, s / 20);
  })();
  const lateGain = (() => {
    const s = scaleParam(get(CloudseedParam.LateOut, 0.5), CloudseedParam.LateOut);
    return s <= -30 ? 0 : Math.pow(10, s / 20);
  })();
  const earlyGain = (() => {
    const s = scaleParam(get(CloudseedParam.EarlyOut, 0), CloudseedParam.EarlyOut);
    return s <= -30 ? 0 : Math.pow(10, s / 20);
  })();
  const lowShelfEnabled = scaleParam(get(CloudseedParam.EqLowShelfEnabled, 0), CloudseedParam.EqLowShelfEnabled) >= 0.5;
  const highShelfEnabled = scaleParam(get(CloudseedParam.EqHighShelfEnabled, 0), CloudseedParam.EqHighShelfEnabled) >= 0.5;
  const lowpassEnabled = scaleParam(get(CloudseedParam.EqLowpassEnabled, 0), CloudseedParam.EqLowpassEnabled) >= 0.5;
  const lsFreq = scaleParam(get(CloudseedParam.EqLowFreq, 0.4), CloudseedParam.EqLowFreq);
  const lsGain = scaleParam(get(CloudseedParam.EqLowGain, 0.5), CloudseedParam.EqLowGain);
  const hsFreq = scaleParam(get(CloudseedParam.EqHighFreq, 0.5), CloudseedParam.EqHighFreq);
  const hsGain = scaleParam(get(CloudseedParam.EqHighGain, 0.5), CloudseedParam.EqHighGain);
  const lpFreq = scaleParam(get(CloudseedParam.EqCutoff, 0.9), CloudseedParam.EqCutoff);
  return {
    preDelaySamples, lineCount, lineDelays, lineFeedbacks, lineBufs, lineWrites,
    lowShelfEnabled, highShelfEnabled, lowpassEnabled,
    lsState: new Float32Array(12 * 4),
    hsState: new Float32Array(12 * 4),
    lpState: new Float32Array(12),
    lsCoeff: biquadLowShelfCoeffs(lsFreq, sr, lsGain),
    hsCoeff: biquadHighShelfCoeffs(hsFreq, sr, hsGain),
    lpCoeff: onePoleCoeffs(lpFreq, sr),
    dryGain, earlyGain, lateGain,
    preBuf, preWrite: 0,
  };
}

/**
 * Measure RT60 from an impulse response by fitting -60 dB on the
 * envelope. We compute a moving-window RMS envelope, find where it
 * drops by 60 dB from peak, and return the elapsed seconds. Returns
 * `durationSeconds` if the tail never decays that far (i.e., infinite-
 * reverb corner).
 */
export function measureRt60(ir: Float32Array, sr: number): number {
  const win = Math.floor(sr * 0.04); // 40ms RMS window
  const env = new Float32Array(ir.length);
  let acc = 0;
  for (let i = 0; i < ir.length; i++) {
    acc += ir[i]! * ir[i]!;
    if (i >= win) acc -= ir[i - win]! * ir[i - win]!;
    env[i] = Math.sqrt(acc / Math.min(i + 1, win));
  }
  // Skip the dry tap at i=0; start looking after the impulse + a few ms.
  const startAt = Math.floor(sr * 0.05);
  let peak = 0;
  for (let i = startAt; i < env.length; i++) {
    if (env[i]! > peak) peak = env[i]!;
  }
  if (peak === 0) return ir.length / sr;
  const target = peak * Math.pow(10, -60 / 20);
  // Scan from the end backwards for the first crossing.
  for (let i = env.length - 1; i > startAt; i--) {
    if (env[i]! >= target) {
      return (i - startAt) / sr;
    }
  }
  return ir.length / sr;
}
