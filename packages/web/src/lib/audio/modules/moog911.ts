// packages/web/src/lib/audio/modules/moog911.ts
//
// MOOG 911 ENVELOPE GENERATOR — Moog System 55/35 contour generator.
//
// Slice of the Moog System 55 / 35 clone initiative (.myrobots/MOOG/),
// after the 921 VCO. The 911 ships in BOTH systems (S35 ×3, S55 ×6), so
// like the 921 it's categorized under Moog → SYS55 (the shared bucket).
//
// NOT a literal ADSR — the 911 is a three-time-constant CONTOUR generator
// with a single sustain LEVEL:
//   On S-trigger (gate high): ATTACK over T1 to peak (1.0) → INITIAL DECAY
//   over T2 down to Esus → hold at Esus while the gate is held.
//   On release (gate low): FINAL DECAY over T3. Trigger-close forces T3
//   regardless of the current stage.
//
// DSP: own-code exponential-segment contour generator
// (packages/dsp/src/moog911.ts) — permissive, not a port of any Moog
// schematic or copyleft source (.myrobots/MOOG/LICENSING.md). Loosely
// modelled on the repo's `adsr` (gate-driven, unipolar 0..1, +inverted tap)
// but with the 911's T1→peak / T2→Esus / T3 contour, not A-D-S-R.
//
// Inputs:
//   gate (gate): S-trigger. Rising edge = ATTACK; falling edge = FINAL DECAY (T3).
//   t1_cv (cv, log, paramTarget=t1): scales the attack-time param symmetrically.
//   t2_cv (cv, log, paramTarget=t2): scales the initial-decay-time param.
//   esus_cv (cv, linear, paramTarget=esus): displaces the sustain level (0..1).
//   t3_cv (cv, log, paramTarget=t3): scales the final-decay-time param.
//
// Outputs:
//   env (cv): the contour, 0..1.
//   env_inv (cv): 1 - env — the inverted tap for ducking / sidechain use.
//
// Params:
//   t1   (log 1e-4..10s, default 0.01): ATTACK time in seconds.
//   t2   (log 1e-4..10s, default 0.2):  INITIAL DECAY time in seconds.
//   esus (linear 0..1, default 0.6):    SUSTAIN level.
//   t3   (log 1e-4..10s, default 0.4):  FINAL DECAY time in seconds.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog911.js?url';

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog911Def: AudioModuleDef = {
  type: 'moog911',
  domain: 'audio',
  label: 'Moog 911 EG',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    { id: 'gate', type: 'gate' },
    // CV inputs route to the corresponding AudioParam with engine-level
    // scaling (cvScale), so a -1..+1 LFO sweeps each param's full natural
    // range centered on the user's knob position (see .myrobots/plans/
    // cv-range-standard.md). T-times use log scaling (their range spans
    // log decades); Esus is unipolar 0..1 so it uses linear scaling.
    { id: 't1_cv',   type: 'cv', paramTarget: 't1',   cvScale: { mode: 'log' } },
    { id: 't2_cv',   type: 'cv', paramTarget: 't2',   cvScale: { mode: 'log' } },
    { id: 'esus_cv', type: 'cv', paramTarget: 'esus', cvScale: { mode: 'linear' } },
    { id: 't3_cv',   type: 'cv', paramTarget: 't3',   cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'env',     type: 'cv' },
    // Inverted contour: 1 - env. Standard Eurorack semantic for unipolar
    // envelopes — ducking, reverse-modulation, "sidechain"-style use.
    // Computed per-sample in the worklet (outputs[1]).
    { id: 'env_inv', type: 'cv' },
  ],
  params: [
    { id: 't1',   label: 'T1',   defaultValue: 0.01, min: 0.0001, max: 10, curve: 'log', units: 's' },
    { id: 't2',   label: 'T2',   defaultValue: 0.2,  min: 0.0001, max: 10, curve: 'log', units: 's' },
    { id: 'esus', label: 'Esus', defaultValue: 0.6,  min: 0,      max: 1,  curve: 'linear' },
    { id: 't3',   label: 'T3',   defaultValue: 0.4,  min: 0.0001, max: 10, curve: 'log', units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog911', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Feed silence into the gate input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 / analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog911Def.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['gate', { node: workletNode, input: 0 }],
        // CV → AudioParam fast-path; engine sums the scaled CV into these.
        ['t1_cv',   { node: workletNode, input: 0, param: params.get('t1')!   }],
        ['t2_cv',   { node: workletNode, input: 0, param: params.get('t2')!   }],
        ['esus_cv', { node: workletNode, input: 0, param: params.get('esus')! }],
        ['t3_cv',   { node: workletNode, input: 0, param: params.get('t3')!   }],
      ]),
      outputs: new Map([
        ['env',     { node: workletNode, output: 0 }],
        ['env_inv', { node: workletNode, output: 1 }],
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
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
