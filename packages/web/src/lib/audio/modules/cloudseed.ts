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
//
// Inputs:
//   in_l / in_r (audio): stereo input feeding the reverb tank.
//   dry_cv / early_cv / late_cv (cv, linear, paramTarget=…_out): displaces the dry / early-reflections / late-reverb mix.
//   input_mix_cv (cv, linear, paramTarget=input_mix): displaces the input stereo cross-feed.
//   low_cut_cv / high_cut_cv (cv, linear, paramTarget=…): displaces the wet-path input HPF / input LPF corners.
//   cross_seed_cv (cv, linear, paramTarget=cross_seed): displaces the L/R layout convergence.
//
// Outputs:
//   out_l / out_r (audio): wet+dry stereo output.
//
// Params (7 AudioParam macros + 38 message-port params + preset index):
//   dry_out (linear 0..1, default 0.87): dry-signal mix.
//   early_out (linear 0..1, default 0): early-reflections mix.
//   late_out (linear 0..1, default 0.66): late-tank mix.
//   input_mix (linear 0..1, default 0.23): pre-tank stereo cross-feed (1 = both tanks get the mono sum).
//   low_cut (linear 0..1, default 0.64): wet-path input HPF (mapped to CloudSeed's frequency curve).
//   high_cut (linear 0..1, default 0.29): wet-path input LPF.
//   cross_seed (linear 0..1, default 0): L/R random-layout convergence (0 = independent layouts = widest).
//   preset_index (discrete 0..CLOUDSEED_PRESETS.length-1, default 0): preset bank
//     picker. STORE-ONLY — recall is a graph stamp of all 46 values, never an
//     engine push (see the factory's setParam note + cloudseed-preset-actions).
//   38 message-port params (toggles / integer counts / seeds / per-EQ-band freq + gain /
//     modulation knobs) — mutated via port.postMessage; see the worklet header.
//     TEN of them are `discrete 0..1` because the worklet hard-thresholds them
//     at 0.5 (scaleParam's `val < 0.5 ? 0 : 1` arm): the eight stage ENABLES,
//     `interpolation`, and `late_mode`. The last names its states (PRE/POST)
//     rather than reading as an on/off switch.
//
// Engine WRITE keys (handle.write, not params):
//   clearTail — flush the reverb tank (the worklet's `clearBuffers`).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/cloudseed.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'cloudseed';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** The engine-handle `write()` key that flushes the reverb tank. Declared on
 *  the def (not on the UI action) because the HANDLE is what implements it —
 *  the key is part of this module's engine surface, and the card + the shell
 *  cell both address it through `$lib/ui/modules/cloudseed-preset-actions`. */
export const CLOUDSEED_CLEAR_TAIL_KEY = 'clearTail';

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

/** Macro-AudioParam IDs → C++ Parameter enum, for the preset stamp + the
 *  per-knob readout formatter. Declared ABOVE the def because `cloudseedDef`'s
 *  param array reads it while the object literal is being evaluated (a
 *  `const` below the def would be in its temporal dead zone). */
export const CLOUDSEED_MACRO_CPP_MAP: Readonly<Record<string, number>> = {
  dry_out: CloudseedParam.DryOut,
  early_out: CloudseedParam.EarlyOut,
  late_out: CloudseedParam.LateOut,
  input_mix: CloudseedParam.InputMix,
  low_cut: CloudseedParam.LowCut,
  high_cut: CloudseedParam.HighCut,
  cross_seed: CloudseedParam.EqCrossSeed,
};

/** Non-AudioParam parameters mutated via postMessage to the worklet. `label` is
 *  the RACKLINE face display name (cosmetic — NOT in the contract golden).
 *
 *  `curve` OVERRIDES the default `'linear'`. Ten entries declare `'discrete'`
 *  and the flip is a CORRECTION, not a UI preference: the worklet
 *  hard-thresholds all ten at 0.5 (`scaleParam`, the `val < 0.5 ? 0 : 1` arm),
 *  so they have exactly two reachable states and `'linear'` was always a lie
 *  about the value space. It also made them invisible to the shell — nine of
 *  them painted as CONTINUOUS ROTARIES reading `0.00` where the module used to
 *  draw ON/OFF pills, and `looksLikeToggle` (which requires `discrete`) could
 *  not see any of them, so even the unclassified-switch gate was blind.
 *
 *  `options` names the states of a param whose two positions are not on/off
 *  (`late_mode` is PRE vs POST — a Toggle labelled "Late Mode" has no
 *  meaningful on-state). Per the PF-1/PF-10 vocabulary gate, `options` implies
 *  `curve: 'discrete'`. */
export const CLOUDSEED_MESSAGE_PARAMS: ReadonlyArray<{
  id: string;
  label: string;
  cppId: number;
  defaultValue: number;
  curve?: 'discrete';
  options?: readonly { value: number; label: string; title?: string }[];
}> = [
  { id: 'interpolation',           label: 'Interp',         cppId: CloudseedParam.Interpolation,         defaultValue: 1, curve: 'discrete' },
  { id: 'low_cut_enabled',         label: 'Low Cut On',     cppId: CloudseedParam.LowCutEnabled,         defaultValue: 1, curve: 'discrete' },
  { id: 'high_cut_enabled',        label: 'High Cut On',    cppId: CloudseedParam.HighCutEnabled,        defaultValue: 0, curve: 'discrete' },
  { id: 'tap_enabled',             label: 'Taps On',        cppId: CloudseedParam.TapEnabled,            defaultValue: 0, curve: 'discrete' },
  { id: 'tap_count',               label: 'Tap Count',      cppId: CloudseedParam.TapCount,              defaultValue: 0.2 },
  { id: 'tap_decay',               label: 'Tap Decay',      cppId: CloudseedParam.TapDecay,              defaultValue: 1 },
  { id: 'tap_predelay',            label: 'Pre-Delay',      cppId: CloudseedParam.TapPredelay,           defaultValue: 0 },
  { id: 'tap_length',              label: 'Tap Length',     cppId: CloudseedParam.TapLength,             defaultValue: 0.98 },
  { id: 'early_diffuse_enabled',   label: 'Early Diff On',  cppId: CloudseedParam.EarlyDiffuseEnabled,   defaultValue: 0, curve: 'discrete' },
  { id: 'early_diffuse_count',     label: 'Early Stages',   cppId: CloudseedParam.EarlyDiffuseCount,     defaultValue: 0.3 },
  { id: 'early_diffuse_delay',     label: 'Early Delay',    cppId: CloudseedParam.EarlyDiffuseDelay,     defaultValue: 0.3 },
  { id: 'early_diffuse_mod_amt',   label: 'Early Mod Amt',  cppId: CloudseedParam.EarlyDiffuseModAmount, defaultValue: 0.14 },
  { id: 'early_diffuse_feedback',  label: 'Early Feedback', cppId: CloudseedParam.EarlyDiffuseFeedback,  defaultValue: 0.77 },
  { id: 'early_diffuse_mod_rate',  label: 'Early Mod Rate', cppId: CloudseedParam.EarlyDiffuseModRate,   defaultValue: 0.25 },
  {
    id: 'late_mode', label: 'Late Mode', cppId: CloudseedParam.LateMode, defaultValue: 1, curve: 'discrete',
    options: [
      { value: 0, label: 'pre',  title: 'PRE — each tank line is tapped straight off the delay; its diffuser + EQ shape only the recirculating feedback' },
      { value: 1, label: 'post', title: 'POST — each tank line is tapped after its diffuser + EQ, so you hear them directly on every echo' },
    ],
  },
  { id: 'late_line_count',         label: 'Lines',          cppId: CloudseedParam.LateLineCount,         defaultValue: 1 },
  { id: 'late_diffuse_enabled',    label: 'Late Diff On',   cppId: CloudseedParam.LateDiffuseEnabled,    defaultValue: 1, curve: 'discrete' },
  { id: 'late_diffuse_count',      label: 'Diff Count',     cppId: CloudseedParam.LateDiffuseCount,      defaultValue: 0.49 },
  { id: 'late_line_size',          label: 'Size',           cppId: CloudseedParam.LateLineSize,          defaultValue: 0.47 },
  { id: 'late_line_mod_amt',       label: 'Line Mod Amt',   cppId: CloudseedParam.LateLineModAmount,    defaultValue: 0.27 },
  { id: 'late_diffuse_delay',      label: 'Diff Delay',     cppId: CloudseedParam.LateDiffuseDelay,      defaultValue: 0.24 },
  { id: 'late_diffuse_mod_amt',    label: 'Diff Mod Amt',   cppId: CloudseedParam.LateDiffuseModAmount,  defaultValue: 0.15 },
  { id: 'late_line_decay',         label: 'Decay',          cppId: CloudseedParam.LateLineDecay,         defaultValue: 0.63 },
  { id: 'late_line_mod_rate',      label: 'Line Mod Rate',  cppId: CloudseedParam.LateLineModRate,       defaultValue: 0.23 },
  { id: 'late_diffuse_feedback',   label: 'Diff Feedback',  cppId: CloudseedParam.LateDiffuseFeedback,   defaultValue: 0.85 },
  { id: 'late_diffuse_mod_rate',   label: 'Diff Mod Rate',  cppId: CloudseedParam.LateDiffuseModRate,    defaultValue: 0.17 },
  { id: 'eq_low_shelf_enabled',    label: 'Low Shelf On',   cppId: CloudseedParam.EqLowShelfEnabled,     defaultValue: 0, curve: 'discrete' },
  { id: 'eq_high_shelf_enabled',   label: 'High Shelf On',  cppId: CloudseedParam.EqHighShelfEnabled,    defaultValue: 1, curve: 'discrete' },
  { id: 'eq_lowpass_enabled',      label: 'EQ LP On',       cppId: CloudseedParam.EqLowpassEnabled,      defaultValue: 0, curve: 'discrete' },
  { id: 'eq_low_freq',             label: 'Lo Freq',        cppId: CloudseedParam.EqLowFreq,             defaultValue: 0.39 },
  { id: 'eq_high_freq',            label: 'Hi Freq',        cppId: CloudseedParam.EqHighFreq,            defaultValue: 0.51 },
  { id: 'eq_cutoff',               label: 'EQ Cutoff',      cppId: CloudseedParam.EqCutoff,              defaultValue: 0.97 },
  { id: 'eq_low_gain',             label: 'Lo Gain',        cppId: CloudseedParam.EqLowGain,             defaultValue: 0.56 },
  { id: 'eq_high_gain',            label: 'Hi Gain',        cppId: CloudseedParam.EqHighGain,            defaultValue: 0.77 },
  { id: 'seed_tap',                label: 'Tap Seed',       cppId: CloudseedParam.SeedTap,               defaultValue: 0.33 },
  { id: 'seed_diffusion',          label: 'Diff Seed',      cppId: CloudseedParam.SeedDiffusion,         defaultValue: 0.19 },
  { id: 'seed_delay',              label: 'Delay Seed',     cppId: CloudseedParam.SeedDelay,             defaultValue: 0.22 },
  { id: 'seed_post_diffusion',     label: 'Post Seed',      cppId: CloudseedParam.SeedPostDiffusion,     defaultValue: 0.37 },
];

/** The PRESET roster the face paints (PF-1 `ParamDef.options`). Derived from
 *  the bank so a preset added to `CLOUDSEED_PRESETS` cannot go un-named — the
 *  vocabulary gate requires one option per discrete step of `preset_index`,
 *  whose `max` is derived from the same array. The stored `preset.name` is NOT
 *  touched: the ART impulse-response scenario matches on `.includes('SHORT')`. */
const CLOUDSEED_PRESET_OPTIONS = CLOUDSEED_PRESETS.map((p, i) => ({
  value: i,
  label: p.name.replace(/^\[FX\]\s*/, '').toLowerCase(),
  title: `${p.name} — recalls all 46 values as ONE undoable edit`,
}));

export const cloudseedDef: AudioModuleDef = {
  type: 'cloudseed',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'cloudseed',
  category: 'effects',
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],
  ossAttribution: { author: 'Ghost Note Audio' },

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
  // ── PF-3 READOUTS ─────────────────────────────────────────────────────────
  // Every knob on this module carries `format` = the module's OWN
  // `formatParameter` (the 1:1 mirror of CloudSeed's FormatParameter). The
  // normalized 0..1 a ParamDef stores is meaningless on a reverb whose knobs
  // mean SECONDS, HERTZ, DECIBELS and COUNTS: the module used to print
  // `2.34 sec` / `4300 Hz` / `12` and the migrated shell printed `0.63`. One
  // `format` per param restores every one of those 45 readouts from a single
  // formatter instead of 45 re-typed unit strings — the range/meaning of a knob
  // must come from ONE place, and here that place is the C++ port.
  //
  // `preset_index` and `late_mode` are the two exceptions: they declare
  // `options` instead, so the dial prints the STATE NAME and the dock paints a
  // real picker. (`knobReadout` ranks `format` above `options`, so declaring
  // both would silently mute the roster's own labels.)
  params: [
    // The 7 AudioParam macros. Defaults match DarkPlate's output mix.
    { id: 'dry_out',    label: 'Dry',        defaultValue: 0.87, min: 0, max: 1, curve: 'linear', format: (v: number) => formatParameter(v, CLOUDSEED_MACRO_CPP_MAP.dry_out!) },
    { id: 'early_out',  label: 'Early',      defaultValue: 0,    min: 0, max: 1, curve: 'linear', format: (v: number) => formatParameter(v, CLOUDSEED_MACRO_CPP_MAP.early_out!) },
    { id: 'late_out',   label: 'Late',       defaultValue: 0.66, min: 0, max: 1, curve: 'linear', format: (v: number) => formatParameter(v, CLOUDSEED_MACRO_CPP_MAP.late_out!) },
    { id: 'input_mix',  label: 'Input Mix',  defaultValue: 0.23, min: 0, max: 1, curve: 'linear', format: (v: number) => formatParameter(v, CLOUDSEED_MACRO_CPP_MAP.input_mix!) },
    { id: 'low_cut',    label: 'Low Cut',    defaultValue: 0.64, min: 0, max: 1, curve: 'linear', format: (v: number) => formatParameter(v, CLOUDSEED_MACRO_CPP_MAP.low_cut!) },
    { id: 'high_cut',   label: 'High Cut',   defaultValue: 0.29, min: 0, max: 1, curve: 'linear', format: (v: number) => formatParameter(v, CLOUDSEED_MACRO_CPP_MAP.high_cut!) },
    { id: 'cross_seed', label: 'Cross Seed', defaultValue: 0,    min: 0, max: 1, curve: 'linear', format: (v: number) => formatParameter(v, CLOUDSEED_MACRO_CPP_MAP.cross_seed!) },
    // The 38 message-port params. We declare them on the def so the
    // multiplayer-sync / persist / preset-load paths all see the full
    // parameter inventory; defaults pulled from DarkPlate where set.
    ...CLOUDSEED_MESSAGE_PARAMS.map((p) => ({
      id: p.id,
      label: p.label,
      defaultValue: p.defaultValue,
      min: 0,
      max: 1,
      curve: p.curve ?? ('linear' as const),
      ...(p.options
        ? { options: p.options }
        : { format: (v: number) => formatParameter(v, p.cppId) }),
    })),
    // Preset slot index — the whole-space recall. `options` NAMES the four
    // bundled spaces so the dock paints them as a segment row instead of a
    // rotary printing `0.00`, and the lane dial prints the space's name.
    {
      id: 'preset_index', label: 'Preset', defaultValue: 0,
      min: 0, max: CLOUDSEED_PRESETS.length - 1, curve: 'discrete',
      options: CLOUDSEED_PRESET_OPTIONS,
    },
  ],

  // CLEAR TAIL — a one-shot action, not a param (there is no state to persist:
  // it flushes every delay line / diffuser / shelf / lowpass in the tank).
  // The worklet has ALWAYS handled `clearBuffers`
  // (packages/dsp/src/cloudseed.ts) and the host had never sent it; on a preset
  // whose tail runs ~30 s, "make it stop" is a real gesture with a real
  // implementation and, until now, no button.
  controlFamilies: [
    { id: 'cloudseed-clear', label: 'Clear tail', kind: 'other', testidPrefix: 'cs-clear-tail' },
  ],

  docs: {
    explanation:
      "An algorithmic reverb — an exact port of Ghost Note Audio's open-source CloudSeed. The very first stage is the INPUT MIX cross-feed, and each channel's ENTIRE path — the dry tap included — hears its output. From there the wet path is one serial chain: the cross-fed input passes the input LOW CUT high-pass and HIGH CUT low-pass (when enabled), then the PRE-DELAY, then TAPS (a seeded multitap layer of sparse early echoes, when enabled), then EARLY DIFFUSION (cascaded all-passes that smear the echoes into a cloud, when enabled), and finally feeds the LATE tank — up to 12 parallel modulated delay lines whose feedback is tuned so the tail dies 60 dB in exactly the DECAY seconds (the RT60 hero readout). The output blend is three faders: DRY (each channel's post-INPUT-MIX input, tapped ahead of the cut filters and the rest of the wet chain), EARLY (the wet path tapped just before the tank), and LATE (the tank sum). The EQ shelves + lowpass sit INSIDE each tank line's feedback loop, so their cut compounds with every recirculation — progressive damping that only shapes the late tail. Every stage's layout is rolled from a SEED (tap / diffusion / delay / post-diffusion), and CROSS SEED sets how much the two channels' layouts converge: 0 keeps L and R fully independent (widest), 100% makes both tanks identical. Seven macros (the three output faders, input mix, both cut corners, cross seed) are CV-able AudioParams; the other 38 parameters travel over the worklet's message port. A bundled preset bank jumps between four spaces (DIVINE INSPIRATION / SHORT ROOM / BRIGHT HALL / INFINITE PAD).",
    inputs: {
      in_l: 'Left audio input into the reverb. Pairs with IN R as the stereo source; a signal patched into only one side is mirrored to both channels, so a mono source still excites both stereo tanks.',
      in_r: 'Right audio input into the reverb, partnering IN L for the stereo source (same mono-mirroring when patched alone).',
      dry_cv: 'CV that offsets the DRY output-mix macro (0..1, ±1 CV sweeps the full span around the knob): raise the level of the un-reverbed (post-INPUT-MIX) signal in the output blend.',
      early_cv: 'CV that offsets the EARLY output-mix macro: raise the level of the pre-tank stage (pre-delay + taps + diffusion) in the blend.',
      late_cv: 'CV that offsets the LATE output-mix macro: raise the level of the long reverberant tank in the blend — modulate it for swells.',
      input_mix_cv: 'CV that offsets the INPUT MIX macro — the front-of-path stereo cross-feed that everything (dry tap included) hears — sliding the two channel feeds from fully independent L/R toward the same mono average.',
      low_cut_cv: 'CV that offsets the LOW CUT macro — the wet-path input high-pass corner — to thin or thicken the lows entering the reverb.',
      high_cut_cv: 'CV that offsets the HIGH CUT macro — the wet-path input low-pass corner — to darken or brighten what enters the reverb.',
      cross_seed_cv: 'CV that offsets the CROSS SEED macro, sweeping the L/R tank layouts between fully independent (wide, de-correlated tail) and identical (centered).',
    },
    outputs: {
      out_l: 'Left channel of the output blend — the DRY, EARLY, and LATE faders summed. Pair with OUT R to keep the stereo width.',
      out_r: 'Right channel of the output blend, the partner of OUT L.',
    },
    controls: (() => {
      const controls: Record<string, string> = {
        // 7 macro AudioParams.
        dry_out: 'DRY output level — how much un-reverbed input is in the blend. The dry tap is taken AFTER the INPUT MIX cross-feed (so raising INPUT MIX narrows the dry signal itself) but ahead of the cut filters, pre-delay, and the rest of the wet chain. Internally a dB fader (−30 dB..0 dB; the bottom reads MUTED). CV via the DRY input.',
        early_out: 'EARLY output level — the wet path tapped just before the tank: the pre-delayed input plus TAPS and EARLY DIFFUSION when those stages are on (dB fader, MUTED at the bottom). CV via the EARLY input.',
        late_out: 'LATE output level — the tank sum in the blend, the main "reverb" you hear (dB fader, MUTED at the bottom). CV via the LATE input.',
        input_mix: 'INPUT MIX — the stereo cross-feed at the very front of the reverb (0..1), ahead of each channel\'s ENTIRE path (wet chain AND dry tap alike): at 0 each channel\'s path is fed its own input untouched; raising it blends in the opposite channel until at 1 both paths receive the same (L+R)/2 mono average. Because the dry tap sits after it, raising it also pulls the DRY signal toward mono — not just the reverb feed. CV via the IN MIX input.',
        low_cut: 'LOW CUT — the wet-path input high-pass corner (mapped along CloudSeed\'s frequency curve, ~20 Hz–1 kHz); rolls off lows before they enter the reverb (the dry path is untouched). In circuit only while LOW CUT ENABLE is on. CV via the LO CUT input.',
        high_cut: 'HIGH CUT — the wet-path input low-pass corner (~400 Hz–20 kHz); darkens everything entering the reverb (the dry path is untouched). In circuit only while HIGH CUT ENABLE is on. CV via the HI CUT input.',
        cross_seed: 'CROSS SEED — L/R layout convergence: at 0 each channel rolls a fully independent seeded layout (the widest, most de-correlated tail); raising it blends both channels toward one shared layout until at 100% the L and R tanks are identical (a centered, mono-correlated wet). CV via the X-SEED input.',
        // Preset.
        preset_index: 'The active preset slot in the bundled bank (DIVINE INSPIRATION / SHORT ROOM / BRIGHT HALL / INFINITE PAD). Selecting a slot writes that whole preset — every macro AND every message-port value — into the module as ONE undoable edit, so the sound, the saved rack and every collaborator agree. Because the recall is a graph edit rather than a hidden push to the reverb, a rack-mate sees all 46 knobs move.',
        // CLEAR TAIL (control family) — an ACTION, not a stored value.
        'cloudseed-clear-{n}': 'CLEAR TAIL — flushes the reverb instantly: every tap, early-diffusion all-pass and late-tank delay line (and their in-loop shelves and lowpass) is zeroed, so whatever is still ringing stops on the spot. It changes no setting and is not undoable — the space is unchanged, only its current contents are dropped. The gesture DECAY makes necessary: at the long end the tail runs ~60 seconds, and INFINITE PAD parks near it.',
      };
      // 38 message-port params — described by function. Grouped: input stage /
      // TAPS / EARLY DIFFUSION / LATE tank / EQ / SEEDS.
      const msg: Record<string, string> = {
        interpolation: 'INTERPOLATION on/off — enables smooth fractional-delay reads in the late tank\'s diffusers for cleaner modulation (less zipper/pitch grit) at a small CPU cost.',
        low_cut_enabled: 'LOW CUT enable — switches the wet-path input high-pass (set by LOW CUT) in or out of circuit.',
        high_cut_enabled: 'HIGH CUT enable — switches the wet-path input low-pass (set by HIGH CUT) in or out of circuit.',
        tap_enabled: 'TAPS enable — switches the seeded multitap early-echo stage in or out (when on it colors both the EARLY output and what feeds the tank).',
        tap_count: 'TAP COUNT — how many discrete early taps the multitap layer fires (1..256); more taps = denser early reflections.',
        tap_decay: 'TAP DECAY — the level slope across the tap cluster (0..100%): at 0% every tap is equal; raising it makes later taps fall away exponentially.',
        tap_predelay: 'PRE-DELAY — a 0..500 ms gap ahead of the entire wet path (taps, early AND late; dry is unaffected) — the classic reverb pre-delay that pushes the space back behind the source.',
        tap_length: 'TAP LENGTH — the total time span (10..1000 ms) the taps are spread across; longer = the early-reflection cluster lasts longer.',
        early_diffuse_enabled: 'EARLY DIFFUSION enable — switches the cascaded all-pass network (which smears the taps into a denser cloud) in or out.',
        early_diffuse_count: 'EARLY DIFFUSION STAGES — number of cascaded all-pass diffusers (1..12); more stages smear the early reflections into a smoother, denser cloud.',
        early_diffuse_delay: 'EARLY DIFFUSION DELAY — the base all-pass delay (10..100 ms); each stage sits at a seeded fraction of it, setting the grain/texture of the early diffusion.',
        early_diffuse_mod_amt: 'EARLY DIFFUSION MOD AMT — how deeply the diffusers\' delays are modulated, adding chorusing/shimmer to the early field (modulation engages once the depth clears a small threshold).',
        early_diffuse_feedback: 'EARLY DIFFUSION FEEDBACK — the all-pass feedback coefficient (0..100%); higher thickens and lengthens the early diffusion.',
        early_diffuse_mod_rate: 'EARLY DIFFUSION MOD RATE — the LFO rate (0..5 Hz, per-stage seeded variation) of the early-diffusion modulation.',
        late_mode: 'LATE MODE (PRE/POST) — where each tank line\'s output is tapped: PRE taps straight off the delay line (its diffuser + EQ shape only the recirculating feedback); POST taps after the diffuser + EQ, so you hear them directly on every echo.',
        late_line_count: 'LATE LINE COUNT — number of parallel delay lines in the reverb tank (1..12); more lines = a denser, smoother tail.',
        late_diffuse_enabled: 'LATE DIFFUSION enable — switches the all-pass diffuser inside each tank line\'s feedback loop in or out.',
        late_diffuse_count: 'LATE DIFFUSION COUNT — number of all-pass stages inside each tank line (1..8); more = a smoother, more washed-out tail.',
        late_line_size: 'LATE LINE SIZE — the base delay-line length (20..1000 ms), i.e. the perceived size of the space; each of the 12 lines rolls a seeded 0.5×..1.5× of it.',
        late_line_mod_amt: 'LATE LINE MOD AMT — how deeply the tank delay lines are modulated, adding movement and de-metallizing long tails.',
        late_diffuse_delay: 'LATE DIFFUSION DELAY — the base all-pass delay (10..100 ms) inside each tank line, shaping the tail\'s texture.',
        late_diffuse_mod_amt: 'LATE DIFFUSION MOD AMT — modulation depth of the in-line diffusers, adding shimmer to the tail.',
        late_line_decay: 'DECAY — the reverb time / RT60 (0.05 s..60 s, the hero readout): each line\'s feedback is computed so the tail falls 60 dB in exactly this many seconds, from a tight room to a near-infinite pad.',
        late_line_mod_rate: 'LATE LINE MOD RATE — the LFO rate (0..5 Hz, per-line seeded variation) of the tank delay-line modulation.',
        late_diffuse_feedback: 'LATE DIFFUSION FEEDBACK — feedback coefficient of the in-line diffusers (0..100%); higher lengthens and thickens the diffuse tail.',
        late_diffuse_mod_rate: 'LATE DIFFUSION MOD RATE — the LFO rate (0..5 Hz) of the late-diffusion modulation.',
        eq_low_shelf_enabled: 'EQ LOW SHELF enable — switches the low shelf inside each tank line\'s feedback loop in or out; its cut compounds with every recirculation (late tail only — dry/early are untouched).',
        eq_high_shelf_enabled: 'EQ HIGH SHELF enable — switches the in-loop high shelf in or out; per-pass high damping is the classic dark-tail move.',
        eq_lowpass_enabled: 'EQ LOWPASS enable — switches the in-loop lowpass (set by EQ CUTOFF) in or out for the steepest progressive darkening.',
        eq_low_freq: 'EQ LO FREQ — the corner frequency (~20 Hz–1 kHz) of the in-loop low shelf.',
        eq_high_freq: 'EQ HI FREQ — the corner frequency (~400 Hz–20 kHz) of the in-loop high shelf.',
        eq_cutoff: 'EQ CUTOFF — the corner frequency (~400 Hz–20 kHz) of the in-loop lowpass.',
        eq_low_gain: 'EQ LO GAIN — cut-only shelf gain (−20..0 dB; 0 = no cut) applied to the lows on every pass through the loop, progressively thinning the tail\'s bottom as it decays.',
        eq_high_gain: 'EQ HI GAIN — cut-only shelf gain (−20..0 dB; 0 = no cut) applied to the highs on every pass, progressively darkening the tail as it decays.',
        seed_tap: 'TAP SEED (000–999) — the random seed for the multitap layout; change it to audition a different early-reflection pattern at the same settings.',
        seed_diffusion: 'DIFFUSION SEED (000–999) — the random seed for the early all-pass layout; reshapes the diffuse texture without changing the knob settings.',
        seed_delay: 'DELAY SEED (000–999) — the random seed for the tank\'s delay-line lengths; reshapes the tail\'s modal structure.',
        seed_post_diffusion: 'POST-DIFFUSION SEED (000–999) — the random seed for the diffusers inside the tank lines (each line derives its own from it); another dial for re-rolling the late texture.',
      };
      return { ...controls, ...msg };
    })(),
  },

  // RACKLINE face — the FX-archetype rework (fullcard-mocks/cloudseed.html):
  // the recall + the blend center-stage, DECAY as the hero stat, everything
  // else re-grouped by the SIGNAL PATH the docs describe rather than by the
  // C++ Parameter enum's grouping.
  //
  // `order` is a PRIORITY ranking for tiers that show a SUBSET; `pages` is
  // FUNCTION order for the tier that shows EVERYTHING. They answer different
  // questions and they disagree here on purpose — do not "fix" one to match
  // the other.
  //
  //   mini    (1) PRESET. On a 46-parameter CONSTRUCTIVE reverb the first
  //               decision is never a fader: every other control on this
  //               module is a trim on a space you have already chosen, and the
  //               four bundled spaces are ~30 s apart in tail length.
  //               ⚠ Priced: the lane knob column caps at 46px, so mini paints
  //               a dial whose readout ELLIPSES ('divine inspirati…'). The
  //               ranking still stands — a truncated name still says which of
  //               four spaces you are in; a LATE fader says nothing about it.
  //   compact (2 + glyph) + LATE — "how much reverb", the one control a player
  //               rides. The VU glyph says whether signal is arriving.
  //   full    (6 — laneBodyPlan's no-clip cap; ranks 7+ are DOCK-ONLY) adds
  //               DECAY, DRY, SIZE and PRE-DELAY. That is a complete playable
  //               reverb: which room, how much, how long, how much dry, how
  //               big, how far back. ⚠ 6 cells ⇒ TWO plate rows ⇒ the full
  //               tier renders NO in-lane glyph (laneBodyPlan: glyph = hasGlyph
  //               && rows <= 1). Priced deliberately: the meter survives at
  //               mini, compact and the dock hero, and a sixth control beats a
  //               level meter on a module whose level meter is the dock's.
  //   dock:       every control, in eight tabbed pages (PF-16).
  //
  // ⚠ THE BIGGEST RE-RANK, and the clearest illustration of what a curated
  // face is FOR: `tap_predelay` 15 → 6. It is buried in the tap group only
  // because the C++ enum put it there (`CloudseedParam.TapPredelay = 12`),
  // while the module's own docs say it is "a 0..500 ms gap ahead of the ENTIRE
  // wet path" — taps, early AND late. Pre-delay is on the front panel of every
  // reverb ever made, and it is the control that moves a space behind the
  // source without changing the space.
  //
  // glyph 'meter': an FX processor reads I/O level, not a waveform.
  face: {
    order: [
      // ── the lane budget: ranks 1-6 are everything mini/compact/full can show
      'preset_index',       // 1  mini
      'late_out',           // 2  compact
      'late_line_decay',    // 3
      'dry_out',            // 4
      'late_line_size',     // 5
      'tap_predelay',       // 6  ← the lane budget ends HERE
      // ── dock-only from here down
      'early_out',          // 7  the third fader; 0 by default, so it ranks below
      'high_cut',           // 8  the wet-path tone trims, brightest-first
      'low_cut',            // 9
      'input_mix',          // 10
      'low_cut_enabled',    // 11
      'high_cut_enabled',   // 12
      // the late tank — the delay lines that ARE the reverb
      'late_line_count',    // 13
      'late_mode',          // 14
      'late_line_mod_amt',  // 15
      'late_line_mod_rate', // 16
      // the diffusers INSIDE the tank's feedback loop
      'late_diffuse_enabled',  // 17
      'late_diffuse_count',    // 18
      'late_diffuse_feedback', // 19
      'late_diffuse_delay',    // 20
      'late_diffuse_mod_amt',  // 21
      'late_diffuse_mod_rate', // 22
      'interpolation',         // 23
      // taps — off by default, so the whole stage ranks below the tank
      'tap_enabled',   // 24
      'tap_count',     // 25
      'tap_length',    // 26
      'tap_decay',     // 27
      // early diffusion — likewise off by default
      'early_diffuse_enabled',  // 28
      'early_diffuse_count',    // 29
      'early_diffuse_feedback', // 30
      'early_diffuse_delay',    // 31
      'early_diffuse_mod_amt',  // 32
      'early_diffuse_mod_rate', // 33
      // in-loop EQ — the high shelf is on by default and is the dark-tail move
      'eq_high_shelf_enabled', // 34
      'eq_high_gain',          // 35
      'eq_high_freq',          // 36
      'eq_low_shelf_enabled',  // 37
      'eq_low_gain',           // 38
      'eq_low_freq',           // 39
      'eq_lowpass_enabled',    // 40
      'eq_cutoff',             // 41
      // stereo width + the seeds that roll every layout
      'cross_seed',          // 42
      'seed_delay',          // 43  the tank's modal structure — the audible one
      'seed_tap',            // 44
      'seed_diffusion',      // 45
      'seed_post_diffusion', // 46
      // last on purpose: a panic button is not a performance control, and
      // spending one of six lane cells on it would be.
      'cloudseed-clear-{n}', // 47
    ],
    // EIGHT pages, in SIGNAL order. Three things worth naming:
    //  * the old `late` page was a 12-control dumping ground holding two
    //    different engines. The def's own order comment already knew the
    //    split (delay lines vs. in-loop diffusion); the page never took it.
    //  * `low_cut` sat on `input stage` and `high_cut` on `output stage`,
    //    yet the docs describe BOTH as wet-path INPUT filters — a plain
    //    paging bug. Fixing it also un-splits the rear (see `rear` below).
    //  * the LABELS are short because on this face they are TAB CAPTIONS
    //    (PF-16), and eight of them share one 1220px rail. Descriptive band
    //    headers ('late tank · delay lines', 'tail eq · inside the loop')
    //    pushed the eighth tab off the end into the rail's overflow scroll —
    //    measured, in the regenerated baseline. The page's own contents say
    //    the rest.
    pages: [
      { id: 'space',    label: 'space · blend',     controls: ['preset_index', 'late_out', 'late_line_decay', 'dry_out', 'early_out', 'late_line_size', 'cloudseed-clear-{n}'] },
      { id: 'input',    label: 'input · pre-delay', controls: ['input_mix', 'tap_predelay', 'low_cut_enabled', 'low_cut', 'high_cut_enabled', 'high_cut'] },
      { id: 'taps',     label: 'taps',              controls: ['tap_enabled', 'tap_count', 'tap_length', 'tap_decay'] },
      { id: 'early',    label: 'early diffusion',   controls: ['early_diffuse_enabled', 'early_diffuse_count', 'early_diffuse_delay', 'early_diffuse_feedback', 'early_diffuse_mod_amt', 'early_diffuse_mod_rate'] },
      { id: 'lines',    label: 'late tank',         controls: ['late_mode', 'late_line_count', 'late_line_mod_amt', 'late_line_mod_rate'] },
      { id: 'latediff', label: 'late diffusion',    controls: ['late_diffuse_enabled', 'late_diffuse_count', 'late_diffuse_delay', 'late_diffuse_feedback', 'late_diffuse_mod_amt', 'late_diffuse_mod_rate', 'interpolation'] },
      { id: 'eq',       label: 'tail eq',           controls: ['eq_low_shelf_enabled', 'eq_low_freq', 'eq_low_gain', 'eq_high_shelf_enabled', 'eq_high_freq', 'eq_high_gain', 'eq_lowpass_enabled', 'eq_cutoff'] },
      { id: 'seeds',    label: 'stereo · seeds',    controls: ['cross_seed', 'seed_tap', 'seed_diffusion', 'seed_delay', 'seed_post_diffusion'] },
    ],
    glyph: 'meter',
    // REAR CARD curation (rear-card-model) — the flip-side jack field.
    //  * The leading band is PINNED as the stereo insert and headed 'stereo in'
    //    rather than the derived 'signal': IN L / IN R are one two-hole port
    //    pair (see `stereoPairs`), and the rear only draws the pair tie on the
    //    OUTPUT rail, so the band header is where that has to be said. Pinning
    //    them also keeps a future non-audio input out of the insert band.
    //    ⚠ The group id 'signal' must never collide with a `pages` id — a
    //    curated group whose id matches a page claims the page slot TOO and
    //    the band renders TWICE (dx7 hit exactly this).
    //  * The CV bands DERIVE from the pages: 'space' (the three faders),
    //    'input' (IN MIX + both cut corners, now that the re-paging put them
    //    together) and 'seeds' (X-SEED). Five of the eight pages render NO
    //    band on purpose: taps / early diffusion / late tank / late diffusion /
    //    tail eq are message-port params with no CV inputs, and the rear
    //    card's job is to show what you can PATCH — an empty band would
    //    advertise holes this reverb does not have.
    //  * The 'wet tone cuts' cluster is a ~14px sub-header, not a ninth band:
    //    LO CUT and HI CUT are one idea (the filters at the mouth of the wet
    //    path) sitting inside the input band beside IN MIX, which is not.
    //  * No `~` ticks: the seven macros are smoothed AudioParams read by the
    //    reverb per block, not audio-rate modulation destinations, and the two
    //    audio inputs are the signal itself (the tick would be noise).
    rear: {
      groups: [{ id: 'signal', label: 'stereo in', ports: ['in_l', 'in_r'] }],
      clusters: [{ group: 'input', label: 'wet tone cuts', ports: ['low_cut_cv', 'high_cut_cv'] }],
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
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
      // ⚠ THERE IS DELIBERATELY NO `preset_index` BRANCH HERE.
      //
      // It used to push the whole preset into the WORKLET and explicitly leave
      // the store alone — so turning the dock's PRESET control changed the
      // SOUND while the persisted Y.Doc kept the old 45 values, and the next
      // knob move, save/reload or peer join silently reverted it. Preset recall
      // is a GRAPH edit ($lib/ui/modules/cloudseed-preset-actions): one
      // `mutateNode` writing all 46 values, which the reconciler then diffs and
      // replays through `setParam` per changed key — arriving here as ordinary
      // param writes. `preset_index` itself is store-only state (the active
      // slot every collaborator sees); the engine has nothing to do with it.
      setParam(paramId, value) {
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
      // CLEAR TAIL — the one non-param engine gesture this module has. The
      // worklet has handled `clearBuffers` since it shipped (it fans out to
      // every delay line, diffuser, shelf and lowpass in the tank via
      // ReverbController); nothing had ever sent it.
      write(key) {
        if (key === CLOUDSEED_CLEAR_TAIL_KEY) worklet.port.postMessage({ type: 'clearBuffers' });
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
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
      // Correct precedence: ((wi - delay) % L + L) % L for non-negative wrap.
      // Earlier ((wi - delay) | 0 + L) % L was a JS-precedence bug — `+`
      // binds tighter than `|`, producing wrong (often negative) indices
      // and NaN feedback on the EQ-on path.
      const delaySamples = ch.lineDelays[li]! | 0;
      let di = wi - delaySamples;
      di = ((di % buf.length) + buf.length) % buf.length;
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
